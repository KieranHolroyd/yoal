import { spawn } from 'node:child_process';
import type { KeyObject } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	hostPlatform,
	loadTrustedKeys,
	SignatureError,
	verifyManifest,
	type ManifestArtifact,
} from '../../../scripts/update-self/signing.ts';
import { ValidationError } from './validate.ts';

/**
 * The fixed `node/update` verb (D99): install a signed Yoal release's agent and helper on a worker.
 *
 * The only inputs are a release version and a repository name. Everything that decides what runs as
 * root is checked here, on the node: the release manifest must verify against a release-signing key
 * compiled into this binary (or one an operator dropped into /etc/yoal/updater/keys), the bundle
 * must match the manifest's size and sha256, and the version may not go backwards. A compromised
 * control plane or agent can therefore at most install a genuine, newer Yoal release.
 *
 * A control-plane host is refused: its binaries belong to the release `yoal-update-self` manages
 * (`/opt/yoal/current` is a symlink into /opt/yoal/releases there), and replacing them in place
 * would break that release's rollback.
 */

export const NODE_BUNDLE_FILES = ['yoal-agent', 'yoal-helper'] as const;

export interface NodeUpdateRequest {
	version: string;
	repo: string;
}

export interface NodeUpdateResult {
	version: string;
	previous: string;
	installed: string[];
	/** Whether the rollback guard is armed; false where systemd-run is unavailable (a container). */
	guarded: boolean;
}

/**
 * How long a freshly installed release has to prove itself before the node rolls back on its own.
 * The new agent confirms after its first heartbeat the control plane accepts, which normally takes
 * seconds; ten minutes covers a slow restart and a brief control-plane blip.
 */
export const NODE_UPDATE_GUARD_SECONDS = 600;
/** The transient `.timer`/`.service` pair `systemd-run` creates for the guard. */
export const NODE_UPDATE_GUARD_UNIT = 'yoal-node-update-guard';

/** The armed guard, in `node-update-guard.json` beside the work dir (root-only). */
export interface NodeUpdateGuard {
	/** The release being proven. */
	version: string;
	/** The release the guard restores. */
	previous: string;
	/** Epoch milliseconds. */
	armedAt: number;
	/** Epoch milliseconds when the timer fires. */
	deadline: number;
}

/** What the guard script leaves behind after it rolled a node back. */
export interface NodeUpdateRollback {
	/** The release that never confirmed. */
	from: string;
	/** The release now running again. */
	to: string;
	afterSeconds: number;
	/** ISO time from `date -u -Iseconds`; empty if `date` failed. */
	rolledBackAt: string;
}

export interface NodeUpdateGuardStatus {
	guard: NodeUpdateGuard | null;
	rollback: NodeUpdateRollback | null;
}

export interface NodeUpdatePaths {
	/** The agent binary the units run (`yoal-builder`/`yoal-storage` are symlinks to it). */
	agentBinary: string;
	/** This helper's own binary. */
	helperBinary: string;
	/** A symlink here marks a control-plane release layout, which is refused. */
	releaseLink: string;
	/** Root-only scratch space for the download. */
	workDir: string;
}

export interface NodeUpdateDeps {
	paths: NodeUpdatePaths;
	/** The running helper's version (embedded at build time). */
	currentVersion: string;
	fetch?: typeof fetch;
	trustedKeys?: () => Map<string, KeyObject>;
	platform?: () => string;
	/** List an archive's entries (`tar -tzf`). */
	list?: (archive: string) => Promise<string[]>;
	/** Unpack an archive (`tar -xzf … -C dest`). */
	extract?: (archive: string, dest: string) => Promise<void>;
	/** Restart the agent and this helper once the response is out. */
	scheduleRestart?: () => void;
	/** Seconds before an unconfirmed install rolls back (`NODE_UPDATE_GUARD_SECONDS`). */
	guardSeconds?: number;
	/** Absolute systemctl; `systemd-run` is expected beside it. */
	systemctlPath?: string;
	/** Run a command without a shell (systemd-run/systemctl for the guard). */
	exec?: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
	now?: () => number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class NodeUpdateError extends Error {}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const METADATA_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Generous for two compiled Bun binaries; a bigger bundle is refused before it fills the disk. */
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

/** `POST /v1/node/update/confirm` takes exactly `{ version }`, a plain release version. */
export function parseNodeUpdateConfirm(body: unknown): { version: string } {
	if (typeof body !== 'object' || body === null || Array.isArray(body))
		throw new ValidationError('request must be an object');
	const record = body as Record<string, unknown>;
	const extra = Object.keys(record).filter((key) => key !== 'version');
	if (extra.length) throw new ValidationError(`unexpected field ${extra[0]}`);
	if (typeof record.version !== 'string' || !VERSION_PATTERN.test(record.version))
		throw new ValidationError('version must be a release version like 1.2.3');
	return { version: record.version };
}

export function parseNodeUpdateRequest(body: unknown): NodeUpdateRequest {
	if (typeof body !== 'object' || body === null || Array.isArray(body))
		throw new ValidationError('request must be an object');
	const record = body as Record<string, unknown>;
	const extra = Object.keys(record).filter((key) => key !== 'version' && key !== 'repo');
	if (extra.length) throw new ValidationError(`unexpected field ${extra[0]}`);
	if (typeof record.version !== 'string' || !VERSION_PATTERN.test(record.version))
		throw new ValidationError('version must be a release version like 1.2.3');
	if (typeof record.repo !== 'string' || record.repo.length > 140 || !REPO_PATTERN.test(record.repo))
		throw new ValidationError('repo must be owner/name');
	return { version: record.version, repo: record.repo };
}

export class NodeUpdater {
	private busy = false;
	private readonly fetch: typeof fetch;
	private readonly trustedKeys: () => Map<string, KeyObject>;
	private readonly platform: () => string;
	private readonly list: (archive: string) => Promise<string[]>;
	private readonly extract: (archive: string, dest: string) => Promise<void>;
	private readonly scheduleRestart: () => void;
	private readonly guardSeconds: number;
	private readonly systemctl: string;
	private readonly exec: NonNullable<NodeUpdateDeps['exec']>;
	private readonly now: () => number;
	private readonly log: NonNullable<NodeUpdateDeps['log']>;

	constructor(private readonly deps: NodeUpdateDeps) {
		this.fetch = deps.fetch ?? fetch;
		this.trustedKeys = deps.trustedKeys ?? (() => loadTrustedKeys());
		this.platform = deps.platform ?? hostPlatform;
		this.list = deps.list ?? tarList;
		this.extract = deps.extract ?? tarExtract;
		this.scheduleRestart = deps.scheduleRestart ?? restartNodeServices;
		this.guardSeconds = deps.guardSeconds ?? NODE_UPDATE_GUARD_SECONDS;
		this.systemctl = deps.systemctlPath ?? '/usr/bin/systemctl';
		this.exec = deps.exec ?? execArgv;
		this.now = deps.now ?? Date.now;
		this.log = deps.log ?? (() => undefined);
	}

	/**
	 * The new agent's word that it runs and the control plane accepted its heartbeat. Only a guard
	 * armed for `version` is disarmed; anything else answers `confirmed: false`, so a retried or
	 * late confirm is harmless.
	 */
	async confirm(version: string): Promise<{ confirmed: boolean }> {
		const files = guardFiles(this.deps.paths);
		const guard = await readGuard(files.guard);
		if (!guard || guard.version !== version) return { confirmed: false };
		// The marker first: if the timer fires while we stop it, the script still sees the confirm.
		await writeFileAtomic(files.confirmed, `${version}\n`);
		await this.disarm();
		await fs.rm(files.guard, { force: true });
		this.log('info', `${version} confirmed a healthy heartbeat; rollback guard disarmed`);
		return { confirmed: true };
	}

	/** The armed guard and the last rollback, so the agent can explain why it runs the old version. */
	async guardStatus(): Promise<NodeUpdateGuardStatus> {
		const files = guardFiles(this.deps.paths);
		return { guard: await readGuard(files.guard), rollback: await readRollback(files.rollback) };
	}

	/**
	 * Arm a one-shot timer that restores `.previous` unless the new release confirms in time. It
	 * runs as its own transient unit, outside both services, so neither new binary has to work for
	 * it to fire. Best effort: without systemd-run the update goes ahead unguarded.
	 */
	private async arm(version: string, previous: string): Promise<boolean> {
		const files = guardFiles(this.deps.paths);
		try {
			await this.disarm();
			await fs.rm(files.confirmed, { force: true });
			const script = renderGuardScript({
				version,
				previous,
				agentBinary: this.deps.paths.agentBinary,
				helperBinary: this.deps.paths.helperBinary,
				confirmedPath: files.confirmed,
				guardPath: files.guard,
				rollbackPath: files.rollback,
				systemctlPath: this.systemctl,
				guardSeconds: this.guardSeconds,
			});
			const argv = renderGuardArgv(join(dirname(this.systemctl), 'systemd-run'), this.guardSeconds, script);
			const armedAt = this.now();
			const result = await this.exec(argv);
			if (result.code !== 0) throw new Error(`systemd-run exited ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
			const guard: NodeUpdateGuard = { version, previous, armedAt, deadline: armedAt + this.guardSeconds * 1000 };
			await writeFileAtomic(files.guard, `${JSON.stringify(guard)}\n`);
			return true;
		} catch (error) {
			this.log(
				'warn',
				`could not arm the rollback guard, continuing unguarded: ${error instanceof Error ? error.message : String(error)}`,
			);
			await this.disarm().catch(() => undefined);
			return false;
		}
	}

	/** Stop the timer (and a still-queued run) and clear failed state; "not loaded" is fine. */
	private async disarm(): Promise<void> {
		const units = [`${NODE_UPDATE_GUARD_UNIT}.timer`, `${NODE_UPDATE_GUARD_UNIT}.service`];
		await this.exec([this.systemctl, 'stop', ...units]).catch(() => undefined);
		await this.exec([this.systemctl, 'reset-failed', ...units]).catch(() => undefined);
	}

	async update(request: NodeUpdateRequest): Promise<NodeUpdateResult> {
		if (this.busy) throw new NodeUpdateError('a node update is already running');
		this.busy = true;
		try {
			const result = await this.install(request);
			// After the caller has its answer: restarting the helper ends this process.
			this.scheduleRestart();
			return result;
		} finally {
			this.busy = false;
		}
	}

	private async install({ version, repo }: NodeUpdateRequest): Promise<NodeUpdateResult> {
		const { paths, currentVersion } = this.deps;
		await this.refuseReleaseLayout();
		if (!(await isFile(paths.agentBinary)))
			throw new NodeUpdateError(`no agent binary at ${paths.agentBinary}; this node was not installed the way the updater expects`);
		if (compareVersions(version, currentVersion) < 0)
			throw new NodeUpdateError(`refusing to downgrade from ${currentVersion} to ${version}`);

		const base = `https://github.com/${repo}/releases/download/v${version}`;
		const manifestBytes = await this.download(`${base}/manifest.json`, `v${version} has no signed manifest in ${repo}`);
		const signature = new TextDecoder().decode(
			await this.download(`${base}/manifest.json.sig`, `v${version} has no manifest signature in ${repo}`),
		);
		let manifest;
		try {
			manifest = verifyManifest(manifestBytes, signature, this.trustedKeys());
		} catch (error) {
			if (error instanceof SignatureError) throw new NodeUpdateError(`v${version} is not trusted: ${error.message}`);
			throw error;
		}
		if (manifest.version !== version)
			throw new NodeUpdateError(`v${version}'s signed manifest describes ${manifest.version}; refusing a mislabelled release`);
		if (manifest.repo.toLowerCase() !== repo.toLowerCase())
			throw new NodeUpdateError(`v${version}'s signed manifest is for ${manifest.repo}, not ${repo}`);
		const platform = this.platform();
		const entry = manifest.nodeArtifacts?.[platform];
		if (!entry)
			throw new NodeUpdateError(
				`v${version} ships no node bundle for ${platform}${manifest.nodeArtifacts ? '' : ' (it predates node updates)'}`,
			);
		assertBundleEntry(entry);

		await fs.rm(paths.workDir, { recursive: true, force: true });
		await fs.mkdir(paths.workDir, { recursive: true, mode: 0o700 });
		try {
			const archive = join(paths.workDir, entry.file);
			this.log('info', `downloading ${entry.file} (${(entry.size / 1024 ** 2).toFixed(0)} MiB) from v${version}`);
			await this.downloadTo(`${base}/${entry.file}`, archive, entry.size);
			const sha256 = await sha256Of(archive);
			if (sha256 !== entry.sha256)
				throw new NodeUpdateError(`${entry.file} does not match its signed checksum (got ${sha256.slice(0, 16)}…)`);

			const entries = (await this.list(archive)).filter(Boolean);
			const expected = [...NODE_BUNDLE_FILES].sort();
			if (JSON.stringify([...entries].sort()) !== JSON.stringify(expected))
				throw new NodeUpdateError(`${entry.file} must contain exactly ${expected.join(' and ')}; found ${entries.join(', ') || 'nothing'}`);
			const stage = join(paths.workDir, 'stage');
			await fs.mkdir(stage, { mode: 0o700 });
			await this.extract(archive, stage);

			// Stage both before swapping either, so a failure leaves the old pair in place.
			const targets = [
				{ source: join(stage, 'yoal-agent'), dest: paths.agentBinary },
				{ source: join(stage, 'yoal-helper'), dest: paths.helperBinary },
			];
			for (const { source, dest } of targets) {
				if (!(await isFile(source))) throw new NodeUpdateError(`${entry.file} did not unpack ${source}`);
				await fs.mkdir(dirname(dest), { recursive: true });
				await fs.copyFile(source, `${dest}.new`);
				await fs.chmod(`${dest}.new`, 0o755);
				await fs.chown(`${dest}.new`, 0, 0).catch(() => undefined);
			}
			// `.previous` must be exactly what runs now: the guard restores it. A stale copy from an
			// older update would roll the node back further than it came from, so it goes.
			for (const { dest } of targets) {
				if (await isFile(dest)) await fs.copyFile(dest, `${dest}.previous`);
				else await fs.rm(`${dest}.previous`, { force: true });
			}
			const guarded = await this.arm(version, currentVersion);
			let swapped = 0;
			try {
				// Rename is atomic over a running binary.
				for (const { dest } of targets) {
					await fs.rename(`${dest}.new`, dest);
					swapped += 1;
				}
			} catch (error) {
				// Nothing replaced: the old pair keeps running and there is nothing to roll back.
				// Half replaced: leave the guard armed, it restores the pair if nothing confirms.
				if (guarded && swapped === 0) await this.disarm().then(() => fs.rm(guardFiles(paths).guard, { force: true }));
				throw error;
			}
			this.log(
				'info',
				`installed yoal-agent and yoal-helper ${version} (was ${currentVersion}); restarting${guarded ? `, rolling back in ${this.guardSeconds}s unless it confirms` : ' (unguarded)'}`,
			);
			return { version, previous: currentVersion, installed: targets.map((target) => target.dest), guarded };
		} finally {
			for (const dest of [paths.agentBinary, paths.helperBinary])
				await fs.rm(`${dest}.new`, { force: true }).catch(() => undefined);
			await fs.rm(paths.workDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async refuseReleaseLayout(): Promise<void> {
		const stat = await fs.lstat(this.deps.paths.releaseLink).catch(() => null);
		if (stat?.isSymbolicLink())
			throw new NodeUpdateError(
				`${this.deps.paths.releaseLink} is a control-plane release; this node updates with yoal-update-self, not from the node list`,
			);
	}

	private async download(url: string, missing: string): Promise<Uint8Array> {
		const response = await this.fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS), redirect: 'follow' });
		if (response.status === 404) throw new NodeUpdateError(missing);
		if (!response.ok) throw new NodeUpdateError(`GitHub ${response.status} fetching ${url}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length > 1024 * 1024) throw new NodeUpdateError(`${url} is unexpectedly large`);
		return bytes;
	}

	private async downloadTo(url: string, path: string, size: number): Promise<void> {
		const response = await this.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' });
		if (!response.ok || !response.body) throw new NodeUpdateError(`GitHub ${response.status} downloading ${url}`);
		// Streamed by hand so an oversized body stops at the signed size instead of filling the disk.
		const handle = await fs.open(path, 'w', 0o600);
		let written = 0;
		try {
			for await (const chunk of response.body) {
				written += chunk.byteLength;
				if (written > size) throw new NodeUpdateError(`${url} is larger than the ${size} bytes its signed manifest says`);
				await handle.write(chunk);
			}
		} finally {
			await handle.close();
		}
		if (written !== size) throw new NodeUpdateError(`${url} is ${written} bytes; the signed manifest says ${size}`);
	}
}

function assertBundleEntry(entry: ManifestArtifact): void {
	if (!/^yoal-node-[\w.-]+\.tar\.gz$/.test(entry.file)) throw new NodeUpdateError(`unexpected node bundle name ${entry.file}`);
	if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new NodeUpdateError('the node bundle has no sha256');
	if (!Number.isInteger(entry.size) || entry.size <= 0 || entry.size > MAX_BUNDLE_BYTES)
		throw new NodeUpdateError(`the node bundle size (${entry.size}) is out of range`);
}

/** -1, 0 or 1 for plain `x.y.z` versions; an unparseable current version never blocks an update. */
export function compareVersions(a: string, b: string): number {
	const left = VERSION_PATTERN.exec(a);
	const right = VERSION_PATTERN.exec(b);
	if (!left || !right) return 1;
	for (let index = 1; index <= 3; index += 1) {
		const diff = Number(left[index]) - Number(right[index]);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
}

async function isFile(path: string): Promise<boolean> {
	return (await fs.stat(path).catch(() => null))?.isFile() ?? false;
}

async function sha256Of(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest('hex');
}

function run(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0 ? resolve(stdout) : reject(new NodeUpdateError(`${command} ${args[0]} failed: ${stderr.trim().slice(0, 300)}`)),
		);
	});
}

async function tarList(archive: string): Promise<string[]> {
	return (await run('tar', ['-tzf', archive])).split('\n').map((line) => line.trim()).filter(Boolean);
}

async function tarExtract(archive: string, dest: string): Promise<void> {
	await run('tar', ['-xzf', archive, '-C', dest, '--no-same-owner', ...NODE_BUNDLE_FILES]);
}

/**
 * The `systemctl --no-block` restarts after a swap, shared by the verb and the rollback guard. The
 * builder, studio and mail run the agent binary too, but only where they are enabled.
 */
export const NODE_RESTARTS: readonly (readonly string[])[] = [
	['try-restart', 'yoal-builder.service', 'yoal-studio.service', 'yoal-mail.service'],
	['restart', 'yoal-agent.service', 'yoal-helper.service'],
];

/**
 * Queue the restarts with systemd and return at once (`--no-block`): the helper's own restart ends
 * this process, so it must not wait.
 */
export function restartNodeServices(systemctl = '/usr/bin/systemctl'): void {
	setTimeout(() => {
		for (const args of NODE_RESTARTS)
			spawn(systemctl, ['--no-block', ...args], { stdio: 'ignore', detached: true }).unref();
	}, 500);
}

/** Root-only state beside the work dir (which is wiped on every update). */
export function guardFiles(paths: Pick<NodeUpdatePaths, 'workDir'>): { guard: string; confirmed: string; rollback: string } {
	const dir = dirname(paths.workDir);
	return {
		guard: join(dir, 'node-update-guard.json'),
		confirmed: join(dir, 'node-update-confirmed'),
		rollback: join(dir, 'node-update-rollback.json'),
	};
}

/** POSIX single-quoting: the only character that needs care inside '…' is ' itself. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface GuardScriptInput {
	version: string;
	previous: string;
	agentBinary: string;
	helperBinary: string;
	confirmedPath: string;
	guardPath: string;
	rollbackPath: string;
	systemctlPath: string;
	guardSeconds: number;
}

/**
 * The rollback the guard timer runs as `/bin/sh -c`. It uses only coreutils, never either new
 * binary, so it works however broken the new release is. Unless the confirm marker names this
 * version it copies each `.previous` to a temp name beside the binary and renames it over (atomic,
 * and `.previous` survives for another try), records the rollback and queues the same restarts as
 * an update.
 *
 * The script contains no `$`: the service manager expands `$VAR` in a transient unit's command
 * line on most systemd versions, and `$$` would not survive the ones that do not. Paths carrying
 * `$`, `%`, a newline or NUL are refused rather than escaped for both layers.
 */
export function renderGuardScript(input: GuardScriptInput): string {
	for (const [name, value] of Object.entries(input))
		if (typeof value === 'string' && /[$%\n\0]/.test(value)) throw new NodeUpdateError(`${name} cannot be used in the rollback guard`);
	if (!VERSION_PATTERN.test(input.version) || !VERSION_PATTERN.test(input.previous))
		throw new NodeUpdateError('the rollback guard needs plain release versions');
	const q = shellQuote;
	const restore = (binary: string) =>
		`cp -p ${q(`${binary}.previous`)} ${q(`${binary}.rollback`)} && chmod 0755 ${q(`${binary}.rollback`)} && mv -f ${q(`${binary}.rollback`)} ${q(binary)} || exit 1`;
	const marker = JSON.stringify({ from: input.version, to: input.previous, afterSeconds: input.guardSeconds });
	return [
		`grep -qxF ${q(input.version)} ${q(input.confirmedPath)} 2>/dev/null && exit 0`,
		`[ -f ${q(`${input.agentBinary}.previous`)} ] || exit 1`,
		restore(input.agentBinary),
		`if [ -f ${q(`${input.helperBinary}.previous`)} ]; then ${restore(input.helperBinary)}; fi`,
		// One line of JSON with the time from `date`, without a `$(…)`.
		`{ echo ${q(`${marker.slice(0, -1)},"rolledBackAt":"`)}; date -u -Iseconds; echo ${q('"}')}; } | tr -d '\\n' > ${q(`${input.rollbackPath}.tmp`)} && mv -f ${q(`${input.rollbackPath}.tmp`)} ${q(input.rollbackPath)}`,
		`rm -f ${q(input.guardPath)}`,
		...NODE_RESTARTS.map((args) => [q(input.systemctlPath), '--no-block', ...args].join(' ')),
	].join('\n');
}

/** `systemd-run` argv for the guard: a transient timer firing once, `seconds` from now. */
export function renderGuardArgv(systemdRun: string, seconds: number, script: string): string[] {
	return [
		systemdRun,
		`--unit=${NODE_UPDATE_GUARD_UNIT}`,
		'--description=Yoal node update rollback guard',
		`--on-active=${seconds}s`,
		'--timer-property=AccuracySec=5s',
		'/bin/sh',
		'-c',
		script,
	];
}

async function readGuard(path: string): Promise<NodeUpdateGuard | null> {
	const value = await readJsonFile(path);
	if (
		!value ||
		typeof value.version !== 'string' ||
		typeof value.previous !== 'string' ||
		typeof value.armedAt !== 'number' ||
		typeof value.deadline !== 'number'
	)
		return null;
	return { version: value.version, previous: value.previous, armedAt: value.armedAt, deadline: value.deadline };
}

async function readRollback(path: string): Promise<NodeUpdateRollback | null> {
	const value = await readJsonFile(path);
	if (!value || typeof value.from !== 'string' || typeof value.to !== 'string') return null;
	return {
		from: value.from,
		to: value.to,
		afterSeconds: typeof value.afterSeconds === 'number' ? value.afterSeconds : NODE_UPDATE_GUARD_SECONDS,
		rolledBackAt: typeof value.rolledBackAt === 'string' ? value.rolledBackAt : '',
	};
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
	try {
		const value = JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
		return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp`;
	await fs.writeFile(temp, contents, { mode: 0o600 });
	await fs.rename(temp, path);
}

function execArgv(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const [command, ...args] = argv;
		if (!command) return reject(new Error('Refusing to run an empty command'));
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
		child.on('error', reject);
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}
