import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CADDY_RESTART_DROP_IN, caddyRestartDropIn } from '../../../scripts/systemd/caddy.ts';
import { ensureCaddyRestartDropIn } from './caddy-restart.ts';

/**
 * F10 review: workers update through the helper's `node/update`, which swaps binaries and never
 * runs release convergence, so the Caddy restart drop-in has to come from the helper itself. It
 * writes fixed content (no inputs) on start, reloads systemd, and never restarts Caddy.
 */
let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function setup(loadState = 'loaded') {
	const root = mkdtempSync(join(tmpdir(), 'yoal-helper-caddy-'));
	dir = root;
	const calls: string[][] = [];
	const runner = {
		run: async (argv: string[]) => {
			calls.push(argv);
			if (argv.includes('LoadState')) return { code: 0, stdout: `${loadState}\n`, stderr: '' };
			return { code: 0, stdout: '', stderr: '' };
		},
	};
	return { unitDir: root, calls, runner, path: join(root, 'caddy.service.d', CADDY_RESTART_DROP_IN) };
}

describe('Caddy restart drop-in from the helper (F10 review)', () => {
	test('writes the fixed drop-in once, reloads systemd, and never touches the running Caddy', async () => {
		const t = setup();
		const options = { unitDir: t.unitDir, systemctlPath: '/usr/bin/systemctl', runner: t.runner, log: () => undefined };
		expect(await ensureCaddyRestartDropIn(options)).toBe(true);
		expect(readFileSync(t.path, 'utf8')).toBe(caddyRestartDropIn());
		expect(t.calls).toEqual([
			['/usr/bin/systemctl', 'show', '-p', 'LoadState', '--value', 'caddy.service'],
			['/usr/bin/systemctl', 'daemon-reload'],
		]);
		// A second start finds it current: no write, no reload.
		expect(await ensureCaddyRestartDropIn(options)).toBe(false);
		expect(t.calls.filter((argv) => argv.includes('daemon-reload'))).toHaveLength(1);
		// Nothing restarts, reloads or starts Caddy: the drop-in applies on its next start.
		expect(t.calls.some((argv) => argv.some((arg) => /^(restart|reload|start|try-restart|reload-or-restart)$/.test(arg)))).toBe(false);
	});

	test('a changed copy is put back', async () => {
		const t = setup();
		const options = { unitDir: t.unitDir, systemctlPath: '/usr/bin/systemctl', runner: t.runner, log: () => undefined };
		await ensureCaddyRestartDropIn(options);
		writeFileSync(t.path, '[Service]\nRestart=no\n');
		expect(await ensureCaddyRestartDropIn(options)).toBe(true);
		expect(readFileSync(t.path, 'utf8')).toBe(caddyRestartDropIn());
	});

	test('a host without caddy.service gets nothing', async () => {
		for (const state of ['not-found', 'masked', '']) {
			const t = setup(state);
			expect(
				await ensureCaddyRestartDropIn({ unitDir: t.unitDir, systemctlPath: '/usr/bin/systemctl', runner: t.runner, log: () => undefined }),
			).toBe(false);
			expect(t.calls).toHaveLength(1);
			rmSync(t.unitDir, { recursive: true, force: true });
		}
	});

	test('the helper runs it on every start', () => {
		const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
		expect(main).toContain('ensureCaddyRestartDropIn({');
	});
});
