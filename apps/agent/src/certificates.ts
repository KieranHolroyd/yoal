import { randomUUID } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
	ACME_CHALLENGE_PATH,
	type CertificateActivation,
	type CertificateActivationEntry,
	type CertificateRelay,
	certificateActivationSchema,
	certificateFleetFingerprint,
	normalizeCertificateHost,
} from '@yoal/contracts';

/**
 * Shared-certificate delivery on an ingress (HA-PLAN H20, W7).
 *
 * The control plane issues once under the ACME lease and seals the pair; this node fetches the
 * activation over its node token, caches it on disk (0600, root only) and serves the pair to Caddy
 * through the standard `get_certificate http` manager — at handshake time, so a renewal swaps the
 * certificate without reloading the config or closing keep-alive connections (S4, `B-hot`).
 *
 * With `SHARED_CERTIFICATES` off the control plane returns an empty activation, `manager()` is
 * null, and the compiled config is today's per-node ACME.
 */
export interface CertificateDeliveryOptions {
	controlUrl: string;
	nodeToken: string;
	dataDir: string;
	/** Injected for tests; production uses the global fetch. */
	fetch?: typeof fetch;
	now?: () => number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** How often a desired-state change may trigger a fetch (default 30 s). */
	minRefreshMs?: number;
}

interface CachedActivation {
	generation: number;
	fingerprint: string | null;
	certificates: CertificateActivationEntry[];
	relays: CertificateRelay[];
}

const CACHE_FILE = 'activation.json';
const MIN_REFRESH_MS = 30_000;
/** The periodic refresh CLUSTERING §7.3 sets: a certificate that changes with no state bump. */
export const CERTIFICATE_REFRESH_MS = 6 * 3_600_000;

export class CertificateDelivery {
	private readonly directory: string;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly minRefreshMs: number;
	private activation: CachedActivation | null = null;
	private lastFetchAt = 0;
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly token: string;
	private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;

	constructor(private readonly options: CertificateDeliveryOptions) {
		this.directory = join(options.dataDir, 'certificates');
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.minRefreshMs = options.minRefreshMs ?? MIN_REFRESH_MS;
		this.log = options.log ?? (() => undefined);
		this.token = randomUUID().replace(/-/g, '');
		this.activation = this.readCache();
	}

	/** The current fingerprint, exactly as the control plane computes it. */
	fingerprint(): string | null {
		if (!this.activation || this.activation.certificates.length === 0) return null;
		return certificateFleetFingerprint(
			this.activation.certificates.map((entry) => ({ host: entry.host, fingerprint: entry.fingerprint })),
		);
	}

	/** What Caddy's `get_certificate` policy needs, or null for today's per-node issuance. */
	manager(): { url: string; subjects: string[] } | null {
		if (!this.activation || this.activation.certificates.length === 0) return null;
		this.startServer();
		const address = this.server;
		if (!address) return null;
		const subjects = this.activation.certificates.map((entry) => entry.host);
		return { url: `http://127.0.0.1:${address.port}/pair?token=${this.token}`, subjects };
	}

	/** Hosts whose ACME challenge this node relays to the lease holder, over the overlay. */
	relays(): CertificateRelay[] {
		return this.activation?.relays ?? [];
	}

	/** The hosts this node has been told to serve (for the health reason and metrics). */
	hosts(): string[] {
		return this.activation?.certificates.map((entry) => entry.host) ?? [];
	}

	/**
	 * Fetch when due. Called after every desired-state change and from the start-up path: a
	 * certificate change bumps the desired-state version, so convergence is what wakes a node.
	 */
	async ensureFresh(): Promise<boolean> {
		const now = this.now();
		// A certificate change bumps desired state, which wakes the long-poll; this cap keeps a
		// stream of unrelated reconciles from turning into a fetch loop.
		if (this.lastFetchAt !== 0 && now - this.lastFetchAt < this.minRefreshMs) return false;
		return this.refresh();
	}

	/** One activation fetch. Returns true when what this node serves changed. */
	async refresh(): Promise<boolean> {
		this.lastFetchAt = this.now();
		const response = await this.fetchImpl(`${this.options.controlUrl}/api/agent/certificates/activation`, {
			headers: { authorization: `Bearer ${this.options.nodeToken}`, accept: 'application/json' },
		});
		if (!response.ok) throw new Error(`certificates/activation -> ${response.status}`);
		const parsed = certificateActivationSchema.safeParse(await response.json());
		if (!parsed.success) throw new Error(`certificates/activation failed validation: ${parsed.error.message}`);
		const next: CachedActivation = {
			generation: parsed.data.generation,
			fingerprint: parsed.data.fingerprint,
			certificates: parsed.data.certificates,
			relays: parsed.data.relays,
		};
		const changed = this.changed(next);
		this.activation = next;
		if (changed) {
			this.writeCache(next);
			this.writePairs(next.certificates);
			if (next.certificates.length === 0) {
				this.server?.stop(true);
				this.server = null;
			}
			this.log(
				'info',
				next.certificates.length === 0
					? 'Shared certificates: none delivered (per-node issuance stays in force)'
					: `Shared certificates: generation ${next.generation}, ${next.certificates.length} hosts, fingerprint ${next.fingerprint}`,
			);
			this.startServer();
		}
		return changed;
	}

	close(): void {
		this.server?.stop(true);
		this.server = null;
	}

	// ------------------------------------------------------------------ internals

	private changed(next: CachedActivation): boolean {
		const current = this.activation;
		if (!current) return next.generation !== 0 || next.certificates.length > 0 || next.relays.length > 0;
		return (
			current.generation !== next.generation ||
			current.fingerprint !== next.fingerprint ||
			current.certificates.length !== next.certificates.length ||
			current.relays.length !== next.relays.length
		);
	}

	private startServer(): void {
		if (this.server || !this.activation || this.activation.certificates.length === 0) return;
		this.server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: (request) => this.servePair(request),
		});
	}

	/** Caddy's manager: `?server_name=<SNI>&token=<token>`, a PEM chain plus the key, or 404. */
	private servePair(request: Request): Response {
		const url = new URL(request.url);
		if (url.pathname !== '/pair') return new Response('not found', { status: 404 });
		if (url.searchParams.get('token') !== this.token) return new Response('forbidden', { status: 403 });
		const servername = normalizeCertificateHost(url.searchParams.get('server_name') ?? '');
		const entry = this.activation?.certificates.find(
			(candidate) =>
				candidate.host === servername ||
				(candidate.host.startsWith('*.') && hostMatchesWildcard(servername, candidate.host)),
		);
		if (!entry) return new Response('no certificate for that name', { status: 404 });
		return new Response(`${entry.chainPem.trim()}\n${entry.keyPem.trim()}\n`, {
			status: 200,
			headers: { 'content-type': 'application/x-pem-file', 'cache-control': 'no-store' },
		});
	}

	private readCache(): CachedActivation | null {
		const path = join(this.directory, CACHE_FILE);
		if (!existsSync(path)) return null;
		try {
			const parsed = certificateActivationSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
			if (!parsed.success) return null;
			return {
				generation: parsed.data.generation,
				fingerprint: parsed.data.fingerprint,
				certificates: parsed.data.certificates,
				relays: parsed.data.relays,
			};
		} catch {
			return null;
		}
	}

	/** Atomic cache write; 0600 because it carries the private keys (the agent runs as root). */
	private writeCache(activation: CachedActivation): void {
		try {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			const path = join(this.directory, CACHE_FILE);
			const temporary = `${path}.${process.pid}.tmp`;
			writeFileSync(temporary, JSON.stringify(activation), { mode: 0o600 });
			renameSync(temporary, path);
			chmodSync(path, 0o600);
		} catch (error) {
			this.log('warn', `Could not cache the shared certificates: ${(error as Error).message}`);
		}
	}

	/** One readable pair per host, 0640, for an operator inspecting the node (never Caddy). */
	private writePairs(entries: readonly CertificateActivationEntry[]): void {
		try {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			for (const entry of entries) {
				const safe = entry.host.replace(/[^a-z0-9.-]/gi, '_');
				const certPath = join(this.directory, `${safe}.pem`);
				const keyPath = join(this.directory, `${safe}.key`);
				writeFileSync(certPath, entry.chainPem.trim() + '\n', { mode: 0o640 });
				writeFileSync(keyPath, entry.keyPem.trim() + '\n', { mode: 0o640 });
				chmodSync(certPath, 0o640);
				chmodSync(keyPath, 0o640);
			}
			// A host that left the fleet must not leave its private key on this node.
			const keep = new Set(entries.map((entry) => entry.host.replace(/[^a-z0-9.-]/gi, '_')));
			for (const name of readdirSync(this.directory)) {
				const match = /^(.+)\.(pem|key)$/.exec(name);
				if (match && !keep.has(match[1]!)) rmSync(join(this.directory, name), { force: true });
			}
		} catch (error) {
			this.log('warn', `Could not write the shared certificate files: ${(error as Error).message}`);
		}
	}
}

function hostMatchesWildcard(host: string, wildcard: string): boolean {
	const suffix = wildcard.slice(1);
	return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes('.');
}

/** The path Caddy matches for a relay route; exported so the compiler and tests agree. */
export const ACME_RELAY_PATH_MATCH = `${ACME_CHALLENGE_PATH}*`;

/** The manager policy Caddy needs: get_certificate http, plus a dead-end issuer so no public CA is tried. */
export function certificateManagerPolicy(manager: { url: string; subjects: string[] }): Record<string, unknown> {
	return {
		subjects: manager.subjects,
		get_certificate: [{ via: 'http', url: manager.url }],
		// A manager supplies the certificate; if it cannot, fail the handshake rather than fall back
		// to a public CA (S4's incident: a policy without an issuer reached Let's Encrypt and ZeroSSL).
		issuers: [{ module: 'acme', ca: 'https://127.0.0.1:9/no-issuance-here' }],
	};
}
