import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Where Caddy keeps certificates on the two node layouts (docs/OPS.md §10):
 * - the installer's `caddy.service` runs as `caddy` with `HOME=/var/lib/caddy`, so its data dir is
 *   `/var/lib/caddy/.local/share/caddy`;
 * - `yoal-caddy.service` (converted Skiff hosts, the node image) sets
 *   `XDG_DATA_HOME=/var/lib/yoal/caddy/data`, so its data dir is `/var/lib/yoal/caddy/data/caddy`.
 *
 * The helper does not know which unit a node runs, so it looks in both. Only one exists on a
 * given host; a missing directory is skipped.
 */
export const DEFAULT_CADDY_DATA_DIRS: readonly string[] = [
	'/var/lib/caddy/.local/share/caddy',
	'/var/lib/yoal/caddy/data/caddy',
];

/** `YOAL_CADDY_DATA_DIR` pins one directory; unset, both layouts are searched. */
export function caddyDataDirs(env: Record<string, string | undefined> = process.env): string[] {
	const configured = env.YOAL_CADDY_DATA_DIR?.trim();
	return configured ? [configured] : [...DEFAULT_CADDY_DATA_DIRS];
}

/**
 * The newest certificate Caddy stored under `storage` (`<dir>/certificates/<issuer>/<storage>/`),
 * across every data dir and issuer, or null when none has it.
 */
export async function findCaddyCertificate(
	dataDirs: readonly string[],
	storage: string,
): Promise<{ cert: string; key: string } | null> {
	let best: { cert: string; key: string; mtime: number } | null = null;
	for (const dataDir of dataDirs) {
		const root = join(dataDir, 'certificates');
		let issuers: string[];
		try {
			issuers = await fs.readdir(root);
		} catch {
			continue;
		}
		for (const issuer of issuers) {
			const cert = join(root, issuer, storage, `${storage}.crt`);
			const key = join(root, issuer, storage, `${storage}.key`);
			try {
				const [stat] = await Promise.all([fs.stat(cert), fs.stat(key)]);
				if (!best || stat.mtimeMs > best.mtime) best = { cert, key, mtime: stat.mtimeMs };
			} catch {
				// Not issued by this issuer.
			}
		}
	}
	return best ? { cert: best.cert, key: best.key } : null;
}
