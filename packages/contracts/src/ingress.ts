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
		healthPort: z.number().int().min(1).max(65_535).nullable().default(null),
	})
	.strict();

export type IngressSettings = z.infer<typeof ingressSettingsSchema>;

/**
 * The ingress settings as desired state carries them to one node (HA-PLAN H19, W8). The settings
 * are additive: an older control plane sends no `ingress` at all and the agent keeps today's
 * behaviour. `certificateFingerprint` is lane B's fleet fingerprint; null (or absent) means the
 * node does not verify certificates, which is exactly the single-node path.
 */
export const ingressDesiredSchema = ingressSettingsSchema.extend({
	certificateFingerprint: z.string().min(1).max(128).nullable().default(null),
});
export type IngressDesired = z.infer<typeof ingressDesiredSchema>;

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
}

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

export const ingressHealthSchema = z.object({
	status: z.enum(['ok', 'draining', 'unready']),
	reason: z.enum(['caddy', 'desired-state', 'releases', 'certificates']).nullable(),
	desiredStateVersion: z.number().int().nonnegative().nullable(),
	appliedStateVersion: z.number().int().nonnegative().nullable(),
	certificateFingerprint: z.string().max(128).nullable(),
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
