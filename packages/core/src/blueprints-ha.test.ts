import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, type BlueprintPlanView, type FeatureName } from '@yoal/contracts';
import { createDb } from '@yoal/db';
import { applyBlueprintHa } from './blueprints-ha.ts';
import { parseBlueprint, parseResourceKey } from './blueprints.ts';
import { ValidationError } from './errors.ts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * Blueprint HA keys (HA-PLAN §8, W14; Wave 5 lane C): the §8 example plans as the exact list of
 * refusals with the flags off, plans and applies on a fixture fleet with them on, re-applies as a
 * no-op, fails `requires` shortfalls with the gap, and never half-applies.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-blueprints-ha-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-21T10:00:00Z');
const features = { ...DEFAULT_FEATURES, BLUEPRINTS: true, BACKUPS_RESTORE: true };
const HA_FLAGS: FeatureName[] = ['RELEASE_PHASE', 'SYNC_REPLICA', 'DB_AUTO_PROMOTE', 'PITR', 'PITR_REWIND', 'STEERING', 'REGIONS'];
const setFlags = (on: boolean) => {
	for (const name of HA_FLAGS) (features as Record<string, boolean>)[name] = on;
};

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'apps.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
		features,
		pitrRepository: {
			kind: 's3',
			endpoint: 'https://s3.test',
			bucket: 'yoal-pitr',
			region: 'us-east-1',
			pathPrefix: 'yoal/pitr',
			forcePathStyle: true,
			accessKeyId: 'access-key',
			secretAccessKey: 'super-secret-key',
		},
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const member = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'owner' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

/** HA-PLAN §8, verbatim except the database is `main` on this fixture's nodes. */
const section8 = `
apiVersion: yoal/v1
name: lynxnet
cluster:
  requires: { zones: 3, ingressNodes: 2, dataNodes: 3 }
  steering: { driver: external-lb, drainSeconds: 20 }
projects:
  lynxnet:
    runtime: container
    image: registry.apps.example.org/nhs/lynxnet:1.4.0
    port: 3460
    healthPath: /healthz
    readinessPath: /readyz
    replicas: 3
    placement: { spread: zone }
    release: { command: ["bun", "run", "db:migrate"], timeoutSeconds: 300 }
    rollout: { canary: 1, soakSeconds: 900, maxUnavailable: 1 }
    drainSeconds: 15
    domains: [lynxnet.example.org]
    secrets: [BETTER_AUTH_SECRET]
databases:
  main:
    engine: postgres
    version: 18
    replicas: 2
    durability: sync
    failover: auto
    spread: zone
    pitr: true
    backups: { target: azure-uksouth, immutable: true }
    standbyRegion: ukwest
attachments:
  - { project: lynxnet, database: main, prefix: DATABASE }
`;

/** §8 without `standbyRegion`, which waits on lane A (regions); everything else as written. */
const section8NoStandby = section8.replace('    standbyRegion: ukwest\n', '');

const CAPABILITIES = ['database-replicas', 'db-member', 'db-member-self-fencing', 'pitr-rewind', 'release-phase'];
const nodeIds: Record<string, string> = {};

function enrol(name: string, zone: string, roles: string[], address: string): string {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, name).token, name });
	opened.sqlite.run(
		'UPDATE nodes SET status = ?, zone = ?, roles_json = ?, capabilities_json = ?, private_address = ?, slice_memory_mb = ? WHERE id = ?',
		['online', zone, JSON.stringify(roles), JSON.stringify(CAPABILITIES), address, 16_384, joined.nodeId],
	);
	nodeIds[name] = joined.nodeId;
	return joined.nodeId;
}

async function plan(document: string): Promise<BlueprintPlanView> {
	return core.blueprints.plan(owner, { document });
}

/** Every problem a failed plan reports, as `path: message`. */
async function problems(document: string, principal = owner): Promise<string[]> {
	try {
		await core.blueprints.plan(principal, { document });
	} catch (error) {
		if (error instanceof ValidationError) return (error.issues as { path: string[]; message: string }[]).map((issue) => `${issue.path.join('.')}: ${issue.message}`);
		throw error;
	}
	return [];
}

async function applyPlan(view: BlueprintPlanView) {
	const started = core.blueprints.apply(owner, { planHash: view.planHash });
	await core.operations.settled(started.operationId);
	return core.blueprints.applyView(owner, started.operationId);
}

const haSection = (view: BlueprintPlanView) => view.resources.filter((resource) => resource.kind === 'ha');

/** The database `main` already serving: two streaming replicas in two more zones, sync in force, a passed drill. */
function serveMain(): void {
	const created = core.databases.create(owner, { name: 'main', engine: 'postgres', version: '18', placement: nodeIds['edge-a']! });
	let sequence = 0;
	for (const node of ['edge-b', 'data-c']) {
		sequence += 1;
		opened.sqlite.run(
			`INSERT INTO database_replicas (id, database_id, node_id, status, slot, primary_generation, replay_lsn, reported_at, created_at, updated_at)
			 VALUES (?, ?, ?, 'streaming', ?, 0, '0/100', ?, 1, 1)`,
			[`dbr_main_${sequence}`, created.id, nodeIds[node]!, `slot_main_${sequence}`, clock],
		);
	}
	opened.sqlite.run(
		"UPDATE databases SET durability = 'sync', durability_effective = 'sync', sync_state = 'steady', sync_lease_etag = 'etag', sync_replica_node_id = ? WHERE id = ?",
		[nodeIds['edge-b']!, created.id],
	);
	opened.sqlite.run(
		`INSERT INTO database_failover_drills
		 (id, database_id, drill_database_id, status, durability, started_at, finished_at, time_to_writable_ms,
		  lost_commits, generation, arbiter_tested, arbiter_tested_at, created_by, created_at)
		 VALUES ('drl_main', ?, 'db_disposable', 'passed', 'sync', ?, ?, 21000, 0, 0, 1, ?, 'user_1', 1)`,
		[created.id, clock - 1_000, clock, clock],
	);
}

describe('fixture', () => {
	test('three zones, two ingress nodes, three data nodes, an immutable backup target and the app secret', async () => {
		enrol('edge-a', 'uksouth-1', ['ingress', 'control', 'compute', 'data'], '10.47.0.1');
		enrol('edge-b', 'uksouth-2', ['ingress', 'compute', 'data'], '10.47.0.2');
		enrol('data-c', 'uksouth-3', ['compute', 'data'], '10.47.0.3');
		core.backupTargets.create(owner, {
			name: 'azure-uksouth',
			kind: 's3',
			endpoint: 'https://s3.test',
			bucket: 'yoal-backups',
			accessKeyId: 'AKIAEXAMPLE',
			secretAccessKey: 'secret-1234',
			objectLock: true,
		});
		await core.secrets.set(owner, { name: 'BETTER_AUTH_SECRET', value: 'better-auth-secret-value', projectId: null });
	});
});

describe('the §8 blueprint', () => {
	beforeEach(() => setFlags(false));

	test('HA keys parse and name their steps; an old file has no HA section', async () => {
		const doc = parseBlueprint(section8);
		expect(doc.cluster?.steering).toEqual({ driver: 'external-lb', drainSeconds: 20 });
		expect(parseResourceKey('cluster.requires')).toEqual({ kind: 'ha', ha: { section: 'requires' } });
		expect(parseResourceKey('projects.lynxnet.ha')).toEqual({ kind: 'ha', ha: { section: 'project', name: 'lynxnet' } });
		expect(parseResourceKey('databases.main.ha')).toEqual({ kind: 'ha', ha: { section: 'database', name: 'main' } });
		const old = await plan('apiVersion: yoal/v1\nname: old\nprojects:\n  old-site: {}\n');
		expect(old.resources.map((resource) => resource.kind)).toEqual(['project']);
	});

	test('with the flags off it plans as the precise list of refusals, and nothing changes', async () => {
		const before = core.cluster.get().steering.driver;
		expect(await problems(section8)).toEqual([
			'projects.lynxnet.release: release needs the release phase, which is not enabled on this platform (YOAL_FEATURE_RELEASE_PHASE).',
			'projects.lynxnet.readinessPath: readinessPath needs the release phase, which is not enabled on this platform (YOAL_FEATURE_RELEASE_PHASE).',
			'projects.lynxnet.drainSeconds: drainSeconds needs the release phase, which is not enabled on this platform (YOAL_FEATURE_RELEASE_PHASE).',
			'projects.lynxnet.rollout: rollout needs the release phase, which is not enabled on this platform (YOAL_FEATURE_RELEASE_PHASE).',
			'projects.lynxnet.placement: placement needs the release phase, which is not enabled on this platform (YOAL_FEATURE_RELEASE_PHASE).',
			'databases.main.standbyRegion: blueprint.databases.standbyRegion needs regions, which are not enabled on this platform (YOAL_FEATURE_REGIONS).',
			'databases.main.pitr: PITR is disabled on this control plane (YOAL_FEATURE_PITR).',
			'databases.main.replicas: "main" has point-in-time recovery on; replicas of a PITR database need YOAL_FEATURE_PITR_REWIND.',
			'databases.main.durability: Synchronous replicas are off: enable SYNC_REPLICA first (HA-PLAN H23).',
			'databases.main.failover: failover: auto is refused [auto-promote-off]: Automatic database failover is off globally; enable DB_AUTO_PROMOTE first (HA-PLAN W11).',
			expect.stringMatching(/^databases\.main\.failover: failover: auto is refused \[no-drill\]: No failover drill has run/),
		]);
		expect(core.projects.list(owner)).toEqual([]);
		expect(core.cluster.get().steering.driver).toBe(before);
	});

	test('a fleet below cluster.requires fails the plan with the exact shortfall', async () => {
		opened.sqlite.run("UPDATE nodes SET status = 'offline' WHERE id = ?", [nodeIds['data-c']!]);
		try {
			const found = await problems('apiVersion: yoal/v1\nname: lynxnet\ncluster:\n  requires: { zones: 3, ingressNodes: 3, dataNodes: 3 }\n');
			expect(found).toEqual([
				'cluster.requires.zones: The file requires 3 zones; the online nodes span 2 (uksouth-1, uksouth-2), 1 short. Enrol a node with --zone in another zone; a blueprint provisions nothing. Not counted: data-c is offline.',
				'cluster.requires.ingressNodes: The file requires 3 ingress nodes; 2 online nodes have the ingress role, 1 short. Enrol one with --roles ingress, or add the role to a node. Not counted: data-c is offline.',
				'cluster.requires.dataNodes: The file requires 3 data nodes; 2 online nodes have the data role, 1 short. Enrol one with --roles data, or add the role to a node. Not counted: data-c is offline.',
			]);
		} finally {
			opened.sqlite.run("UPDATE nodes SET status = 'online' WHERE id = ?", [nodeIds['data-c']!]);
		}
		// Met, the check is an up-to-date HA step that says what the fleet has.
		const met = await plan('apiVersion: yoal/v1\nname: fleet-check\ncluster:\n  requires: { zones: 3, ingressNodes: 2, dataNodes: 3 }\n');
		expect(haSection(met)).toEqual([
			{ key: 'cluster.requires', kind: 'ha', action: 'noop', changes: [], reason: 'online: 3 zones, 2 ingress nodes, 3 data nodes' },
		]);
	});

	test('cluster.steering needs a platform admin signed in to the dashboard, as the cluster settings do', async () => {
		expect(await problems('apiVersion: yoal/v1\nname: steer\ncluster:\n  steering: { driver: external-lb }\n', member)).toEqual([
			expect.stringMatching(/^cluster\.steering: Only a platform admin role signed in to the dashboard/),
		]);
	});

	test('with every flag on, a fresh fleet plans the steps that cannot apply in one run as refusals', async () => {
		setFlags(true);
		expect(await problems(section8)).toEqual([
			'databases.main.standbyRegion: blueprint.databases.standbyRegion is not built yet (HA-PLAN W13, Wave 5 lane A); regions are enabled but only node regions are stored.',
			expect.stringMatching(/^databases\.main\.durability: durability: sync picks a replica that is already streaming, and this plan creates the database\./),
			expect.stringMatching(/^databases\.main\.failover: failover: auto is refused \[no-drill\]/),
		]);
		// spread: region is the same not-built refusal, for apps and databases.
		const regional = section8NoStandby.replace('placement: { spread: zone }', 'placement: { spread: region }').replace('durability: sync', 'durability: async').replace('spread: zone\n    pitr', 'spread: region\n    pitr');
		expect((await problems(regional)).filter((line) => line.includes('not built'))).toEqual([
			'projects.lynxnet.placement: blueprint.projects.placement.spread is not built yet (HA-PLAN W13, Wave 5 lane A); regions are enabled but only node regions are stored.',
			'databases.main.spread: blueprint.databases.spread is not built yet (HA-PLAN W13, Wave 5 lane A); regions are enabled but only node regions are stored.',
		]);
	});

	test('on a fleet where main already serves, it plans an HA section and applies', async () => {
		setFlags(true);
		serveMain();
		const view = await plan(section8NoStandby);
		expect(view.warnings).toEqual([]);
		expect(haSection(view)).toEqual([
			{ key: 'cluster.requires', kind: 'ha', action: 'noop', changes: [], reason: 'online: 3 zones, 2 ingress nodes, 3 data nodes' },
			{
				key: 'cluster.steering',
				kind: 'ha',
				action: 'update',
				// drainSeconds: 20 is already the default, so only the driver changes.
				changes: [{ path: 'steering.driver', from: 'direct', to: 'external-lb' }],
				reason: 'cluster setting shared with ha init; the last write wins',
			},
			{
				key: 'projects.lynxnet.ha',
				kind: 'ha',
				action: 'create',
				changes: [
					{ path: 'readinessPath', from: null, to: '/readyz' },
					{ path: 'release', from: null, to: '{"command":["bun","run","db:migrate"],"timeoutSeconds":300}' },
					{ path: 'rollout', from: null, to: '{"canary":1,"soakSeconds":900,"maxUnavailable":1}' },
					{ path: 'drainSeconds', from: null, to: '15' },
					{ path: 'placement.spread', from: null, to: 'zone' },
				],
				reason: null,
			},
			{
				key: 'databases.main.ha',
				kind: 'ha',
				action: 'update',
				changes: [
					{ path: 'pitr', from: 'false', to: 'true' },
					{ path: 'failover', from: 'manual', to: 'auto' },
				],
				reason: 'exists; this stack adopts it',
			},
		]);
		const result = await applyPlan(view);
		expect(result.error).toBeNull();
		expect(result.status).toBe('succeeded');
		expect(core.cluster.get().steering.driver).toBe('external-lb');
		expect(core.cluster.get().ingress.drainSeconds).toBe(20);
		expect(core.workloads.projectSpec(core.projects.requireRow(owner, 'lynxnet'))).toMatchObject({
			readinessPath: '/readyz',
			drainSeconds: 15,
			release: { command: ['bun', 'run', 'db:migrate'], timeoutSeconds: 300 },
			rollout: { canary: 1, soakSeconds: 900, maxUnavailable: 1 },
			placement: { spread: 'zone' },
		});
		// The project's own placementSpec is untouched: the spread is the workload's.
		expect(core.projects.requireRow(owner, 'lynxnet').placement).toBe('edge');
		expect(core.failoverPolicies.view(owner, 'main')).toMatchObject({ failoverMode: 'auto', acceptDataLoss: false });
		expect(core.databases.pitrStatus(owner, 'main').enabled).toBe(true);
		const audits = opened.sqlite.query<{ action: string }, []>('SELECT action FROM audit_log').all().map((row) => row.action);
		expect(audits).toEqual(expect.arrayContaining(['database.failover.arm', 'database.pitr-policy', 'platform.cluster_config']));
	});

	test('a second apply of the same file is a no-op', async () => {
		setFlags(true);
		const count = () => opened.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log WHERE action NOT LIKE 'operation.%' AND action != 'blueprint.apply'").get()!.n;
		const view = await plan(section8NoStandby);
		expect(view.stackAction).toBe('noop');
		expect(view.summary.create + view.summary.update + view.summary.delete).toBe(0);
		expect(haSection(view).every((step) => step.action === 'noop')).toBe(true);
		const before = count();
		const result = await applyPlan(view);
		expect(result.status).toBe('succeeded');
		expect(result.resources.every((resource) => resource.status === 'skipped')).toBe(true);
		expect(count()).toBe(before);
	});

	test('removing a key keeps its value, and an HA step is never pruned', async () => {
		setFlags(true);
		const trimmed = section8NoStandby.replace('    readinessPath: /readyz\n', '').replace('    failover: auto\n', '');
		const view = await core.blueprints.plan(owner, { document: trimmed, prune: true });
		expect(view.resources.filter((resource) => resource.action === 'delete')).toEqual([]);
		await applyPlan(view);
		expect(core.workloads.projectSpec(core.projects.requireRow(owner, 'lynxnet'))?.readinessPath).toBe('/readyz');
		expect(core.failoverPolicies.view(owner, 'main').failoverMode).toBe('auto');
	});

	test('failover: manual disarms; a blueprint never lowers replicas', async () => {
		setFlags(true);
		const manual = section8NoStandby.replace('failover: auto', 'failover: manual');
		const view = await plan(manual);
		expect(haSection(view).find((step) => step.key === 'databases.main.ha')?.changes).toEqual([{ path: 'failover', from: 'auto', to: 'manual' }]);
		await applyPlan(view);
		expect(core.failoverPolicies.view(owner, 'main').failoverMode).toBe('manual');
		expect(await problems(manual.replace('replicas: 2', 'replicas: 1'))).toEqual([
			'databases.main.replicas: "main" has 2 replicas and the file asks for 1. A blueprint never removes a replica; remove one with `yoal db replica remove` and plan again.',
		]);
	});

	test('a plan whose live state moved applies nothing; a refused HA step writes nothing', async () => {
		setFlags(true);
		const view = await plan(section8NoStandby.replace('pitr: true', 'pitr: false'));
		expect(haSection(view).find((step) => step.key === 'databases.main.ha')?.changes).toEqual([
			{ path: 'pitr', from: 'true', to: 'false' },
			{ path: 'failover', from: 'manual', to: 'auto' },
		]);
		// The drill evidence goes away after the plan: apply refuses the whole plan before any step.
		opened.sqlite.run('DELETE FROM database_failover_drills');
		expect(() => core.blueprints.apply(owner, { planHash: view.planHash })).toThrow(/no-drill/);
		expect(core.databases.pitrStatus(owner, 'main').enabled).toBe(true);
		// The step itself re-checks before its first write: PITR (first in order) stays on.
		await expect(applyBlueprintHa(core.ctx, owner, parseBlueprint(section8NoStandby.replace('pitr: true', 'pitr: false')), 'databases.main.ha')).rejects.toThrow(
			/databases\.main\.failover: failover: auto is refused \[no-drill\]/,
		);
		expect(core.databases.pitrStatus(owner, 'main').enabled).toBe(true);
		expect(core.failoverPolicies.view(owner, 'main').failoverMode).toBe('manual');
	});

	test('backups are assertions on where the database backs up to', async () => {
		setFlags(true);
		const found = await problems(section8NoStandby.replace('target: azure-uksouth', 'target: elsewhere'));
		expect(found).toEqual(expect.arrayContaining([
			'databases.main.backups.target: Backups of "main" go to "azure-uksouth" (the org target), not "elsewhere". A database has no backup target of its own: make "elsewhere" this organisation\'s first backup target in Settings → Backups.',
		]));
	});
});

describe('replicas on new nodes', () => {
	test('added replicas follow spread: zone, and the plan names the nodes', async () => {
		setFlags(true);
		enrol('data-d', 'uksouth-4', ['compute', 'data'], '10.47.0.4');
		const doc0 = section8NoStandby.replace('failover: auto', 'failover: manual').replace('replicas: 2\n    durability: sync', 'replicas: 3\n    durability: sync');
		expect(await problems(doc0)).toEqual(['databases.main.replicas: This install allows at most 2 replica(s) per database.']);
		core.cluster.update(owner, { database: { maxReplicas: 4 } });
		const doc = section8NoStandby.replace('replicas: 2\n    durability: sync', 'replicas: 3\n    durability: sync').replace('failover: auto', 'failover: manual');
		const view = await plan(doc);
		expect(haSection(view).find((step) => step.key === 'databases.main.ha')?.changes).toEqual([
			{ path: 'replicas', from: '2', to: '3' },
			{ path: 'replicas.nodes', from: null, to: 'data-d (uksouth-4)' },
		]);
		const result = await applyPlan(view);
		expect(result.status).toBe('succeeded');
		expect(core.databaseReplicas.list(owner, 'main').map((replica) => replica.nodeId).sort()).toEqual(
			[nodeIds['edge-b']!, nodeIds['data-c']!, nodeIds['data-d']!].sort(),
		);
		// A fourth needs a fifth zone.
		expect(await problems(doc.replace('replicas: 3\n    durability', 'replicas: 4\n    durability'))).toEqual([
			expect.stringMatching(/^databases\.main\.replicas: 1 more replica with spread: zone needs 1 zones not yet used by "main"/),
		]);
	});
});

describe('previews match the services', () => {
	test('durability: sync with one replica plans the refusal setDurability throws, word for word', async () => {
		setFlags(true);
		const solo = core.databases.create(owner, { name: 'solo', engine: 'postgres', version: '18', placement: nodeIds['edge-a']! });
		opened.sqlite.run(
			`INSERT INTO database_replicas (id, database_id, node_id, status, slot, primary_generation, replay_lsn, reported_at, created_at, updated_at)
			 VALUES ('dbr_solo', ?, ?, 'streaming', 'slot_solo', 0, '0/100', ?, 1, 1)`,
			[solo.id, nodeIds['edge-b']!, clock],
		);
		const found = await problems('apiVersion: yoal/v1\nname: solo\ndatabases:\n  solo: { durability: sync }\n');
		const thrown = await core.databaseMembers.setDurability(owner, 'solo', { durability: 'sync' }).then(
			() => '',
			(error: Error) => error.message,
		);
		expect(thrown).toMatch(/two replicas in different zones/);
		expect(found).toEqual([`databases.solo.durability: ${thrown}`]);
		expect(core.databases.requireRow(owner, 'solo').durability).toBe('async');
	});

	test('failover: auto on an existing database plans armRefusals, which match what arm refuses', async () => {
		setFlags(true);
		const refusals = core.failoverPolicies.armRefusals(owner, 'solo', { acceptDataLoss: true }).map((refusal) => refusal.code);
		expect(refusals).toEqual(['no-drill']);
		expect(await problems('apiVersion: yoal/v1\nname: solo\ndatabases:\n  solo: { failover: auto, acceptDataLoss: true }\n')).toEqual([
			'databases.solo.failover: failover: auto is refused [no-drill]: No failover drill has run for this database; run one before arming auto.',
		]);
		await expect(core.failoverPolicies.arm(owner, 'solo', { confirm: true, acceptDataLoss: true })).rejects.toThrow(/No failover drill has run/);
	});
});
