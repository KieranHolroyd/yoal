import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	desiredStateSchema,
	type DesiredState,
	type ReleaseCommandTask,
	type WorkloadActivation,
	type WorkloadDesired,
} from '@yoal/contracts';
import { ReleaseCommandRunner, releaseHelperRunId, type HelperJobApi, type HelperJobStatus } from './jobs.ts';

const SHA = 'a'.repeat(64);
const ACTIVATION = 'b'.repeat(64);
const RC = `rc_${'1'.repeat(32)}`;
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const task = (overrides: Partial<ReleaseCommandTask> = {}): ReleaseCommandTask => ({
	runId: RC,
	releaseId: 'dep_2',
	workloadId: 'wld_1',
	release: SHA,
	command: ['bun', 'run', 'db:migrate'],
	timeoutSeconds: 60,
	attempt: 1,
	startBy: '2026-11-20T10:05:00Z',
	...overrides,
});

function workload(overrides: Partial<WorkloadDesired> = {}): WorkloadDesired {
	const parsed = desiredStateSchema.parse({
		version: 1,
		nodeId: 'nod_1',
		agentVersion: '0.1.0',
		generatedAt: '2026-11-20T09:00:00.000Z',
		contentDomain: 'example.com',
		releases: [],
		routes: [],
		workloads: [
			{
				id: 'wld_1',
				projectId: 'prj_1',
				projectSlug: 'shop',
				deploymentId: 'dep_1',
				runtime: 'process',
				status: 'running',
				release: 'c'.repeat(64),
				upstream: 'unix//run/yoal-workloads/prj_1.sock',
				memoryMb: 256,
				cpus: 1,
				port: 3000,
				healthPath: '/healthz',
				socketActivation: true,
				activationVersion: ACTIVATION,
				env: { NODE_ENV: 'production' },
				secrets: [],
				dataSizeMb: null,
				...overrides,
			},
		],
	});
	return parsed.workloads[0]!;
}

function state(releaseCommands: ReleaseCommandTask[], overrides: Partial<WorkloadDesired> = {}): DesiredState {
	return desiredStateSchema.parse({
		version: 1,
		nodeId: 'nod_1',
		agentVersion: '0.1.0',
		generatedAt: '2026-11-20T10:00:00.000Z',
		contentDomain: 'example.com',
		releases: [{ sha256: SHA, url: 'https://r2.example.com/a.zip', sizeBytes: 1, fileCount: 1, precompressed: false }],
		routes: [],
		workloads: [workload(overrides)],
		releaseCommands,
	});
}

function status(outcome: HelperJobStatus['outcome'], extra: Partial<HelperJobStatus> = {}): HelperJobStatus {
	return {
		runId: releaseHelperRunId(RC),
		outcome,
		exitCode: outcome === 'succeeded' ? 0 : null,
		signal: null,
		startedAt: 1_000,
		finishedAt: outcome === 'running' ? null : 2_000,
		...extra,
	};
}

class FakeHelper implements HelperJobApi {
	calls: string[] = [];
	starts: Array<Parameters<HelperJobApi['startJob']>[0]> = [];
	current: HelperJobStatus = status('running');
	failStart: Error | null = null;
	failStatus: Error | null = null;
	onStart: (() => void) | null = null;
	async startJob(input: Parameters<HelperJobApi['startJob']>[0]): Promise<HelperJobStatus> {
		this.calls.push(`start:${input.run.runId}:${input.workload.release ?? 'no-release'}`);
		this.starts.push(input);
		this.onStart?.();
		if (this.failStart) throw this.failStart;
		return this.current;
	}
	async jobStatus(runId: string, timeout?: number): Promise<HelperJobStatus> {
		this.calls.push(`status:${runId}:${timeout}`);
		if (this.failStatus) throw this.failStatus;
		return this.current;
	}
	async jobLogs() {
		return { entries: [], nextCursor: null };
	}
	async stopJob(runId: string, force = false): Promise<void> {
		this.calls.push(`stop:${runId}:${force}`);
	}
	async removeJob(runId: string): Promise<void> {
		this.calls.push(`remove:${runId}`);
	}
}

class FakeReleases {
	ensured: string[] = [];
	async hasRelease(): Promise<boolean> {
		return false;
	}
	async ensureRelease(spec: { sha256: string }): Promise<boolean> {
		this.ensured.push(spec.sha256);
		return true;
	}
}

function setup(options: { statePath?: string | null; now?: number } = {}) {
	const helper = new FakeHelper();
	const releases = new FakeReleases();
	let clock = options.now ?? Date.parse('2026-11-20T10:00:00Z');
	const runner = new ReleaseCommandRunner({
		helper,
		releases,
		fetchActivation: async (id) => ({ workloadId: id, activationVersion: ACTIVATION, env: { DATABASE_URL: 'postgres://secret' }, files: {} }) as WorkloadActivation,
		statePath: options.statePath ?? null,
		now: () => clock,
		sleep: async () => undefined,
	});
	return { helper, releases, runner, advance: (ms: number) => (clock += ms) };
}

const signal = new AbortController().signal;

describe('ReleaseCommandRunner', () => {
	test('runs once against the new release with the app activation, then reports success', async () => {
		const f = setup();
		const desired = state([task()]);
		await f.runner.tick(desired, signal);

		expect(f.helper.starts).toHaveLength(1);
		expect(f.helper.starts[0]!.run).toEqual({
			runId: releaseHelperRunId(RC),
			command: ['bun', 'run', 'db:migrate'],
			timeoutSeconds: 60,
		});
		// The new release, not the one the old copies still run.
		expect(f.helper.starts[0]!.workload.release).toBe(SHA);
		expect(f.helper.starts[0]!.activation.env.DATABASE_URL).toBe('postgres://secret');
		expect(f.releases.ensured).toEqual([SHA]);
		expect(f.runner.pendingResults(desired)).toEqual([
			expect.objectContaining({ runId: RC, releaseId: 'dep_2', status: 'running', startedAt: Date.parse('2026-11-20T10:00:00Z') }),
		]);

		f.helper.current = status('succeeded');
		await f.runner.tick(desired, signal);
		expect(f.runner.pendingResults(desired)).toEqual([
			expect.objectContaining({ runId: RC, status: 'succeeded', exitCode: 0 }),
		]);
	});

	test('a failed run is reported failed and is never started again', async () => {
		const f = setup();
		const desired = state([task()]);
		await f.runner.tick(desired, signal);
		f.helper.current = status('failed', { exitCode: 3 });
		await f.runner.tick(desired, signal);

		expect(f.runner.pendingResults(desired)).toEqual([
			expect.objectContaining({ runId: RC, status: 'failed', exitCode: 3, error: 'Exited with status 3.' }),
		]);
		// A replayed desired state (a partition lost the heartbeat, the control plane re-sends it)
		// must not run the command twice (I16).
		await f.runner.tick(desired, signal);
		expect(f.helper.starts).toHaveLength(1);
	});

	test('a lost start response does not become a second attempt', async () => {
		const f = setup();
		f.helper.failStart = new Error('helper connection reset');
		const desired = state([task()]);
		await f.runner.tick(desired, signal);
		// The helper did start the unit; the response was lost. It is watched, never restarted.
		expect(f.runner.pendingResults(desired)).toEqual([expect.objectContaining({ status: 'running' })]);
		await f.runner.tick(desired, signal);
		expect(f.helper.starts).toHaveLength(1);
	});

	test('refuses to run a process release command without the new release', async () => {
		const f = setup();
		const desired = state([task({ release: null })]);
		await f.runner.tick(desired, signal);
		expect(f.helper.starts).toEqual([]);
		expect(f.runner.pendingResults(desired)).toEqual([
			expect.objectContaining({ status: 'failed', error: expect.stringMatching(/needs the new release/) }),
		]);
	});

	test('refuses to start after startBy, and a clock that moves back cannot revive it', async () => {
		const f = setup({ now: Date.parse('2026-11-20T10:06:00Z') });
		const desired = state([task()]);
		await f.runner.tick(desired, signal);
		expect(f.helper.starts).toEqual([]);
		expect(f.runner.pendingResults(desired)).toEqual([
			expect.objectContaining({ status: 'failed', error: expect.stringMatching(/start deadline/) }),
		]);

		f.advance(-10 * 60_000); // an NTP step back must not make a stale lease runnable
		await f.runner.tick(desired, signal);
		expect(f.helper.starts).toEqual([]);
	});

	test('kills its run at the timeout with no control plane contact, then escalates', async () => {
		const f = setup();
		const desired = state([task({ timeoutSeconds: 30 })]);
		await f.runner.tick(desired, signal);
		expect(f.helper.starts).toHaveLength(1);

		f.advance(30_000);
		await f.runner.tick(desired, signal);
		expect(f.helper.calls).toContain(`stop:${releaseHelperRunId(RC)}:false`);

		f.advance(31_000);
		await f.runner.tick(desired, signal);
		expect(f.helper.calls).toContain(`stop:${releaseHelperRunId(RC)}:true`);

		f.helper.current = status('timeout', { signal: 15 });
		await f.runner.tick(desired, signal);
		expect(f.runner.pendingResults(desired)).toEqual([
			expect.objectContaining({ status: 'timeout', error: 'Timed out after 30 s.' }),
		]);
	});

	test('a restarted agent resumes the report and never starts the same run id again', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-release-commands-'));
		dirs.push(dir);
		const statePath = join(dir, 'release-commands-state.json');
		const first = setup({ statePath });
		const desired = state([task()]);
		await first.runner.tick(desired, signal);
		first.helper.current = status('succeeded');
		await first.runner.tick(desired, signal);

		const second = setup({ statePath });
		await second.runner.tick(desired, signal);
		expect(second.helper.starts).toEqual([]);
		expect(second.runner.pendingResults(desired)).toEqual([
			expect.objectContaining({ runId: RC, status: 'succeeded' }),
		]);
	});

	test('stops a run whose task leaves desired state rather than finish without the lease', async () => {
		const f = setup();
		await f.runner.tick(state([task()]), signal);
		await f.runner.tick(state([], {}), signal);
		expect(f.helper.calls).toContain(`stop:${releaseHelperRunId(RC)}:false`);
	});

	test('flag off (no releaseCommands) is a no-op and reports nothing', async () => {
		const f = setup();
		await f.runner.tick(state([]), signal);
		expect(f.helper.calls).toEqual([]);
		expect(f.runner.pendingResults(state([]))).toEqual([]);
		expect(f.runner.heldRuns()).toEqual([]);
	});

	test('a desired state that could not be fetched (null) never stops a held run', async () => {
		const f = setup();
		const desired = state([task()]);
		await f.runner.tick(desired, signal);
		await f.runner.tick(null, signal);
		expect(f.helper.calls.filter((call) => call.startsWith('stop:'))).toEqual([]);
		expect(f.runner.pendingResults(desired)).toEqual([expect.objectContaining({ status: 'running' })]);
	});

	test('the run id is on disk before the helper is asked to start it (I16)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-release-commands-'));
		dirs.push(dir);
		const statePath = join(dir, 'release-commands-state.json');
		const f = setup({ statePath });
		let onDisk: string[] = [];
		f.helper.onStart = () => {
			onDisk = (JSON.parse(readFileSync(statePath, 'utf8')) as { seen: string[] }).seen;
		};
		await f.runner.tick(state([task()]), signal);
		expect(f.helper.starts).toHaveLength(1);
		expect(onDisk).toEqual([RC]);
	});
});

describe('ReleaseCommandRunner with a corrupt state file (I16)', () => {
	const TRUNCATED = `{"version":1,"seen":["${RC}"],"runs":[{"runId":"${RC}`;
	const corrupt = () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-release-commands-'));
		dirs.push(dir);
		const statePath = join(dir, 'release-commands-state.json');
		writeFileSync(statePath, TRUNCATED);
		return { dir, statePath };
	};

	for (const [label, content] of [
		['an empty object', '{}'],
		['an array', '[]'],
		['a string', '"x"'],
		['a non-array seen', `{"version":1,"seen":"${RC}","runs":[]}`],
		['an unknown version', `{"version":2,"seen":[],"runs":[]}`],
	] as const)
		test(`valid JSON in the wrong shape (${label}) is quarantined, never read as an empty history`, async () => {
			const dir = mkdtempSync(join(tmpdir(), 'yoal-release-commands-'));
			dirs.push(dir);
			const statePath = join(dir, 'release-commands-state.json');
			writeFileSync(statePath, content);
			const f = setup({ statePath });
			f.helper.current = status('running', { startedAt: Date.parse('2026-11-20T09:59:30Z') });
			await f.runner.tick(state([task({ timeoutSeconds: 60 })]), signal);
			expect(f.helper.starts).toEqual([]);
			expect(f.helper.calls[0]).toBe(`status:${releaseHelperRunId(RC)}:60`);
		});

	test('a run still going in the helper is adopted and watched, never started or failed', async () => {
		const { statePath } = corrupt();
		const f = setup({ statePath });
		f.helper.current = status('running', { startedAt: Date.parse('2026-11-20T09:59:30Z') });
		const desired = state([task({ timeoutSeconds: 60 })]);
		await f.runner.tick(desired, signal);

		expect(f.helper.calls[0]).toBe(`status:${releaseHelperRunId(RC)}:60`);
		expect(f.helper.starts).toEqual([]);
		expect(f.runner.pendingResults(desired)).toEqual([expect.objectContaining({ runId: RC, status: 'running' })]);
		// Watched like any held run: the node's own timeout runs from the helper's start time.
		f.advance(31_000);
		await f.runner.tick(desired, signal);
		expect(f.helper.calls).toContain(`stop:${releaseHelperRunId(RC)}:false`);
		f.helper.current = status('timeout', { signal: 15 });
		await f.runner.tick(desired, signal);
		expect(f.runner.pendingResults(desired)).toEqual([expect.objectContaining({ runId: RC, status: 'timeout' })]);
		expect(f.helper.starts).toEqual([]);
	});

	test('a run the helper already finished reports the helper’s outcome', async () => {
		const { statePath } = corrupt();
		const f = setup({ statePath });
		f.helper.current = status('succeeded');
		const desired = state([task()]);
		await f.runner.tick(desired, signal);
		expect(f.helper.starts).toEqual([]);
		expect(f.runner.pendingResults(desired)).toEqual([expect.objectContaining({ status: 'succeeded', exitCode: 0 })]);
		expect(f.helper.calls).toContain(`remove:${releaseHelperRunId(RC)}`);
	});

	test('a run the helper does not know is reported timeout (unknown), never failed', async () => {
		const { statePath } = corrupt();
		const f = setup({ statePath });
		f.helper.current = status('not-found');
		const desired = state([task()]);
		await f.runner.tick(desired, signal);
		expect(f.helper.starts).toEqual([]);
		expect(f.runner.pendingResults(desired)).toEqual([
			expect.objectContaining({ status: 'timeout', error: expect.stringMatching(/unknown/) }),
		]);
	});

	test('an unreachable helper decides nothing until it answers', async () => {
		const { statePath } = corrupt();
		const f = setup({ statePath });
		f.helper.failStatus = new Error('helper socket refused');
		const desired = state([task()]);
		await f.runner.tick(desired, signal);
		expect(f.runner.pendingResults(desired)).toEqual([]);
		expect(f.helper.starts).toEqual([]);

		f.helper.failStatus = null;
		f.helper.current = status('running');
		await f.runner.tick(desired, signal);
		expect(f.runner.pendingResults(desired)).toEqual([expect.objectContaining({ status: 'running' })]);
		expect(f.helper.starts).toEqual([]);
	});

	test('the corrupt file is moved aside intact and keeps refusing across restarts until removed', async () => {
		const { statePath } = corrupt();
		const first = setup({ statePath });
		first.helper.current = status('not-found');
		await first.runner.tick(state([task()]), signal);
		expect(readFileSync(`${statePath}.corrupt`, 'utf8')).toBe(TRUNCATED);

		// Restart, then a new release's task: still refused, still reconciled, never started.
		const other = `rc_${'2'.repeat(32)}`;
		const second = setup({ statePath });
		second.helper.current = status('not-found', { runId: releaseHelperRunId(other) });
		const next = state([task({ runId: other, releaseId: 'dep_3' })]);
		await second.runner.tick(next, signal);
		expect(second.helper.starts).toEqual([]);
		expect(second.runner.pendingResults(next)).toEqual([expect.objectContaining({ runId: other, status: 'timeout' })]);
		expect(readFileSync(`${statePath}.corrupt`, 'utf8')).toBe(TRUNCATED);

		// A person removes the quarantined file: new runs start again.
		rmSync(`${statePath}.corrupt`);
		const third = `rc_${'3'.repeat(32)}`;
		const after = setup({ statePath });
		await after.runner.tick(state([task({ runId: third, releaseId: 'dep_4' })]), signal);
		expect(after.helper.starts).toHaveLength(1);
	});

	test('a corrupt file that cannot be moved aside is never written over', async () => {
		const { dir, statePath } = corrupt();
		chmodSync(dir, 0o500);
		try {
			const f = setup({ statePath });
			f.helper.current = status('not-found');
			await f.runner.tick(state([task()]), signal);
			expect(f.helper.starts).toEqual([]);
			expect(readFileSync(statePath, 'utf8')).toBe(TRUNCATED);
			expect(existsSync(`${statePath}.corrupt`)).toBe(false);
		} finally {
			chmodSync(dir, 0o700);
		}
	});
});
