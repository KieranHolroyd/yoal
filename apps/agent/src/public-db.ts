import { createHash } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { TLSSocket, createSecureContext, type SecureContext } from 'node:tls';
import {
	PUBLIC_ACCESS_EVENTS_PER_HEARTBEAT,
	PUBLIC_ACCESS_LIMITS,
	cidrContains,
	parseCidr,
	parseIpAddress,
	type ParsedCidr,
	type PublicDatabaseEvent,
	type PublicDatabaseListener,
	type PublicDatabaseStatus,
	type PublicListenerState,
	type PublicRefusalReason,
} from '@yoal/contracts';

/**
 * Public database proxy (docs/DATABASES.md §19, D241).
 *
 * One listener per exposed database on this ingress. Each connection is checked against the
 * database's CIDRs (the kernel table already did; this is the second check), the per-source ban,
 * the per-source connect rate and the connection cap, then TLS is terminated with the public
 * certificate and the bytes go to the database's loopback port (or this node's service endpoint
 * for it) in plaintext. Postgres connections negotiate TLS with `SSLRequest` or directly, and the
 * proxy reads the startup message to refuse roles that are not on the list before the database
 * sees them. Plaintext upstream is deliberate: a TLS upstream would make the database offer
 * SCRAM-SHA-256-PLUS, whose channel binding the client computes over the proxy's certificate.
 *
 * Reconfiguration never rebinds an unchanged port; it swaps the configuration and closes the open
 * connections a narrowing no longer allows.
 */

export interface PublicDbCertificate {
	certPem: string;
	keyPem: string;
}

export interface PublicConvergeOptions {
	/** The helper applied the firewall for exactly these listeners. Nothing is bound otherwise. */
	firewallReady: boolean;
	/** The helper has no public-db verbs: nothing can be served safely. */
	helperOutdated?: boolean;
	/** Certificates by name (`app-org1.db.example.com`, `*.db.example.com`). */
	certificates: ReadonlyMap<string, PublicDbCertificate>;
}

export interface PublicProxyOptions {
	now?: () => number;
	log?: (level: 'info' | 'warn', message: string) => void;
	/** Addresses to bind, tried in order (default `::` dual-stack, then `0.0.0.0`). */
	bindHosts?: string[];
	/** Where upstream ports live (default loopback). */
	upstreamHost?: string;
	limits?: Partial<ProxyLimits>;
}

type ProxyLimits = { -readonly [K in keyof typeof PUBLIC_ACCESS_LIMITS]: number };

const SSL_REQUEST = 80_877_103;
const GSSENC_REQUEST = 80_877_104;
const CANCEL_REQUEST = 80_877_102;
const MAX_PREAMBLE = 10_240;
const MAX_STARTUP = 10_000;
const AUTH_WATCH_BYTES = 65_536;
/** Events kept between heartbeats; the oldest are dropped first. */
const EVENT_RING = PUBLIC_ACCESS_EVENTS_PER_HEARTBEAT;
const MAX_TIMER_MS = 2_147_483_000;

interface SourceState {
	connects: number[];
	authFailures: number[];
	handshakeFailures: number[];
	bannedUntil: number;
}

interface Conn {
	client: Socket;
	tls: TLSSocket | null;
	upstream: Socket | null;
	address: { family: 4 | 6; bits: bigint };
	source: string;
	user: string | null;
	timer: ReturnType<typeof setTimeout> | null;
	done: boolean;
}

interface Entry {
	config: PublicDatabaseListener;
	allow: ParsedCidr[];
	users: Set<string>;
	context: SecureContext | null;
	contextKey: string | null;
	contextError: string | null;
	server: Server | null;
	boundPort: number | null;
	binding: boolean;
	bindError: string | null;
	firewallReady: boolean;
	helperOutdated: boolean;
	conns: Set<Conn>;
	accepted: number;
	refused: number;
	authFailures: number;
	sources: Map<string, SourceState>;
	expiryTimer: ReturnType<typeof setTimeout> | null;
	expired: boolean;
}

export class PublicDatabaseProxy {
	private readonly entries = new Map<string, Entry>();
	private events: PublicDatabaseEvent[] = [];
	private readonly now: () => number;
	private readonly log: (level: 'info' | 'warn', message: string) => void;
	private readonly bindHosts: string[];
	private readonly upstreamHost: string;
	private readonly limits: ProxyLimits;
	private closed = false;

	constructor(options: PublicProxyOptions = {}) {
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => undefined);
		this.bindHosts = options.bindHosts ?? ['::', '0.0.0.0'];
		this.upstreamHost = options.upstreamHost ?? '127.0.0.1';
		this.limits = { ...PUBLIC_ACCESS_LIMITS, ...options.limits };
	}

	/** Reconcile listeners to desired state. Idempotent; an unchanged port is never rebound. */
	converge(listeners: readonly PublicDatabaseListener[], options: PublicConvergeOptions): void {
		this.closed = false;
		const wanted = new Map(listeners.map((listener) => [listener.id, listener]));
		for (const [id, entry] of this.entries)
			if (!wanted.has(id)) {
				this.teardown(entry);
				this.entries.delete(id);
			}
		for (const listener of listeners) {
			let entry = this.entries.get(listener.id);
			if (!entry) {
				entry = {
					config: listener,
					allow: [],
					users: new Set(),
					context: null,
					contextKey: null,
					contextError: null,
					server: null,
					boundPort: null,
					binding: false,
					bindError: null,
					firewallReady: false,
					helperOutdated: false,
					conns: new Set(),
					accepted: 0,
					refused: 0,
					authFailures: 0,
					sources: new Map(),
					expiryTimer: null,
					expired: false,
				};
				this.entries.set(listener.id, entry);
			}
			this.configure(entry, listener, options);
		}
	}

	/** One report per listener, for the heartbeat. */
	status(): PublicDatabaseStatus[] {
		const now = this.now();
		return [...this.entries.values()].map((entry) => {
			const { state, error } = this.stateOf(entry);
			let banned = 0;
			for (const source of entry.sources.values()) if (source.bannedUntil > now) banned += 1;
			return {
				id: entry.config.id,
				state,
				error,
				open: entry.conns.size,
				accepted: entry.accepted,
				refused: entry.refused,
				authFailures: entry.authFailures,
				banned,
				version: entry.config.version,
			};
		});
	}

	/** Refusals since the last call, newest last, at most 50. */
	drainEvents(): PublicDatabaseEvent[] {
		const out = this.events;
		this.events = [];
		return out;
	}

	/** Whether any listener is configured (the heartbeat then carries the fields). */
	get size(): number {
		return this.entries.size;
	}

	/** The port a listener is bound to, or null (tests use port 0 through `bindHosts`). */
	boundPort(id: string): number | null {
		const entry = this.entries.get(id);
		const address = entry?.server?.address();
		return address && typeof address === 'object' ? address.port : null;
	}

	close(): void {
		this.closed = true;
		for (const entry of this.entries.values()) this.teardown(entry);
		this.entries.clear();
	}

	// ------------------------------------------------------------------------------ config

	private configure(entry: Entry, listener: PublicDatabaseListener, options: PublicConvergeOptions): void {
		const portChanged = entry.config.port !== listener.port;
		entry.config = listener;
		entry.allow = listener.allow.map((cidr) => parseCidr(cidr, { exact: true })).filter((cidr): cidr is ParsedCidr => cidr !== null);
		entry.users = new Set(listener.users);
		entry.firewallReady = options.firewallReady && !options.helperOutdated;
		entry.helperOutdated = options.helperOutdated === true;

		// TLS context, swapped in place: the next handshake uses it.
		const certificate = listener.certificateNames.map((name) => options.certificates.get(name)).find((item) => item !== undefined);
		const key = certificate ? createHash('sha256').update(certificate.certPem).update('\0').update(certificate.keyPem).digest('hex') : null;
		if (key !== entry.contextKey) {
			entry.contextKey = key;
			entry.context = null;
			entry.contextError = null;
			if (certificate)
				try {
					entry.context = createSecureContext({ cert: certificate.certPem, key: certificate.keyPem, minVersion: 'TLSv1.2' });
				} catch (error) {
					entry.contextError = `The certificate for ${listener.host} could not be loaded: ${(error as Error).message}`;
				}
		}

		// Expiry: closed at the time itself, even with no control plane.
		if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
		entry.expiryTimer = null;
		const expiresAt = listener.expiresAt ? Date.parse(listener.expiresAt) : Number.NaN;
		entry.expired = Number.isFinite(expiresAt) && expiresAt <= this.now();
		if (Number.isFinite(expiresAt) && !entry.expired) {
			entry.expiryTimer = setTimeout(() => {
				entry.expiryTimer = null;
				if (this.entries.get(listener.id) !== entry) return;
				entry.expired = true;
				this.log('info', `Public access to ${listener.host} expired; closing its listener`);
				this.unbind(entry);
				for (const conn of [...entry.conns]) this.destroy(entry, conn);
			}, Math.min(MAX_TIMER_MS, expiresAt - this.now()));
			entry.expiryTimer.unref?.();
		}

		// Narrowing: cut what is no longer allowed.
		for (const conn of [...entry.conns]) {
			const sourceOk = entry.allow.some((cidr) => cidrContains(cidr, conn.address));
			// Postgres always checks the role: an empty list (every credential revoked) lets nobody in.
			const userOk = entry.config.protocol !== 'postgres' || conn.user === null || entry.users.has(conn.user);
			if (!sourceOk || !userOk || entry.expired) this.destroy(entry, conn);
		}

		if (portChanged || entry.expired || !entry.firewallReady) this.unbind(entry);
		if (!entry.expired && entry.firewallReady && !entry.server && !entry.binding) void this.bind(entry);
	}

	private stateOf(entry: Entry): { state: PublicListenerState; error: string | null } {
		if (entry.expired) return { state: 'expired', error: null };
		if (entry.helperOutdated) return { state: 'helper-outdated', error: 'The helper on this node has no public-db verbs; update the node.' };
		if (!entry.firewallReady) return { state: 'firewall-pending', error: null };
		if (entry.bindError) return { state: 'bind-failed', error: entry.bindError };
		if (!entry.server) return { state: 'firewall-pending', error: null };
		if (entry.config.upstreamPort === null)
			return { state: 'unreachable', error: 'The database is on another node and this node has no service endpoint for it yet.' };
		if (!entry.context) return { state: 'no-certificate', error: entry.contextError ?? `No certificate for ${entry.config.host} yet.` };
		return { state: 'listening', error: null };
	}

	private async bind(entry: Entry): Promise<void> {
		entry.binding = true;
		const port = entry.config.port;
		let lastError: string | null = null;
		for (const host of this.bindHosts) {
			const server = createServer({ pauseOnConnect: false }, (socket) => this.accept(entry, socket));
			try {
				await new Promise<void>((resolve, reject) => {
					server.once('error', reject);
					server.listen({ port, host, ...(host === '::' ? { ipv6Only: false } : {}) }, () => {
						server.off('error', reject);
						resolve();
					});
				});
			} catch (error) {
				lastError = `${host}:${port}: ${(error as Error).message}`;
				server.close();
				continue;
			}
			entry.binding = false;
			// A converge, an expiry or close may have happened while binding.
			if (this.closed || this.entries.get(entry.config.id) !== entry || entry.expired || !entry.firewallReady || entry.config.port !== port) {
				server.close();
				return;
			}
			server.on('error', (error) => this.log('warn', `Public listener ${port}: ${error.message}`));
			entry.server = server;
			entry.boundPort = port;
			entry.bindError = null;
			this.log('info', `Public access listening on ${host}:${port} for ${entry.config.host}`);
			return;
		}
		entry.binding = false;
		if (entry.bindError !== lastError) this.log('warn', `Public listener could not bind (${lastError}); retrying at the next converge`);
		entry.bindError = lastError;
	}

	private unbind(entry: Entry): void {
		if (entry.server) {
			entry.server.close();
			entry.server = null;
			entry.boundPort = null;
		}
		entry.bindError = null;
	}

	private teardown(entry: Entry): void {
		if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
		entry.expiryTimer = null;
		this.unbind(entry);
		for (const conn of [...entry.conns]) this.destroy(entry, conn);
	}

	// ------------------------------------------------------------------------------ admission

	private sourceState(entry: Entry, source: string): SourceState {
		let state = entry.sources.get(source);
		if (!state) {
			if (entry.sources.size > 10_000) this.pruneSources(entry);
			state = { connects: [], authFailures: [], handshakeFailures: [], bannedUntil: 0 };
			entry.sources.set(source, state);
		}
		return state;
	}

	private pruneSources(entry: Entry): void {
		const now = this.now();
		for (const [key, state] of entry.sources) {
			const recent = [...state.connects, ...state.authFailures, ...state.handshakeFailures].some((at) => now - at < this.limits.failureWindowMs);
			if (!recent && state.bannedUntil <= now) entry.sources.delete(key);
		}
	}

	private refuse(entry: Entry, source: string, reason: PublicRefusalReason, detail: string | null = null): void {
		entry.refused += 1;
		this.events.push({ id: entry.config.id, at: new Date(this.now()).toISOString(), source: source.slice(0, 64), reason, detail: detail?.slice(0, 200) ?? null });
		if (this.events.length > EVENT_RING) this.events.splice(0, this.events.length - EVENT_RING);
	}

	/** Count a failed login or handshake; ban the source at the threshold. */
	private fail(entry: Entry, source: string, kind: 'auth' | 'handshake'): void {
		const now = this.now();
		const state = this.sourceState(entry, source);
		const list = kind === 'auth' ? state.authFailures : state.handshakeFailures;
		list.push(now);
		while (list.length > 0 && now - list[0]! > this.limits.failureWindowMs) list.shift();
		const threshold = kind === 'auth' ? this.limits.authFailures : this.limits.handshakeFailures;
		if (list.length >= threshold && state.bannedUntil <= now) {
			state.bannedUntil = now + this.limits.banMs;
			list.length = 0;
			this.refuse(entry, source, 'banned', `${threshold} failed ${kind === 'auth' ? 'logins' : 'handshakes'}; banned for ${Math.round(this.limits.banMs / 60_000)} min`);
		}
	}

	private accept(entry: Entry, client: Socket): void {
		client.on('error', () => undefined);
		const raw = client.remoteAddress ?? '';
		const address = parseIpAddress(raw);
		const source = address ? displayAddress(raw, address) : raw || 'unknown';
		const now = this.now();
		if (!address || !entry.allow.some((cidr) => cidrContains(cidr, address))) {
			this.refuse(entry, source, 'source');
			client.destroy();
			return;
		}
		if (entry.expired) {
			this.refuse(entry, source, 'expired');
			client.destroy();
			return;
		}
		const state = this.sourceState(entry, source);
		if (state.bannedUntil > now) {
			this.refuse(entry, source, 'banned');
			client.destroy();
			return;
		}
		state.connects.push(now);
		while (state.connects.length > 0 && now - state.connects[0]! > 60_000) state.connects.shift();
		if (state.connects.length > this.limits.connectsPerMinute) {
			this.refuse(entry, source, 'rate-limit');
			client.destroy();
			return;
		}
		if (entry.conns.size >= entry.config.maxConnections) {
			this.refuse(entry, source, 'capacity', `${entry.config.maxConnections} connections open`);
			client.destroy();
			return;
		}
		if (entry.config.upstreamPort === null) {
			this.refuse(entry, source, 'upstream', 'no route to the database from this node');
			client.destroy();
			return;
		}
		// Postgres can still be told why (see `postgresPreamble`); other protocols speak TLS from the
		// first byte, so there is nothing to answer with.
		if (!entry.context && entry.config.protocol !== 'postgres') {
			this.refuse(entry, source, 'no-certificate');
			client.destroy();
			return;
		}
		const conn: Conn = { client, tls: null, upstream: null, address, source, user: null, timer: null, done: false };
		entry.conns.add(conn);
		client.on('close', () => this.destroy(entry, conn));
		conn.timer = setTimeout(() => {
			conn.timer = null;
			this.refuse(entry, source, 'handshake', 'timed out');
			this.fail(entry, source, 'handshake');
			this.destroy(entry, conn);
		}, this.limits.handshakeTimeoutMs);
		if (entry.config.protocol === 'postgres') this.postgresPreamble(entry, conn);
		else this.readFirst(conn, (first) => this.startTls(entry, conn, first, null, (tls) => this.pipe(entry, conn, tls, Buffer.alloc(0), null)));
	}

	private readFirst(conn: Conn, then: (first: Buffer) => void): void {
		conn.client.once('data', (chunk: Buffer) => {
			conn.client.pause();
			then(chunk);
		});
	}

	// ------------------------------------------------------------------------------ Postgres

	/**
	 * Before TLS: direct TLS, `SSLRequest`, `GSSENCRequest`, a plaintext cancel, or a refusal.
	 *
	 * With no certificate yet, `SSLRequest` is answered `N` rather than by hanging up: a client on the
	 * default `sslmode=prefer` then sends its startup message in plaintext and gets an ErrorResponse
	 * that says why, instead of "server closed the connection unexpectedly". (libpq ignores the text
	 * of an error sent in reply to `SSLRequest` itself, CVE-2024-10977.) `sslmode=require` stops at
	 * the `N` with "server does not support SSL". Nothing past the startup message is read and no
	 * plaintext session is ever opened.
	 */
	private postgresPreamble(entry: Entry, conn: Conn): void {
		let buffer = Buffer.alloc(0);
		let declinedTls = false;
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.length === 0) return;
				if (buffer[0] === 0x16) {
					stop();
					this.startTls(entry, conn, buffer, ['postgresql'], (tls) => this.postgresStartup(entry, conn, tls));
					return;
				}
				if (buffer.length < 8) {
					if (buffer.length > MAX_PREAMBLE) break;
					return;
				}
				const length = buffer.readInt32BE(0);
				const code = buffer.readInt32BE(4);
				if (length === 8 && code === SSL_REQUEST && !entry.context) {
					if (!declinedTls) this.refuse(entry, conn.source, 'no-certificate');
					declinedTls = true;
					conn.client.write('N');
					buffer = buffer.subarray(8);
					continue;
				}
				if (length === 8 && code === SSL_REQUEST) {
					stop();
					const rest = buffer.subarray(8);
					conn.client.write('S');
					this.startTls(entry, conn, rest, null, (tls) => this.postgresStartup(entry, conn, tls));
					return;
				}
				if (length === 8 && code === GSSENC_REQUEST) {
					conn.client.write('N');
					buffer = buffer.subarray(8);
					continue;
				}
				if (length === 16 && code === CANCEL_REQUEST) {
					if (buffer.length < 16) return;
					stop();
					this.forwardCancel(entry, conn, buffer.subarray(0, 16));
					return;
				}
				if (length >= 8 && length <= MAX_STARTUP && code >>> 16 === 3 && !entry.context) {
					stop();
					if (!declinedTls) this.refuse(entry, conn.source, 'no-certificate');
					conn.client.end(postgresError('57P03', noCertificateMessage(entry.config.host)));
					this.finish(entry, conn);
					return;
				}
				if (length >= 8 && length <= MAX_STARTUP && code >>> 16 === 3) {
					stop();
					this.refuse(entry, conn.source, 'tls-required');
					conn.client.end(postgresError('28000', 'Public access requires TLS (sslmode=require or stronger)'));
					this.finish(entry, conn);
					return;
				}
				break;
			}
			stop();
			this.refuse(entry, conn.source, 'handshake', 'not a Postgres handshake');
			this.fail(entry, conn.source, 'handshake');
			this.destroy(entry, conn);
		};
		const stop = () => {
			conn.client.off('data', onData);
			conn.client.pause();
		};
		conn.client.on('data', onData);
	}

	/** After TLS: the startup message (or a cancel), the role check, then the upstream. */
	private postgresStartup(entry: Entry, conn: Conn, tls: TLSSocket): void {
		let buffer = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length < 8) return;
			const length = buffer.readInt32BE(0);
			const code = buffer.readInt32BE(4);
			if (length < 8 || length > MAX_STARTUP) return bad('startup message too long or short');
			if (buffer.length < length) return;
			tls.off('data', onData);
			tls.pause();
			const message = buffer.subarray(0, length);
			const rest = buffer.subarray(length);
			if (length === 16 && code === CANCEL_REQUEST) return this.forwardCancel(entry, conn, message);
			if (code >>> 16 !== 3) return bad('unsupported protocol');
			const params = startupParams(message);
			const user = params.get('user') ?? '';
			conn.user = user;
			// Fail closed: an empty list (every listed credential revoked) refuses every role.
			if (!entry.users.has(user)) {
				this.refuse(entry, conn.source, 'role', user);
				this.fail(entry, conn.source, 'auth');
				entry.authFailures += 1;
				tls.end(postgresError('28000', `role "${user}" is not allowed over public access`));
				this.finish(entry, conn);
				return;
			}
			this.pipe(entry, conn, tls, Buffer.concat([message, rest]), user);
		};
		const bad = (detail: string) => {
			tls.off('data', onData);
			this.refuse(entry, conn.source, 'handshake', detail);
			this.fail(entry, conn.source, 'handshake');
			this.destroy(entry, conn);
		};
		tls.on('data', onData);
		tls.resume();
	}

	private forwardCancel(entry: Entry, conn: Conn, message: Buffer): void {
		this.clearTimer(conn);
		const upstream = connect({ host: this.upstreamHost, port: entry.config.upstreamPort! });
		upstream.on('error', () => upstream.destroy());
		upstream.on('connect', () => upstream.end(message));
		this.finish(entry, conn);
		conn.tls?.end();
		conn.client.end();
	}

	// ------------------------------------------------------------------------------ TLS + pipe

	private startTls(entry: Entry, conn: Conn, first: Buffer, alpn: string[] | null, then: (tls: TLSSocket) => void): void {
		const context = entry.context;
		if (!context) {
			this.refuse(entry, conn.source, 'no-certificate');
			this.destroy(entry, conn);
			return;
		}
		const tls = new TLSSocket(replay(conn.client, first) as unknown as Socket, {
			isServer: true,
			secureContext: context,
			...(alpn ? { ALPNProtocols: alpn } : {}),
		});
		conn.tls = tls;
		let secure = false;
		tls.on('error', (error) => {
			if (!secure) {
				this.refuse(entry, conn.source, 'handshake', error.message);
				this.fail(entry, conn.source, 'handshake');
			}
			this.destroy(entry, conn);
		});
		tls.on('close', () => this.destroy(entry, conn));
		tls.once('secure', () => {
			secure = true;
			if (conn.done) return;
			then(tls);
		});
	}

	/** Connect upstream in plaintext, send what the client already sent, pipe both ways. */
	private pipe(entry: Entry, conn: Conn, tls: TLSSocket, head: Buffer, pgUser: string | null): void {
		if (conn.done) return;
		const upstream = connect({ host: this.upstreamHost, port: entry.config.upstreamPort ?? 1 });
		conn.upstream = upstream;
		upstream.on('error', (error) => {
			if (!conn.done && conn.timer) this.refuse(entry, conn.source, 'upstream', error.message);
			this.destroy(entry, conn);
		});
		upstream.on('close', () => this.destroy(entry, conn));
		upstream.on('connect', () => {
			if (conn.done) return;
			this.clearTimer(conn);
			entry.accepted += 1;
			if (head.length > 0) upstream.write(head);
			if (pgUser !== null) this.watchAuth(entry, conn, upstream, pgUser);
			upstream.pipe(tls);
			tls.pipe(upstream);
			tls.resume();
		});
	}

	/** Read the database's first answers: AuthenticationOk ends the watch, a 28P01/28000 counts. */
	private watchAuth(entry: Entry, conn: Conn, upstream: Socket, user: string): void {
		let buffer = Buffer.alloc(0);
		let seen = 0;
		const onData = (chunk: Buffer) => {
			seen += chunk.length;
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 5) {
				const type = String.fromCharCode(buffer[0]!);
				const length = buffer.readInt32BE(1);
				if (length < 4 || buffer.length < length + 1) break;
				const body = buffer.subarray(5, length + 1);
				buffer = buffer.subarray(length + 1);
				if (type === 'R' && body.length >= 4 && body.readInt32BE(0) === 0) return stop();
				if (type === 'E') {
					const code = errorCode(body);
					if (code === '28P01' || code === '28000') {
						entry.authFailures += 1;
						this.refuse(entry, conn.source, 'auth-failed', user);
						this.fail(entry, conn.source, 'auth');
					}
					return stop();
				}
			}
			if (seen > AUTH_WATCH_BYTES) stop();
		};
		const stop = () => upstream.off('data', onData);
		upstream.on('data', onData);
	}

	private clearTimer(conn: Conn): void {
		if (conn.timer) clearTimeout(conn.timer);
		conn.timer = null;
	}

	/** Forget a connection whose sockets are closing on their own. */
	private finish(entry: Entry, conn: Conn): void {
		this.clearTimer(conn);
		conn.done = true;
		entry.conns.delete(conn);
	}

	private destroy(entry: Entry, conn: Conn): void {
		this.finish(entry, conn);
		conn.upstream?.destroy();
		conn.tls?.destroy();
		conn.client.destroy();
	}
}

/** The source as people read it: IPv4-mapped IPv6 becomes the IPv4 address. */
function displayAddress(raw: string, address: { family: 4 | 6; bits: bigint }): string {
	if (address.family === 4) {
		const n = address.bits;
		return `${(n >> 24n) & 255n}.${(n >> 16n) & 255n}.${(n >> 8n) & 255n}.${n & 255n}`;
	}
	return raw.replace(/%.*$/, '').toLowerCase();
}

/** A duplex that yields `first` and then whatever the raw socket reads, for a server-side TLS wrap. */
function replay(raw: Socket, first: Buffer): Duplex {
	const duplex = new Duplex({
		read() {
			raw.resume();
		},
		write(chunk, _encoding, callback) {
			if (raw.destroyed) return callback(new Error('socket closed'));
			raw.write(chunk, (error) => callback(error ?? null));
		},
		final(callback) {
			raw.end();
			callback();
		},
		destroy(error, callback) {
			raw.destroy();
			callback(error);
		},
	});
	if (first.length > 0) duplex.push(first);
	raw.on('data', (chunk: Buffer) => {
		if (!duplex.push(chunk)) raw.pause();
	});
	raw.on('end', () => duplex.push(null));
	raw.on('close', () => duplex.destroy());
	return duplex;
}

/** `key\0value\0…\0` after the length and protocol version. */
function startupParams(message: Buffer): Map<string, string> {
	const params = new Map<string, string>();
	const parts = message.subarray(8).toString('utf8').split('\0');
	for (let index = 0; index + 1 < parts.length; index += 2) {
		const key = parts[index]!;
		if (key === '') break;
		params.set(key, parts[index + 1]!);
	}
	return params;
}

function errorCode(body: Buffer): string | null {
	let offset = 0;
	while (offset < body.length && body[offset] !== 0) {
		const field = String.fromCharCode(body[offset]!);
		const end = body.indexOf(0, offset + 1);
		if (end === -1) return null;
		if (field === 'C') return body.subarray(offset + 1, end).toString('utf8');
		offset = end + 1;
	}
	return null;
}

/** What a Postgres client is told while the node has no certificate for the host. */
export function noCertificateMessage(host: string): string {
	return `Public access to ${host} is not serving yet: this node has no TLS certificate for it. It starts by itself once the certificate is issued; the database's Public access panel shows the status.`;
}

/** A FATAL ErrorResponse. */
export function postgresError(code: string, message: string): Buffer {
	const fields = Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${message}\0\0`, 'utf8');
	const out = Buffer.alloc(5 + fields.length);
	out.write('E', 0, 'ascii');
	out.writeInt32BE(4 + fields.length, 1);
	fields.copy(out, 5);
	return out;
}
