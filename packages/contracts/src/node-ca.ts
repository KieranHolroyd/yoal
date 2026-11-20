import * as z from 'zod';

/**
 * The per-install certificate authority (HA-PLAN H24 "Trust", CLUSTERING §4.3; Wave 1 lanes A
 * and B).
 *
 * One CA per install issues every node a leaf certificate (CN = node id, URI SAN
 * `yoal://node/<id>`, 90 days). The node generates its key pair itself and sends only a CSR, at
 * enrolment (`nodeJoinSchema.csrPem`) or in a heartbeat (`nodeCsrSchema`); the private key never
 * leaves the node. The CA's private key is sealed with the master key in `node_ca`. Desired state
 * carries only public material (`nodeTrustDesiredSchema`): the CA bundle, this node's signed
 * certificate and the revoked serials.
 *
 * This replaces the pinned self-signed fingerprints of C2 (`tlsFingerprint`,
 * `allowedClientFingerprints`), so adding a node does not mean re-pinning every peer.
 */

/** Leaf lifetime and when a node asks for a new one. */
export const NODE_CERT_VALIDITY_DAYS = 90;
export const NODE_CERT_RENEW_BEFORE_DAYS = 30;
/** The install CA's own lifetime; rotation overlaps two CAs in `caBundlePem`. */
export const NODE_CA_VALIDITY_DAYS = 3_650;
/** At most this many CAs are trusted at once (current plus the one being rotated in or out). */
export const NODE_CA_BUNDLE_MAX = 3;

/** The URI SAN that names a node in its leaf; verification matches on it, not on the CN. */
export function nodeCertificateUri(nodeId: string): string {
	return `yoal://node/${nodeId}`;
}

const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/;
const PEM_CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g;
const PEM_CSR = /^-----BEGIN CERTIFICATE REQUEST-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE REQUEST-----\r?\n?$/;

/** Rejects anything that looks like a private key, wherever it appears. */
const noPrivateKey = (value: string) => !/PRIVATE KEY/.test(value);

/** One PEM certificate (public material only). */
export const pemCertificateSchema = z
	.string()
	.max(16_384)
	.refine(noPrivateKey, 'A certificate must not contain a private key.')
	.refine((value) => PEM_CERTIFICATE.test(value), 'Give one PEM certificate.');

/** One to `NODE_CA_BUNDLE_MAX` concatenated PEM certificates, nothing else. */
export const pemCertificateBundleSchema = z
	.string()
	.max(16_384 * NODE_CA_BUNDLE_MAX)
	.refine(noPrivateKey, 'A CA bundle must not contain a private key.')
	.refine((value) => {
		const blocks = value.match(PEM_CERTIFICATE_BLOCK) ?? [];
		if (blocks.length < 1 || blocks.length > NODE_CA_BUNDLE_MAX) return false;
		return value.replace(PEM_CERTIFICATE_BLOCK, '').trim() === '';
	}, `Give 1–${NODE_CA_BUNDLE_MAX} PEM certificates and nothing else.`);

/** A PKCS#10 certificate signing request in PEM. */
export const pemCsrSchema = z
	.string()
	.max(16_384)
	.refine(noPrivateKey, 'A CSR must not contain a private key.')
	.refine((value) => PEM_CSR.test(value), 'Give one PEM certificate signing request.');

/** Certificate serials as lowercase hex, as the CA issues them. */
export const certificateSerialSchema = z.string().regex(/^[a-f0-9]{2,64}$/, 'Serials are lowercase hex.');

/**
 * `nodeTrust` in desired state, rendered only to a node that advertises `endpoints-gateway`.
 * Public material only: no key of any kind ever travels here (HA-PLAN §10).
 */
export const nodeTrustDesiredSchema = z.object({
	/** Bumps whenever any field below changes, so the agent reloads its listeners once. */
	generation: z.number().int().nonnegative(),
	/** Every CA the node trusts for peers: the current one, plus the other during a rotation. */
	caBundlePem: pemCertificateBundleSchema,
	/** This node's leaf, signed by the CA from its CSR; null until the first CSR is signed. */
	certificatePem: pemCertificateSchema.nullable().default(null),
	serial: certificateSerialSchema.nullable().default(null),
	/** ISO 8601. */
	notAfter: z.string().max(40).nullable().default(null),
	/** Serials no listener may accept, even though they chain to the CA (node removed or re-keyed). */
	revokedSerials: z.array(certificateSerialSchema).max(1_000).default([]),
});
export type NodeTrustDesired = z.infer<typeof nodeTrustDesiredSchema>;

/** Why a node sends a CSR. */
export const nodeCsrReasons = ['enrol', 'renew', 'rekey'] as const;
export type NodeCsrReason = (typeof nodeCsrReasons)[number];

/**
 * A CSR in a heartbeat (`heartbeatSchema.nodeCsr`). Sent while the node has no valid leaf, or
 * within `NODE_CERT_RENEW_BEFORE_DAYS` of `notAfter`, until desired state carries a certificate
 * whose public key matches. The control plane signs only a CSR whose subject is the authenticated
 * node's own id.
 */
export const nodeCsrSchema = z.object({
	csrPem: pemCsrSchema,
	reason: z.enum(nodeCsrReasons),
});
export type NodeCsr = z.infer<typeof nodeCsrSchema>;

/** The install CA as views show it: public fields only. */
export const nodeCaViewSchema = z.object({
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	subject: z.string().max(500),
	notBefore: z.string(),
	notAfter: z.string(),
	/** `active` signs new leaves; `previous` is still trusted during a rotation. */
	state: z.enum(['active', 'previous', 'retired']),
	createdAt: z.string(),
});
export type NodeCaView = z.infer<typeof nodeCaViewSchema>;

/** One issued leaf, as views show it. */
export const issuedNodeCertificateViewSchema = z.object({
	nodeId: z.string(),
	serial: certificateSerialSchema,
	notAfter: z.string(),
	issuedAt: z.string(),
	revokedAt: z.string().nullable(),
});
export type IssuedNodeCertificateView = z.infer<typeof issuedNodeCertificateViewSchema>;
