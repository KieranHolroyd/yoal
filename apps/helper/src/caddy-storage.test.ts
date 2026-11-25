import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caddyDataDirs, DEFAULT_CADDY_DATA_DIRS, findCaddyCertificate } from './caddy-storage.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(dataDir: string, issuer: string, storage: string, mtime: number): string {
	const folder = join(dataDir, 'certificates', issuer, storage);
	mkdirSync(folder, { recursive: true });
	const cert = join(folder, `${storage}.crt`);
	writeFileSync(cert, 'cert');
	writeFileSync(join(folder, `${storage}.key`), 'key');
	utimesSync(cert, mtime, mtime);
	return cert;
}

describe('caddyDataDirs', () => {
	test('searches both node layouts unless YOAL_CADDY_DATA_DIR pins one', () => {
		expect(caddyDataDirs({})).toEqual([...DEFAULT_CADDY_DATA_DIRS]);
		expect(DEFAULT_CADDY_DATA_DIRS).toContain('/var/lib/caddy/.local/share/caddy');
		expect(DEFAULT_CADDY_DATA_DIRS).toContain('/var/lib/yoal/caddy/data/caddy');
		expect(caddyDataDirs({ YOAL_CADDY_DATA_DIR: ' /srv/caddy ' })).toEqual(['/srv/caddy']);
		expect(caddyDataDirs({ YOAL_CADDY_DATA_DIR: '' })).toEqual([...DEFAULT_CADDY_DATA_DIRS]);
	});
});

describe('findCaddyCertificate', () => {
	test('finds a certificate in the second layout when the first does not exist', async () => {
		const root = mkdtempSync(join(tmpdir(), 'yoal-caddy-storage-'));
		dirs.push(root);
		const yoalCaddy = join(root, 'yoal', 'caddy', 'data', 'caddy');
		const cert = put(yoalCaddy, 'acme-v02', 'wildcard_.db.example.com', 1_000);
		const found = await findCaddyCertificate([join(root, 'missing'), yoalCaddy], 'wildcard_.db.example.com');
		expect(found?.cert).toBe(cert);
		expect(await findCaddyCertificate([join(root, 'missing'), yoalCaddy], 'other.db.example.com')).toBeNull();
	});

	test('picks the newest copy across data dirs and issuers', async () => {
		const root = mkdtempSync(join(tmpdir(), 'yoal-caddy-storage-'));
		dirs.push(root);
		const a = join(root, 'a');
		const b = join(root, 'b');
		put(a, 'acme-old', 'smtp.example.com', 1_000);
		const newest = put(b, 'acme-new', 'smtp.example.com', 3_000);
		put(b, 'zerossl', 'smtp.example.com', 2_000);
		expect((await findCaddyCertificate([a, b], 'smtp.example.com'))?.cert).toBe(newest);
	});
});
