import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { decrypt, encrypt } from './util.ts';
import type { ControlReplicaState } from './control-standby.ts';

/**
 * The control-standby enrolment ceremony (docs/build-plan/W9-SPEC.md §4.5, CLUSTERING §6.5).
 *
 * The standby generates its own key pair and sends a CSR; the primary signs it with the install CA
 * and delivers, **sealed**, the master key and the allowlisted `yoal.env` values. Nothing about
 * the master key or the secrets ever appears in desired state, a log line or an audit argument.
 *
 * Sealing uses a one-time activation code (192 random bits) shown once on the primary and typed on
 * the standby. The code derives an AES-256-GCM key; the bundle carries its own salt. The operator
 * may alternatively move the recovery kit out of band; that is the same material and the same
 * fingerprint check. Losing the code loses the bundle, and re-running enrolment issues a new one —
 * there is no recovery path from a half-delivered bundle.
 */

/** Non-secret `yoal.env` values the two control nodes must agree on. */
export const CONTROL_CONFIG_KEYS = [
	'YOAL_PLATFORM_ORIGIN',
	'YOAL_CONTENT_DOMAIN',
	'YOAL_EDGE_NODE_ID',
	'YOAL_ACME_EMAIL',
	'YOAL_ACME_CA',
	'YOAL_SMTP_HOST',
	'YOAL_SMTP_PORT',
	'YOAL_SMTP_USER',
	'YOAL_MAIL_DOMAIN',
	'YOAL_ALERT_EMAIL',
] as const;

/**
 * Secrets that must match too. The dashboard cookie secret is what keeps a session valid across a
 * promotion (CLUSTERING §6.4); it is delivered sealed and never hashed into a public field.
 */
export const CONTROL_SECRET_KEYS = [
	'BETTER_AUTH_SECRET',
	'YOAL_SITE_COOKIE_SECRET',
	'YOAL_OBJECT_STORE_SECRET',
	'YOAL_ACCESS_JWT_SECRET',
	'YOAL_CLOUDFLARE_API_TOKEN',
] as const;

export interface ControlConfigEnvelope {
	config: Record<string, string>;
	secrets: Record<string, string>;
}

export interface SealedControlBundle {
	version: 1;
	nodeId: string;
	primaryNodeId: string;
	createdAt: string;
	/** `sha256` of the allowlisted config, stable across both hosts. */
	configDigest: string;
	/** `sha256` of the master key bytes; compared, never the key itself. */
	masterKeyFingerprint: string;
	/** AES-256-GCM deposit, key derived from the activation code with `salt`. */
	salt: string;
	sealed: { ciphertext: string; nonce: string };
}

export interface OpenedControlBundle {
	masterKey: string;
	config: Record<string, string>;
	secrets: Record<string, string>;
}

/** A stable fingerprint of the key bytes. Never log the key or a raw hash of a low-entropy secret. */
export function masterKeyFingerprint(key: Uint8Array): string {
	return createHash('sha256').update(key).digest('hex');
}

/** Canonical JSON (sorted keys, no whitespace) so key order cannot change the digest. */
export function canonicalJson(value: Record<string, unknown>): string {
	const ordered = Object.keys(value)
		.sort()
		.map((key) => [key, value[key]] as const);
	return JSON.stringify(Object.fromEntries(ordered));
}

export function controlConfigDigest(values: Record<string, string | undefined>): string {
	const picked: Record<string, string> = {};
	for (const key of [...CONTROL_CONFIG_KEYS, ...CONTROL_SECRET_KEYS]) {
		const value = values[key];
		if (value !== undefined) picked[key] = value;
	}
	return createHash('sha256').update(canonicalJson(picked)).digest('hex');
}

/** The values the caller would deliver: non-secret keys in the clear, secrets only inside. */
export function controlConfigEnvelope(
	env: Record<string, string | undefined>,
): ControlConfigEnvelope {
	const config: Record<string, string> = {};
	const secrets: Record<string, string> = {};
	for (const key of CONTROL_CONFIG_KEYS) {
		const value = env[key];
		if (value !== undefined) config[key] = value;
	}
	for (const key of CONTROL_SECRET_KEYS) {
		const value = env[key];
		if (value !== undefined) secrets[key] = value;
	}
	return { config, secrets };
}

function deriveActivationKey(code: string, salt: Buffer): Buffer {
	// A human may type the code, so a slow KDF with a per-bundle salt; the code itself is 192 bits.
	return scryptSync(code.normalize('NFKC').trim(), salt, 32);
}

/**
 * Seal the master key and allowlisted config for one standby. Returns the bundle and the one-time
 * code; the caller shows the code once and never stores it.
 */
export function sealControlBundle(input: {
	nodeId: string;
	primaryNodeId: string;
	masterKey: Uint8Array;
	envelope: ControlConfigEnvelope;
	now?: () => number;
	activationCode?: string;
}): { bundle: SealedControlBundle; activationCode: string } {
	const activationCode = input.activationCode ?? randomBytes(24).toString('base64url');
	const salt = randomBytes(16);
	const payload: OpenedControlBundle = {
		masterKey: Buffer.from(input.masterKey).toString('base64'),
		config: input.envelope.config,
		secrets: input.envelope.secrets,
	};
	const sealed = encrypt(deriveActivationKey(activationCode, salt), Buffer.from(JSON.stringify(payload)));
	return {
		bundle: {
			version: 1,
			nodeId: input.nodeId,
			primaryNodeId: input.primaryNodeId,
			createdAt: new Date((input.now ?? Date.now)()).toISOString(),
			configDigest: controlConfigDigest({ ...input.envelope.config, ...input.envelope.secrets }),
			masterKeyFingerprint: masterKeyFingerprint(input.masterKey),
			salt: salt.toString('base64'),
			sealed,
		},
		activationCode,
	};
}

/** Open on the standby. A wrong code fails authentication, never yields a partial payload. */
export function openControlBundle(bundle: SealedControlBundle, activationCode: string): OpenedControlBundle {
	const key = deriveActivationKey(activationCode, Buffer.from(bundle.salt, 'base64'));
	const payload = JSON.parse(new TextDecoder().decode(decrypt(key, bundle.sealed.ciphertext, bundle.sealed.nonce))) as OpenedControlBundle;
	const masterKey = new Uint8Array(Buffer.from(payload.masterKey, 'base64'));
	if (masterKeyFingerprint(masterKey) !== bundle.masterKeyFingerprint)
		throw new Error('The sealed bundle’s master key does not match its fingerprint.');
	if (controlConfigDigest({ ...payload.config, ...payload.secrets }) !== bundle.configDigest)
		throw new Error('The sealed bundle’s config does not match its digest.');
	return payload;
}

/**
 * What enrolment leaves on this host for the promotion check. Mode 0600: it contains fingerprints
 * and digests, not secrets, but it is still host-private.
 */
export interface ControlEnrolmentRecord {
	version: 1;
	nodeId: string;
	primaryNodeId: string;
	masterKeyFingerprint: string;
	configDigest: string;
	/** Replay status written by the restore step; `readControlReplicaStatus` falls back to it. */
	replica: ControlReplicaState;
	enrolledAt: string;
}

export async function readControlEnrolment(path: string): Promise<ControlEnrolmentRecord | null> {
	try {
		const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ControlEnrolmentRecord>;
		if (
			value.version !== 1 ||
			typeof value.nodeId !== 'string' ||
			typeof value.primaryNodeId !== 'string' ||
			typeof value.masterKeyFingerprint !== 'string' ||
			typeof value.configDigest !== 'string'
		)
			return null;
		return value as ControlEnrolmentRecord;
	} catch {
		return null;
	}
}

/** Replay status written by the restore/litestream-follow step, or the enrolment default. */
export async function readControlReplicaStatus(
	path: string,
	fallback: ControlReplicaState = { restored: false, lagSeconds: null, position: null },
): Promise<ControlReplicaState> {
	try {
		const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ControlReplicaState>;
		if (typeof value.restored !== 'boolean') return fallback;
		return {
			restored: value.restored,
			lagSeconds: typeof value.lagSeconds === 'number' && Number.isFinite(value.lagSeconds) ? value.lagSeconds : null,
			position: typeof value.position === 'string' ? value.position : null,
		};
	} catch {
		return fallback;
	}
}
