import { describe, expect, test } from 'bun:test';
import {
	externalProberRegistrationInputSchema,
	externalProberReportSchema,
	externalProberViewSchema,
	haTimelineItemSchema,
	projectHaTargetInputSchema,
	projectHaTargetViewSchema,
	sloOverviewSchema,
} from './index.ts';

/** W15 read views: the shapes the REST surface, dashboard, prober and metrics agree on. */
const AT = '2026-11-21T10:00:00.000Z';

describe('W15 observability contracts', () => {
	test('a declared target is one HA level or null', () => {
		expect(projectHaTargetInputSchema.parse({ target: 'L2' }).target).toBe('L2');
		expect(projectHaTargetInputSchema.parse({ target: null }).target).toBeNull();
		expect(() => projectHaTargetInputSchema.parse({ target: 'L4' })).toThrow();
	});

	test('the effective view carries the weakest level and its blockers', () => {
		const view = projectHaTargetViewSchema.parse({
			projectId: 'prj_1',
			slug: 'app',
			name: 'App',
			declared: 'L2',
			effective: 'L0',
			belowTarget: true,
			blockers: ['add a replica on another node'],
		});
		expect(view.belowTarget).toBe(true);
		expect(view.blockers).toHaveLength(1);
	});

	test('a timeline item distinguishes a measured drill from an unmeasured failover', () => {
		const drill = haTimelineItemSchema.parse({
			id: 'drl_1',
			source: 'drill',
			kind: 'drill',
			databaseId: 'db_1',
			databaseName: 'main',
			status: 'passed',
			durability: 'sync',
			promotionSource: 'drill',
			fromNodeId: 'nod_1',
			fromNodeName: 'a',
			toNodeId: 'nod_2',
			toNodeName: 'b',
			generation: 2,
			startedAt: AT,
			finishedAt: AT,
			timeToWritableMs: 21_000,
			lostCommits: 0,
			arbiterTested: true,
			message: null,
		});
		expect(drill.timeToWritableMs).toBe(21_000);
		expect(drill.lostCommits).toBe(0);
		expect(
			haTimelineItemSchema.parse({
				...drill,
				id: 'dbf_1',
				source: 'failover',
				kind: 'failover',
				promotionSource: 'auto',
				lostCommits: null,
				arbiterTested: null,
			}).lostCommits,
		).toBeNull();
	});

	test('a report sequence starts at 1, so sequence 0 is refused', () => {
		expect(() =>
			externalProberReportSchema.parse({
				proberId: 'prb_1',
				sequence: 0,
				sentAt: AT,
				targets: [{ target: 'https://app.test/healthz', kind: 'https', status: 'up', checkedAt: AT }],
			}),
		).toThrow();
	});

	test('a prober registration defaults its interval and health is explicit', () => {
		const input = externalProberRegistrationInputSchema.parse({ name: 'london' });
		expect(input.intervalSeconds).toBe(60);
		expect(input.installId).toBeNull();
		const view = externalProberViewSchema.parse({
			proberId: 'prb_1',
			name: 'london',
			installId: null,
			intervalSeconds: 60,
			createdBy: 'user_1',
			createdAt: AT,
			revokedAt: null,
			lastReportAt: null,
			lastSequence: 0,
			stale: false,
			staleAfterSeconds: 180,
			targets: [],
			counts: { up: 0, degraded: 0, down: 0 },
		});
		expect(view.stale).toBe(false);
	});

	test('the SLO overview is explicitly empty while the flag is off', () => {
		const overview = sloOverviewSchema.parse({ enabled: false, generatedAt: AT, objects: [] });
		expect(overview.enabled).toBe(false);
		expect(() => sloOverviewSchema.parse({ enabled: false, generatedAt: AT })).toThrow();
	});
});
