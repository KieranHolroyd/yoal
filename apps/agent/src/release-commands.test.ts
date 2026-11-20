import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
	async startJob(input: Parameters<HelperJobApi['startJob']>[0]): Promise<HelperJobStatus> {
		this.calls.push(`start:${input.run.runId}:${input.workload.release ?? 'no-release'}`);
		this.starts.push(input);
		if (this.failStart) throw this.failStart;
		return this.current;
	}
	async jobStatus(runId: string, timeout?: number): Promise<HelperJobStatus> {
		this.calls.push(`status:${runId}:${timeout}`);
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
});
