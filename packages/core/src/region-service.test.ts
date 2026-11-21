import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, nodeCapabilities, type Heartbeat, type RegionPromotionPlan, type RegionPromotionView } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import { RegionService } from './region-service.ts';

/**
 * W13 exit criteria with fake nodes in two regions (HA-PLAN H26): uksouth (a1 edge, a2) and ukwest
 * (b1, b2). The control plane runs the real W10 database path; the W9 control-plane promote is a
 * fake with the same contract (a CAS at the expected epoch, refused while the lease is live unless
 * break glass), counted so a resumed run can prove it never promotes twice.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-regions-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-21T10:00:00Z');
const core: Core = createCore({
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
		features: { ...DEFAULT_FEATURES, REGIONS: true, SYNC_REPLICA: true, INGRESS_SET: true, MULTI_NODE_REPLICAS: true },
		now: () => clock,
	},
});
const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
type Joined = { nodeId: string; token: string };
const joinNode = (name: string, address: string, zone: string, region: string): Joined => {
	const node = core.nodes.join({ token: core.nodes.createJoinToken(admin, name).token, name });
	core.nodes.update(admin, node.nodeId, { sliceMemoryMb: 8192 });
	opened.sqlite.run('UPDATE nodes SET private_address = ?, zone = ?, region = ?, roles_json = ? WHERE id = ?', [
		address,
		zone,
		region,
		JSON.stringify(['ingress', 'compute', 'data']),
		node.nodeId,
	]);
	return node;
};
const a1 = joinNode('a1', '10.47.1.1', 'uks-1', 'uksouth');
const a2 = joinNode('a2', '10.47.1.2', 'uks-2', 'uksouth');
const b1 = joinNode('b1', '10.47.2.1', 'ukw-1', 'ukwest');
const b2 = joinNode('b2', '10.47.2.2', 'ukw-2', 'ukwest');
const fingerprint = (node: Joined) => node.nodeId.replace(/[^a-f0-9]/g, '').padEnd(64, 'a').slice(0, 64);
function beat(node: Joined): void {
	core.nodes.heartbeat(node.token, {
		nodeId: node.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: core.nodes.stateVersion(),
		status: 'online',
		caddyOk: true,
		releases: [],
		capabilities: [...nodeCapabilities],
		nodeCertificate: { certPem: 'pem', fingerprint: fingerprint(node), expiresAt: new Date(clock + 86_400_000).toISOString() },
	} as Heartbeat);
}
for (const node of [a1, a2, b1, b2]) beat(node);

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

/** The W9 contract, faked: a CAS at `expected`, refused while another holder's lease is live. */
class FakeControlPlane {
	epoch = 5;
	holder: string = a1.nodeId;
	leaseExpiresAt = clock - 60_000;
	promotions = 0;
	constructor(readonly nodeId: string) {}
	enabled() {
		return true;
	}
	snapshot() {
		return { role: this.holder === this.nodeId ? 'primary' : 'standby', lease: { holderNodeId: this.holder, expiresAt: this.leaseExpiresAt } } as never;
	}
	async highestEpoch() {
		return this.epoch;
	}
	lease() {
		return { epoch: this.epoch, holderNodeId: this.holder, holderVersion: '0.1.0', expiresAt: new Date(this.leaseExpiresAt).toISOString() };
	}
	mayActAsPrimary() {
		return this.holder === this.nodeId;
	}
	async promote(_principal: unknown, expected?: number, options: { breakGlass?: boolean } = {}) {
		if (expected !== undefined && expected !== this.epoch) throw new CoreError('conflict', `the lease is at epoch ${this.epoch}, not ${expected}`, 409);
		if (this.holder === this.nodeId) return [];
		if (this.leaseExpiresAt > clock && !options.breakGlass) throw new CoreError('conflict', 'Promotion refused: the lease has not expired', 409);
		this.promotions += 1;
		this.epoch += 1;
		this.holder = this.nodeId;
		return [];
	}
}

let control: FakeControlPlane;
let runner: RegionService;
const service = (fake: FakeControlPlane, runnerId: string) =>
	new RegionService({ ...core.ctx, controlPlane: fake as unknown as CoreContext['controlPlane'] }, { runnerId });

/** What the W10 node protocol does once the replica's node has promoted and re-pointed. */
function completeFailover(databaseId: string): void {
	const row = opened.sqlite
		.query<{ id: string; to_node_id: string; generation: number }, [string]>(
			"SELECT id, to_node_id, generation FROM database_failovers WHERE database_id = ? AND status IN ('pending', 'promoting') ORDER BY started_at DESC",
		)
		.get(databaseId)!;
	opened.sqlite.run("UPDATE database_failovers SET status = 'completed', finished_at = ? WHERE id = ?", [clock, row.id]);
	opened.sqlite.run('UPDATE databases SET node_id = ?, primary_generation = ? WHERE id = ?', [row.to_node_id, row.generation, databaseId]);
}

const ids = (name: string) => opened.sqlite.query<{ id: string }, [string]>('SELECT id FROM databases WHERE name = ?').get(name)!.id;
const failovers = (databaseId: string) =>
	opened.sqlite.query<{ n: number }, [string]>('SELECT count(*) AS n FROM database_failovers WHERE database_id = ?').get(databaseId)!.n;

beforeEach(() => {
	opened.sqlite.run('DELETE FROM region_promotion_steps');
	opened.sqlite.run('DELETE FROM region_promotions');
	opened.sqlite.run('DELETE FROM database_failovers');
	opened.sqlite.run('DELETE FROM database_replicas');
	opened.sqlite.run('DELETE FROM database_attachments');
	opened.sqlite.run('DELETE FROM databases');
	opened.sqlite.run("UPDATE nodes SET status = 'online'");
	control = new FakeControlPlane(b1.nodeId);
	runner = service(control, 'runner-b1');
});

describe('standby region', () => {
	test('setting one places an async replica there; it is never in the sync set', () => {
		core.databases.create(admin, { name: 'orders', placement: a1.nodeId });
		const view = core.databases.update(admin, 'orders', { standbyRegion: 'ukwest' });
		expect(view.standbyRegion).toBe('ukwest');
		const replicas = core.databaseReplicas.list(admin, 'orders');
		expect(replicas).toHaveLength(1);
		expect([b1.nodeId, b2.nodeId]).toContain(replicas[0]!.nodeId);
		expect(replicas[0]!.mode).toBe('async');
		// Setting it again finds the replica already there.
		core.databases.update(admin, 'orders', { standbyRegion: null });
		core.databases.update(admin, 'orders', { standbyRegion: 'ukwest' });
		expect(core.databaseReplicas.list(admin, 'orders')).toHaveLength(1);
	});

	test('the primary region, or a region with no data node, is refused before anything is written', () => {
		core.databases.create(admin, { name: 'orders', placement: a1.nodeId });
		expect(() => core.databases.update(admin, 'orders', { standbyRegion: 'uksouth' })).toThrow(/must differ from the primary's region/);
		expect(() => core.databases.update(admin, 'orders', { standbyRegion: 'euwest' })).toThrow(/No online data node is in region "euwest"/);
		expect(core.databases.get(admin, 'orders').standbyRegion).toBeNull();
		expect(core.databaseReplicas.list(admin, 'orders')).toHaveLength(0);
	});

	test('a database created with a standby region gets its replica in the same transaction', () => {
		const view = core.databases.create(admin, { name: 'ledger', placement: a1.nodeId, standbyRegion: 'ukwest' });
		expect(view.standbyRegion).toBe('ukwest');
		expect(core.databaseReplicas.list(admin, 'ledger')).toHaveLength(1);
	});
});

describe('sync only inside a region', () => {
	test('a cross-region sync replica is refused with a clear message', () => {
		core.databases.create(admin, { name: 'orders', placement: a1.nodeId });
		opened.sqlite.run("UPDATE databases SET durability = 'sync' WHERE name = 'orders'");
		expect(() => core.databaseReplicas.add(admin, 'orders', { node: b1.nodeId, mode: 'sync' })).toThrow(
			/A synchronous replica must be in the primary's region: b1 is in "ukwest", the primary on a1 is in "uksouth"/,
		);
		expect(core.databaseReplicas.add(admin, 'orders', { node: a2.nodeId, mode: 'sync' }).nodeId).toBe(a2.nodeId);
	});

	test('durability sync with only cross-region replicas is refused', async () => {
		core.databases.create(admin, { name: 'orders', placement: a1.nodeId, standbyRegion: 'ukwest' });
		await expect(core.databaseMembers.setDurability(admin, 'orders', { durability: 'sync', onSyncLoss: 'block' })).rejects.toThrow(/must be in the primary's region/);
	});
});

describe('automatic promotion never chooses the standby region', () => {
	test('the node never carries the W11 policy, and the controller never picks it', async () => {
		(core.ctx.config.features as Record<string, boolean>).DB_AUTO_PROMOTE = true;
		try {
			core.databases.create(admin, { name: 'orders', placement: a1.nodeId, standbyRegion: 'ukwest' });
			core.databaseReplicas.add(admin, 'orders', { node: a2.nodeId });
			const id = ids('orders');
			opened.sqlite.run("UPDATE databases SET failover_mode = 'auto', accept_data_loss = 1 WHERE id = ?", [id]);
			opened.sqlite.run("UPDATE database_replicas SET status = 'streaming', replay_lsn = '0/3000000', reported_at = ? WHERE database_id = ?", [clock, id]);
			const standby = core.databaseReplicas.list(admin, 'orders').find((replica) => replica.nodeId !== a2.nodeId)!;
			// Desired state per node: the in-region replica is armed, the standby-region one is not.
			expect(core.databaseMembers.membersDesired(id, a2.nodeId)?.failover?.mode).toBe('auto');
			expect(core.databaseMembers.membersDesired(id, standby.nodeId)?.failover).toBeUndefined();
			// The controller's choice and its gates.
			opened.sqlite.run("UPDATE database_replicas SET status = 'stopped' WHERE database_id = ? AND node_id = ?", [id, a2.nodeId]);
			const status = core.failover.status(admin).databases.find((row) => row.id === id)!;
			expect(status.candidate).toBeNull();
			expect(status.refusals.join(' ')).toContain('never promoted automatically');
			const database = opened.sqlite.query<Record<string, unknown>, [string]>('SELECT * FROM databases WHERE id = ?').get(id)!;
			expect(
				await core.databaseMembers.automaticPromotionRefusal(
					{ id, nodeId: a1.nodeId, primaryGeneration: 0, acceptDataLoss: true, failoverMode: 'auto', durabilityEffective: 'async', syncState: 'steady' } as never,
					standby.nodeId,
				),
			).toMatch(/automatic failover is no longer eligible|never promoted automatically/);
			const outcome = core.databaseReplicas.runFailoverStage(
				'fence',
				{ databaseId: id, candidateNodeId: standby.nodeId, generation: (database.primary_generation as number) + 1, reason: 'test' } as never,
				{ epoch: 1, holds: () => true } as never,
			);
			expect(outcome).toMatchObject({ status: 'failed', message: expect.stringContaining('never promoted automatically') });
		} finally {
			(core.ctx.config.features as Record<string, boolean>).DB_AUTO_PROMOTE = false;
		}
	});
});

function setupFleet(): { orders: string; ledger: string } {
	core.databases.create(admin, { name: 'orders', placement: a1.nodeId, standbyRegion: 'ukwest' });
	core.databases.create(admin, { name: 'ledger', placement: a2.nodeId });
	const ledgerReplica = core.databaseReplicas.add(admin, 'ledger', { node: b2.nodeId });
	expect(ledgerReplica.nodeId).toBe(b2.nodeId);
	opened.sqlite.run("UPDATE database_replicas SET status = 'streaming', replay_lsn = '0/5000000', lag_seconds = 4, lag_bytes = 4096, reported_at = ?", [clock]);
	return { orders: ids('orders'), ledger: ids('ledger') };
}

describe('yoal ha region promote', () => {
	test('without confirm it returns a plan in dependency order and stores nothing', async () => {
		setupFleet();
		const plan = (await runner.promote(admin, 'ukwest', {})) as RegionPromotionPlan & { liveLeases: string[]; blockers: string[] };
		expect(plan.fromRegion).toBe('uksouth');
		expect(plan.steps.map((step) => [step.kind, step.name])).toEqual([
			['control-plane', 'control plane on b1'],
			// The standby-region database first, then the others with a replica there.
			['database', 'orders'],
			['database', 'ledger'],
			['steering', 'steering: direct'],
		]);
		expect(plan.steps[0]!.expectedGeneration).toBe(5);
		expect(plan.maxLagSeconds).toBe(4);
		expect(plan.blockers).toEqual([]);
		expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
		expect(opened.sqlite.query('SELECT count(*) AS n FROM region_promotions').get()).toEqual({ n: 0 });
	});

	test('refused without the typed confirmation, on a stale plan, and while the old region holds its lease', async () => {
		setupFleet();
		const plan = (await runner.promote(admin, 'ukwest', {})) as RegionPromotionPlan;
		const confirm = { confirm: 'ukwest', planHash: plan.planHash, acceptDataLoss: true, reason: 'uksouth is down' };
		await expect(runner.promote(admin, 'ukwest', { confirm: 'ukwest' })).rejects.toThrow();
		await expect(runner.promote(admin, 'ukwest', { ...confirm, acceptDataLoss: false })).rejects.toThrow();
		await expect(runner.promote(admin, 'ukwest', { ...confirm, planHash: 'f'.repeat(64) })).rejects.toMatchObject({ status: 412 });
		// MCP never runs it, and neither does a non-admin.
		await expect(runner.promote({ ...admin, kind: 'mcp' }, 'ukwest', confirm)).rejects.toMatchObject({ status: 403 });
		await expect(runner.promote(buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'owner' }), 'ukwest', confirm)).rejects.toMatchObject({ status: 403 });
		// The old region's control-plane lease is still valid.
		control.leaseExpiresAt = clock + 20_000;
		await expect(runner.promote(admin, 'ukwest', confirm)).rejects.toThrow(/still holds a valid lease: the control-plane lease is held by a1/);
		expect(control.promotions).toBe(0);
		expect(opened.sqlite.query('SELECT count(*) AS n FROM region_promotions').get()).toEqual({ n: 0 });
		// Break glass is explicit and audited.
		const view = (await runner.promote(admin, 'ukwest', { ...confirm, breakGlass: true })) as RegionPromotionView;
		expect(view.steps[0]).toMatchObject({ kind: 'control-plane', status: 'done', fencedGeneration: 6 });
		const audit = opened.sqlite.query<{ args_json: string }, []>("SELECT args_json FROM audit_log WHERE action = 'ha.region.promote'").get();
		expect(JSON.parse(audit!.args_json)).toMatchObject({ breakGlass: true, toRegion: 'ukwest' });
	});

	test('runs control plane, databases, steering in order and records each step', async () => {
		const { orders, ledger } = setupFleet();
		const plan = (await runner.promote(admin, 'ukwest', {})) as RegionPromotionPlan;
		let view = (await runner.promote(admin, 'ukwest', { confirm: 'ukwest', planHash: plan.planHash, acceptDataLoss: true, reason: 'drill' })) as RegionPromotionView;
		// The control plane promoted itself first; the record is written under the new epoch.
		expect(control.promotions).toBe(1);
		expect(view.steps.map((step) => [step.kind, step.status])).toEqual([
			['control-plane', 'done'],
			['database', 'running'],
			['database', 'pending'],
			['steering', 'pending'],
		]);
		expect(view.steps[0]!.fencedGeneration).toBe(6);
		expect(view.steps[3]!.expectedGeneration).toBe(6);
		expect(view.stage).toBe('databases');
		// One database at a time, through the W10 path at the planned generation.
		expect(failovers(orders)).toBe(1);
		expect(failovers(ledger)).toBe(0);
		completeFailover(orders);
		await runner.tick();
		expect(failovers(ledger)).toBe(1);
		completeFailover(ledger);
		clock += 1_000;
		await runner.tick();
		view = core.regions.view(admin).recent[0]!;
		expect(view.stage).toBe('completed');
		expect(view.steps.map((step) => [step.kind, step.status, step.fencedGeneration])).toEqual([
			['control-plane', 'done', 6],
			['database', 'done', 1],
			['database', 'done', 1],
			['steering', 'done', null],
		]);
		expect(view.steps[3]!.message).toContain('direct: Yoal writes nothing; point your DNS or balancer at b1, b2');
		const started = view.steps.map((step) => Date.parse(step.startedAt!));
		expect([...started].sort((a, b) => a - b)).toEqual(started);
		// Steering now offers ukwest's ingress.
		expect(core.regions.activeRegion()).toBe('ukwest');
		expect(core.ctx.steering.driverContext().nodes().filter((node) => node.ingress).map((node) => node.name).sort()).toEqual(['b1', 'b2']);
	});

	test('a crash mid-promotion resumes on another runner without repeating a completed step', async () => {
		const { orders, ledger } = setupFleet();
		const plan = (await runner.promote(admin, 'ukwest', {})) as RegionPromotionPlan;
		await runner.promote(admin, 'ukwest', { confirm: 'ukwest', planHash: plan.planHash, acceptDataLoss: true, reason: 'drill' });
		// Runner b1 "crashes" here: it holds the lease, the orders promotion is in flight.
		const other = service(control, 'runner-b2');
		await other.tick();
		expect(opened.sqlite.query<{ runner_id: string; attempt: number }, []>('SELECT runner_id, attempt FROM region_promotions').get()).toEqual({ runner_id: 'runner-b1', attempt: 1 });
		clock += 61_000;
		await other.tick();
		expect(opened.sqlite.query<{ runner_id: string; attempt: number }, []>('SELECT runner_id, attempt FROM region_promotions').get()).toEqual({ runner_id: 'runner-b2', attempt: 2 });
		// The in-flight promotion is the step's own: never started twice.
		expect(failovers(orders)).toBe(1);
		completeFailover(orders);
		await other.tick();
		completeFailover(ledger);
		await other.tick();
		expect(control.promotions).toBe(1);
		expect(failovers(orders)).toBe(1);
		expect(failovers(ledger)).toBe(1);
		expect(core.regions.view(admin).recent[0]!.stage).toBe('completed');
	});

	test('a failed step stops the run with a precise state', async () => {
		const { orders } = setupFleet();
		const plan = (await runner.promote(admin, 'ukwest', {})) as RegionPromotionPlan;
		await runner.promote(admin, 'ukwest', { confirm: 'ukwest', planHash: plan.planHash, acceptDataLoss: true, reason: 'drill' });
		opened.sqlite.run("UPDATE database_failovers SET status = 'failed', message = 'pg_ctl promote failed on b1' WHERE database_id = ?", [orders]);
		await runner.tick();
		const view = core.regions.view(admin).recent[0]!;
		expect(view.stage).toBe('failed');
		expect(view.error).toBe('orders: pg_ctl promote failed on b1');
		expect(view.steps.map((step) => step.status)).toEqual(['done', 'failed', 'pending', 'pending']);
	});

	test('it must run on the control plane in the target region', async () => {
		setupFleet();
		const wrong = service(new FakeControlPlane(a2.nodeId), 'runner-a2');
		await expect(wrong.promote(admin, 'ukwest', {})).rejects.toThrow(/Run the promotion on the control plane in region "ukwest"/);
	});
});

describe('flag off', () => {
	test('promotion and region values are refused, and steering is the whole ingress set', async () => {
		(core.ctx.config.features as Record<string, boolean>).REGIONS = false;
		try {
			await expect(runner.promote(admin, 'ukwest', {})).rejects.toThrow(/YOAL_FEATURE_REGIONS/);
			expect(() => core.nodes.update(admin, a2.nodeId, { region: 'uknorth' })).toThrow(/YOAL_FEATURE_REGIONS/);
			expect(core.ctx.steering.driverContext().nodes().filter((node) => node.ingress)).toHaveLength(4);
			expect(core.regions.view(admin).enabled).toBe(false);
		} finally {
			(core.ctx.config.features as Record<string, boolean>).REGIONS = true;
		}
	});
});
