import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { CADDY_RESTART_DROP_IN, STOCK_CADDY_UNIT, caddyRestartDropIn } from '../../../scripts/systemd/caddy.ts';

/**
 * The Caddy restart drop-in on every node (HA-PLAN Wave 1 F10). Release convergence writes it on
 * control-plane hosts; a worker updates through `node/update`, which only swaps the agent and
 * helper binaries, so the helper makes sure of it each time it starts. The content is fixed and
 * nothing is taken as input. Caddy is never restarted, reloaded or started here: the daemon-reload
 * is all a restart policy needs. True when the file was written.
 */
export async function ensureCaddyRestartDropIn(options: {
	unitDir: string;
	systemctlPath: string;
	runner: { run(argv: string[]): Promise<{ code: number; stdout: string }> };
	log: (level: 'info' | 'warn', message: string) => void;
}): Promise<boolean> {
	const loaded = await options.runner.run([options.systemctlPath, 'show', '-p', 'LoadState', '--value', STOCK_CADDY_UNIT]);
	if (loaded.code !== 0 || loaded.stdout.trim() !== 'loaded') return false;
	const dir = join(options.unitDir, `${STOCK_CADDY_UNIT}.d`);
	const path = join(dir, CADDY_RESTART_DROP_IN);
	const body = caddyRestartDropIn();
	const current = await fs.readFile(path, 'utf8').catch(() => null);
	if (current === body) return false;
	await fs.mkdir(dir, { recursive: true, mode: 0o755 });
	await fs.writeFile(`${path}.tmp`, body, { mode: 0o644 });
	await fs.rename(`${path}.tmp`, path);
	const reload = await options.runner.run([options.systemctlPath, 'daemon-reload']);
	if (reload.code !== 0) options.log('warn', `wrote ${path} but systemctl daemon-reload failed (exit ${reload.code})`);
	else options.log('info', `${STOCK_CADDY_UNIT} now restarts on failure (${path}); Caddy itself was not restarted`);
	return true;
}
