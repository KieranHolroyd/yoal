/**
 * `yoal-helper` TEST BUILD entry point: the release helper plus the HA lab fault verbs
 * (docs/HA-PLAN.md W1, `faults.ts`). Built only by `bun run build:faults`, which the lab installs
 * through a systemd drop-in (tests/lab). The release `build` script compiles `main.ts`, which never
 * imports this file or `faults.ts`, so a release binary has no fault code to enable (HA-PLAN §10);
 * `faults-release.test.ts` checks that.
 */
import { runHelper } from './main.ts';
import { FaultInjector } from './faults.ts';
import { spawnRunner } from './systemd.ts';

if (import.meta.main) {
	await runHelper({
		async extend({ systemctlPath, log }) {
			const faults = new FaultInjector({
				runner: spawnRunner(),
				systemctlPath,
				log: (level, message) => log(level, `faults: ${message}`),
			});
			log('warn', 'TEST BUILD: fault injection verbs are enabled on this helper');
			// A helper that restarted with faults active reverts them: their timers died with it.
			await faults.clearAll('startup sweep').catch((error: unknown) =>
				log('error', `faults: startup sweep failed: ${error instanceof Error ? error.message : String(error)}`),
			);
			return { routes: (request, url) => faults.handle(request, url) };
		},
	}).catch((error: unknown) => {
		console.error(`[yoal-helper] fatal: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
