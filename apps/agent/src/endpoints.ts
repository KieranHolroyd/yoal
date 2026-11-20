import { createServer, connect, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer, connect as connectTls, type PeerCertificate, type SecureContextOptions, type TLSSocket } from 'node:tls';
import type { EndpointTrustMode, ReadEndpoint, ServiceEndpoint, ServiceProvider } from '@yoal/contracts';

/**
 * Cross-node service forwarding (docs/CLUSTERING.md §4.3, phase C2; HA-PLAN H24; Bun forwarder).
 *
 * The control plane plans the endpoints; this process owns only the sockets. A consumer listens
 * on 127.0.0.1:<localPort> (and, with `endpoints-gateway`, on the node's container gateway
 * address, same port) and pipes to the provider's overlay address. A provider listens on its
 * overlay address and pipes to the service's loopback port.
 *
 * Trust per connection is `pinned` (C2: the provider's self-signed leaf by SHA-256, the consumer's
 * by an allowlist) or `install-ca` (HA-PLAN H24: a chain to the install CA bundle, the peer's URI
 * SAN `yoal://node/<id>`, and no revoked serial).
 *
 * Reloads never rebind a listener whose address and port are unchanged (spike S10 found every
 * converge restarting every listener, which refuses connections in the gap): a changed upstream,
 * trust mode, allowlist or CA bundle is swapped in place and applies to the next connection.
 */

/** The node's install-CA identity (`apps/agent/src/node-ca.ts`): its leaf, key and the bundle. */
export interface NodeTrustMaterial {
	keyPem: string;
	certPem: string;
	caBundlePem: string;
	/** Normalized serials (`normalizeSerial`) no peer may present. */
	revokedSerials: ReadonlySet<string>;
	/** `nodeTrust.generation`: a change re-applies provider TLS contexts. */
	generation: number;
}

export interface ConvergeExtras {
	/** Read endpoints (`readEndpoints`, `endpoints-gateway` only). */
	readEndpoints?: ReadEndpoint[];
	/** The install-CA material, or null while the node has no signed leaf. */
	trust?: NodeTrustMaterial | null;
	/**
	 * Whether gateway addresses may be bound. The agent sets it only after the helper's endpoint
	 * guard is in place, so a gateway listener is never reachable from another bridge or the
	 * underlay (fails closed: loopback only).
	 */
	gatewayAllowed?: boolean;
}

export interface ConvergeResult {
	/** Listeners created (a consumer port or a provider port). */
	started: number;
	/** Listeners removed. */
	stopped: number;
	/** Existing listeners whose route changed in place (no rebind). */
	updated: number;
}

interface Upstream {
	nodeId: string;
	address: string | null;
	port: number;
	trust: EndpointTrustMode;
	fingerprint: string | null;
}

interface ConsumerRoute {
	port: number;
	binds: string[];
	upstreams: Upstream[];
	/** Read endpoints balance over all but the last upstream; the last is the fallback. */
	balance: boolean;
	version: number | null;
}

interface ConsumerEntry {
	route: ConsumerRoute;
	servers: Map<string, Server>;
	clients: Set<Socket>;
	next: number;
}

interface ProviderEntry {
	provider: ServiceProvider;
	server: Server;
	tls: boolean;
	contextKey: string;
}

const LOOPBACK = '127.0.0.1';
const BIND_RETRY_MS = 2_000;

export class ServiceForwarder {
	private readonly consumers = new Map<number, ConsumerEntry>();
	private readonly providers = new Map<number, ProviderEntry>();
	private readonly log: (level: 'info' | 'warn', message: string) => void;
	private readonly certificate?: { certPem: string; keyPem: string };
	private trust: NodeTrustMaterial | null = null;
	/** `<address>:<port>` -> last bind error, so a failing bind logs once, not every converge. */
	private readonly bindFailures = new Map<string, string>();
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;

	constructor(options: { log?: (level: 'info' | 'warn', message: string) => void; certificate?: { certPem: string; keyPem: string } } = {}) {
		this.log = options.log ?? (() => undefined);
		this.certificate = options.certificate;
	}

	/** Reconcile listeners to desired state. Idempotent; an unchanged listener is never rebound. */
	converge(endpoints: ServiceEndpoint[], providers: ServiceProvider[], extras: ConvergeExtras = {}): ConvergeResult {
		this.closed = false;
		this.trust = extras.trust ?? null;
		const gatewayAllowed = extras.gatewayAllowed === true;
		const wanted = new Map<number, ConsumerRoute>();
		for (const endpoint of endpoints) wanted.set(endpoint.localPort, serviceRoute(endpoint, gatewayAllowed));
		for (const endpoint of extras.readEndpoints ?? []) wanted.set(endpoint.localPort, readRoute(endpoint, gatewayAllowed));
		const wantedProviders = new Map<number, ServiceProvider>();
		for (const provider of providers) wantedProviders.set(provider.listenPort, provider);

		const result: ConvergeResult = { started: 0, stopped: 0, updated: 0 };
		for (const [port, entry] of this.consumers) {
			if (wanted.has(port)) continue;
			for (const server of entry.servers.values()) closeServer(server);
			this.consumers.delete(port);
			result.stopped += 1;
		}
		for (const route of wanted.values()) {
			const entry = this.consumers.get(route.port);
			if (!entry) {
				const created: ConsumerEntry = { route, servers: new Map(), clients: new Set(), next: 0 };
				this.consumers.set(route.port, created);
				this.bindConsumer(created);
				result.started += 1;
				continue;
			}
			if (routeKey(entry.route) !== routeKey(route)) {
				const failover = isFailover(entry.route, route);
				entry.route = route;
				result.updated += 1;
				// A re-pointed upstream with a newer version is a failover (CLUSTERING §13.5): cut the
				// sessions still on the old provider so clients reconnect through the new one.
				if (failover) for (const client of entry.clients) client.destroy();
			}
			for (const [address, server] of entry.servers) {
				if (route.binds.includes(address)) continue;
				closeServer(server);
				entry.servers.delete(address);
			}
			this.bindConsumer(entry);
		}

		for (const [port, entry] of this.providers) {
			const provider = wantedProviders.get(port);
			// Reuse only if the address and the transport (plain versus TLS) are unchanged; a CA leaf
			// appearing or disappearing moves an install-ca listener between them.
			if (provider && provider.listenAddress === entry.provider.listenAddress && this.providerTls(provider) === entry.tls) continue;
			closeServer(entry.server);
			this.providers.delete(port);
			result.stopped += 1;
		}
		for (const provider of wantedProviders.values()) {
			const entry = this.providers.get(provider.listenPort);
			if (!entry) {
				this.providers.set(provider.listenPort, this.listenProvider(provider));
				result.started += 1;
				continue;
			}
			if (providerKey(entry.provider) !== providerKey(provider)) result.updated += 1;
			entry.provider = provider;
			if (entry.tls) this.refreshProviderContext(entry);
		}
		return result;
	}

	/** Stop every listener; used on shutdown. Open connections are left to finish. */
	close(): void {
		this.closed = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		for (const entry of this.consumers.values()) for (const server of entry.servers.values()) closeServer(server);
		for (const entry of this.providers.values()) closeServer(entry.server);
		this.consumers.clear();
		this.providers.clear();
	}

	/** Addresses each consumer port is listening on right now (for status and tests). */
	listening(): Record<number, string[]> {
		const out: Record<number, string[]> = {};
		for (const [port, entry] of this.consumers) out[port] = [...entry.servers.keys()].sort();
		return out;
	}

	private bindConsumer(entry: ConsumerEntry): void {
		const port = entry.route.port;
		for (const address of entry.route.binds) {
			if (entry.servers.has(address)) continue;
			const server = createServer((socket) => this.acceptConsumer(entry, socket));
			entry.servers.set(address, server);
			const key = `${address}:${port}`;
			server.on('listening', () => {
				if (this.bindFailures.delete(key)) this.log('info', `endpoint ${key} is listening`);
			});
			server.on('error', (error) => {
				if (entry.servers.get(address) === server) entry.servers.delete(address);
				closeServer(server);
				if (this.bindFailures.get(key) !== error.message)
					this.log('warn', `endpoint ${key} could not listen: ${error.message}`);
				this.bindFailures.set(key, error.message);
				// A gateway address appears only once Podman has brought its bridge up; try again.
				if (address !== LOOPBACK) this.scheduleRetry();
			});
			server.listen(port, address);
		}
	}

	private scheduleRetry(): void {
		if (this.retryTimer || this.closed) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			if (this.closed) return;
			for (const [port, entry] of this.consumers) if (this.consumers.get(port) === entry) this.bindConsumer(entry);
		}, BIND_RETRY_MS);
		(this.retryTimer as { unref?: () => void }).unref?.();
	}

	private acceptConsumer(entry: ConsumerEntry, socket: Socket): void {
		const route = entry.route;
		entry.clients.add(socket);
		socket.on('close', () => entry.clients.delete(socket));
		socket.on('error', () => undefined);
		const candidates = route.upstreams.filter((upstream) => upstream.address);
		if (candidates.length === 0) {
			socket.destroy();
			return;
		}
		let order = candidates;
		if (route.balance && candidates.length > 1) {
			const pool = candidates.slice(0, -1);
			const start = entry.next++ % pool.length;
			order = [...pool.slice(start), ...pool.slice(0, start), candidates.at(-1)!];
		}
		const attempt = (index: number): void => {
			if (socket.destroyed) return;
			const upstream = order[index];
			if (!upstream) {
				socket.destroy();
				return;
			}
			this.dial(route.port, upstream, socket, () => attempt(index + 1));
		};
		attempt(0);
	}

	/** Connect `socket` to one upstream, or call `fail` before any byte has moved. */
	private dial(port: number, upstream: Upstream, socket: Socket, fail: () => void): void {
		const host = upstream.address!;
		let settled = false;
		const giveUp = (target: { destroy(): void }, message?: string): void => {
			if (message) this.log('warn', `endpoint ${LOOPBACK}:${port} -> ${host}:${upstream.port}: ${message}`);
			target.destroy();
			if (settled) {
				socket.destroy();
				return;
			}
			settled = true;
			fail();
		};
		const ready = (target: Socket): void => {
			settled = true;
			socket.on('error', () => target.destroy());
			socket.on('close', () => target.destroy());
			target.on('error', () => socket.destroy());
			target.on('close', () => socket.destroy());
			target.pipe(socket).pipe(target);
		};

		if (upstream.trust === 'install-ca') {
			const trust = this.trust;
			if (!trust) {
				// Fail closed: the provider expects a CA leaf this node does not have yet.
				giveUp({ destroy: () => undefined }, 'install-ca trust without a signed node certificate');
				return;
			}
			const target = connectTls(
				{
					host,
					port: upstream.port,
					key: trust.keyPem,
					cert: trust.certPem,
					ca: trust.caBundlePem,
					rejectUnauthorized: true,
					checkServerIdentity: (_host, certificate) =>
						certificateNodeIds(certificate).includes(upstream.nodeId)
							? undefined
							: new Error(`provider certificate does not name ${upstream.nodeId}`),
				},
				() => {
					if (trust.revokedSerials.has(normalizeSerial(target.getPeerCertificate().serialNumber ?? ''))) {
						giveUp(target, 'provider certificate is revoked');
						return;
					}
					ready(target);
				},
			);
			target.once('error', (error) => {
				if (!settled) giveUp(target, error.message);
			});
			return;
		}

		if (!this.certificate || !upstream.fingerprint) {
			const target = connect({ host, port: upstream.port }, () => ready(target));
			target.once('error', (error) => {
				if (!settled) giveUp(target, error.message);
			});
			return;
		}
		const fingerprint = upstream.fingerprint;
		const target = connectTls(
			{ host, port: upstream.port, key: this.certificate.keyPem, cert: this.certificate.certPem, rejectUnauthorized: false },
			() => {
				const peer = normalizeFingerprint(target.getPeerCertificate().fingerprint256 ?? '');
				if (peer !== fingerprint) {
					giveUp(target, 'provider certificate does not match the pinned fingerprint');
					return;
				}
				ready(target);
			},
		);
		target.once('error', (error) => {
			if (!settled) giveUp(target, error.message);
		});
	}

	private listenProvider(provider: ServiceProvider): ProviderEntry {
		const bind = provider.listenAddress;
		const port = provider.listenPort;
		if (!this.providerTls(provider)) {
			const entry: ProviderEntry = { provider, server: createServer(), tls: false, contextKey: 'plain' };
			entry.server.on('connection', (socket: Socket) => {
				// Without a node certificate there is no TLS to check; `install-ca` fails closed.
				if ((entry.provider.clientAuth ?? 'pinned') === 'install-ca') {
					socket.destroy();
					return;
				}
				this.pipeLoopback(socket, entry.provider.targetPort);
			});
			entry.server.on('error', (error) => this.log('warn', `provider ${bind}:${port} could not listen: ${error.message}`));
			entry.server.listen(port, bind);
			return entry;
		}
		const { key, context } = this.providerContext(provider);
		const entry: ProviderEntry = {
			provider,
			server: createTlsServer({ ...context, requestCert: true, rejectUnauthorized: false }),
			tls: true,
			contextKey: key,
		};
		entry.server.on('secureConnection', (socket: TLSSocket) => {
			const reason = this.refuseClient(entry.provider, socket);
			if (reason) {
				this.log('warn', `provider ${bind}:${port} rejected a client: ${reason}`);
				socket.destroy();
				return;
			}
			this.pipeLoopback(socket, entry.provider.targetPort);
		});
		entry.server.on('tlsClientError', () => undefined);
		entry.server.on('error', (error) => this.log('warn', `provider ${bind}:${port} could not listen: ${error.message}`));
		entry.server.listen(port, bind);
		return entry;
	}

	/** Why a client may not use this listener, or null. Checked per connection, after the handshake. */
	private refuseClient(provider: ServiceProvider, socket: TLSSocket): string | null {
		const certificate = socket.getPeerCertificate();
		if ((provider.clientAuth ?? 'pinned') === 'pinned') {
			const peer = normalizeFingerprint(certificate.fingerprint256 ?? '');
			return provider.allowedClientFingerprints.includes(peer) ? null : 'unknown client certificate';
		}
		const trust = this.trust;
		if (!trust) return 'install-ca trust without a signed node certificate';
		if (!socket.authorized) return `client certificate does not chain to the install CA (${String(socket.authorizationError ?? 'none')})`;
		if (trust.revokedSerials.has(normalizeSerial(certificate.serialNumber ?? ''))) return 'client certificate is revoked';
		const allowed = provider.allowedClientNodeIds ?? [];
		return certificateNodeIds(certificate).some((id) => allowed.includes(id)) ? null : 'client node is not allowed';
	}

	/** Whether this provider listener must speak TLS: install-ca needs CA material or a pinned identity. */
	private providerTls(provider: ServiceProvider): boolean {
		if ((provider.clientAuth ?? 'pinned') === 'install-ca') return this.trust !== null || this.certificate !== undefined;
		return this.certificate !== undefined;
	}

	private providerContext(provider: ServiceProvider): { key: string; context: SecureContextOptions } {
		const trust = this.trust;
		if ((provider.clientAuth ?? 'pinned') === 'install-ca' && trust)
			return {
				key: `ca:${trust.generation}:${trust.certPem.length}:${trust.caBundlePem.length}`,
				context: { key: trust.keyPem, cert: trust.certPem, ca: trust.caBundlePem },
			};
		return { key: 'pinned', context: { key: this.certificate!.keyPem, cert: this.certificate!.certPem } };
	}

	private refreshProviderContext(entry: ProviderEntry): void {
		const { key, context } = this.providerContext(entry.provider);
		if (key === entry.contextKey) return;
		(entry.server as Server & { setSecureContext(options: SecureContextOptions): void }).setSecureContext(context);
		entry.contextKey = key;
	}

	private pipeLoopback(socket: Socket, port: number): void {
		const upstream = connect({ host: LOOPBACK, port });
		upstream.on('error', (error) => {
			this.log('warn', `endpoint -> ${LOOPBACK}:${port} failed: ${error.message}`);
			socket.destroy();
		});
		socket.on('error', () => upstream.destroy());
		upstream.pipe(socket).pipe(upstream);
	}
}

function serviceRoute(endpoint: ServiceEndpoint, gatewayAllowed: boolean): ConsumerRoute {
	return {
		port: endpoint.localPort,
		binds: binds(endpoint.gatewayAddress, gatewayAllowed),
		upstreams: [
			{
				nodeId: endpoint.upstream.nodeId,
				address: endpoint.upstream.address,
				port: endpoint.upstream.port,
				trust: endpoint.trust ?? 'pinned',
				fingerprint: endpoint.tlsFingerprint,
			},
		],
		balance: false,
		version: endpoint.version ?? null,
	};
}

function readRoute(endpoint: ReadEndpoint, gatewayAllowed: boolean): ConsumerRoute {
	return {
		port: endpoint.localPort,
		binds: binds(endpoint.gatewayAddress, gatewayAllowed),
		upstreams: endpoint.upstreams.map((upstream) => ({
			nodeId: upstream.nodeId,
			address: upstream.address,
			port: upstream.port,
			trust: upstream.trust,
			fingerprint: upstream.tlsFingerprint,
		})),
		balance: true,
		version: endpoint.version,
	};
}

function binds(gatewayAddress: string | undefined, gatewayAllowed: boolean): string[] {
	return gatewayAddress && gatewayAllowed && gatewayAddress !== LOOPBACK ? [LOOPBACK, gatewayAddress] : [LOOPBACK];
}

function routeKey(route: ConsumerRoute): string {
	return JSON.stringify([route.upstreams, route.balance, route.version]);
}

function upstreamTargets(route: ConsumerRoute): string {
	return route.upstreams.map((upstream) => `${upstream.nodeId}@${upstream.address ?? ''}:${upstream.port}`).join(',');
}

function isFailover(before: ConsumerRoute, after: ConsumerRoute): boolean {
	return (
		before.version !== null &&
		after.version !== null &&
		after.version > before.version &&
		upstreamTargets(before) !== upstreamTargets(after)
	);
}

function providerKey(provider: ServiceProvider): string {
	return JSON.stringify([
		provider.targetPort,
		[...provider.allowedClientFingerprints].sort(),
		provider.clientAuth ?? 'pinned',
		[...(provider.allowedClientNodeIds ?? [])].sort(),
	]);
}

/** Node ids named by `yoal://node/<id>` URI SANs in a peer certificate. */
export function certificateNodeIds(certificate: Pick<PeerCertificate, 'subjectaltname'> | undefined): string[] {
	const names = certificate?.subjectaltname ?? '';
	const ids: string[] = [];
	for (const part of names.split(',')) {
		const match = /^\s*URI:yoal:\/\/node\/([^\s,]+)\s*$/.exec(part);
		if (match) ids.push(match[1]!);
	}
	return ids;
}

/** Lowercase hex without leading zeros, so `0A1B` and `a1b` compare equal. */
export function normalizeSerial(value: string): string {
	return value.replaceAll(':', '').toLowerCase().replace(/^0+(?=.)/, '');
}

function normalizeFingerprint(value: string): string {
	return value.replaceAll(':', '').toLowerCase();
}

function closeServer(server: Server): void {
	try {
		server.close();
	} catch {
		// A listener that never bound has nothing to close.
	}
}
