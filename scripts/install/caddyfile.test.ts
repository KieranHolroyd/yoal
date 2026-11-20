import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapCaddyfile, ensureNodeCaddyfile } from './caddyfile.ts';

/**
 * HA-PLAN Wave 1 F12: with Caddy already installed, the installer kept the package's stock
 * Caddyfile, whose admin API listens on TCP :2019. The agent could not drive Caddy, and a TCP admin
 * API on a node is a hole. The installer now writes its bootstrap file whenever the admin API is
 * not on a unix socket, backing the old file up and saying so.
 */
const STOCK = `# The Caddyfile is an easy way to configure your Caddy web server.
:80 {
	root * /usr/share/caddy
	file_server
}
`;

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});
const setup = (content: string | null) => {
	const root = mkdtempSync(join(tmpdir(), 'yoal-caddyfile-'));
	dir = root;
	const path = join(root, 'Caddyfile');
	if (content !== null) writeFileSync(path, content);
	const calls: string[][] = [];
	const logs: string[] = [];
	return { path, calls, logs, run: (cmd: string[]) => void calls.push(cmd), log: (line: string) => void logs.push(line) };
};

describe('bootstrap Caddyfile (F12)', () => {
	test('the bootstrap file keeps the admin API on the unix socket', () => {
		const body = bootstrapCaddyfile(':80');
		expect(body).toContain('\tadmin unix//var/lib/caddy/admin.sock|0660\n');
		expect(body).not.toMatch(/^\s*admin\s+(?!unix)/m);
		expect(bootstrapCaddyfile('http://127.0.0.1:8080', '127.0.0.1')).toContain('\tbind 127.0.0.1\n');
	});

	test('a preinstalled Caddy with the stock file gets the bootstrap file, a backup and a restart', () => {
		const t = setup(STOCK);
		expect(ensureNodeCaddyfile({ path: t.path, listen: ':80', run: t.run, log: t.log, restart: true })).toBe(true);
		expect(readFileSync(t.path, 'utf8')).toBe(bootstrapCaddyfile(':80'));
		expect(readFileSync(`${t.path}.dist`, 'utf8')).toBe(STOCK);
		// The installer output says where the old file went and why.
		expect(t.logs.join('\n')).toContain(`${t.path}.dist`);
		expect(t.logs.join('\n')).toMatch(/admin API/);
		// Caddy is running the stock config with its admin API on TCP: only a restart drops it.
		expect(t.calls).toEqual([
			['systemctl', 'enable', 'caddy'],
			['systemctl', 'restart', 'caddy'],
		]);
	});

	test('a file whose admin API is already on a unix socket is left alone', () => {
		const t = setup(bootstrapCaddyfile(':80').replace('Yoal is starting.', 'patched by Yoal'));
		const before = readFileSync(t.path, 'utf8');
		expect(ensureNodeCaddyfile({ path: t.path, listen: ':80', run: t.run, log: t.log, restart: true })).toBe(false);
		expect(readFileSync(t.path, 'utf8')).toBe(before);
		expect(existsSync(`${t.path}.dist`)).toBe(false);
		expect(t.calls).toEqual([]);
	});

	test('an earlier backup is never overwritten', () => {
		const t = setup('{\n\tadmin localhost:2019\n}\n');
		writeFileSync(`${t.path}.dist`, STOCK);
		expect(ensureNodeCaddyfile({ path: t.path, listen: ':80', run: t.run, log: t.log, now: () => 1234 })).toBe(true);
		expect(readFileSync(`${t.path}.dist`, 'utf8')).toBe(STOCK);
		expect(readFileSync(`${t.path}.dist.1234`, 'utf8')).toBe('{\n\tadmin localhost:2019\n}\n');
		// Without `restart` the caller restarts Caddy itself.
		expect(t.calls).toEqual([]);
	});

	test('no file yet: the bootstrap file is written with nothing to back up', () => {
		const t = setup(null);
		expect(ensureNodeCaddyfile({ path: t.path, listen: ':80', run: t.run, log: t.log })).toBe(true);
		expect(readFileSync(t.path, 'utf8')).toBe(bootstrapCaddyfile(':80'));
		expect(t.logs.join('\n')).not.toContain('.dist');
	});

	test('a dry run writes nothing', () => {
		const t = setup(STOCK);
		expect(ensureNodeCaddyfile({ path: t.path, listen: ':80', run: t.run, log: t.log, dryRun: true, restart: true })).toBe(false);
		expect(readFileSync(t.path, 'utf8')).toBe(STOCK);
		expect(t.calls).toEqual([]);
		expect(t.logs.join('\n')).toContain('would');
	});

	test('the control-plane install writes it even when Caddy was already installed', () => {
		// The installer is a script; check its control-plane path calls the module outside
		// installCaddy() (which runs only when it installs the package) and before the admin socket
		// is detected from the file.
		const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
		const writeUnits = main.slice(main.indexOf('function writeUnits('), main.indexOf('function ensureCaddyAccess('));
		expect(writeUnits).toContain('ensureNodeCaddyfile(');
		expect(writeUnits.indexOf('ensureNodeCaddyfile(')).toBeLessThan(writeUnits.indexOf('ensureCaddyAccess()'));
		expect(main).not.toContain('function ensureBootstrapCaddyfile(');
	});
});
