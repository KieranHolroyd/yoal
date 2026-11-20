import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminOnUnixSocket, bootstrapCaddyfile, controlPlaneCaddyfile, workerCaddyfile, type CaddyfileHost } from './caddyfile.ts';

/**
 * HA-PLAN Wave 1 F12 and its review. With Caddy already installed, the installer kept the package's
 * stock Caddyfile, whose admin API listens on TCP :2019: the agent could not drive Caddy, and a
 * TCP admin API on a node is a hole. The installer now writes its bootstrap file, but only where
 * that is safe: Caddy runs as `caddy.service`, and on the control plane it is the first install, the
 * file is the package's own, or the operator asked with --replace-caddyfile.
 */
const STOCK = `# The Caddyfile is an easy way to configure your Caddy web server.
:80 {
	root * /usr/share/caddy
	file_server
}
`;
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

/** A host: its Caddyfile, which Caddy unit is loaded, and what dpkg says the package shipped. */
function host(content: string | null, options: { unit?: 'caddy.service' | 'yoal-caddy.service' | null; shipped?: string | null; mode?: number } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'yoal-caddyfile-'));
	dir = root;
	const path = join(root, 'Caddyfile');
	if (content !== null) {
		writeFileSync(path, content);
		if (options.mode !== undefined) chmodSync(path, options.mode);
	}
	const unit = options.unit === undefined ? 'caddy.service' : options.unit;
	const shipped = options.shipped === undefined ? STOCK : options.shipped;
	const calls: string[][] = [];
	const logs: string[] = [];
	const deps: CaddyfileHost = {
		path,
		run: (cmd) => void calls.push(cmd),
		capture: (cmd) => {
			if (cmd[0] === 'systemctl' && cmd.includes('LoadState')) return cmd.at(-1) === unit ? 'loaded' : 'not-found';
			if (cmd[0] === 'dpkg-query') return shipped === null ? null : ` ${path} ${md5(shipped)}\n /etc/caddy/other 0\n`;
			return null;
		},
		log: (line) => void logs.push(line),
		now: () => 1234,
	};
	return { path, calls, logs, deps };
}
const restarted = [
	['systemctl', 'enable', 'caddy.service'],
	['systemctl', 'restart', 'caddy.service'],
];

describe('reading the admin address (F12 review)', () => {
	test('only a live admin directive on a unix socket counts; comments do not', () => {
		expect(adminOnUnixSocket(bootstrapCaddyfile(':80'))).toBe(true);
		expect(adminOnUnixSocket('{\n\tadmin   unix//run/caddy.sock\n}\n')).toBe(true);
		expect(adminOnUnixSocket('{\n\t# admin unix//run/caddy.sock\n\tadmin localhost:2019\n}\n')).toBe(false);
		expect(adminOnUnixSocket('{\n#admin unix//run/caddy.sock\n}\n')).toBe(false);
		expect(adminOnUnixSocket('{\n\tadmin localhost:2019 # was admin unix//x\n}\n')).toBe(false);
		expect(adminOnUnixSocket('{\n\tadmin unix//run/caddy.sock # the agent\n}\n')).toBe(true);
		expect(adminOnUnixSocket(STOCK)).toBe(false);
		expect(adminOnUnixSocket('')).toBe(false);
	});
});

describe('control-plane install (F12)', () => {
	test('first install over a preinstalled Caddy: bootstrap file, backup with its mode, enable and restart', () => {
		const t = host(STOCK, { mode: 0o600 });
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: true, force: false })).toBe(true);
		expect(readFileSync(t.path, 'utf8')).toBe(bootstrapCaddyfile(':80'));
		expect(readFileSync(`${t.path}.dist`, 'utf8')).toBe(STOCK);
		// The backup keeps the original's mode (and owner): never widened by root's umask.
		expect(statSync(`${t.path}.dist`).mode & 0o777).toBe(0o600);
		expect(t.logs.join('\n')).toContain(`${t.path}.dist`);
		expect(t.logs.join('\n')).toMatch(/admin API/);
		expect(t.calls).toEqual(restarted);
	});

	test('the backup of a 0640 file stays 0640', () => {
		const t = host('{\n\tadmin localhost:2019\n}\n', { mode: 0o640 });
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: true, force: false })).toBe(true);
		expect(statSync(`${t.path}.dist`).mode & 0o777).toBe(0o640);
	});

	test('a host whose proxy is yoal-caddy.service is left alone: no second Caddy', () => {
		const t = host(STOCK, { unit: 'yoal-caddy.service' });
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: true, force: true })).toBe(false);
		expect(readFileSync(t.path, 'utf8')).toBe(STOCK);
		expect(existsSync(`${t.path}.dist`)).toBe(false);
		expect(t.calls).toEqual([]);
		expect(t.logs.join('\n')).toContain('yoal-caddy.service');
	});

	test('no Caddy unit at all: nothing is enabled or restarted', () => {
		const t = host(STOCK, { unit: null });
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: true, force: false })).toBe(false);
		expect(t.calls).toEqual([]);
	});

	test('an existing install with its own Caddyfile is left alone with a warning', () => {
		const custom = '{\n\tadmin localhost:2019\n}\nexample.test {\n\trespond "mine"\n}\n';
		const t = host(custom);
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: false, force: false })).toBe(false);
		expect(readFileSync(t.path, 'utf8')).toBe(custom);
		expect(t.calls).toEqual([]);
		expect(t.logs.join('\n')).toContain('--replace-caddyfile');
		// …unless the operator asks.
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: false, force: true })).toBe(true);
		expect(readFileSync(`${t.path}.dist`, 'utf8')).toBe(custom);
		expect(t.calls).toEqual(restarted);
	});

	test('an existing install still on the package\'s own Caddyfile is repaired', () => {
		const t = host(STOCK);
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: false, force: false })).toBe(true);
		expect(t.calls).toEqual(restarted);
	});

	test('a file whose admin API is already on a unix socket is never touched', () => {
		const t = host(bootstrapCaddyfile(':80').replace('Yoal is starting.', 'patched by Yoal'));
		const before = readFileSync(t.path, 'utf8');
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: true, force: true })).toBe(false);
		expect(readFileSync(t.path, 'utf8')).toBe(before);
		expect(existsSync(`${t.path}.dist`)).toBe(false);
		expect(t.calls).toEqual([]);
	});

	test('a commented-out unix admin line does not stop the repair', () => {
		const t = host(`{\n\t# admin unix//var/lib/caddy/admin.sock\n}\n${STOCK}`);
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: true, force: false })).toBe(true);
		expect(adminOnUnixSocket(readFileSync(t.path, 'utf8'))).toBe(true);
	});

	test('an earlier backup is never overwritten', () => {
		const t = host('{\n\tadmin localhost:2019\n}\n');
		writeFileSync(`${t.path}.dist`, STOCK);
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: true, force: false })).toBe(true);
		expect(readFileSync(`${t.path}.dist`, 'utf8')).toBe(STOCK);
		expect(readFileSync(`${t.path}.dist.1234`, 'utf8')).toBe('{\n\tadmin localhost:2019\n}\n');
	});

	test('no file yet: written, nothing to back up', () => {
		const t = host(null);
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: false, force: false })).toBe(true);
		expect(readFileSync(t.path, 'utf8')).toBe(bootstrapCaddyfile(':80'));
		expect(t.logs.join('\n')).not.toContain('.dist');
	});

	test('a dry run writes and runs nothing', () => {
		const t = host(STOCK);
		expect(controlPlaneCaddyfile({ ...t.deps, firstInstall: true, force: false, dryRun: true })).toBe(false);
		expect(readFileSync(t.path, 'utf8')).toBe(STOCK);
		expect(t.calls).toEqual([]);
		expect(t.logs.join('\n')).toContain('would');
	});
});

describe('worker join', () => {
	test('a worker gets the loopback-only bootstrap file, and only under caddy.service', () => {
		const t = host(STOCK);
		expect(workerCaddyfile(t.deps)).toBe(true);
		expect(readFileSync(t.path, 'utf8')).toBe(bootstrapCaddyfile('http://127.0.0.1:8080', '127.0.0.1'));
		expect(readFileSync(t.path, 'utf8')).toContain('\tbind 127.0.0.1\n');
		expect(t.calls).toEqual(restarted);

		const other = host(STOCK, { unit: 'yoal-caddy.service' });
		expect(workerCaddyfile(other.deps)).toBe(false);
		expect(other.calls).toEqual([]);
	});
});

describe('installer wiring', () => {
	test('main.ts uses these entry points and parses --replace-caddyfile', () => {
		const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
		expect(main).toContain('controlPlaneCaddyfile({');
		expect(main).toContain('workerCaddyfile({');
		expect(main).toContain("has('--replace-caddyfile')");
		expect(main).not.toContain('ensureNodeCaddyfile(');
	});
});
