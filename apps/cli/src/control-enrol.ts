import { createDecipheriv, createHash, scryptSync } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The standby half of control-plane enrolment (docs/build-plan/W9-SPEC.md §4.5, CLUSTERING §6.5).
 *
 * This mirrors `packages/core/src/control-enrolment.ts` (the CLI is published standalone and does
 * not import the server package). The formats must stay byte-compatible: the same AES-256-GCM
 * deposit with a scrypt-derived key, the same canonical config digest and the same fingerprint.
 * A wrong code or a tampered bundle fails authentication before anything is written.
 */

/** Non-secret `yoal.env` values the two control nodes must agree on (mirrors core). */
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

/** Secrets delivered sealed as well (mirrors core). */
export const CONTROL_SECRET_KEYS = [
	'BETTER_AUTH_SECRET',
	'YOAL_SITE_COOKIE_SECRET',
	'YOAL_OBJECT_STORE_SECRET',
	'YOAL_ACCESS_JWT_SECRET',
	'YOAL_CLOUDFLARE_API_TOKEN',
] as const;

export interface SealedControlBundle {
	version: 1;
	nodeId: string;
	primaryNodeId: string;
	createdAt: string;
	configDigest: string;
	masterKeyFingerprint: string;
	salt: string;
	sealed: { ciphertext: string; nonce: string };
}

export interface OpenedControlBundle {
	/** Base64 of the 32-byte key, the same form `/etc/yoal/master.key` holds. */
	masterKey: string;
	config: Record<string, string>;
	secrets: Record<string, string>;
}

export interface InstalledControlEnrolment {
	nodeId: string;
	primaryNodeId: string;
	masterKeyFingerprint: string;
	configDigest: string;
	masterKeyPath: string;
	envPath: string;
	recordPath: string;
	replica: { restored: boolean; lagSeconds: number | null; position: string | null };
}

export function masterKeyFingerprint(key: Uint8Array): string {
	return createHash('sha256').update(key).digest('hex');
}

/** Canonical JSON (sorted keys, no whitespace), identical to the server's digest input. */
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

function deriveActivationKey(code: string, salt: Buffer): Buffer {
	return scryptSync(code.normalize('NFKC').trim(), salt, 32);
}

/** Parse and structurally validate a bundle before attempting to decrypt it. */
export function parseSealedControlBundle(text: string): SealedControlBundle {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('The enrolment file is not valid JSON.');
	}
	// `--out` writes `{ bundle, certificate }` so the standby also gets its certificate; accept a
	// bare bundle too, for an operator who extracted it or moved it through another channel.
	const wrapped =
		parsed !== null && typeof parsed === 'object' && 'bundle' in parsed
			? (parsed as { bundle: unknown }).bundle
			: parsed;
	const value = wrapped as Partial<SealedControlBundle>;
	if (
		value === null ||
		typeof value !== 'object' ||
		value.version !== 1 ||
		typeof value.nodeId !== 'string' ||
		typeof value.primaryNodeId !== 'string' ||
		typeof value.masterKeyFingerprint !== 'string' ||
		typeof value.configDigest !== 'string' ||
		typeof value.salt !== 'string' ||
		typeof value.sealed?.ciphertext !== 'string' ||
		typeof value.sealed?.nonce !== 'string'
	)
		throw new Error('The enrolment file is not a version 1 sealed control bundle.');
	return value as SealedControlBundle;
}

/** Open on the standby; a wrong code fails authentication and never yields a partial payload. */
export function openControlBundle(bundle: SealedControlBundle, activationCode: string): OpenedControlBundle {
	let payload: OpenedControlBundle;
	try {
		const key = deriveActivationKey(activationCode, Buffer.from(bundle.salt, 'base64'));
		const data = Buffer.from(bundle.sealed.ciphertext, 'base64');
		const tag = data.subarray(data.length - 16);
		const body = data.subarray(0, data.length - 16);
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.sealed.nonce, 'base64'));
		decipher.setAuthTag(tag);
		const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
		payload = JSON.parse(plaintext.toString('utf8')) as OpenedControlBundle;
	} catch {
		throw new Error('The activation code does not open this bundle.');
	}
	if (
		typeof payload.masterKey !== 'string' ||
		typeof payload.config !== 'object' ||
		payload.config === null ||
		typeof payload.secrets !== 'object' ||
		payload.secrets === null
	)
		throw new Error('The sealed bundle is missing the master key or the allowlisted config.');
	// Both fingerprints, before anything reaches disk.
	const keyBytes = new Uint8Array(Buffer.from(payload.masterKey, 'base64'));
	if (keyBytes.byteLength !== 32) throw new Error('The sealed bundle’s master key is not 32 bytes.');
	if (masterKeyFingerprint(keyBytes) !== bundle.masterKeyFingerprint)
		throw new Error('The sealed bundle’s master key does not match its fingerprint.');
	if (controlConfigDigest({ ...payload.config, ...payload.secrets }) !== bundle.configDigest)
		throw new Error('The sealed bundle’s config does not match its digest.');
	return payload;
}

/**
 * Write the opened material with the modes the runbook requires:
 * `master.key` 0400, `yoal.env` 0600 (merged, so unrelated settings survive) and the enrolment
 * record 0600. Every write is temp-file + rename, so a crash cannot leave a half-written key.
 */
export async function installControlEnrolment(input: {
	bundle: SealedControlBundle;
	activationCode: string;
	dataDir: string;
	masterKeyPath: string;
	envPath: string;
	now?: () => number;
}): Promise<InstalledControlEnrolment> {
	const opened = openControlBundle(input.bundle, input.activationCode);
	const keyBytes = Buffer.from(opened.masterKey, 'base64');
	// Merge (and validate) first: a bad config value must not leave a key behind on a host whose
	// enrolment then failed.
	const envContent = mergeEnvFile(await readOptional(input.envPath), opened);

	await atomicWrite(input.masterKeyPath, `${keyBytes.toString('base64')}\n`, 0o400);
	await atomicWrite(input.envPath, envContent, 0o600);

	const replicaPath = join(input.dataDir, 'ha-control-replica.json');
	const replica = await readReplicaStatus(replicaPath);
	const recordPath = join(input.dataDir, 'ha-control-enrolment.json');
	const record = {
		version: 1,
		nodeId: input.bundle.nodeId,
		primaryNodeId: input.bundle.primaryNodeId,
		masterKeyFingerprint: input.bundle.masterKeyFingerprint,
		configDigest: input.bundle.configDigest,
		replica,
		enrolledAt: new Date((input.now ?? Date.now)()).toISOString(),
	};
	await atomicWrite(recordPath, `${JSON.stringify(record, null, 2)}\n`, 0o600);

	return {
		nodeId: input.bundle.nodeId,
		primaryNodeId: input.bundle.primaryNodeId,
		masterKeyFingerprint: input.bundle.masterKeyFingerprint,
		configDigest: input.bundle.configDigest,
		masterKeyPath: input.masterKeyPath,
		envPath: input.envPath,
		recordPath,
		replica,
	};
}

/** Replace only the allowlisted keys; comments, ordering and unrelated settings are preserved. */
export function mergeEnvFile(existing: string, opened: OpenedControlBundle): string {
	const values: Record<string, string> = { ...opened.config, ...opened.secrets };
	for (const [key, value] of Object.entries(values)) {
		if (/[\r\n]/.test(value)) throw new Error(`The sealed config value for ${key} contains a newline.`);
	}
	const seen = new Set<string>();
	const lines = existing.length > 0 ? existing.replace(/\r\n/g, '\n').split('\n') : [];
	const merged = lines.map((line) => {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
		if (!match || values[match[1]!] === undefined) return line;
		seen.add(match[1]!);
		return `${match[1]}=${values[match[1]!]}`;
	});
	for (const key of [...CONTROL_CONFIG_KEYS, ...CONTROL_SECRET_KEYS]) {
		if (values[key] !== undefined && !seen.has(key)) merged.push(`${key}=${values[key]}`);
	}
	// Trim only the trailing blank introduced by splitting a file that already ended in a newline.
	while (merged.length > 0 && merged[merged.length - 1] === '') merged.pop();
	return `${merged.join('\n')}\n`;
}

async function readOptional(path: string): Promise<string> {
	try {
		return await readFile(path, 'utf8');
	} catch {
		return '';
	}
}

async function readReplicaStatus(path: string): Promise<{ restored: boolean; lagSeconds: number | null; position: string | null }> {
	try {
		const value = JSON.parse(await readFile(path, 'utf8')) as {
			restored?: unknown;
			lagSeconds?: unknown;
			position?: unknown;
		};
		return {
			restored: value.restored === true,
			lagSeconds: typeof value.lagSeconds === 'number' && Number.isFinite(value.lagSeconds) ? value.lagSeconds : null,
			position: typeof value.position === 'string' ? value.position : null,
		};
	} catch {
		return { restored: false, lagSeconds: null, position: null };
	}
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp-${process.pid}`;
	await writeFile(temporary, content, { mode });
	await chmod(temporary, mode);
	await rename(temporary, path);
	await chmod(path, mode);
}
