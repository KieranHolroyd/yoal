import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, deployments, nodes, releaseCommandRuns, releases, workloadReplicas, workloads } from '@yoal/db';
import { DEFAULT_FEATURES, workloadSpecSchema, type FeatureFlags } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { RELEASE_START_WINDOW_MS, ReleaseCommandScheduler } from './release-commands.ts';

/**
 * HA-PLAN H25 / invariant I16: one release-command attempt per release, leased to one node with a
 * start deadline; a failure frees the lease for a retry, a success closes it, and a lost node turns
 * into `timeout` with an unknown outcome that is never retried automatically.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-w1-release-commands-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const spec = workloadSpecSchema.parse({
	runtime: 'process',
	command: ['bun', 'run', 'start'],
	port: 3000,
	replicas: 1,
	release: { command: ['bin/migrate'] },
});

let clock = 1_000_000_000;

/** A heartbeat result with the fields the agent always sends. */
const result = (
	runId: string,
	releaseId: string,
	status: 'failed' | 'running' | 'succeeded' | 'timeout',
	extra: { exitCode?: number | null; error?: string | null; startedAt?: number | null; finishedAt?: number | null } = {},
) => ({ runId, releaseId, status, exitCode: null, startedAt: null, finishedAt: null, error: null, ...extra });

function makeCore(features: Partial<FeatureFlags> = {}) {
	const opened = createDb({ path: ':memory:' });
	const core = createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '0.1.0',
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
			features: { ...DEFAULT_FEATURES, RELEASE_PHASE: true, ...features },
			now: () => clock,
		},
	});
	return { core, close: () => opened.sqlite.close() };
}

async function fixture(options: { capabilities?: string[]; online?: boolean } = {}) {
	clock = 1_000_000_000;
	const { core, close } = makeCore();
	const node = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'node-a').token, name: 'node-a' });
	core.ctx.db
		.update(nodes)
		.set({
			status: options.online === false ? 'offline' : 'online',
			capabilitiesJson: JSON.stringify(options.capabilities ?? ['release-phase']),
			lastHeartbeatAt: clock,
		})
		.where(eq(nodes.id, node.nodeId))
		.run();
	const project = await core.projects.create(principal, {
		name: 'app',
		slug: 'app',
		runtime: 'process',
		placement: node.nodeId,
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	const row = core.projects.requireRow(principal, 'app');
	core.ctx.db
		.insert(workloads)
		.values({
			id: 'wl_1',
			orgId: 'org_1',
			projectId: project.id,
			deploymentId: 'dep_0',
			nodeId: node.nodeId,
			runtime: 'process',
			runtimeName: 'process',
			status: 'running',
			specJson: JSON.stringify(spec),
			memoryMb: 256,
			cpus: 1,
		})
		.run();
	// The app has a second copy on another node; the release command may run on either.
	core.ctx.db
		.insert(workloadReplicas)
		.values({ id: 'wr_1', workloadId: 'wl_1', projectId: project.id, nodeId: node.nodeId, replicaIndex: 0, status: 'running' })
		.run();

	let counter = 0;
	const deployment = (env: Record<string, string>) => {
		const id = `dep_${++counter}`;
		core.ctx.db
			.insert(deployments)
			.values({
				id,
				orgId: 'org_1',
				projectId: project.id,
				releaseId: `rel_${counter}`,
				configSnapshotId: `cfgsnap_${counter}`,
				shortId: `short${counter}`,
				environmentId: null,
				runtime: 'process',
				runtimeName: 'process',
				workloadJson: JSON.stringify({ ...spec, env }),
				status: 'active',
				previewHost: `app--short${counter}.sites.test`,
				pinned: false,
				nodeId: node.nodeId,
				createdBy: principal.userId,
				createdAt: clock,
				activatedAt: clock,
			})
			.run();
		core.ctx.db
			.insert(releases)
			.values({
				id: `rel_${counter}`,
				orgId: 'org_1',
				sha256: `sha${counter}`,
				objectKey: `releases/sha${counter}`,
				storage: 'local',
				sizeBytes: 1,
				fileCount: 1,
				manifestJson: '[]',
				createdBy: principal.userId,
				createdAt: clock,
			})
			.run();
		return id;
	};
	const schedule = (releaseId: string, command = ['bin/migrate']) =>
		core.releaseCommands.schedule({
			releaseId,
			orgId: 'org_1',
			projectId: project.id,
			workloadId: 'wl_1',
			spec: { command, timeoutSeconds: 30 },
			createdBy: null,
		});
	return { core, close, node: node.nodeId, project: row, deployment, schedule };
}

describe('release-command lease (I16)', () => {
	test('queues once and hands the run to the eligible node with a start deadline', async () => {
		const { core, close, node, deployment, schedule } = await fixture();
		const releaseId = deployment({});
		const run = schedule(releaseId);
		expect(run.status).toBe('queued');
		expect(run.nodeId).toBe(node);
		const row = core.ctx.db.select().from(releaseCommandRuns).where(eq(releaseCommandRuns.id, run.id)).get();
		expect(row?.startBy).toBe(clock + RELEASE_START_WINDOW_MS);
		// A second schedule while it is live returns the same run, never a second attempt.
		expect(schedule(releaseId).id).toBe(run.id);
		close();
	});

	test('a missing capability or an offline node leaves the run unleased until the deadline', async () => {
		for (const options of [{ capabilities: [] as string[] }, { online: false }]) {
			const { core, close, deployment, schedule } = await fixture(options);
			const releaseId = deployment({});
			const run = schedule(releaseId);
			expect(run.nodeId).toBeNull();
			clock += 1;
			core.releaseCommands.tick(clock);
			expect(core.releaseCommands.gate(releaseId).state).toBe('pending');
			// The unleased limit is the rollout timeout, not the start window.
			clock += 11 * 60_000;
			core.releaseCommands.tick(clock);
			expect(core.releaseCommands.gate(releaseId).state).toBe('failed');
			close();
		}
	});

	test('a success closes the lease; a failure frees it for one retry', async () => {
		const { core, close, deployment, node, schedule } = await fixture();
		const releaseId = deployment({});
		const first = schedule(releaseId);
		core.releaseCommands.recordResults(node, [result(first.id, releaseId, 'running')]);
		expect(core.releaseCommands.gate(releaseId).state).toBe('pending');
		core.releaseCommands.recordResults(node, [result(first.id, releaseId, 'succeeded', { exitCode: 0 })]);
		expect(core.releaseCommands.gate(releaseId).state).toBe('succeeded');
		// One success per release, ever: scheduling again returns the succeeded run.
		expect(schedule(releaseId).id).toBe(first.id);

		const failedRelease = deployment({});
		const failed = schedule(failedRelease);
		core.releaseCommands.recordResults(node, [result(failed.id, failedRelease, 'failed', { exitCode: 1, error: 'boom' })]);
		expect(core.releaseCommands.gate(failedRelease).state).toBe('failed');
		const retry = schedule(failedRelease);
		expect(retry.id).not.toBe(failed.id);
		expect(retry.attempt).toBe(2);
		close();
	});

	test('results from a node that does not hold the run are ignored', async () => {
		const { core, close, deployment, node, schedule } = await fixture();
		const releaseId = deployment({});
		const run = schedule(releaseId);
		core.releaseCommands.recordResults('some-other-node', [result(run.id, releaseId, 'succeeded', { exitCode: 0 })]);
		expect(core.releaseCommands.gate(releaseId).state).toBe('pending');
		core.releaseCommands.recordResults(node, [result(run.id, releaseId, 'succeeded', { exitCode: 0 })]);
		expect(core.releaseCommands.gate(releaseId).state).toBe('succeeded');
		close();
	});

	test('an expired lease becomes timeout and is not retried automatically', async () => {
		const { core, close, deployment, schedule } = await fixture();
		const releaseId = deployment({});
		const run = schedule(releaseId);
		const row = core.ctx.db.select().from(releaseCommandRuns).where(eq(releaseCommandRuns.id, run.id)).get()!;
		const expires = ReleaseCommandScheduler.leaseExpiresAt(row)!;
		clock = expires;
		core.releaseCommands.tick(clock);
		const gate = core.releaseCommands.gate(releaseId);
		expect(gate.state).toBe('failed');
		if (gate.state === 'failed') expect(gate.run.status).toBe('timeout');
		// A person retrying is a new attempt; the timeout itself schedules nothing.
		expect(core.ctx.db.select().from(releaseCommandRuns).where(eq(releaseCommandRuns.id, run.id)).all()).toHaveLength(1);
		close();
	});

	test('a queued run past its start deadline is not served', async () => {
		const { core, close, deployment, node, schedule } = await fixture();
		const run = schedule(deployment({}));
		expect(core.releaseCommands.tasksForNode(node).map((task) => task.runId)).toEqual([run.id]);
		clock += RELEASE_START_WINDOW_MS + 1;
		expect(core.releaseCommands.tasksForNode(node)).toEqual([]);
		close();
	});

	test('a running run is still served after its start deadline, so the agent can report it', async () => {
		const { core, close, deployment, node, schedule } = await fixture();
		const run = schedule(deployment({}));
		core.releaseCommands.recordResults(node, [result(run.id, run.releaseId, 'running')]);
		clock += RELEASE_START_WINDOW_MS + 1;
		expect(core.releaseCommands.tasksForNode(node).map((task) => task.runId)).toContain(run.id);
		close();
	});

	test('two releases for one app never run at once', async () => {
		const { core, close, deployment, schedule } = await fixture();
		const a = schedule(deployment({}));
		const b = schedule(deployment({}));
		expect(a.nodeId).not.toBeNull();
		expect(b.nodeId).toBeNull();
		close();
	});

	test('activation resolves the new release environment, not the running spec', async () => {
		const { core, close, deployment, node, schedule } = await fixture();
		const releaseId = deployment({ RELEASE_VAR: 'new' });
		const run = schedule(releaseId);
		expect(core.releaseCommands.activation(node, run.id).env.RELEASE_VAR).toBe('new');
		expect(() => core.releaseCommands.activation('other-node', run.id)).toThrow();
		close();
	});
});
