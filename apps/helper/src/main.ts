import { loadHelperConfig } from './config.ts';
import { PublicDbManager } from './public-db.ts';
import { startHelperServer, type RunningHelper } from './server.ts';
import { spawnRunner, SystemdDriver } from './systemd.ts';
import { NodeUpdater } from './node-update.ts';
import { WireguardManager } from './wireguard.ts';
import { NetworkManager } from './network.ts';
import { ShareMounter } from './shares.ts';
import { DiskMounter } from './disks.ts';
import { ContainerConsole } from './container-console.ts';
import { DEFAULT_SUBID_FILES } from './userns.ts';
import { JobDriver } from './jobs.ts';
import { PipelineJobDriver, resolveBuildsRoot } from './pipeline-jobs.ts';
import { ensureStorageTools } from './storage-tools.ts';
import { ensureCaddyRestartDropIn } from './caddy-restart.ts';
import { KeepalivedManager } from './keepalived.ts';
import { dirname, join } from 'node:path';

/**
 * `yoal-helper`: the only privileged Yoal process (D26). It listens on a root-owned,
 * group-restricted unix socket, validates every field itself and renders fixed units. The agent
 * never runs as root.
 */

export function log(level: 'info' | 'warn' | 'error', message: string): void {
	const line = `[yoal-helper ${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
	else console.log(line);
}

/**
 * What a test-only entry point may add to the helper: routes in front of the fixed verbs, set up
 * before the socket opens. The release entry (this file's `import.meta.main` branch) passes nothing.
 */
export interface HelperExtension {
	routes?: (request: Request, url: URL) => Promise<Response | null>;
}

export interface RunHelperOptions {
	extend?: (context: { systemctlPath: string; log: typeof log }) => Promise<HelperExtension>;
}

export async function runHelper(options: RunHelperOptions = {}): Promise<void> {
	const config = loadHelperConfig();
	const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
	if (uid !== 0) {
		throw new Error(`yoal-helper must run as root (uid 0); running as uid ${uid}`);
	}

	const driver = new SystemdDriver({
		runner: spawnRunner(),
		unitDir: config.unitDir,
		quadletDir: config.quadletDir,
		runtimeDir: config.runtimeDir,
		stateDir: config.stateDir,
		replicationDir: config.replicationDir,
		releaseDirs: config.releaseDirs,
		workerdDir: config.workerdDir,
		bunPath: config.bunPath,
		nodePath: config.nodePath,
		systemctlPath: config.systemctlPath,
		journalctlPath: config.journalctlPath,
		podmanPath: config.podmanPath,
		opensslPath: config.opensslPath,
		apparmorProfile: config.apparmorProfile,
		containerSubids: DEFAULT_SUBID_FILES,
		socketMode: config.workloadSocketMode,
		socketGroup: config.workloadSocketGroup,
	});

	let helper: RunningHelper | null = null;
	let containers: ContainerConsole | null = null;
	let stopping = false;
	let resolveStop: (() => void) | null = null;
	const stopped = new Promise<void>((resolve) => {
		resolveStop = resolve;
	});
	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		resolveStop?.();
		log('info', 'Shutting down');
		// Workloads stay running: the agent owns their lifecycle, the helper only renders them.
		await containers?.closeAll().catch(() => undefined);
		await helper?.stop().catch(() => undefined);
		helper = null;
	};

	const signals = process as unknown as {
		once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
	};
	signals.once('SIGTERM', () => void stop());
	signals.once('SIGINT', () => void stop());

	const nodeUpdate = new NodeUpdater({
		paths: config.nodeUpdate,
		currentVersion: config.version,
		systemctlPath: config.systemctlPath,
		log: (level, message) => log(level, `node update: ${message}`),
	});
	const firewall = new NetworkManager();
	const publicDb = new PublicDbManager();
	const wireguard = new WireguardManager({ firewall });
	containers = new ContainerConsole({
		podmanPath: config.podmanPath,
		systemctlPath: config.systemctlPath,
		quadletDir: config.quadletDir,
		runner: spawnRunner(),
		log: (level, message) => log(level, `container console: ${message}`),
	});
	// Routes a test-only entry point adds (it passes `extend`); the release entry never does.
	const extension = await options.extend?.({ systemctlPath: config.systemctlPath, log });
	const keepalivedRunner = spawnRunner();
	helper = await startHelperServer(config, driver, {
		...(extension?.routes ? { extraRoutes: extension.routes } : {}),
		// keepalived/VRRP for the `vip` steering driver (HA-PLAN H18). No daemon is added here:
		// the distribution's keepalived.service is the only long-running process.
		keepalived: new KeepalivedManager({
			paths: {
				systemctlPath: config.systemctlPath,
				ipPath: Bun.which('ip') ?? '/usr/sbin/ip',
			},
			runner: (argv) => keepalivedRunner.run(argv),
		}),
		nodeUpdate,
		wireguard,
		endpointGuard: { apply: () => firewall.applyEndpointGuard() },
		// Public database access (D241): the per-port allowlist table and the `*.db` certificate copy.
		publicDb: {
			firewall: (rules) => publicDb.applyFirewall(rules),
			copyTls: (names) => publicDb.copyTls(names),
		},
		shares: new ShareMounter(),
		disks: new DiskMounter(),
		volumeProfiler: driver.volumeProfiler(),
		containers,
		appVolumes: driver.appVolumeData({ log: (level, message) => log(level, `app volumes: ${message}`) }),
		// Job runs (plan 09): systemd-run sits beside systemctl on every supported distribution.
		jobs: new JobDriver({
			runner: spawnRunner(),
			runtimeDir: config.runtimeDir,
			releaseDirs: config.releaseDirs,
			bunPath: config.bunPath,
			nodePath: config.nodePath,
			systemdRunPath: join(dirname(config.systemctlPath), 'systemd-run'),
			systemctlPath: config.systemctlPath,
			journalctlPath: config.journalctlPath,
			podmanPath: config.podmanPath,
			apparmorProfile: config.apparmorProfile,
			resolveAppVolumeMounts: (workload) => driver.resolveAppVolumeMounts(workload),
			resolveDataDir: (workload) => driver.resolveDataDir(workload),
		}),
		// Pipeline job containers (docs/PIPELINES.md W5/W6): the Builder never runs Podman itself.
		pipelineJobs: new PipelineJobDriver({
			runner: spawnRunner(),
			podmanPath: config.podmanPath,
			runtimeDir: config.runtimeDir,
			buildsRoot: () => resolveBuildsRoot({ override: process.env.YOAL_HELPER_BUILDS_DIR?.trim() || null, unitDir: config.unitDir }),
			stepBinary: config.nodeUpdate.agentBinary,
			apparmorProfile: config.apparmorProfile,
			subidFiles: DEFAULT_SUBID_FILES,
			log: (level, message) => log(level, message),
		}),
	});
	if (stopping) await helper.stop();
	log('info', `Listening on unix/${config.socketPath} (units ${config.unitDir})`);

	// Storage tools for disk profiling and share mounts (docs/STORAGE.md §5.1): a node that updated
	// in place gets them on its first start of a new helper version. Off the request path.
	if (config.installStorageTools) {
		const runner = spawnRunner();
		void ensureStorageTools({
			stateDir: config.stateDir,
			version: config.version,
			run: (argv, env) => runner.run(argv, env ? { env } : {}),
			log: (level, message) => log(level, `storage tools: ${message}`),
		});
	}

	// Every node's caddy.service restarts on failure (F10). Workers update through `node/update`,
	// which never runs release convergence, so the helper makes sure of it on each start. Fixed
	// content, off the request path; Caddy is not restarted.
	void ensureCaddyRestartDropIn({
		unitDir: config.unitDir,
		systemctlPath: config.systemctlPath,
		runner: spawnRunner(),
		log: (level, message) => log(level, `caddy: ${message}`),
	}).catch((error: unknown) =>
		log('warn', `caddy: could not write the restart drop-in: ${error instanceof Error ? error.message : String(error)}`),
	);

	// D96 retired the D60 studio console; clear any console sidecar a node kept from before the upgrade. Best
	// effort and off the request path: a failure is logged and retried on the next helper start.
	void driver
		.removeLegacyConsoles()
		.then((ids) => {
			if (ids.length > 0) log('info', `Removed leftover studio console sidecars (D60): ${ids.join(', ')}`);
		})
		.catch((error: unknown) =>
			log('warn', `Could not remove leftover studio console sidecars (D60): ${error instanceof Error ? error.message : String(error)}`),
		);

	// Keep the process alive until a signal resolves the stop promise.
	await stopped;
}

if (import.meta.main) {
	await runHelper().catch((error: unknown) => {
		console.error(
			`[yoal-helper] fatal: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
}
