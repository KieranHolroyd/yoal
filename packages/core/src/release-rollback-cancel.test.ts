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
describe('proof: rollback onto the held-from release', () => {
	test('rolling back to A while B\'s command is still queued cancels B (it must never run after the fact)', async () => {
		const f = fleet(['a', 'b']);
		await f.core.projects.create(principal, { name: 'web', slug: 'web', runtime: 'process', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
		f.core.workloads.setSpec(principal, f.project('web'), { ...baseSpec, release: { command: ['bin/migrate'] } });
		const A = (await f.deploy('web', '1')).id;
		const [runA] = f.run(A);
		f.core.releaseCommands.recordResults(runA!.nodeId!, [{ runId: runA!.id, releaseId: A, status: 'succeeded', exitCode: 0 }]);
		f.core.workloads.rolloutTick(f.clock.now);
		await f.settle('web');
		const B = (await f.deploy('web', '2')).id;
		// B's run waits for a node (none leased yet).
		f.sqlite.run("UPDATE release_command_runs SET node_id = NULL, start_by = NULL WHERE release_id = ?", [B]);
		expect(f.run(B)[0]!.status).toBe('queued');
		await f.core.deployments.rollback(principal, f.project('web'));
		expect(f.row('web').deploymentId).toBe(A);
		console.log('B run after rollback:', f.run(B));
		f.core.releaseCommands.tick(f.clock.now);
		console.log('B run after tick:', f.run(B));
		expect(f.run(B)[0]!.status).toBe('cancelled');
	});
});
