import { describe, expect, test } from 'bun:test';
import {
	databaseFailoverArmRequestSchema,
	databaseFailoverDrillRequestSchema,
	databaseFailoverDrillSchema,
	databaseFailoverEvidenceSchema,
	databaseFailoverPolicyViewSchema,
	databaseMemberReportSchema,
	databaseMembersDesiredSchema,
	externalProberReportSchema,
	failoverArmRefusalSchema,
	sloBurnAlertSchema,
	sloObjectInputSchema,
	sloObjectViewSchema,
} from './index.ts';

/**
 * HA Wave 4 foundation (docs/build-plan/HA-WAVE-4.md): old member/desired data still parses, the
 * policy and refusal shapes are stable, and W15's SLO/prober contracts refuse impossible values.
 */

const AT = '2026-11-21T10:00:00.000Z';

const oldDesired = {
	databaseId: 'db_1',
	generation: 1,
	members: [
		{ nodeId: 'nod_1', address: '10.0.0.1', role: 'primary', slot: null },
		{ nodeId: 'nod_2', address: '10.0.0.2', role: 'replica', slot: 'yoal_repl_db_1_nod_2' },
	],
	sync: [],
	durability: 'async',
};

describe('W11 failover policy contracts', () => {
	test('an old databaseMembersDesired parses and omits failover', () => {
		const parsed = databaseMembersDesiredSchema.parse(oldDesired);
		expect(parsed.failover).toBeUndefined();
		expect(parsed.syncState).toBe('steady');
	});

	test('a W11 desired entry carries the per-database policy', () => {
		const parsed = databaseMembersDesiredSchema.parse({
			...oldDesired,
			failover: { mode: 'auto', acceptDataLoss: true, autoArmedAt: AT },
		});
		expect(parsed.failover).toEqual({ mode: 'auto', acceptDataLoss: true, autoArmedAt: AT });
	});

	test('an old member heartbeat parses; W11 detection fields are optional', () => {
		const parsed = databaseMemberReportSchema.parse({
			databaseId: 'db_1',
			role: 'streaming',
			generation: 1,
			epoch: 0,
			streaming: true,
			inRecovery: true,
			observedAt: AT,
		});
		expect(parsed.arbiterReachable).toBeUndefined();
		expect(parsed.leaseExpiresAt).toBeUndefined();
		const withEvidence = databaseMemberReportSchema.parse({
			databaseId: 'db_1',
			role: 'streaming',
			generation: 1,
			epoch: 0,
			streaming: true,
			inRecovery: true,
			arbiterReachable: true,
			leaseExpiresAt: AT,
			primaryKeepAliveAt: AT,
			observedAt: AT,
		});
		expect(withEvidence.arbiterReachable).toBe(true);
		expect(withEvidence.primaryKeepAliveAt).toBe(AT);
	});

	test('evidence defaults are safe, so an empty stored object parses', () => {
		const evidence = databaseFailoverEvidenceSchema.parse({});
		expect(evidence.autoPromoteEnabled).toBe(false);
		expect(evidence.dataNodeCount).toBe(0);
		expect(evidence.membersCapable).toBe(false);
		expect(evidence.syncState).toBe('steady');
		expect(evidence.observedAt).toBeNull();
	});

	test('refusals carry a stable code, a message and structured detail', () => {
		const refusal = failoverArmRefusalSchema.parse({
			code: 'too-few-data-nodes',
			message: 'Auto needs three data nodes.',
			detail: { count: 2, required: 3 },
		});
		expect(refusal.code).toBe('too-few-data-nodes');
		expect(refusal.detail).toEqual({ count: 2, required: 3 });
		expect(() => failoverArmRefusalSchema.parse({ code: 'made-up', message: 'x' })).toThrow();
	});

	test('a drill records the measured time to writable and the arbiter evidence', () => {
		const drill = databaseFailoverDrillSchema.parse({
			id: 'drl_1',
			databaseId: 'db_1',
			status: 'passed',
			startedAt: AT,
			finishedAt: AT,
			timeToWritableMs: 21_400,
			lostCommits: 0,
			generation: 2,
			fromNodeId: 'nod_1',
			toNodeId: 'nod_2',
			arbiterTested: true,
			arbiterTestedAt: AT,
			message: null,
		});
		expect(drill.timeToWritableMs).toBe(21_400);
		expect(drill.evidence).toEqual({});
	});

	test('the policy view shows the active state and every refusal', () => {
		const view = databaseFailoverPolicyViewSchema.parse({
			databaseId: 'db_1',
			failoverMode: 'auto',
			acceptDataLoss: false,
			autoArmedAt: AT,
			lastFailoverDrillAt: AT,
			lastDrill: null,
			evidence: {},
			armedEvidence: null,
			active: false,
			refusals: [{ code: 'drill-stale', message: 'Run a fresh drill.' }],
		});
		expect(view.active).toBe(false);
		expect(view.refusals[0]?.code).toBe('drill-stale');
	});

	test('arming and drilling need a typed confirmation', () => {
		expect(databaseFailoverArmRequestSchema.parse({ confirm: true }).acceptDataLoss).toBe(false);
		expect(databaseFailoverDrillRequestSchema.parse({ confirm: true }).note).toBeUndefined();
		expect(() => databaseFailoverArmRequestSchema.parse({ confirm: false })).toThrow();
	});
});

describe('W15 SLO and prober contracts', () => {
	test('an SLO object defaults its burn alerts and accepts a 30-day target', () => {
		const slo = sloObjectInputSchema.parse({
			name: 'app availability',
			indicator: 'http_availability',
			target: 0.999,
			windowSeconds: 30 * 24 * 60 * 60,
		});
		expect(slo.burnAlerts).toEqual([]);
		expect(slo.enabled).toBe(true);
		expect(slo.description).toBeNull();
	});

	test('a target of 1 or 0 is refused: there is no error budget to alert on', () => {
		expect(() => sloObjectInputSchema.parse({ name: 'x', indicator: 'x', target: 1, windowSeconds: 86_400 })).toThrow();
		expect(() => sloObjectInputSchema.parse({ name: 'x', indicator: 'x', target: 0, windowSeconds: 86_400 })).toThrow();
	});

	test('a burn alert must use a short window inside its long one', () => {
		expect(
			sloBurnAlertSchema.parse({ severity: 'critical', burnRate: 14.4, windowSeconds: 3_600, shortWindowSeconds: 300 }),
		).toMatchObject({ severity: 'critical', burnRate: 14.4 });
		expect(() =>
			sloBurnAlertSchema.parse({ severity: 'warning', burnRate: 6, windowSeconds: 3_600, shortWindowSeconds: 3_600 }),
		).toThrow();
	});

	test('a burn window cannot exceed the SLO window', () => {
		expect(() =>
			sloObjectInputSchema.parse({
				name: 'x',
				indicator: 'x',
				target: 0.99,
				windowSeconds: 3_600,
				burnAlerts: [{ severity: 'warning', burnRate: 2, windowSeconds: 7_200 }],
			}),
		).toThrow();
	});

	test('the SLO view carries the derived error budget, null before evaluation', () => {
		const view = sloObjectViewSchema.parse({
			id: 'slo_1',
			orgId: 'org_1',
			projectId: 'prj_1',
			name: 'availability',
			description: null,
			indicator: 'http_availability',
			target: 0.999,
			windowSeconds: 2_592_000,
			burnAlerts: [],
			enabled: true,
			createdBy: 'user_1',
			createdAt: AT,
			updatedAt: AT,
			errorBudget: null,
		});
		expect(view.errorBudget).toBeNull();
	});

	test('an external prober report parses with per-target outcomes', () => {
		const report = externalProberReportSchema.parse({
			proberId: 'prb_lon_1',
			sequence: 42,
			sentAt: AT,
			targets: [
				{ target: 'https://app.example.com/healthz', kind: 'https', status: 'up', statusCode: 200, latencyMs: 84, checkedAt: AT },
				{ target: 'db.example.com:5432', kind: 'database', status: 'down', error: 'connection refused', checkedAt: AT },
			],
		});
		expect(report.installId).toBeNull();
		expect(report.targets[1]?.status).toBe('down');
		expect(report.targets[0]?.error).toBeNull();
	});

	test('a prober report needs at least one target', () => {
		expect(() => externalProberReportSchema.parse({ proberId: 'p', sequence: 1, sentAt: AT, targets: [] })).toThrow();
	});
});
