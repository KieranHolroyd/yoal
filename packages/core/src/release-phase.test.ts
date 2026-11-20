import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, workloadSpecSchema, type FeatureFlags, type WorkloadStatus } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * HA-PLAN H25 / W5 lane C: the release phase on the rollout. A release command gates the first
 * copy and leaves every copy on the old release when it fails (I16); a canary is judged on the
 * edge's own counters; per-app spread overrides the cluster's; image pre-pulls reach a node that
 * declares `release-phase`. The flag-off path stays exactly today's rollout.
 */

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
const stats = { diskUsedBytes: 1, diskTotalBytes: 100_000_000_000, diskFreeBytes: 90_000_000_000, uptimeSeconds: 1, load1: 0, certs: [] };
type Report = { id: string; status: WorkloadStatus; restarts: number };

const baseSpec = {
	runtime: 'process' as const,
	command: ['bun', 'run', 'start'],
	port: 3000,
	memoryMb: 256,
	cpus: 1,
	healthPath: '/',
	socketActivation: true,
	env: {},
	secrets: [],
};

function fleet(
	names: string[],
	options: { features?: Partial<FeatureFlags>; zones?: Record<string, string>; slices?: Record<string, number>; capabilities?: string[] } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-release-phase-'));
	const opened = createDb({ path: ':memory:' });
	const clock = { now: Date.UTC(2026, 10, 20) };
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
			now: () => clock.now,
			features: { ...DEFAULT_FEATURES, RELEASE_PHASE: true, ...options.features },
		},
	});
	const capabilities = options.capabilities ?? ['release-phase'];
	const node: Record<string, { id: string; token: string }> = {};
	for (const name of names) {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
		node[name] = { id: joined.nodeId, token: joined.token };
		opened.sqlite.run(
			'UPDATE nodes SET public_address = ?, slice_memory_mb = ?, zone = ? WHERE id = ?',
			[`${name}.internal:8080`, options.slices?.[name] ?? 1024, options.zones?.[name] ?? 'default', joined.nodeId],
		);
	}
	const beat = (name: string, workloads: Report[] = [], actualStateVersion = core.projects.stateVersion()) =>
		core.nodes.heartbeat(node[name]!.token, {
			nodeId: node[name]!.id,
			agentVersion: '0.1.0',
			actualStateVersion,
			status: 'online',
			caddyOk: true,
			capabilities,
			stats,
			releases: [],
			workloads,
		});
	for (const name of names) beat(name);
	const project = (slug: string) => core.projects.requireRow(principal, slug);
	const deploy = (slug: string, content: string) => core.uploads.deployInline(principal, project(slug), [file('index.js', content)], { promote: true });
	const app = async (slug: string, spec: Record<string, unknown> = {}) => {
		await core.projects.create(principal, { name: slug, slug, runtime: 'process', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
		core.workloads.setSpec(principal, project(slug), { ...baseSpec, ...spec });
		await deploy(slug, '1');
		return core.workloads.view(project(slug))!;
	};
	const copies = (slug: string) =>
		opened.sqlite
			.query<{ id: string; index: number; nodeId: string; status: string; deploymentId: string | null; appliedVersion: number | null }, [string]>(
				`SELECT r.id, r.replica_index AS "index", r.node_id AS nodeId, r.status, r.deployment_id AS deploymentId, r.applied_version AS appliedVersion
				 FROM workload_replicas r JOIN projects p ON p.id = r.project_id WHERE p.slug = ? ORDER BY r.replica_index`,
			)
			.all(slug);
	const row = (slug: string) =>
		opened.sqlite
			.query<{ deploymentId: string; status: string | null; message: string | null; from: string | null }, [string]>(
				'SELECT w.deployment_id AS deploymentId, w.rollout_status AS status, w.rollout_message AS message, w.rollout_from_deployment_id AS "from" FROM workloads w JOIN projects p ON p.id = w.project_id WHERE p.slug = ?',
			)
			.get(slug)!;
	const settle = async (slug: string) => {
		for (const name of names) {
			const desired = (await core.nodes.desiredState(node[name]!.token)).workloads.filter((entry) => entry.projectSlug === slug);
			beat(name, desired.map((entry) => ({ id: entry.id, status: 'running' as const, restarts: 0 })));
		}
	};
	const desired = async (name: string, slug: string) =>
		(await core.nodes.desiredState(node[name]!.token)).workloads.filter((entry) => entry.projectSlug === slug);
	const run = (releaseId?: string) =>
		releaseId
			? opened.sqlite.query<{ id: string; nodeId: string | null; status: string }, [string]>('SELECT id, node_id AS nodeId, status FROM release_command_runs WHERE release_id = ? ORDER BY attempt').all(releaseId)
			: opened.sqlite.query<{ id: string; nodeId: string | null; status: string }, []>('SELECT id, node_id AS nodeId, status FROM release_command_runs').all();
	return { core, sqlite: opened.sqlite, clock, node, names, beat, app, deploy, project, copies, row, settle, desired, run, nameOf: (id: string) => names.find((name) => node[name]!.id === id)! };
}

describe('release command gates the rollout (I16, H25)', () => {
	test('a failed release command leaves every copy on the old release', async () => {
		const f = fleet(['a', 'b']);
		const first = await f.app('web', { replicas: 2 });
		expect(f.copies('web')).toHaveLength(2);
		f.core.workloads.setSpec(principal, f.project('web'), { ...baseSpec, replicas: 2, release: { command: ['bin/migrate'] } });
		const second = await f.deploy('web', '2');
		expect(second.id).not.toBe(first.deploymentId);

		// Nothing has rolled: both copies still run the first release, and desired state agrees.
		expect(f.copies('web').map((copy) => copy.deploymentId)).toEqual([first.deploymentId, first.deploymentId]);
		expect((await f.desired('a', 'web')).map((entry) => entry.deploymentId)).toEqual([first.deploymentId]);

		const [scheduled] = f.run(second.id);
		expect(scheduled?.status).toBe('queued');
		expect(scheduled?.nodeId).not.toBeNull();
		f.core.releaseCommands.recordResults(scheduled!.nodeId!, [
			{ runId: scheduled!.id, releaseId: second.id, status: 'failed', exitCode: 1, error: 'migration refused' },
		]);
		expect(f.core.releaseCommands.gate(second.id).state).toBe('failed');

		const alerts = f.core.workloads.rolloutTick(f.clock.now);
		expect(alerts.some((alert) => alert.detail.includes('release command'))).toBe(true);

		// Every copy is still on the old release; the pointer came back to it too.
		expect(f.copies('web').map((copy) => copy.deploymentId)).toEqual([first.deploymentId, first.deploymentId]);
		expect(f.row('web').deploymentId).toBe(first.deploymentId);
		expect(f.row('web').status).toBeNull();
		// A failure frees the lease but schedules no retry on its own (I16).
		expect(f.run(second.id)).toHaveLength(1);
	});

	test('a first deploy with a release command starts no copy until it succeeds', async () => {
		const f = fleet(['a', 'b']);
		await f.core.projects.create(principal, { name: 'web', slug: 'web', runtime: 'process', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
		f.core.workloads.setSpec(principal, f.project('web'), { ...baseSpec, replicas: 2, release: { command: ['bin/migrate'] } });
		const deployment = await f.deploy('web', '1');
		const [run] = f.run(deployment.id);
		expect(run?.status).toBe('queued');
		// No previous release to hold: desired state withholds the copies until the gate opens.
		expect(await f.desired('a', 'web')).toEqual([]);
		expect(await f.desired('b', 'web')).toEqual([]);
		f.core.releaseCommands.recordResults(run!.nodeId!, [{ runId: run!.id, releaseId: deployment.id, status: 'succeeded', exitCode: 0 }]);
		const rendered = [...(await f.desired('a', 'web')), ...(await f.desired('b', 'web'))];
		expect(rendered).toHaveLength(2);
		expect(rendered.every((entry) => entry.deploymentId === deployment.id)).toBe(true);
	});

	test('a release command runs once and no copy moves before it succeeds', async () => {
		const f = fleet(['a', 'b']);
		const first = await f.app('web', { replicas: 2 });
		f.core.workloads.setSpec(principal, f.project('web'), { ...baseSpec, replicas: 2, release: { command: ['bin/migrate'] } });
		const second = await f.deploy('web', '2');
		const [run] = f.run(second.id);
		expect(f.core.releaseCommands.gate(second.id).state).toBe('pending');

		// A tick while the gate is pending changes nothing.
		f.core.workloads.rolloutTick(f.clock.now);
		expect(f.copies('web').map((copy) => copy.deploymentId)).toEqual([first.deploymentId, first.deploymentId]);

		f.core.releaseCommands.recordResults(run!.nodeId!, [
			{ runId: run!.id, releaseId: second.id, status: 'running', startedAt: f.clock.now },
			{ runId: run!.id, releaseId: second.id, status: 'succeeded', exitCode: 0, startedAt: f.clock.now, finishedAt: f.clock.now },
		]);
		expect(f.core.releaseCommands.gate(second.id).state).toBe('succeeded');

		// Whatever node the run was leased to, the rollout can now reach copies one at a time.
		f.core.workloads.rolloutTick(f.clock.now);
		const afterFirstTick = f.copies('web');
		expect(afterFirstTick.filter((copy) => copy.deploymentId === first.deploymentId)).toHaveLength(1);
		await f.settle('web');
		f.core.workloads.rolloutTick(f.clock.now);
		await f.settle('web');
		f.core.workloads.rolloutTick(f.clock.now);
		expect(f.copies('web').every((copy) => copy.deploymentId !== first.deploymentId)).toBe(true);
		expect(f.row('web').status).toBeNull();
		const rendered = await f.desired('a', 'web');
		const other = await f.desired('b', 'web');
		expect([...rendered, ...other].every((entry) => entry.deploymentId === second.id)).toBe(true);

		// One success, ever: scheduling again returns the same attempt.
		const workloadId = f.sqlite.query<{ id: string }, [string]>('SELECT w.id FROM workloads w JOIN projects p ON p.id = w.project_id WHERE p.slug = ?').get('web')!.id;
		expect(f.core.releaseCommands.schedule({ releaseId: second.id, orgId: 'org_1', projectId: f.project('web').id, workloadId, spec: { command: ['bin/migrate'], timeoutSeconds: 600 }, createdBy: null }).id).toBe(run!.id);
		expect(f.run(second.id)).toHaveLength(1);
	});
});

describe('canary judged on the edge counters (H25)', () => {
	const canarySpec = { replicas: 3, rollout: { canary: 1, soakSeconds: 10 } };
	/** A v1 release that is settled, then v2 with the canary spec: an update is what canaries. */
	const rollingUpdate = async () => {
		const f = fleet(['edge', 'a', 'b']);
		await f.app('web', { replicas: 3 });
		await f.settle('web');
		const first = f.row('web').deploymentId;
		f.core.workloads.setSpec(principal, f.project('web'), { ...baseSpec, ...canarySpec });
		const second = await f.deploy('web', '2');
		f.core.workloads.rolloutTick(f.clock.now);
		await f.settle('web');
		// The canary copy is the one that left the previous release; the other two are still on it.
		const canaryNode = f.copies('web').find((copy) => copy.deploymentId !== first)!.nodeId;
		const upstream = (nodeId: string) => `http://${f.nameOf(nodeId)}.internal:8080`;
		return { f, first, second: second.id, canaryNode, upstream };
	};

	test('a canary 5xx spike pauses the rollout before the rest roll', async () => {
		const { f, first, second, canaryNode, upstream } = await rollingUpdate();
		// The canary copy answers with 10% 5xx; the two old copies are healthy.
		f.core.workloads.recordUpstreamCounters(f.node['a']!.id, [
			{ projectId: f.project('web').id, upstream: upstream(canaryNode), from: f.clock.now - 5_000, to: f.clock.now + 5_000, requests: 100, status5xx: 10, durationP95Ms: 40 },
			...f.copies('web')
				.filter((copy) => copy.nodeId !== canaryNode)
				.map((copy) => ({ projectId: f.project('web').id, upstream: upstream(copy.nodeId), from: f.clock.now - 5_000, to: f.clock.now + 5_000, requests: 100, status5xx: 0, durationP95Ms: 40 })),
		]);

		f.clock.now += 11_000;
		const alerts = f.core.workloads.rolloutTick(f.clock.now);
		expect(alerts.some((alert) => alert.detail.includes('canary failed'))).toBe(true);
		const state = f.sqlite
			.query<{ state: string; reason: string | null }, [string]>('SELECT state, reason FROM deployment_canaries WHERE deployment_id = ?')
			.get(second)!;
		expect(state.state).toBe('failed');
		expect(state.reason).toContain('5xx');
		// The pointers move back at once: every copy renders the old release again, the canary included.
		const rendered = [...(await f.desired('a', 'web')), ...(await f.desired('b', 'web'))];
		expect(rendered.every((entry) => entry.deploymentId === first)).toBe(true);
		expect(f.row('web').deploymentId).toBe(first);
	});

	test('a healthy canary passes after the soak and the rest roll', async () => {
		const { f, first, second, canaryNode, upstream } = await rollingUpdate();
		f.core.workloads.recordUpstreamCounters(f.node['a']!.id, [
			{ projectId: f.project('web').id, upstream: upstream(canaryNode), from: f.clock.now - 5_000, to: f.clock.now + 5_000, requests: 100, status5xx: 0, durationP95Ms: 40 },
			{ projectId: f.project('web').id, upstream: upstream(canaryNode), from: f.clock.now - 5_000, to: f.clock.now + 5_000, requests: 100, status5xx: 0, durationP95Ms: 40 },
		]);
		f.clock.now += 11_000;
		expect(f.core.workloads.rolloutTick(f.clock.now).some((alert) => alert.severity === 'warning')).toBe(false);
		const state = f.sqlite.query<{ state: string }, [string]>('SELECT state FROM deployment_canaries WHERE deployment_id = ?').get(second)!;
		expect(state.state).toBe('passed');
		// One more copy moved once the canary passed: two are off the old release now.
		expect(f.copies('web').filter((copy) => copy.deploymentId === first)).toHaveLength(1);
	});
});

describe('per-app spread and image pre-pull (H25)', () => {
	test('placement.spread overrides the cluster spread for one app', async () => {
		const nodes = ['n1', 'n2', 'n3', 'n4'];
		const zones = { n1: 'z1', n2: 'z1', n3: 'z1', n4: 'z2' };
		// The cluster spreads by node, so two copies take the roomy z1 nodes: both in z1.
		const slices = { n1: 1024, n2: 1024, n3: 1024, n4: 512 };
		const plainFleet = fleet(nodes, { zones, slices });
		await plainFleet.app('plain', { replicas: 2 });
		expect(plainFleet.copies('plain').map((copy) => zones[plainFleet.nameOf(copy.nodeId) as keyof typeof zones])).toEqual(['z1', 'z1']);

		// The app's own `placement.spread: zone` reaches the z2 node although it has less room.
		const zonedFleet = fleet(nodes, { zones, slices });
		await zonedFleet.app('zoned', { replicas: 2, placement: { spread: 'zone' } });
		const spread = zonedFleet.copies('zoned').map((copy) => zones[zonedFleet.nameOf(copy.nodeId) as keyof typeof zones]);
		expect(new Set(spread).size).toBe(2);
	});

	test('a node that declares release-phase gets the image to pre-pull; one that does not, nothing', async () => {
		const f = fleet(['a', 'b'], { capabilities: ['release-phase'] });
		// A container workload, written directly: no registry call is involved in reading desired state.
		const project = await f.core.projects.create(principal, { name: 'img', slug: 'img', runtime: 'container', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
		const containerSpec = workloadSpecSchema.parse({ runtime: 'container', image: 'docker.io/library/nginx:1.27', port: 8080, memoryMb: 128, cpus: 1 });
		f.sqlite.run(
			`INSERT INTO deployments (id, org_id, project_id, release_id, config_snapshot_id, short_id, runtime, runtime_name, workload_json, status, preview_host, pinned, node_id, created_by, created_at, activated_at)
			 VALUES ('dep_img', 'org_1', ?, 'rel_img', 'cfgsnap_img', 'img1', 'container', 'container', ?, 'active', 'img--x.sites.test', 0, ?, 'user_1', ?, ?)`,
			[project.id, JSON.stringify(containerSpec), f.node.a!.id, f.clock.now, f.clock.now],
		);
		f.sqlite.run(
			`INSERT INTO releases (id, org_id, sha256, object_key, storage, size_bytes, file_count, manifest_json, created_by, created_at)
			 VALUES ('rel_img', 'org_1', ?, 'releases/img', 'local', 1, 1, '[]', 'user_1', ?)`,
			['a'.repeat(64), f.clock.now],
		);
		f.sqlite.run(
			`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, runtime_name, status, spec_json, memory_mb, cpus, upstream, created_at, updated_at)
			 VALUES ('wl_img', 'org_1', ?, 'dep_img', ?, 'container', 'container', 'running', ?, 128, 1, '127.0.0.1:8080', ?, ?)`,
			[project.id, f.node.a!.id, JSON.stringify(containerSpec), f.clock.now, f.clock.now],
		);
		f.sqlite.run(
			`INSERT INTO workload_replicas (id, workload_id, project_id, node_id, replica_index, status, created_at, updated_at)
			 VALUES ('wr_img', 'wl_img', ?, ?, 0, 'running', ?, ?)`,
			[project.id, f.node.a!.id, f.clock.now, f.clock.now],
		);
		const withCapability = await f.core.nodes.desiredState(f.node.a!.token);
		expect(withCapability.imagePrePulls).toEqual([{ workloadId: 'wl_img', image: 'docker.io/library/nginx:1.27' }]);
		// An agent that does not declare the capability never sees the field, even with the flag on.
		f.sqlite.run("UPDATE nodes SET capabilities_json = '[]' WHERE id = ?", [f.node.b!.id]);
		expect('imagePrePulls' in (await f.core.nodes.desiredState(f.node.b!.token))).toBe(false);
	});
});

describe('flag off is today’s behaviour', () => {
	test('with RELEASE_PHASE off a deploy rolls in place and renders no release-phase fields', async () => {
		const f = fleet(['a', 'b'], { features: { RELEASE_PHASE: false }, capabilities: [] });
		const first = await f.app('web', { replicas: 2 });
		await f.settle('web');
		await f.deploy('web', '2');
		// No release command was queued, and unlike the gated path the rollout starts at once with
		// every copy still on the release it ran.
		expect(f.run()).toHaveLength(0);
		expect(f.row('web').status).toBe('rolling');
		expect(f.copies('web').map((copy) => copy.deploymentId)).toEqual([first.deploymentId, first.deploymentId]);
		const desired = await f.core.nodes.desiredState(f.node.a!.token);
		expect('releaseCommands' in desired).toBe(false);
		expect('imagePrePulls' in desired).toBe(false);
		// A spec that sets a release-phase field is refused, as every other flagged feature is.
		expect(() => f.core.workloads.setSpec(principal, f.project('web'), { ...baseSpec, replicas: 2, release: { command: ['bin/migrate'] } })).toThrow(/release phase/);
	});
});
