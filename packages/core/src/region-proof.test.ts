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
 * The reviewer's proof (W13 rework): the database live-lease gate, with fake nodes in two regions (HA-PLAN H26): uksouth (a1 edge, a2) and ukwest
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


/** A conditional store: the database lease arbiter, answering with its own clock. */
class MemArbiter {
	objects = new Map<string, { body: string; etag: string }>();
	n = 0;
	async readVersioned(key: string) {
		const o = this.objects.get(key);
		return o ? { status: 200, body: o.body, etag: o.etag, serverDate: clock } : { status: 404, body: null, etag: null, serverDate: clock };
	}
	async writeConditional(key: string, body: string, condition: { ifMatch?: string; ifNoneMatch?: string }) {
		const o = this.objects.get(key);
		if (condition.ifNoneMatch && o) return { status: 412, etag: null };
		if (condition.ifMatch && o?.etag !== condition.ifMatch) return { status: 412, etag: null };
		const etag = `"${++this.n}"`;
		this.objects.set(key, { body, etag });
		return { status: 200, etag };
	}
}
type Gated = RegionPromotionPlan & { liveLeases: string[]; blockers: string[]; syncSetLoss: string[] };
const { databaseLeaseKey } = await import('./database-sync.ts');
function setLease(arbiter: MemArbiter, databaseId: string, holder: string, expiresAt: number, extra: Record<string, unknown> = {}) {
	arbiter.objects.set(databaseLeaseKey(databaseId), {
		body: JSON.stringify({ generation: 0, holderNodeId: holder, expiresAt: new Date(expiresAt).toISOString(), sync: [], syncState: 'steady', durability: 'async', ...extra }),
		etag: `"x${++arbiter.n}"`,
	});
}

describe('PROOF: database live-lease gate', () => {
	let arbiter: MemArbiter;
	beforeEach(() => {
		arbiter = new MemArbiter();
		(core.ctx as { arbiter: unknown }).arbiter = arbiter;
	});
	afterAll(() => {
		(core.ctx as { arbiter: unknown }).arbiter = null;
	});

	test('a LIVE lease held by the old primary needs break glass; an EXPIRED one does not', async () => {
		core.databases.create(admin, { name: 'orders', placement: a1.nodeId, standbyRegion: 'ukwest' });
		const orders = ids('orders');
		opened.sqlite.run("UPDATE database_replicas SET status = 'streaming', replay_lsn = '0/5000000', lag_seconds = 4, lag_bytes = 4096, reported_at = ?", [clock]);
		// Old primary a1 still holds a valid lease (it may be serving writes).
		setLease(arbiter, orders, a1.nodeId, clock + 30_000);
		const live = (await runner.promote(admin, 'ukwest', {})) as Gated;
		expect(live.liveLeases).toEqual([expect.stringContaining('orders: the lease is held by a1')]);
		expect(live.blockers).toEqual([]);
		// Old primary's lease has expired at the arbiter's clock (region really dead): nothing to break.
		setLease(arbiter, orders, a1.nodeId, clock - 30_000);
		const dead = (await runner.promote(admin, 'ukwest', {})) as Gated;
		expect(dead.liveLeases).toEqual([]);
		// Back to live: confirming without break glass is refused, and nothing is promoted.
		setLease(arbiter, orders, a1.nodeId, clock + 30_000);
		const confirm = { confirm: 'ukwest', planHash: live.planHash, acceptDataLoss: true, reason: 'x' };
		await expect(runner.promote(admin, 'ukwest', confirm)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('the lease is held by a1') });
		expect(failovers(orders)).toBe(0);
		expect(control.promotions).toBe(0);
		// With break glass it runs, and the record says so.
		const view = (await runner.promote(admin, 'ukwest', { ...confirm, breakGlass: true })) as RegionPromotionView & { breakGlass: boolean };
		expect(view.breakGlass).toBe(true);
		expect(failovers(orders)).toBe(1);
	});

	test('an open sync change and sync-set membership are reported separately, with their own wording', async () => {
		core.databases.create(admin, { name: 'orders', placement: a1.nodeId, standbyRegion: 'ukwest' });
		const orders = ids('orders');
		opened.sqlite.run("UPDATE database_replicas SET status = 'streaming', replay_lsn = '0/5000000', reported_at = ?", [clock]);
		setLease(arbiter, orders, a1.nodeId, clock - 30_000, { durability: 'sync', durabilityEffective: 'sync', sync: [a2.nodeId] });
		const notMember = (await runner.promote(admin, 'ukwest', {})) as Gated;
		expect(notMember.liveLeases).toEqual([]);
		expect(notMember.blockers).toEqual([]);
		expect(notMember.syncSetLoss).toEqual([expect.stringContaining('not in the synchronous set')]);
		setLease(arbiter, orders, a1.nodeId, clock - 30_000, { syncState: 'changing' });
		const changing = (await runner.promote(admin, 'ukwest', {})) as Gated;
		expect(changing.blockers).toEqual([expect.stringContaining('a sync-set change is open')]);
		expect(changing.liveLeases).toEqual([]);
	});

	test('a lease that becomes live between confirm and a later database step stops that step', async () => {
		core.databases.create(admin, { name: 'orders', placement: a1.nodeId, standbyRegion: 'ukwest' });
		core.databases.create(admin, { name: 'ledger', placement: a2.nodeId });
		core.databaseReplicas.add(admin, 'ledger', { node: b2.nodeId });
		opened.sqlite.run("UPDATE database_replicas SET status = 'streaming', replay_lsn = '0/5000000', lag_seconds = 4, lag_bytes = 4096, reported_at = ?", [clock]);
		const plan = (await runner.promote(admin, 'ukwest', {})) as Gated;
		expect(plan.liveLeases).toEqual([]);
		await runner.promote(admin, 'ukwest', { confirm: 'ukwest', planHash: plan.planHash, acceptDataLoss: true, reason: 'x' });
		// The old region's ledger primary comes back and holds a valid lease before its step.
		setLease(arbiter, ids('ledger'), a2.nodeId, clock + 30_000);
		completeFailover(ids('orders'));
		await runner.tick();
		expect(failovers(ids('ledger'))).toBe(0);
		const view = core.regions.view(admin).recent[0]!;
		expect(view.stage).toBe('failed');
		expect(view.error).toContain('ledger: the lease is held by a2');
		expect(view.steps.map((step) => step.status)).toEqual(['done', 'done', 'failed', 'pending']);
	});

	test('with break glass recorded, a later step proceeds over a live lease (resumes included)', async () => {
		core.databases.create(admin, { name: 'orders', placement: a1.nodeId, standbyRegion: 'ukwest' });
		core.databases.create(admin, { name: 'ledger', placement: a2.nodeId });
		core.databaseReplicas.add(admin, 'ledger', { node: b2.nodeId });
		opened.sqlite.run("UPDATE database_replicas SET status = 'streaming', replay_lsn = '0/5000000', reported_at = ?", [clock]);
		const plan = (await runner.promote(admin, 'ukwest', {})) as Gated;
		await runner.promote(admin, 'ukwest', { confirm: 'ukwest', planHash: plan.planHash, acceptDataLoss: true, reason: 'x', breakGlass: true });
		setLease(arbiter, ids('ledger'), a2.nodeId, clock + 30_000);
		completeFailover(ids('orders'));
		// Another runner resumes: break glass is on the record, not in a process.
		clock += 61_000;
		setLease(arbiter, ids('ledger'), a2.nodeId, clock + 30_000);
		await service(control, 'runner-other').tick();
		expect(failovers(ids('ledger'))).toBe(1);
	});

	test('the control plane stops renewing an old primary\'s lease on its behalf once a region promotion is open', async () => {
		core.databases.create(admin, { name: 'orders', placement: a1.nodeId, standbyRegion: 'ukwest' });
		const orders = ids('orders');
		opened.sqlite.run("UPDATE database_replicas SET status = 'streaming', replay_lsn = '0/5000000', reported_at = ?", [clock]);
		opened.sqlite.run("UPDATE databases SET sync_lease_etag = 'x' WHERE id = ?", [orders]);
		const leaseExpiry = () => JSON.parse(arbiter.objects.get(databaseLeaseKey(orders))!.body).expiresAt as string;
		// Inside half a TTL of expiry: an online holder is renewed (today's W10 behaviour).
		setLease(arbiter, orders, a1.nodeId, clock + 5_000);
		await core.databaseMembers.tick(clock);
		expect(Date.parse(leaseExpiry())).toBeGreaterThan(clock + 5_000);
		// The holder's node is offline: never renewed on its behalf.
		setLease(arbiter, orders, a1.nodeId, clock + 5_000);
		opened.sqlite.run("UPDATE nodes SET status = 'offline' WHERE id = ?", [a1.nodeId]);
		await core.databaseMembers.tick(clock);
		expect(Date.parse(leaseExpiry())).toBe(clock + 5_000);
		opened.sqlite.run("UPDATE nodes SET status = 'online' WHERE id = ?", [a1.nodeId]);
		// An open promotion moving this database: never renewed either, so the gate can clear.
		setLease(arbiter, orders, a1.nodeId, clock - 1_000);
		const plan = (await runner.promote(admin, 'ukwest', {})) as Gated;
		await runner.promote(admin, 'ukwest', { confirm: 'ukwest', planHash: plan.planHash, acceptDataLoss: true, reason: 'x' });
		setLease(arbiter, orders, a1.nodeId, clock + 5_000);
		await core.databaseMembers.tick(clock);
		expect(Date.parse(leaseExpiry())).toBe(clock + 5_000);
	});

	test('a primary on a draining or pending node keeps its lease renewed (no promotion open)', async () => {
		core.databases.create(admin, { name: 'orders', placement: a1.nodeId });
		const orders = ids('orders');
		opened.sqlite.run("UPDATE databases SET sync_lease_etag = 'x' WHERE id = ?", [orders]);
		const leaseExpiry = () => JSON.parse(arbiter.objects.get(databaseLeaseKey(orders))!.body).expiresAt as string;
		for (const status of ['draining', 'pending']) {
			setLease(arbiter, orders, a1.nodeId, clock + 5_000);
			opened.sqlite.run('UPDATE nodes SET status = ? WHERE id = ?', [status, a1.nodeId]);
			await core.databaseMembers.tick(clock);
			expect(Date.parse(leaseExpiry())).toBeGreaterThan(clock + 5_000);
		}
	});

	test('with REGIONS off, an offline primary\'s lease is renewed as before regions existed', async () => {
		core.databases.create(admin, { name: 'orders', placement: a1.nodeId });
		const orders = ids('orders');
		opened.sqlite.run("UPDATE databases SET sync_lease_etag = 'x' WHERE id = ?", [orders]);
		const leaseExpiry = () => JSON.parse(arbiter.objects.get(databaseLeaseKey(orders))!.body).expiresAt as string;
		const features = core.ctx.config.features as Record<string, boolean>;
		features.REGIONS = false;
		try {
			setLease(arbiter, orders, a1.nodeId, clock + 5_000);
			opened.sqlite.run("UPDATE nodes SET status = 'offline' WHERE id = ?", [a1.nodeId]);
			await core.databaseMembers.tick(clock);
			expect(Date.parse(leaseExpiry())).toBeGreaterThan(clock + 5_000);
		} finally {
			features.REGIONS = true;
		}
	});
});
