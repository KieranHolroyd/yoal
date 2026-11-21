import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	DEFAULT_FEATURES,
	externalProberReportSchema,
	sloObjectInputSchema,
	type Principal,
	type SloObjectInput,
} from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { ExternalProberService } from './external-prober-service.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import type { MetricPoint, TelemetryStore } from './telemetry.ts';
import { EFFECTIVE_BELOW_TARGET_GRACE_MS } from './slo-service.ts';

/**
 * W15 (HA-PLAN §4): SLO evaluation and burn alerts, the external prober's token sink and health
 * expiry, `ha.effective_below_target`, the failover/drill timeline and the HA metrics. Every
 * SLO/prober surface is flag-gated; the effective-level check and timeline are always readable.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-w4-observability-'));
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
		now: () => clock,
		features: { ...DEFAULT_FEATURES, SLO_OBJECTS: false, EXTERNAL_PROBER: false },
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

/** Traffic and database samples an SLO evaluator reads; no ClickHouse in unit tests. */
class FakeTelemetry {
	traffic: MetricPoint[] = [];
	/** Optional per-window answer, so a short burn window can differ from its long window. */
	trafficFor: ((fromMs: number, toMs: number) => MetricPoint[]) | null = null;
	databases = new Map<string, Array<{ up: number }>>();
	ready = async () => true;
	getPrometheusMetrics = async () => '';
	scrapeSamples = async () => ({ traffic: [], databases: [], databaseCounters: [], storage: [], brokers: [], brokerCounters: [] });
	query = async (input: { from: number; to: number }) =>
		this.trafficFor ? this.trafficFor(Number(input.from), Number(input.to)) : this.traffic;
	queryDatabaseMetrics = async ({ databaseId }: { databaseId: string }) =>
		(this.databases.get(databaseId) ?? []).map((point, index) => ({
			bucket: new Date(clock - index * 60_000).toISOString(),
			...point,
		}));
}

function setFeature(name: keyof typeof DEFAULT_FEATURES, value: boolean): void {
	(core.ctx.config.features as Record<string, boolean>)[name] = value;
}

const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'data').token, name: 'data-a' });
opened.sqlite.run('UPDATE nodes SET capabilities_json = ?, status = ?, zone = ? WHERE id = ?', ['["db-member"]', 'online', 'a', node.nodeId]);
const otherNode = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'data').token, name: 'data-b' });
opened.sqlite.run('UPDATE nodes SET capabilities_json = ?, status = ?, zone = ? WHERE id = ?', ['["db-member"]', 'online', 'b', otherNode.nodeId]);

const projectSlug = 'app';
const databaseName = 'main';
let sequence = 0;

await core.projects.create(owner, {
	name: 'App',
	slug: projectSlug,
	runtime: 'process',
	placement: 'edge',
	productionAccess: 'public',
	previewAccess: 'platform',
});
const database = core.databases.create(owner, { name: databaseName, placement: node.nodeId });
core.databases.attach(owner, core.projects.requireRow(owner, projectSlug), { database: databaseName });
const telemetry = new FakeTelemetry();
(core.ctx as { telemetry?: unknown }).telemetry = telemetry as unknown as TelemetryStore;

const input = (overrides: Partial<SloObjectInput> = {}): SloObjectInput =>
	sloObjectInputSchema.parse({
		name: 'availability',
		indicator: 'http_availability',
		target: 0.9,
		windowSeconds: 3_600,
		...overrides,
	});

function addDrill(
	overrides: Partial<{
		status: string;
		durability: string;
		startedAt: number;
		finishedAt: number | null;
		timeToWritableMs: number | null;
		lostCommits: number | null;
		arbiterTested: number;
		message: string | null;
	}> = {},
): string {
	const id = `drl_${++sequence}`;
	const value = {
		status: 'passed',
		durability: 'sync',
		startedAt: clock - 60_000,
		finishedAt: clock,
		timeToWritableMs: 21_000,
		lostCommits: 0,
		arbiterTested: 1,
		...overrides,
	};
	opened.sqlite.run(
		`INSERT INTO database_failover_drills
		 (id, database_id, drill_database_id, status, durability, started_at, finished_at, time_to_writable_ms,
		  lost_commits, generation, arbiter_tested, arbiter_tested_at, created_by, created_at)
		 VALUES (?, ?, 'db_disposable', ?, ?, ?, ?, ?, ?, 1, ?, ?, 'user_1', 1)`,
		[id, database.id, value.status, value.durability, value.startedAt, value.finishedAt, value.timeToWritableMs, value.lostCommits, value.arbiterTested, value.arbiterTested ? clock : null],
	);
	return id;
}

function addFailover(
	overrides: Partial<{
		kind: string;
		status: string;
		startedAt: number;
		finishedAt: number | null;
		promotionSucceededAt: number | null;
		promotionSource: string;
		fromNodeId: string;
		toNodeId: string;
		generation: number;
		message: string | null;
	}> = {},
): string {
	const id = `dbf_${++sequence}`;
	const value = {
		kind: 'failover',
		status: 'completed',
		startedAt: clock - 90_000,
		finishedAt: clock - 70_000,
		promotionSucceededAt: clock - 68_000,
		promotionSource: 'auto',
		fromNodeId: node.nodeId,
		toNodeId: otherNode.nodeId,
		generation: 2,
		...overrides,
	};
	opened.sqlite.run(
		`INSERT INTO database_failovers
		 (id, database_id, from_node_id, to_node_id, generation, status, kind, promotion_source, started_at,
		  finished_at, promoted_at, promotion_succeeded_at, message)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			database.id,
			value.fromNodeId,
			value.toNodeId,
			value.generation,
			value.status,
			value.kind,
			value.promotionSource,
			value.startedAt,
			value.finishedAt,
			value.promotionSucceededAt,
			value.promotionSucceededAt,
			value.message ?? null,
		],
	);
	return id;
}

function systemAlerts(): Array<{ fingerprint: string | null; title: string; severity: string }> {
	return opened.sqlite
		.query<{ fingerprint: string | null; title: string; severity: string }, []>(
			"SELECT fingerprint, title, severity FROM alert_events WHERE kind = 'system' ORDER BY at",
		)
		.all();
}

beforeEach(() => {
	clock = Date.parse('2026-11-21T10:00:00Z');
	setFeature('SLO_OBJECTS', true);
	setFeature('EXTERNAL_PROBER', true);
	telemetry.traffic = [];
	telemetry.databases.clear();
	opened.sqlite.run('DELETE FROM slo_objects');
	opened.sqlite.run('DELETE FROM alert_events');
	opened.sqlite.run('DELETE FROM alert_state');
	// The service keeps a first-seen map; clearing the declaration is what resets it.
	core.slos.setHaTarget(owner, projectSlug, { target: null });
	opened.sqlite.run("DELETE FROM settings WHERE key = 'external_prober_registrations'");
	opened.sqlite.run('DELETE FROM database_failover_drills');
	opened.sqlite.run('DELETE FROM database_failovers');
	opened.sqlite.run('DELETE FROM database_member_status');
	opened.sqlite.run('DELETE FROM database_replicas');
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('SLO objects', () => {
	test('are absent and refuse writes while SLO_OBJECTS is off', async () => {
		const existing = await core.slos.upsert(owner, projectSlug, input());
		setFeature('SLO_OBJECTS', false);
		expect(core.slos.list(owner, projectSlug)).toEqual([]);
		await expect(core.slos.upsert(owner, projectSlug, input())).rejects.toMatchObject({ code: 'unavailable' });
		await expect(core.slos.evaluate(owner, projectSlug)).rejects.toMatchObject({ code: 'unavailable' });
		expect(() => core.slos.remove(owner, projectSlug, 'slo_x')).toThrow(/SLO_OBJECTS/);
		expect((await core.slos.overview(owner)).enabled).toBe(false);
		setFeature('SLO_OBJECTS', true);
		core.slos.remove(owner, projectSlug, existing.id);
	});

	test('create by name, update in place and list newest values', async () => {
		const created = await core.slos.upsert(owner, projectSlug, input());
		expect(created.id).toStartWith('slo_');
		expect(created.errorBudget).toBeNull();
		const updated = await core.slos.upsert(owner, projectSlug, input({ target: 0.99, name: 'availability' }));
		expect(updated.id).toBe(created.id);
		expect(updated.target).toBe(0.99);
		expect(core.slos.list(owner, projectSlug)).toHaveLength(1);
		const second = await core.slos.upsert(owner, projectSlug, input({ name: 'latency', indicator: 'database_writable' }));
		expect(core.slos.list(owner, projectSlug).map((slo) => slo.name)).toEqual(['availability', 'latency']);
		core.slos.remove(owner, projectSlug, second.id);
		expect(core.slos.list(owner, projectSlug)).toHaveLength(1);
	});
});

describe('SLO evaluation and burn alerts', () => {
	beforeEach(() => {
		telemetry.traffic = [{ requests: 1_000, status5xx: 50 } as unknown as MetricPoint];
	});

	test('computes the error budget from telemetry over the window', async () => {
		await core.slos.upsert(owner, projectSlug, input({ target: 0.9 }));
		const [evaluation] = await core.slos.evaluate(owner, projectSlug);
		expect(evaluation!.errorBudget.total).toBeCloseTo(0.1);
		expect(evaluation!.errorBudget.consumed).toBeCloseTo(0.5);
		expect(evaluation!.errorBudget.remaining).toBeCloseTo(0.5);
		expect(evaluation!.errorBudget.burnRate).toBeCloseTo(0.5);
		expect(evaluation!.note).toBeNull();
	});

	test('a multi-window burn alert fires only when both windows exceed the threshold', async () => {
		await core.slos.upsert(
			owner,
			projectSlug,
			input({
				target: 0.9,
				burnAlerts: [{ severity: 'critical', burnRate: 2, windowSeconds: 3_600, shortWindowSeconds: 300 }],
			}),
		);
		telemetry.traffic = [{ requests: 1_000, status5xx: 400 } as unknown as MetricPoint];
		let [evaluation] = await core.slos.evaluate(owner, projectSlug);
		expect(evaluation!.burnAlerts[0]!.observedBurnRate).toBeCloseTo(4);
		expect(evaluation!.burnAlerts[0]!.firing).toBe(true);

		// The long window still burns, but the short window is clean: no fast-burn confirmation.
		telemetry.trafficFor = (fromMs, toMs) =>
			toMs - fromMs > 300_000
				? [{ requests: 1_000, status5xx: 400 } as unknown as MetricPoint]
				: [{ requests: 300, status5xx: 0 } as unknown as MetricPoint];
		[evaluation] = await core.slos.evaluate(owner, projectSlug);
		expect(evaluation!.burnAlerts[0]!.observedBurnRate).toBeCloseTo(4);
		expect(evaluation!.burnAlerts[0]!.firing).toBe(false);
		telemetry.trafficFor = null;
	});

	test('a zero-traffic window is marked as no data, not a healthy 0%', async () => {
		await core.slos.upsert(owner, projectSlug, input({ target: 0.99 }));
		telemetry.traffic = [];
		const [evaluation] = await core.slos.evaluate(owner, projectSlug);
		expect(evaluation!.errorBudget.hasData).toBe(false);
		expect(evaluation!.note).toContain('no requests');
	});

	test('an unsupported indicator is a note, never a healthy fabricated ratio', async () => {
		await core.slos.upsert(owner, projectSlug, input({ indicator: 'mail_delivery', burnAlerts: [{ severity: 'warning', burnRate: 2, windowSeconds: 3_600, shortWindowSeconds: null }] }));
		const [evaluation] = await core.slos.evaluate(owner, projectSlug);
		expect(evaluation!.note).toContain('has no evaluator');
		expect(evaluation!.errorBudget.consumed).toBe(0);
		expect(evaluation!.burnAlerts[0]!.firing).toBe(false);
	});

	test('database_writable reads the project’s attached database samples', async () => {
		telemetry.databases.set(database.id, [{ up: 1 }, { up: 1 }, { up: 0 }, { up: 1 }]);
		await core.slos.upsert(owner, projectSlug, input({ indicator: 'database_writable', target: 0.5 }));
		const [evaluation] = await core.slos.evaluate(owner, projectSlug);
		expect(evaluation!.errorBudget.consumed).toBeCloseTo(0.5);
		expect(evaluation!.note).toBeNull();
	});

	test('sweep raises one routed alert per firing burn and respects flags', async () => {
		await core.slos.upsert(
			owner,
			projectSlug,
			input({ target: 0.9, burnAlerts: [{ severity: 'critical', burnRate: 2, windowSeconds: 3_600, shortWindowSeconds: null }] }),
		);
		telemetry.traffic = [{ requests: 1_000, status5xx: 400 } as unknown as MetricPoint];
		const fired = await core.slos.sweep();
		expect(fired.some((key) => key.startsWith('ha.slo_burn:'))).toBe(true);
		expect(systemAlerts().some((alert) => alert.fingerprint?.startsWith('ha.slo_burn:'))).toBe(true);

		setFeature('SLO_OBJECTS', false);
		opened.sqlite.run('DELETE FROM alert_events');
		expect(await core.slos.sweep()).toEqual([]);
		expect(systemAlerts()).toHaveLength(0);
	});
});

describe('ha.effective_below_target', () => {
	test('compares the declared target with the weakest live resource', async () => {
		const before = core.slos.haTarget(owner, projectSlug);
		expect(before.declared).toBeNull();
		expect(before.effective).toBe('L0');

		const declared = core.slos.setHaTarget(owner, projectSlug, { target: 'L2' });
		expect(declared.declared).toBe('L2');
		expect(declared.belowTarget).toBe(true);
		expect(declared.blockers.length).toBeGreaterThan(0);

		const targets = core.slos.targets(owner);
		expect(targets.belowTarget).toBe(1);
		expect(targets.targets.find((target) => target.slug === projectSlug)?.effective).toBe('L0');

		const cleared = core.slos.setHaTarget(owner, projectSlug, { target: null });
		expect(cleared.declared).toBeNull();
		expect(cleared.belowTarget).toBe(false);
	});

	test('alerts only after the grace period, then once per cooldown', async () => {
		core.slos.setHaTarget(owner, projectSlug, { target: 'L2' });
		expect(await core.slos.sweep()).toEqual([]);
		clock += EFFECTIVE_BELOW_TARGET_GRACE_MS;
		const fired = await core.slos.sweep();
		expect(fired.some((key) => key === `ha.effective_below_target:${core.projects.requireRow(owner, projectSlug).id}`)).toBe(true);
		expect(systemAlerts().some((alert) => alert.title.includes('HA level below target'))).toBe(true);
	});
});

describe('failover and drill timeline', () => {
	test('merges history newest first with measured TTF and lost commits', async () => {
		const drill = addDrill({ startedAt: clock - 10 * 60_000, finishedAt: clock - 9 * 60_000, timeToWritableMs: 21_000, lostCommits: 0 });
		const failover = addFailover({ startedAt: clock - 60_000, finishedAt: clock - 30_000, promotionSucceededAt: clock - 30_000 });
		const view = core.slos.timeline(owner);
		expect(view.items.map((item) => item.id)).toEqual([failover, drill]);
		const latest = view.items[0]!;
		expect(latest.kind).toBe('failover');
		expect(latest.timeToWritableMs).toBe(30_000);
		expect(latest.lostCommits).toBeNull();
		expect(latest.fromNodeName).toBe('data-a');
		expect(latest.toNodeName).toBe('data-b');
		const drilled = view.items[1]!;
		expect(drilled.source).toBe('drill');
		expect(drilled.timeToWritableMs).toBe(21_000);
		expect(drilled.lostCommits).toBe(0);
		expect(drilled.arbiterTested).toBe(true);
	});
});

describe('external prober', () => {
	test('refuses registration and reports while EXTERNAL_PROBER is off', async () => {
		setFeature('EXTERNAL_PROBER', false);
		expect(core.externalProber.enabled()).toBe(false);
		expect(() => core.externalProber.register(owner, { name: 'outside', installId: null, intervalSeconds: 60 })).toThrow(/EXTERNAL_PROBER/);
		await expect(
			core.externalProber.report('token', externalProberReportSchema.parse({ proberId: 'prb_1', sequence: 1, sentAt: new Date(clock).toISOString(), targets: [{ target: 'https://app.test/healthz', kind: 'https', status: 'up', checkedAt: new Date(clock).toISOString() }] })),
		).rejects.toMatchObject({ code: 'unavailable' });
		expect(core.externalProber.list(owner)).toEqual({ enabled: false, probers: [] });
	});

	test('registers once, verifies the token, de-duplicates sequence and expires stale health', async () => {
		const registration = core.externalProber.register(owner, { name: 'london', installId: null, intervalSeconds: 10 });
		expect(registration.token).toStartWith('yoalp_');
		expect(registration.prober.stale).toBe(false);
		expect(core.externalProber.list(owner).probers[0]!.targets).toEqual([]);

		const report = (sequence: number, status: 'up' | 'down' = 'up') =>
			externalProberReportSchema.parse({
				proberId: registration.prober.proberId,
				sequence,
				sentAt: new Date(clock).toISOString(),
				targets: [{ target: 'https://app.test/healthz', kind: 'https', status, checkedAt: new Date(clock).toISOString() }],
			});
		await expect(core.externalProber.report('wrong-token', report(1))).rejects.toMatchObject({ code: 'unauthorized' });
		const ack = await core.externalProber.report(registration.token, report(1));
		expect(ack.accepted).toBe(1);
		const duplicate = await core.externalProber.report(registration.token, report(1));
		expect(duplicate.accepted).toBe(0);
		expect(core.externalProber.list(owner).probers[0]!.counts.up).toBe(1);

		clock += 121_000;
		const stale = core.externalProber.list(owner).probers[0]!;
		expect(stale.stale).toBe(true);
		const fired = await core.externalProber.sweep();
		expect(fired).toHaveLength(1);
		expect(systemAlerts().some((alert) => alert.fingerprint === `ha.prober_stale:${registration.prober.proberId}`)).toBe(true);
	});

	test('an install-bound registration refuses a report with no installId', async () => {
		const registration = core.externalProber.register(owner, { name: 'bound', installId: 'ins_1', intervalSeconds: 60 });
		const report = (installId: string | null) =>
			externalProberReportSchema.parse({
				proberId: registration.prober.proberId,
				sequence: 1,
				sentAt: new Date(clock).toISOString(),
				installId,
				targets: [{ target: 'https://app.test/healthz', kind: 'https', status: 'up', checkedAt: new Date(clock).toISOString() }],
			});
		await expect(core.externalProber.report(registration.token, report(null))).rejects.toMatchObject({ code: 'conflict' });
		expect((await core.externalProber.report(registration.token, report('ins_1'))).accepted).toBe(1);
	});

	test('a purged project takes its SLO and declared target with it', async () => {
		await core.projects.create(owner, {
			name: 'Stray',
			slug: 'stray-project',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const stray = await core.slos.upsert(owner, 'stray-project', input({ target: 0.9 }));
		core.slos.setHaTarget(owner, 'stray-project', { target: 'L2' });
		const row = core.projects.requireRow(owner, 'stray-project');
		await core.projects.purgeRow(row);
		expect(opened.sqlite.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM slo_objects WHERE id = ?').get(stray.id)!.n).toBe(0);
		expect(opened.sqlite.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM settings WHERE key = ?').get(`ha_target:${row.id}`)!.n).toBe(0);
	});

	test('sweep skips an SLO whose project row has already gone', async () => {
		await core.projects.create(owner, {
			name: 'Orphan',
			slug: 'orphan-project',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const stray = await core.slos.upsert(owner, 'orphan-project', input({ target: 0.9 }));
		telemetry.traffic = [{ requests: 1_000, status5xx: 400 } as unknown as MetricPoint];
		opened.sqlite.run('DELETE FROM projects WHERE id = ?', [core.projects.requireRow(owner, 'orphan-project').id]);
		expect(await core.slos.sweep()).toEqual([]);
		expect(systemAlerts().some((alert) => alert.fingerprint?.includes(stray.id))).toBe(false);
	});

	test('reports are rate-capped per prober', async () => {
		const registration = core.externalProber.register(owner, { name: 'chatty', installId: null, intervalSeconds: 10 });
		const service = new ExternalProberService(core.ctx);
		const report = (sequence: number) =>
			externalProberReportSchema.parse({
				proberId: registration.prober.proberId,
				sequence,
				sentAt: new Date(clock).toISOString(),
				targets: [{ target: 'https://app.test/healthz', kind: 'https', status: 'up', checkedAt: new Date(clock).toISOString() }],
			});
		for (let sequence = 1; sequence <= 120; sequence += 1) await service.report(registration.token, report(sequence));
		await expect(service.report(registration.token, report(121))).rejects.toMatchObject({ code: 'rate_limited' });
	});

	test('a revoked token is refused', async () => {
		const registration = core.externalProber.register(owner, { name: 'berlin', installId: null, intervalSeconds: 60 });
		core.externalProber.revoke(owner, registration.prober.proberId);
		await expect(
			core.externalProber.report(
				registration.token,
				externalProberReportSchema.parse({
					proberId: registration.prober.proberId,
					sequence: 1,
					sentAt: new Date(clock).toISOString(),
					targets: [{ target: 'https://app.test/healthz', kind: 'https', status: 'up', checkedAt: new Date(clock).toISOString() }],
				}),
			),
		).rejects.toMatchObject({ code: 'unauthorized' });
	});
});

describe('HA metrics on /metrics', () => {
	test('renders replication, database lease and steering series', async () => {
		core.slos.setHaTarget(owner, projectSlug, { target: 'L2' });
		opened.sqlite.run(
			`INSERT INTO database_replicas (id, database_id, node_id, status, slot, lag_seconds, lag_bytes, primary_generation, created_at, updated_at)
			 VALUES ('dbr_metrics', ?, ?, 'streaming', 'slot_metrics', 1.5, 2048, 1, 1, 1)`,
			[database.id, otherNode.nodeId],
		);
		opened.sqlite.run(
			`INSERT INTO database_member_status
			 (database_id, node_id, role, generation, epoch, streaming, in_recovery, lease_generation, lease_epoch, observed_at)
			 VALUES (?, ?, 'primary', 3, 2, 1, 0, 3, 2, ?)`,
			[database.id, node.nodeId, clock],
		);
		const platform = await core.ctx.metricsExport.render(owner, { section: 'platform' });
		const org = await core.ctx.metricsExport.render(owner, { section: 'all' });
		expect(platform).toContain('yoal_ha_effective_below_target{project="app"');
		expect(platform).toContain('yoal_database_lease_generation{database="main"');
		expect(platform).toContain('yoal_database_lease_epoch');
		expect(platform).toContain('yoal_steering_active');
		expect(org).toContain('yoal_database_replica_lag_seconds{database="main"');
		expect(org).toContain('yoal_database_durability_effective{database="main"');
		core.ctx.metricsExport.updateSettings(owner, { publicPlatform: true });
		const publicText = await core.ctx.metricsExport.render(undefined, { section: 'all' });
		expect(publicText).not.toContain('yoal_ha_effective_below_target');
		expect(publicText).not.toContain('yoal_database_lease_holder');
		expect(publicText).not.toContain('yoal_steering_active');
		core.ctx.metricsExport.updateSettings(owner, { publicPlatform: false });
	});
});
