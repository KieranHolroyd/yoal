import * as z from 'zod';

/**
 * Cross-node service endpoints (docs/CLUSTERING.md §4.3, phase C2).
 *
 * A consumer node owns one stable loopback port per attached remote service. The provider node
 * exposes only its loopback port over the overlay, behind mTLS and a per-attachment firewall
 * grant. Failover changes the endpoint's upstream, not the consumer's environment.
 */

export const serviceKinds = ['database', 'storage'] as const;
export type ServiceKind = (typeof serviceKinds)[number];

export const endpointPortRange = { min: 21_000, max: 21_999 } as const;
/**
 * Consumer-side loopback ports for stable read URLs (`<P>_READ_URL`, CLUSTERING §9.2) and other
 * read endpoints (HA-PLAN H24). Reserved now, allocated by nothing yet. CLUSTERING first gave
 * reads 22000–22999, which D226 handed to Kubernetes clusters (HA-PLAN F2).
 */
export const readEndpointPortRange = { min: 23_000, max: 23_999 } as const;

/**
 * The agent capability for HA-PLAN H24 (`ENDPOINTS_GATEWAY`): the forwarder also listens on the
 * container gateway address, units take `AddHost` entries, `pool`/`read`/`read-pool` endpoints and
 * install-CA trust. The fields below that carry this behaviour are rendered only to a node that
 * advertises it (`packages/core/src/capability-gate.ts`).
 */
export const ENDPOINTS_GATEWAY_CAPABILITY = 'endpoints-gateway';

/**
 * What an endpoint leads to. `primary` (absent on the wire) is today's database or storage
 * attachment; `pool` is the database's PgBouncer (`<P>_POOL_URL`); `read` and `read-pool` follow a
 * read replica set (`<P>_READ_URL`, `<P>_READ_POOL_URL`). `primary` and `pool` take ports from
 * `endpointPortRange`, `read` and `read-pool` from `readEndpointPortRange` (HA-PLAN H24 "Ports").
 */
export const endpointRoles = ['primary', 'pool', 'read', 'read-pool'] as const;
export type EndpointRole = (typeof endpointRoles)[number];
export const primaryEndpointRoles = ['primary', 'pool'] as const;
export const readEndpointRoles = ['read', 'read-pool'] as const;

/** The port range an endpoint of `role` is allocated from. */
export function endpointPortRangeFor(role: EndpointRole): { min: number; max: number } {
	return role === 'read' || role === 'read-pool' ? readEndpointPortRange : endpointPortRange;
}

/**
 * A container gateway address the forwarder also binds (`10.89.0.1` on Podman's default network).
 * IPv4 only, like the overlay and the nftables rules that guard it.
 */
export const gatewayAddressSchema = z.ipv4();

/**
 * How a consumer checks the provider's certificate. `pinned` (absent) is today's SHA-256 pin in
 * `tlsFingerprint`; `install-ca` verifies the chain against `nodeTrust.caBundlePem` and the peer's
 * URI SAN `yoal://node/<upstream.nodeId>` (HA-PLAN H24 "Trust", CLUSTERING §4.3).
 */
export const endpointTrustModes = ['pinned', 'install-ca'] as const;
export type EndpointTrustMode = (typeof endpointTrustModes)[number];

/**
 * The trust mode for one provider listener and the consumers it allows, in a mixed-version fleet.
 * `install-ca` only when the provider **and every node in its `allowedClientNodeIds`** advertise
 * `endpoints-gateway`; otherwise both sides stay `pinned` (fingerprints, as in C2). A provider
 * takes one client-auth mode per listener, so a single older consumer keeps the whole listener
 * pinned; every consumer endpoint of that provider uses the provider's mode as its `trust`. Lane B
 * calls this when it renders `serviceProviders[].clientAuth` and `serviceEndpoints[].trust`; the
 * pinned fingerprints are rendered in both modes, so a downgrade needs no re-pinning.
 */
export function endpointTrustMode(
	provider: { capabilities: readonly string[] },
	consumers: readonly { capabilities: readonly string[] }[],
): EndpointTrustMode {
	const capable = (node: { capabilities: readonly string[] }) => node.capabilities.includes(ENDPOINTS_GATEWAY_CAPABILITY);
	return capable(provider) && consumers.every(capable) ? 'install-ca' : 'pinned';
}

export const serviceEndpointSchema = z.object({
	id: z.string().min(1).max(100),
	kind: z.enum(serviceKinds),
	serviceId: z.string().min(1).max(100),
	/** Consumer-side loopback port; stable across a provider move. */
	localPort: z.number().int().min(endpointPortRange.min).max(endpointPortRange.max),
	upstream: z.object({
		nodeId: z.string().min(1).max(100),
		/** Provider overlay address; null until the overlay address is known. */
		address: z.string().max(64).nullable().default(null),
		port: z.number().int().min(1).max(65_535),
	}),
	/** SHA-256 of the provider leaf certificate, for the consumer's mTLS pin. */
	tlsFingerprint: z.string().max(128).nullable().default(null),
	/**
	 * `endpoints-gateway` only. Absent means `primary`. Only the primary-range roles are valid here;
	 * read endpoints live in `readEndpoints`, because an older agent would refuse their ports.
	 */
	role: z.enum(primaryEndpointRoles).optional(),
	/**
	 * `endpoints-gateway` only: also listen on this container gateway address, same port, so a
	 * container reaches the endpoint as `db-<id>:<localPort>` through its `AddHost` entry.
	 */
	gatewayAddress: gatewayAddressSchema.optional(),
	/** `endpoints-gateway` only. Absent means `pinned`. Always the provider's mode (`endpointTrustMode`). */
	trust: z.enum(endpointTrustModes).optional(),
	/**
	 * `endpoints-gateway` only: bumps on every re-point of the upstream (CLUSTERING §13.5), so the
	 * agent can tell a failover from a restart. `localPort` never changes with it.
	 */
	version: z.number().int().nonnegative().optional(),
});
export type ServiceEndpoint = z.infer<typeof serviceEndpointSchema>;

/**
 * A read endpoint on the consumer node (HA-PLAN H24, CLUSTERING §9.2): a stable loopback port in
 * `readEndpointPortRange` that follows a database's read replicas. A new desired-state list rather
 * than `serviceEndpoints` entries, so an agent without `endpoints-gateway` never sees one.
 */
export const readEndpointSchema = z.object({
	id: z.string().min(1).max(100),
	kind: z.literal('database'),
	/** The database id. */
	serviceId: z.string().min(1).max(100),
	role: z.enum(readEndpointRoles),
	localPort: z.number().int().min(readEndpointPortRange.min).max(readEndpointPortRange.max),
	/** Every healthy replica the forwarder may balance over; at least one, the primary as a fallback last. */
	upstreams: z
		.array(
			z.object({
				nodeId: z.string().min(1).max(100),
				address: z.string().max(64).nullable().default(null),
				port: z.number().int().min(1).max(65_535),
			}),
		)
		.min(1)
		.max(8),
	gatewayAddress: gatewayAddressSchema.optional(),
	trust: z.enum(endpointTrustModes).default('install-ca'),
	tlsFingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8).optional(),
	version: z.number().int().nonnegative().default(0),
});
export type ReadEndpoint = z.infer<typeof readEndpointSchema>;

/**
 * One `AddHost=<host>:<address>` line on a container unit (HA-PLAN H24): `db-<id>` resolves to
 * the node's container gateway, where the endpoint forwarder listens, wherever the database runs.
 * Structured fields only; the helper validates both again and writes the Quadlet line itself.
 */
export const containerAddHostSchema = z.object({
	host: z
		.string()
		.min(1)
		.max(63)
		.regex(/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/, 'Use a single lowercase DNS label, e.g. db-<id>.'),
	address: gatewayAddressSchema,
});
export type ContainerAddHost = z.infer<typeof containerAddHostSchema>;

/** The `AddHost` name a container uses for a database (`NetworkAlias` on its own network today). */
export function databaseHostAlias(databaseId: string): string {
	return `db-${databaseId}`;
}

/** A public node certificate stored by the control plane; the private key never arrives here. */
export const nodeCertificateSchema = z.object({
	nodeId: z.string().min(1).max(100),
	serial: z.string().min(1).max(100),
	certPem: z.string().min(1).max(16_384),
	caSerial: z.string().max(100).nullable().default(null),
	issuedAt: z.string().max(40),
	expiresAt: z.string().max(40),
	revokedAt: z.string().max(40).nullable().default(null),
});
export type NodeCertificate = z.infer<typeof nodeCertificateSchema>;

/** Provider-side listener: one overlay port forwarding to a local loopback service (C2). */
export const serviceProviderSchema = z.object({
	id: z.string().min(1).max(100),
	listenAddress: z.string().min(1).max(64),
	listenPort: z.number().int().min(1).max(65_535),
	targetPort: z.number().int().min(1).max(65_535),
	/** SHA-256 fingerprints of consumer node certificates allowed to connect (pinned mTLS). */
	allowedClientFingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(64).default([]),
	/**
	 * `endpoints-gateway` only. Absent means `pinned` (the fingerprints above). With `install-ca` the
	 * listener requires a client certificate that chains to `nodeTrust.caBundlePem`, is not in
	 * `nodeTrust.revokedSerials`, and names one of `allowedClientNodeIds`; nftables still allows
	 * only those consumers' overlay addresses (CLUSTERING §4.3). Set it to `install-ca` only when
	 * `endpointTrustMode` says so: the provider and every allowed consumer advertise
	 * `endpoints-gateway`. Keep `allowedClientFingerprints` filled either way.
	 */
	clientAuth: z.enum(endpointTrustModes).optional(),
	allowedClientNodeIds: z.array(z.string().min(1).max(100)).max(64).optional(),
});
export type ServiceProvider = z.infer<typeof serviceProviderSchema>;

/** The node's public certificate plus its pinned fingerprint (C2 interim identity). */
export const nodeIdentityCertificateSchema = z.object({
	certPem: z.string().min(1).max(16_384),
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	expiresAt: z.string().max(40),
});
export type NodeIdentityCertificate = z.infer<typeof nodeIdentityCertificateSchema>;
