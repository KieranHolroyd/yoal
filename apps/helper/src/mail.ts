import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { findCaddyCertificate } from './caddy-storage.ts';
import { ValidationError } from './validate.ts';

/**
 * The helper's email verbs (docs/EMAIL.md §3.2). `yoal-mail` runs as the agent's user without
 * access to Caddy's storage, so the helper copies the submission host's certificate out of it.
 * Only `smtp.*`/`mx.*` names are accepted: a compromised agent must not be able to pull the
 * wildcard site certificate's key this way.
 */

export const MAIL_UNIT = 'yoal-mail.service';
const MAIL_HOST = /^(smtp|mx|mx\d)\.(?!-)[a-z0-9-]{1,63}(\.(?!-)[a-z0-9-]{1,63})+$/;

export function assertMailHost(value: unknown): string {
	if (typeof value !== 'string' || value.length > 253 || !MAIL_HOST.test(value))
		throw new ValidationError('host must be an smtp.* or mx.* hostname');
	return value;
}

export interface MailTlsOptions {
	/** Caddy's data dirs (`caddyDataDirs()`); certificates live under `<dir>/certificates/<issuer>/<host>/`. */
	caddyDataDirs: readonly string[];
	/** Where `yoal-mail` reads `cert.pem` + `key.pem`. */
	outDir: string;
	/** A path owned by the agent's user; the copies get its uid/gid. */
	ownerFrom: string;
	chown: (path: string, uid: number, gid: number) => Promise<void>;
}

/** Copy the newest certificate for `host` into `outDir`. Returns whether the files changed. */
export async function copyMailTls(host: string, options: MailTlsOptions): Promise<{ found: boolean; changed: boolean }> {
	assertMailHost(host);
	const source = await findCaddyCertificate(options.caddyDataDirs, host);
	if (!source) return { found: false, changed: false };
	const [cert, key] = await Promise.all([fs.readFile(source.cert), fs.readFile(source.key)]);
	const certPath = join(options.outDir, 'cert.pem');
	const keyPath = join(options.outDir, 'key.pem');
	const current = await Promise.all([fs.readFile(certPath).catch(() => null), fs.readFile(keyPath).catch(() => null)]);
	if (current[0]?.equals(cert) && current[1]?.equals(key)) return { found: true, changed: false };
	const owner = await fs.stat(options.ownerFrom);
	await fs.mkdir(options.outDir, { recursive: true, mode: 0o700 });
	await options.chown(options.outDir, owner.uid, owner.gid);
	for (const [path, data] of [
		[certPath, cert],
		[keyPath, key],
	] as const) {
		const temp = `${path}.tmp`;
		await fs.writeFile(temp, data, { mode: 0o600 });
		await options.chown(temp, owner.uid, owner.gid);
		await fs.rename(temp, path);
	}
	return { found: true, changed: true };
}
