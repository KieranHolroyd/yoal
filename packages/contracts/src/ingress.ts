import { createHash } from 'node:crypto';
import * as z from 'zod';

/** Ingress high availability drivers and health policy (docs/CLUSTERING.md §7.2, C5). */
export const ingressDrivers = ['direct', 'dns-failover', 'cloudflare-lb', 'cloudflare-tunnel'] as const;
export type IngressDriver = (typeof ingressDrivers)[number];
export const ingressDriverSchema = z.enum(ingressDrivers);

export const ingressHealthPolicySchema = z.object({
	/** Serve a failed node out after this many consecutive failed probes. */
	holdDownMs: z.number().int().min(5_000).max(600_000).default(45_000),
	/** Add a recovered node back only after this long healthy. */
	readdHoldDownMs: z.number().int().min(10_000).max(3_600_000).default(120_000),
	/** Never remove the last healthy record. */
	minHealthy: z.number().int().min(1).max(10).default(1),
});
export type IngressHealthPolicy = z.infer<typeof ingressHealthPolicySchema>;

export interface IngressObservation {
	nodeId: string;
	ok: boolean;
	at: number;
}

export interface IngressHealthDecision {
	/** Nodes that should be withdrawn from DNS. */
	remove: string[];
	/** Nodes that should be added back. */
	add: string[];
	/** Nodes currently healthy and kept. */
	keep: string[];
}

// ---------------------------------------------------------------- ingress set (HA-PLAN H17–H20, W2)

/** The `ingress-set` capability: an agent that serves the full edge payload and the health endpoint. */
export const INGRESS_SET_CAPABILITY = 'ingress-set';

/** A CIDR range Caddy's `trusted_proxies` and the PROXY wrapper accept (IPv4 or IPv6). */
export const CIDR_RANGE =
	/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(?:3[0-2]|[12]?\d)|[0-9a-fA-F:]+\/(?:12[0-8]|1[01]\d|[1-9]?\d))$/;
export const cidrSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(CIDR_RANGE, 'must be a CIDR range');

export const ingressSettingsSchema = z
	.object({
		/** How long a draining ingress answers 503 before Caddy stops (H19). */
		drainSeconds: z.number().int().min(0).max(120).default(20),
		/** The listener wrapper for a balancer in front (H19). */
		proxyProtocol: z.enum(['off', 'v1', 'v2']).default('off'),
		/** CIDRs whose forwarded client address is trusted. Empty means none. */
		trustedProxies: z.array(cidrSchema).max(32).default([]),
		/** The plain HTTP port for L4 balancers (H19); null uses the reserved default. */
		healthPort: z.number().int().min(1_024).max(65_535).nullable().default(null),
	})
	.strict();

export type IngressSettings = z.infer<typeof ingressSettingsSchema>;

/** `GET /.well-known/yoal/health` on every ingress, for any Host (HA-PLAN H19). */
export const INGRESS_HEALTH_PATH = '/.well-known/yoal/health';
/**
 * The reserved plain-HTTP listener an L4 balancer probes (H19). Chosen in spike S9 and recorded in
 * the host-port registry; `ingress.healthPort` overrides it.
 */
export const INGRESS_HEALTH_PORT = 8099;
/**
 * An ingress whose routes trail desired state by more than this is unready (CLUSTERING §7.1,
 * "behind for 2 minutes"). Inside the window it keeps taking traffic: a reload is not an outage.
 */
export const INGRESS_DRIFT_WINDOW_MS = 120_000;

/**
 * The one-word answers the endpoint may give. Constant-size on the wire (the agent pads to 16
 * bytes), so a probe learns readiness and nothing about the fleet (HA-PLAN §10).
 */
export const ingressHealthWords = {
	ok: 'ok',
	draining: 'draining',
	caddy: 'caddy',
	'desired-state': 'desired-state',
	releases: 'releases',
	certificates: 'certificates',
} as const;
export type IngressHealthWord = (typeof ingressHealthWords)[keyof typeof ingressHealthWords];

/** One node that terminates ingress. The payload is the same on every member. */
export interface IngressNodeView {
	id: string;
	name: string;
	zone: string;
	status: string;
	/** True for the compatibility "first ingress" (`mode: 'edge'` / configured id). */
	first: boolean;
	capable: boolean;
	certificateFingerprint: string | null;
	/** The desired-state version this node last reported applying (`actualStateVersion`). */
	actualStateVersion: number | null;
	/** Behind the fleet's version for the drift window (CLUSTERING §7.1). */
	drifted: boolean;
}

/**
 * The public listener and TLS settings every ingress renders (HA-PLAN H17/G5). Rendered only for a
 * node in the ingress set, so a worker that gains the `ingress` role converges from desired state
 * instead of a hand-edited env file. Non-secret: the ACME email is public, the token is not.
 */
export const ingressDesiredSchema = ingressSettingsSchema
	.extend({
		/** The fleet certificate fingerprint this node verifies (H20); null means it does not. */
		certificateFingerprint: z.string().min(1).max(128).nullable().default(null),
		/** Extra Caddy listeners for public traffic. The node's existing listen addresses stay. */
		listeners: z.array(z.string().min(1).max(128)).max(8).default([]),
		/** Terminate TLS with ACME. Null keeps today's env-driven behaviour. */
		tls: z
			.object({
				email: z.string().min(3).max(320),
				ca: z.string().url().max(512).optional(),
			})
			.nullable()
			.default(null),
		/**
		 * The platform dashboard/API route (`control.<domain>`). Until W9's upstream list, a control
		 * node dials its own socket and any other ingress relays to the first ingress over HTTPS.
		 */
		platform: z
			.object({
				host: z.string().min(1).max(253),
				upstream: z.string().min(1).max(512),
			})
			.nullable()
			.default(null),
		/**
		 * Control-node upstreams for the platform route (HA-PLAN H21, W9). Rendered only while
		 * `CONTROL_STANDBY` is on. The node's own socket is first, then peers; Caddy health-checks
		 * `/readyz` with `lb_policy first`, so a fenced or dead primary is skipped. Absent with the
		 * flag off, which keeps a single-node payload byte-identical.
		 */
		platformUpstreams: z
			.array(
				z.object({
					nodeId: z.string().min(1).max(64),
					/** `unix//run/yoal/control.sock` or `https://<address>`. */
					upstream: z.string().min(1).max(512),
					priority: z.number().int().min(0).max(100).default(0),
				}),
			)
			.max(8)
			.optional(),
	})
	.strict();

export type IngressDesired = z.infer<typeof ingressDesiredSchema>;

/**
 * Secrets an ingress fetches from the node-authenticated activation endpoint (HA-PLAN H20, G8).
 * Never part of desired state, a log line or an audit argument; the agent caches them 0600 under
 * its data directory so a restart does not need a control-plane round trip before serving.
 */
export const ingressActivationSchema = z.object({
	/** Null until the control plane has YOAL_ACCESS_JWT_SECRET (the installer writes it). */
	accessJwtSecret: z.string().min(1).max(512).nullable(),
	siteCookieSecret: z.string().min(1).max(512),
	/** The ACME DNS-01 token, when the install uses DNS-01. Null for HTTP-01 or no TLS. */
	cloudflareApiToken: z.string().min(1).max(512).nullable(),
});

export type IngressActivation = z.infer<typeof ingressActivationSchema>;

/**
 * Steering driver kinds (HA-PLAN H18). `ingressDrivers` above is the C5 subset already shipped
 * (`dns-failover`, `cloudflare-lb`, `cloudflare-tunnel`); these are the Wave 2 contract's drivers.
 */
export const steeringDriverKinds = [
	'direct',
	'external-lb',
	'dns-failover',
	'vip',
	'cloud-lb',
	'cloudflare-tunnel',
	'webhook',
] as const;

export type SteeringDriverKind = (typeof steeringDriverKinds)[number];

export interface SteeringCapabilities {
	probes: 'yoal' | 'external' | 'none';
	writes: boolean;
	preservesClientIp: 'native' | 'proxy-protocol' | 'header';
}

/** One driver, declared once so the UI, preflight and the controller agree. */
export interface SteeringDriver {
	kind: SteeringDriverKind;
	capabilities: SteeringCapabilities;
	/** Refuses to enable, with one reason per node. */
	preflight(): Array<{ nodeId: string | null; reason: string }>;
	/** Idempotent, called under the controller lease. */
	desired(): Promise<void>;
	/** What the provider currently has. */
	observe(): Promise<Record<string, unknown>>;
}

export interface IngressSetView {
	nodes: IngressNodeView[];
	settings: IngressSettings;
	steering: { kind: SteeringDriverKind; stacked: SteeringDriverKind[] };
}

/** `GET /.well-known/yoal/health` (H19): 200 only when every condition holds. */
export interface IngressHealth {
	status: 'ok' | 'draining' | 'unready';
	reason: 'caddy' | 'desired-state' | 'releases' | 'certificates' | null;
	desiredStateVersion: number | null;
	appliedStateVersion: number | null;
	certificateFingerprint: string | null;
}

export const ingressHealthSchema = z
	.object({
		status: z.enum(['ok', 'draining', 'unready']),
		reason: z.enum(['caddy', 'desired-state', 'releases', 'certificates']).nullable(),
		desiredStateVersion: z.number().int().nonnegative().nullable(),
		appliedStateVersion: z.number().int().nonnegative().nullable(),
		certificateFingerprint: z.string().max(128).nullable(),
	})
	// An `ok` answer cannot carry a failure reason; the inverse is what the endpoint's one word means.
	.superRefine((value, issue) => {
		if (value.status === 'ok' && value.reason !== null)
			issue.addIssue({ code: 'custom', path: ['reason'], message: 'status ok cannot carry a reason' });
	});

/** One certificate the fleet serves for a host (H20). */
export const ingressCertificateSchema = z.object({
	id: z.string().min(1).max(64),
	host: z.string().min(1).max(253),
	serial: z.string().min(1).max(128),
	fingerprint: z.string().min(1).max(128),
	source: z.enum(['acme', 'byo']),
	notAfter: z.number().int(),
	renewedAt: z.number().int().nullable(),
	revokedAt: z.number().int().nullable(),
	/** Set when an ingress left the fleet: the old node still holds the key, so reissue (H20). */
	reissueRequestedAt: z.number().int().nullable().optional(),
});

export type IngressCertificateView = z.infer<typeof ingressCertificateSchema>;

/** The distributed material for one host: public chain plus the sealed private key reference. */
export interface CertificateBundle {
	host: string;
	fingerprint: string;
	chainPem: string;
	notAfter: number;
	source: 'acme' | 'byo';
}

/** A DNS-01 or HTTP-01 challenge held by one ingress for a host (H20). */
export const acmeLeaseSchema = z.object({
	host: z.string().min(1).max(253),
	nodeId: z.string().min(1).max(64),
	token: z.string().min(1).max(256),
	expiresAt: z.number().int(),
});

export type AcmeLease = z.infer<typeof acmeLeaseSchema>;

// ---------------------------------------------------------------- shared certificates (W7)

/**
 * H20's ACME lease: 600 s TTL, renewed every 120 s (CLUSTERING §7.3). A holder that dies costs one
 * lease TTL, not the certificate: another ingress takes the host on the next sweep.
 */
export const ACME_LEASE_TTL_MS = 600_000;
export const ACME_LEASE_RENEW_MS = 120_000;

/** Renewal starts this far ahead of `not_after` (CLUSTERING §7.3). */
export const CERT_RENEWAL_WINDOW_MS = 30 * 86_400_000;

/** Bring-your-own certificates are never renewed by Yoal; it alerts at each of these. */
export const BYO_EXPIRY_ALERT_DAYS = [30, 14, 3] as const;

/** The path every ingress relays to the ACME holder (H20 item 2). */
export const ACME_CHALLENGE_PATH = '/.well-known/acme-challenge/';

/** DNS-01 providers (H20 item 1). `cloudflare` ships; the rest fill the same interface. */
export const dnsChallengeProviderKinds = ['cloudflare', 'azure-dns', 'route53', 'rfc2136'] as const;
export type DnsChallengeProviderKind = (typeof dnsChallengeProviderKinds)[number];

/** One TXT record a DNS-01 provider presents and later removes. */
export const dnsChallengeRecordSchema = z.object({
	/** The certificate host, e.g. `app.example.com` or `*.example.com`. */
	host: z.string().min(1).max(253),
	/** The record name, e.g. `_acme-challenge.app.example.com`. */
	fqdn: z.string().min(1).max(253),
	/** The TXT value the CA will look up. */
	value: z.string().min(1).max(512),
});
export type DnsChallengeRecord = z.infer<typeof dnsChallengeRecordSchema>;

/** The interface every DNS-01 provider implements (the provider plugins H20 item 1 adds). */
export interface DnsChallengeProvider {
	readonly name: DnsChallengeProviderKind;
	/** Create the TXT record. Throws (so the issuer retries) rather than reporting success falsely. */
	present(record: DnsChallengeRecord): Promise<void>;
	/** Delete exactly this record. Throws so a failed cleanup is visible, never silent (S4). */
	cleanup(record: DnsChallengeRecord): Promise<void>;
	/** Delete stale challenge records for `hosts` older than `olderThanMs`; returns how many went. */
	sweep(hosts: readonly string[], olderThanMs: number): Promise<number>;
}

/** The fingerprint every ingress reports: one value for the whole live set, sorted so order is free. */
export function certificateFleetFingerprint(
	entries: ReadonlyArray<{ host: string; fingerprint: string }>,
): string | null {
	if (entries.length === 0) return null;
	const canonical = entries
		.map((entry) => `${normalizeCertificateHost(entry.host)}=${entry.fingerprint.toLowerCase()}`)
		.sort()
		.join('\n');
	return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Lower-case, strip a trailing dot. A leading `*.` is kept (wildcards are certificate hosts). */
export function normalizeCertificateHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, '');
}

const certificateHostSchema = z
	.string()
	.min(1)
	.max(253)
	.transform(normalizeCertificateHost)
	.refine((host) => /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host), {
		message: 'not a hostname',
	});

/** A PEM pair uploaded by the ACME holder or by an operator (BYO). */
export const certificateUploadSchema = z
	.object({
		host: certificateHostSchema,
		certPem: z.string().min(64).max(1_000_000),
		keyPem: z.string().min(64).max(1_000_000),
	})
	.strict();

export type CertificateUpload = z.infer<typeof certificateUploadSchema>;

/** One certificate as the activation endpoint delivers it. The key never appears in any view. */
export const certificateActivationEntrySchema = z.object({
	host: z.string().min(1).max(253),
	fingerprint: z.string().min(1).max(128),
	chainPem: z.string().min(64).max(1_000_000),
	keyPem: z.string().min(64).max(1_000_000),
	notAfter: z.number().int(),
	source: z.enum(['acme', 'byo']),
});

export type CertificateActivationEntry = z.infer<typeof certificateActivationEntrySchema>;

/** A host whose challenges this node must relay to the lease holder over the overlay. */
export const certificateRelaySchema = z.object({
	host: z.string().min(1).max(253),
	/** `http://<overlay address>:<port>` of the node answering the challenge. */
	upstream: z.string().min(1).max(300),
});

export type CertificateRelay = z.infer<typeof certificateRelaySchema>;

/**
 * The node-authenticated certificate activation (CLUSTERING §7.3 "Distribution"). Fetched by an
 * ingress agent on start, after a desired-state bump and every 6 h; never part of desired state.
 */
export const certificateActivationSchema = z.object({
	generation: z.number().int().nonnegative(),
	/** The fleet fingerprint this set produces; equals the control plane's `fingerprint()`. */
	fingerprint: z.string().max(128).nullable(),
	certificates: z.array(certificateActivationEntrySchema).max(1_000),
	relays: z.array(certificateRelaySchema).max(1_000),
});

export type CertificateActivation = z.infer<typeof certificateActivationSchema>;

/** Where an ingress relays one host's challenges; derived from the live lease. */
export interface CertificateRelayTarget {
	host: string;
	nodeId: string;
	upstream: string;
}
