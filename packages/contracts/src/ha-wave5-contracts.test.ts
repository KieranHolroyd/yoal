import { describe, expect, test } from 'bun:test';
import * as z from 'zod';
import { desiredStateSchema, heartbeatSchema } from './agent.ts';
import { blueprintHaKeys, blueprintSchema } from './blueprint.ts';
import { clusterConfigSchema, clusterConfigUpdateSchema } from './cluster-config.ts';
import { nodeClusterSettingsSchema, placementSpecSchema } from './cluster.ts';
import { databaseCreateSchema, databaseUpdateSchema } from './database.ts';
import { DEFAULT_FEATURES, FEATURE_FLAGS, OPT_IN_FEATURES } from './features.ts';
import {
	HA_CHECK_AREAS,
	HA_PROFILE_REQUIRED_CHECKS,
	featureFlagDrift,
	haCheckIds,
	haDependentChecks,
	haCheckNotBuilt,
	haCheckSchema,
	haFindingStatus,
	summarizeHaChecks,
	type HaCheck,
} from './ha-check.ts';
import {
	HA_DRILL_CATALOGUE,
	haDrillAllRequestSchema,
	haDrillConfirmationIssue,
	haDrillLevelIssue,
	haDrillRunRequestSchema,
	haDrillRunsInAll,
	planHaDrillAll,
	haDrillScenario,
	haDrillScenarioIds,
} from './ha-drill.ts';
import { HA_INIT_FLAGS, haInitAnswersSchema, haInitPlan } from './ha-init.ts';
import { controlReportSchema } from './control-plane.ts';
import { nodeUpdateSchema } from './api.ts';
import {
	DEFAULT_REGION,
	REGION_FIELDS,
	REGION_PROMOTION_ORDER,
	REGION_PROMOTION_STEP_FENCES,
	REGIONS_DOWNGRADE_NOTE,
	autoPromotionAllowedAcrossRegion,
	nextRegionPromotionStage,
	placementSpread,
	regionPromotionLeaseFree,
	regionPromotionStepSchema,
	regionPromoteRequestSchema,
	regionSpreadSyncRefusal,
	regionWriteIssues,
	standbyRegionRefusal,
	syncRegionRefusal,
	zoneRegionIssue,
	zoneRegions,
	type RegionPromotionStage,
} from './region.ts';
import { workloadSpecSchema } from './workload.ts';

/** Wave 5 foundation contracts (docs/build-plan/HA-WAVE-5.md, HA-PLAN H26/H27, §8). */

const OFF = { REGIONS: false };
/** What `ClusterConfigService.get` parses: every section present, then the stored row on top. */
const clusterRow = (stored: Record<string, unknown> = {}) =>
	clusterConfigSchema.parse({
		overlay: {},
		endpoints: {},
		replicas: {},
		database: {},
		storage: {},
		controlPlane: {},
		failover: {},
		scheduling: {},
		updates: {},
		ingress: {},
		steering: {},
		ha: {},
		...stored,
	});
const ON = { REGIONS: true };

describe('REGIONS flag and region fields', () => {
	test('REGIONS is opt-in, off by default', () => {
		expect(DEFAULT_FEATURES.REGIONS).toBe(false);
		expect(OPT_IN_FEATURES.has('REGIONS')).toBe(true);
		expect(FEATURE_FLAGS.REGIONS.description).toContain('H26');
	});

	test('every region field is refused with the flag off and allowed with it on', () => {
		const writes = [
			{ field: 'node.region', value: 'ukwest' },
			{ field: 'cluster.replicas.spread', value: 'region' },
			{ field: 'project.placementSpec.spread', value: 'region' },
			{ field: 'workload.placement.spread', value: 'region' },
			{ field: 'database.standbyRegion', value: 'ukwest' },
			{ field: 'blueprint.databases.spread', value: 'region' },
			{ field: 'blueprint.databases.standbyRegion', value: 'ukwest' },
			{ field: 'blueprint.projects.placement.spread', value: 'region' },
		] as const;
		expect(writes.map((write) => write.field)).toEqual([...REGION_FIELDS]);
		const issues = regionWriteIssues(writes, OFF);
		expect(issues.map((issue) => issue.field)).toEqual([...REGION_FIELDS]);
		for (const issue of issues) expect(issue.message).toContain('YOAL_FEATURE_REGIONS');
		expect(regionWriteIssues(writes, ON)).toEqual([]);
	});

	test('unchanged values, the implicit region, node/zone spreads and clearing a standby region are not region writes', () => {
		expect(
			regionWriteIssues(
				[
					{ field: 'node.region', value: undefined },
					{ field: 'node.region', value: DEFAULT_REGION },
					{ field: 'node.region', value: 'ukwest', current: 'ukwest' },
					// Returning to the implicit region is always allowed, like clearing a standby region.
					{ field: 'node.region', value: DEFAULT_REGION, current: 'ukwest' },
					{ field: 'cluster.replicas.spread', value: 'zone', current: 'node' },
					{ field: 'workload.placement.spread', value: 'region', current: 'region' },
					{ field: 'database.standbyRegion', value: null, current: 'ukwest' },
					{ field: 'database.standbyRegion', value: 'ukwest', current: 'ukwest' },
				],
				OFF,
			),
		).toEqual([]);
	});

	test('a zone belongs to exactly one region', () => {
		const nodes = [
			{ id: 'n1', name: 'a1', zone: 'uksouth-1', region: 'uksouth' },
			{ id: 'n2', name: 'a2', zone: 'uksouth-1', region: 'uksouth' },
			{ id: 'n3', name: 'b1', zone: 'ukwest-1', region: 'ukwest' },
			{ id: 'n4', name: 'old', zone: 'default', region: null },
		];
		expect(zoneRegions(nodes)).toEqual({
			zones: { default: 'default', 'uksouth-1': 'uksouth', 'ukwest-1': 'ukwest' },
			conflicts: [],
		});
		expect(zoneRegionIssue(nodes, { nodeId: 'n2', region: 'ukwest' })).toContain('Zone "uksouth-1" is in region "uksouth"');
		expect(zoneRegionIssue(nodes, { nodeId: 'n3', zone: 'uksouth-1' })).toContain('a zone belongs to exactly one region');
		expect(zoneRegionIssue(nodes, { nodeId: 'n3', zone: 'ukwest-2' })).toBeNull();
		expect(zoneRegionIssue(nodes, { nodeId: 'n4', region: 'default' })).toBeNull();
		expect(zoneRegions([...nodes, { id: 'n5', name: 'bad', zone: 'ukwest-1', region: 'uksouth' }]).conflicts).toEqual([
			{ zone: 'ukwest-1', regions: ['uksouth', 'ukwest'], nodes: ['bad', 'b1'] },
		]);
	});

	test('sync is refused across regions; standby regions never auto-promote', () => {
		expect(syncRegionRefusal({ nodeName: 'a', region: 'uksouth' }, { nodeName: 'b', region: 'uksouth' })).toBeNull();
		expect(syncRegionRefusal({ nodeName: 'a' }, { nodeName: 'b', region: DEFAULT_REGION })).toBeNull();
		expect(syncRegionRefusal({ nodeName: 'a', region: 'uksouth' }, { nodeName: 'dr', region: 'ukwest' })).toMatchObject({
			code: 'sync-across-regions',
			regions: ['uksouth', 'ukwest'],
			nodes: ['a', 'dr'],
		});
		expect(autoPromotionAllowedAcrossRegion('uksouth', 'uksouth')).toBe(true);
		expect(autoPromotionAllowedAcrossRegion(null, undefined)).toBe(true);
		expect(autoPromotionAllowedAcrossRegion('uksouth', 'ukwest')).toBe(false);
		expect(standbyRegionRefusal({ primaryRegion: 'uksouth', standbyRegion: 'uksouth', candidateNodes: ['x'] })?.code).toBe(
			'standby-region-is-primary-region',
		);
		expect(standbyRegionRefusal({ primaryRegion: 'uksouth', standbyRegion: 'ukwest', candidateNodes: [] })?.code).toBe(
			'standby-region-has-no-data-node',
		);
		expect(standbyRegionRefusal({ primaryRegion: 'uksouth', standbyRegion: 'ukwest', candidateNodes: ['dr'] })).toBeNull();
		expect(regionSpreadSyncRefusal('region', 'sync')?.code).toBe('region-spread-with-sync');
		expect(regionSpreadSyncRefusal('zone', 'sync')).toBeNull();
	});

	test('a region promotion runs control plane, databases, steering; each step carries its own fence', () => {
		expect([...REGION_PROMOTION_ORDER]).toEqual(['control-plane', 'databases', 'steering']);
		const path: RegionPromotionStage[] = ['control-plane'];
		for (let next = nextRegionPromotionStage(path[0]!); next; next = nextRegionPromotionStage(next)) path.push(next);
		expect(path).toEqual(['control-plane', 'databases', 'steering', 'completed']);
		expect(nextRegionPromotionStage('failed')).toBeNull();
		expect(nextRegionPromotionStage('cancelled')).toBeNull();
		const step = { position: 0, step: 'control-plane', kind: 'control-plane', resourceId: 'control-plane', name: 'control plane', expectedGeneration: 4 };
		expect(regionPromotionStepSchema.safeParse({ ...step, fencedGeneration: 5 }).success).toBe(true);
		expect(regionPromotionStepSchema.safeParse({ ...step, fencedGeneration: 4 }).success).toBe(false);
		expect(regionPromotionStepSchema.safeParse({ ...step, step: 'steering', kind: 'steering', resourceId: 'dns-failover', fencedGeneration: null }).success).toBe(true);
		expect(REGION_PROMOTION_STEP_FENCES).toEqual({ 'control-plane': 'control-epoch', database: 'database-lease', steering: 'control-epoch' });
		// A crashed runner's lease expires and another may take over; a live one is never doubled.
		expect(regionPromotionLeaseFree({ runnerId: null, leaseExpiresAt: null }, 1_000)).toBe(true);
		expect(regionPromotionLeaseFree({ runnerId: 'cp-b', leaseExpiresAt: 2_000 }, 1_000)).toBe(false);
		expect(regionPromotionLeaseFree({ runnerId: 'cp-b', leaseExpiresAt: 2_000 }, 2_000)).toBe(true);
	});

	test('a promotion request plans without confirm and needs every confirmation field to run', () => {
		expect(regionPromoteRequestSchema.safeParse({}).success).toBe(true);
		const missing = regionPromoteRequestSchema.safeParse({ confirm: 'ukwest' });
		expect(missing.success).toBe(false);
		expect(missing.error?.issues.map((issue) => issue.path.join('.')).sort()).toEqual(['acceptDataLoss', 'planHash', 'reason']);
		const planHash = 'a'.repeat(64);
		expect(regionPromoteRequestSchema.safeParse({ confirm: 'ukwest', planHash, acceptDataLoss: true, reason: 'uksouth is down' }).success).toBe(true);
		expect(regionPromoteRequestSchema.safeParse({ unknown: 1 }).success).toBe(false);
	});

	test('the REGIONS flag and the contract warn that a stored region value cannot be downgraded', () => {
		expect(FEATURE_FLAGS.REGIONS.description).toContain('downgrad');
		expect(REGIONS_DOWNGRADE_NOTE).toContain('older control plane');
	});

	test('a stored spread: region is placed as zone until region placement exists, and always with REGIONS off', () => {
		expect(placementSpread('region', { REGIONS: false })).toBe('zone');
		expect(placementSpread('region', { REGIONS: true })).toBe('zone');
		expect(placementSpread('node', { REGIONS: false })).toBe('node');
		expect(placementSpread('zone', { REGIONS: true })).toBe('zone');
	});

	test('the W9 control report can carry the host\'s running flags; old reports parse unchanged', () => {
		const report = { role: 'standby' as const, epoch: 3, leaseHolderNodeId: 'n1', leaseExpiresAt: null, canPromote: true, replicationLagSeconds: 1 };
		expect(controlReportSchema.parse(report)).toEqual(report);
		expect(controlReportSchema.parse({ ...report, featureFlags: { REGIONS: true } }).featureFlags).toEqual({ REGIONS: true });
	});

	test('no agent-facing schema gains a region value (HA-PLAN §9 mixed versions)', () => {
		for (const schema of [desiredStateSchema, heartbeatSchema]) {
			const json = JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));
			const enums: string[][] = [];
			JSON.parse(json, (key, value) => {
				if (key === 'enum' && Array.isArray(value)) enums.push(value);
				if (key === 'const' && typeof value === 'string') enums.push([value]);
				return value;
			});
			for (const values of enums) expect(values).not.toContain('region');
			expect(json).not.toContain('standbyRegion');
		}
	});

	test('the control-plane spread enums gain region; old values and rows parse unchanged', () => {
		expect(placementSpecSchema.parse({ spread: 'region' })).toEqual({ spread: 'region' });
		expect(placementSpecSchema.parse({ zone: 'a', spread: 'zone' })).toEqual({ zone: 'a', spread: 'zone' });
		const stored = { replicas: { max: 4, spread: 'zone' }, failover: { enabled: true } };
		const parsed = clusterRow(stored);
		expect(parsed.replicas).toEqual({ max: 4, spread: 'zone', healthIntervalSeconds: 5, failoverGraceSeconds: 120 });
		expect(clusterRow().replicas.spread).toBe('node');
		expect(clusterConfigUpdateSchema.safeParse({ replicas: { spread: 'region' } }).success).toBe(true);
		expect(nodeUpdateSchema.parse({ zone: 'a' })).toEqual({ zone: 'a' });
		expect(nodeUpdateSchema.parse({ region: 'ukwest' })).toEqual({ region: 'ukwest' });
		expect(nodeClusterSettingsSchema.parse({ zone: 'a' })).toEqual({ zone: 'a' });
		const database = databaseCreateSchema.parse({ name: 'main' });
		expect('standbyRegion' in database).toBe(false);
		expect(databaseCreateSchema.safeParse({ name: 'cache', engine: 'redis', standbyRegion: 'ukwest' }).success).toBe(false);
		expect(databaseUpdateSchema.parse({ standbyRegion: null })).toEqual({ standbyRegion: null });
		const spec = workloadSpecSchema.parse({ runtime: 'process', placement: { spread: 'region' } });
		expect(spec.placement).toEqual({ spread: 'region' });
	});
});

const LIVE = { 'steering.driver': 'direct', 'steering.stacked': [], 'failover.enabled': true, 'replicas.spread': 'node' } as const;
const HA_FLAGS: string[] = ['ENDPOINTS_GATEWAY', 'RELEASE_PHASE', 'INGRESS_SET', 'SHARED_CERTIFICATES', 'STEERING', 'CONTROL_STANDBY', 'SYNC_REPLICA', 'PITR_REWIND', 'DB_AUTO_PROMOTE'];
const on = (plan: ReturnType<typeof haInitPlan>): string[] => plan.flags.filter((flag) => flag.value).map((flag) => flag.name);

describe('ha init profile plans', () => {
	test('are pure and deterministic', () => {
		for (const profile of ['single', 'ha', 'ha-dr'] as const) {
			const facts = { otherRegions: ['ukwest'], settings: { ...LIVE } };
			const answers = { steering: 'dns-failover' as const };
			const first = haInitPlan(profile, answers, facts);
			const second = haInitPlan(profile, { ...answers }, { ...facts, otherRegions: [...facts.otherRegions] });
			expect(JSON.stringify(first)).toBe(JSON.stringify(second));
			expect(first).toEqual(second);
		}
		// The facts array is not mutated by sorting.
		const regions = ['ukwest', 'eu-north'];
		haInitPlan('ha-dr', {}, { otherRegions: regions });
		expect(regions).toEqual(['ukwest', 'eu-north']);
	});

	test('ask at most three questions, each with its default; the arbiter is not a question', () => {
		expect(haInitPlan('single').questions).toEqual([]);
		const ha = haInitPlan('ha');
		expect(ha.questions.map((question) => [question.id, question.default])).toEqual([
			['steering', 'external-lb'],
			['certificates', 'shared'],
		]);
		expect(ha.unanswered).toEqual([]);
		const dr = haInitPlan('ha-dr', {}, { otherRegions: ['ukwest'] });
		expect(dr.questions.length).toBe(3);
		expect(dr.questions[2]).toMatchObject({ id: 'standbyRegion', default: 'ukwest', value: 'ukwest' });
		expect(dr.standbyRegion).toBe('ukwest');
		expect(haInitPlan('ha-dr', {}, { otherRegions: ['a', 'b'] }).unanswered).toEqual(['standbyRegion']);
		expect(haInitPlan('ha-dr', { standbyRegion: 'b' }, { otherRegions: ['a', 'b'] }).unanswered).toEqual([]);
		expect(haInitAnswersSchema.safeParse({ steering: 'direct' }).success).toBe(false);
		expect(haInitAnswersSchema.safeParse({ arbiter: 's3' }).success).toBe(false);
	});

	test('ha sets its flags and records only the settings it changed, with their previous values', () => {
		const ha = haInitPlan('ha', {}, { settings: { ...LIVE } });
		expect(on(ha)).toEqual(HA_FLAGS);
		expect(ha.envLines).toContain('YOAL_FEATURE_INGRESS_SET=1');
		expect(ha.envLines.some((line) => line.startsWith('YOAL_FEATURE_REGIONS'))).toBe(false);
		expect(ha.cluster).toEqual({
			ha: {
				profile: 'ha',
				applied: {
					profile: 'ha',
					flags: HA_FLAGS,
					settings: [
						{ path: 'steering.driver', previous: 'direct' },
						{ path: 'replicas.spread', previous: 'node' },
					],
				},
			},
			steering: { driver: 'external-lb', stacked: [] },
			failover: { enabled: true },
			replicas: { spread: 'zone' },
		});
		expect(on(haInitPlan('ha', { certificates: 'per-node' }))).not.toContain('SHARED_CERTIFICATES');
		const dr = haInitPlan('ha-dr', {}, { otherRegions: ['ukwest'] });
		expect(on(dr)).toContain('REGIONS');
		expect(dr.cluster.steering).toEqual({ driver: 'external-lb', stacked: ['dns-failover'] });
		expect(dr.notes.join(' ')).toContain('downgrad');
		// Moving from ha to ha-dr keeps the values from before the first profile.
		const after = { ...LIVE, 'steering.driver': 'external-lb', 'replicas.spread': 'zone' } as const;
		const again = haInitPlan('ha-dr', {}, { otherRegions: ['ukwest'], settings: after, applied: ha.cluster.ha!.applied! });
		expect(again.cluster.ha?.applied?.settings).toEqual([
			{ path: 'steering.driver', previous: 'direct' },
			{ path: 'steering.stacked', previous: [] },
			{ path: 'replicas.spread', previous: 'node' },
		]);
		for (const plan of [ha, dr, again]) expect(clusterConfigUpdateSchema.safeParse(plan.cluster).success).toBe(true);
	});

	test('single reverses exactly what the profile set and never touches what was set before it', () => {
		const ha = haInitPlan('ha', {}, { settings: { ...LIVE } });
		const single = haInitPlan('single', {}, { applied: ha.cluster.ha!.applied! });
		expect(on(single)).toEqual([]);
		expect(single.flags.map((flag): string => flag.name)).toEqual(HA_FLAGS);
		expect(single.flags.map((flag): string => flag.name)).not.toContain('REGIONS');
		// failover.enabled was already on before ha init, so it is not touched.
		expect(single.cluster).toEqual({ ha: { profile: 'single', applied: null }, steering: { driver: 'direct' }, replicas: { spread: 'node' } });
		expect(clusterConfigUpdateSchema.safeParse(single.cluster).success).toBe(true);
		expect(single.preflight).toEqual(['ha-dependents']);
		const bare = haInitPlan('single');
		expect(bare.flags).toEqual([]);
		expect(bare.cluster).toEqual({ ha: { profile: 'single', applied: null } });
		expect(bare.notes.join(' ')).toContain('no record');
		expect(ha.preflight).toEqual(HA_PROFILE_REQUIRED_CHECKS.ha);
		expect(clusterRow().ha).toEqual({ profile: 'single', applied: null });
	});

	test('every flag ha init manages is a registered opt-in flag', () => {
		for (const name of HA_INIT_FLAGS) expect(OPT_IN_FEATURES.has(name)).toBe(true);
	});
});

describe('preflight and doctor checks', () => {
	test('ids are stable, unique and each has an area; the W12 finding keys are kept', () => {
		expect(new Set(haCheckIds).size).toBe(haCheckIds.length);
		expect(Object.keys(HA_CHECK_AREAS).sort()).toEqual([...haCheckIds].sort());
		for (const key of ['platform-store', 'registry-storage', 'identity', 'mail', 'telemetry-spool'])
			expect(haCheckIds).toContain(key as (typeof haCheckIds)[number]);
		for (const id of ['nodes', 'zones', 'regions', 'clocks', 'overlay-links', 'arbiter-conditional-writes', 'certificates', 'steering', 'backups', 'headroom', 'flags-consistent', 'ha-dependents'])
			expect(haCheckIds).toContain(id as (typeof haCheckIds)[number]);
		for (const ids of Object.values(HA_PROFILE_REQUIRED_CHECKS)) for (const id of ids) expect(haCheckIds).toContain(id);
		expect(HA_PROFILE_REQUIRED_CHECKS.single).toEqual(['ha-dependents']);
		expect(HA_PROFILE_REQUIRED_CHECKS.ha).toContain('flags-consistent');
	});

	test('finding severities map onto statuses and ok needs every required check to run', () => {
		expect([haFindingStatus('blocker'), haFindingStatus('warning'), haFindingStatus('info')]).toEqual(['fail', 'warn', 'pass']);
		const pass = (id: HaCheck['id']): HaCheck => ({ id, title: id, status: 'pass', evidence: [], fix: null, subject: null });
		const all = HA_PROFILE_REQUIRED_CHECKS.ha.map(pass);
		expect(summarizeHaChecks('ha', all).ok).toBe(true);
		expect(summarizeHaChecks('ha', all.slice(1)).ok).toBe(false);
		expect(summarizeHaChecks('ha', [...all.slice(1), haCheckNotBuilt('nodes', 'Nodes', 'lane B')]).ok).toBe(false);
		expect(summarizeHaChecks('ha', [...all, { ...pass('mail'), status: 'fail' }])).toEqual({
			ok: true,
			counts: { pass: all.length, warn: 0, fail: 1, skip: 0 },
		});
		expect(summarizeHaChecks('single', []).ok).toBe(false);
		expect(summarizeHaChecks('single', [pass('ha-dependents')]).ok).toBe(true);
		expect(haCheckSchema.safeParse({ ...pass('nodes'), fix: { kind: 'command', value: 'yoal nodes list' } }).success).toBe(true);
	});

	test('flag drift between control-plane hosts is found', () => {
		expect(
			featureFlagDrift([
				{ name: 'cp-a', flags: { REGIONS: false, STEERING: true } },
				{ name: 'cp-b', flags: { REGIONS: true, STEERING: true } },
				{ name: 'cp-c', flags: null },
			]),
		).toEqual({ differences: [{ flag: 'REGIONS', values: { 'cp-a': false, 'cp-b': true } }], unreported: ['cp-c'] });
		expect(featureFlagDrift([{ name: 'cp-a', flags: { REGIONS: false } }, { name: 'cp-b', flags: {} }]).differences).toEqual([
			{ flag: 'REGIONS', values: { 'cp-a': false, 'cp-b': null } },
		]);
	});

	test('anything that depends on HA blocks single, each with its way back', () => {
		expect(haDependentChecks([])).toEqual([
			{ id: 'ha-dependents', title: 'Nothing depends on an HA feature', status: 'pass', evidence: ['No sync or armed database, gateway attachment, control standby, region or steering driver.'], fix: null, subject: null },
		]);
		const checks = haDependentChecks([
			{ kind: 'sync-database', id: 'db_1', name: 'main' },
			{ kind: 'armed-database', id: 'db_1', name: 'main' },
			{ kind: 'gateway-attachment', id: 'wl_1', name: 'api' },
			{ kind: 'control-standby', id: 'nod_2', name: 'cp-b' },
			{ kind: 'region', id: 'nod_3', name: 'dr-1' },
			{ kind: 'steering', id: 'external-lb', name: 'external-lb' },
		]);
		expect(checks.every((check) => check.status === 'fail' && check.fix !== null)).toBe(true);
		expect(checks.map((check) => check.fix!.value)).toEqual([
			'yoal db durability main --async',
			'yoal db failover main --disarm',
			expect.stringContaining('ENDPOINTS_GATEWAY'),
			expect.stringContaining('cp-b'),
			expect.stringContaining('"region": "default"'),
			expect.stringContaining('steering.driver'),
		]);
	});
});

describe('drill catalogue', () => {
	test('covers every scenario id once and reconciles with the existing drills', () => {
		expect(HA_DRILL_CATALOGUE.map((entry) => entry.id).sort()).toEqual([...haDrillScenarioIds].sort());
		expect(haDrillScenario('node-offline')).toMatchObject({ recordsIn: 'node_drills', resourceKind: 'node', availability: 'fleet', destructive: true, confirmation: 'typed' });
		expect(haDrillScenario('ingress-offline')).toMatchObject({ destructive: true, confirmation: 'typed' });
		expect(haDrillScenario('database-failover')).toMatchObject({ recordsIn: 'database_failover_drills', confirmation: 'confirm', flags: ['SYNC_REPLICA'] });
		// Not `toMatchObject({ fleetUnavailableReason: expect.any(String) })`: Bun writes the matcher
		// into the received object, which corrupted the shared catalogue for later test files.
		for (const id of ['zone-offline', 'control-plane-failover', 'region-failover'] as const) {
			expect(haDrillScenario(id).availability).toBe('lab');
			expect(typeof haDrillScenario(id).fleetUnavailableReason).toBe('string');
		}
		for (const entry of HA_DRILL_CATALOGUE) expect(entry.fleetUnavailableReason === null).toBe(entry.availability === 'fleet');
	});

	test('destructive scenarios need a typed confirmation; empty names and confirmations are refused', () => {
		for (const entry of HA_DRILL_CATALOGUE) {
			if (entry.destructive) expect(entry.confirmation).toBe('typed');
			expect(entry.measures.length).toBeGreaterThan(0);
			if (entry.bound.rpo !== null) expect(entry.measures).toContain('rpo');
		}
		expect(haDrillConfirmationIssue(haDrillScenario('node-offline'), 'a1', 'a1')).toBeNull();
		expect(haDrillConfirmationIssue(haDrillScenario('node-offline'), 'a1', undefined)).toContain('type the name');
		expect(haDrillConfirmationIssue(haDrillScenario('node-offline'), '', '')).toContain('Name the resource');
		expect(haDrillConfirmationIssue(haDrillScenario('database-failover'), 'main', true)).toBeNull();
		expect(haDrillConfirmationIssue(haDrillScenario('database-failover'), 'main', '')).toContain('confirm: true');
		expect(haDrillConfirmationIssue(haDrillScenario('stale-generation-promote'), 'main', undefined)).toBeNull();
		expect(haDrillRunRequestSchema.safeParse({ scenario: 'node-offline' }).success).toBe(false);
		expect(haDrillRunRequestSchema.safeParse({ scenario: 'node-offline', resource: 'a1', confirm: 'a1' }).success).toBe(true);
		expect(haDrillRunRequestSchema.safeParse({ scenario: 'node-offline', resource: '', confirm: '' }).success).toBe(false);
		expect(haDrillRunRequestSchema.safeParse({ scenario: 'nope', resource: 'x' }).success).toBe(false);
	});

	test('--all runs only fleet, non-destructive, untyped scenarios against named resources', () => {
		for (const entry of HA_DRILL_CATALOGUE)
			expect(haDrillRunsInAll(entry)).toBe(entry.availability === 'fleet' && !entry.destructive && entry.confirmation !== 'typed');
		expect(haDrillAllRequestSchema.safeParse({ includeDestructive: true }).success).toBe(false);
		const plan = planHaDrillAll(haDrillAllRequestSchema.parse({ targets: [{ kind: 'database', resource: 'main', drillDatabase: 'main-drill' }], confirm: true }), {
			SYNC_REPLICA: true,
		});
		expect(plan.runs).toEqual([
			{ scenario: 'stale-generation-promote', resource: 'main' },
			{ scenario: 'database-failover', resource: 'main', drillDatabase: 'main-drill' },
		]);
		const reasons = Object.fromEntries(plan.skipped.map((item) => [item.scenario, item.reason]));
		expect(reasons['node-offline']).toContain('typed confirmation');
		expect(reasons['zone-offline']).toContain('lab');
		const bare = planHaDrillAll(haDrillAllRequestSchema.parse({}), {});
		expect(bare.runs).toEqual([]);
		expect(Object.fromEntries(bare.skipped.map((item) => [item.scenario, item.reason]))['stale-generation-promote']).toContain('No database was named');
		const unconfirmed = planHaDrillAll(haDrillAllRequestSchema.parse({ targets: [{ kind: 'database', resource: 'main', drillDatabase: 'd' }] }), { SYNC_REPLICA: true });
		expect(unconfirmed.runs.map((run) => run.scenario)).toEqual(['stale-generation-promote']);
		const off = planHaDrillAll(haDrillAllRequestSchema.parse({ targets: [{ kind: 'database', resource: 'main', drillDatabase: 'd' }], confirm: true }), {});
		expect(Object.fromEntries(off.skipped.map((item) => [item.scenario, item.reason]))['database-failover']).toContain('YOAL_FEATURE_SYNC_REPLICA');
	});

	test('a drill is refused below the scenario\'s level and on a resource below its own declared level', () => {
		const failover = haDrillScenario('database-failover');
		expect(haDrillLevelIssue(failover, { declared: 'L3', effective: 'L3' })).toBeNull();
		expect(haDrillLevelIssue(failover, { declared: 'L1', effective: 'L3' })).toContain('declared L1');
		expect(haDrillLevelIssue(failover, { declared: 'L3', effective: 'L2' })).toContain('below its declared L3');
		expect(haDrillLevelIssue(failover, { declared: null, effective: 'L1' })).toContain('L1');
		expect(haDrillLevelIssue(failover, { declared: null, effective: 'L2' })).toBeNull();
		expect(haDrillLevelIssue(haDrillScenario('arbiter-unreachable'), { declared: null, effective: 'L0' })).toBeNull();
	});
});


describe('blueprint HA keys (schema only)', () => {
	const old = {
		apiVersion: 'yoal/v1',
		name: 'shop',
		projects: {
			'shop-web': { runtime: 'container', image: 'ghcr.io/acme/shop:1', port: 3000, placement: 'auto', replicas: 2 },
			'shop-site': { runtime: 'static', domains: ['shop.example.com'] },
		},
		databases: { 'shop-db': { engine: 'postgres', version: '17', pooler: true } },
		attachments: [{ project: 'shop-web', database: 'shop-db' }],
	};

	test('an old file parses to exactly what it did, with no HA keys', () => {
		const parsed = blueprintSchema.parse(old);
		expect(parsed).toEqual({
			apiVersion: 'yoal/v1',
			name: 'shop',
			projects: {
				'shop-web': { runtime: 'container', image: 'ghcr.io/acme/shop:1', port: 3000, placement: 'auto', replicas: 2, environments: {}, domains: [] },
				'shop-site': { runtime: 'static', domains: ['shop.example.com'], environments: {} },
			},
			databases: { 'shop-db': { engine: 'postgres', version: '17', pooler: true } },
			storage: {},
			brokers: {},
			attachments: [{ project: 'shop-web', database: 'shop-db' }],
		});
		expect(blueprintHaKeys(parsed)).toEqual([]);
	});

	test('the HA-PLAN §8 example parses and every new key is listed', () => {
		const doc = blueprintSchema.parse({
			apiVersion: 'yoal/v1',
			name: 'lynxnet',
			cluster: {
				requires: { zones: 3, ingressNodes: 2, dataNodes: 3 },
				steering: { driver: 'external-lb', drainSeconds: 20 },
			},
			projects: {
				lynxnet: {
					runtime: 'container',
					image: 'registry.apps.example.org/nhs/lynxnet:1.4.0',
					port: 3460,
					healthPath: '/healthz',
					readinessPath: '/readyz',
					replicas: 3,
					placement: { spread: 'zone' },
					release: { command: ['bun', 'run', 'db:migrate'], timeoutSeconds: 300 },
					rollout: { canary: 1, soakSeconds: 900, maxUnavailable: 1 },
					drainSeconds: 15,
					domains: ['lynxnet.example.org'],
					secrets: ['BETTER_AUTH_SECRET'],
				},
			},
			databases: {
				main: {
					engine: 'postgres',
					version: '18',
					replicas: 2,
					durability: 'sync',
					failover: 'auto',
					spread: 'zone',
					pitr: true,
					backups: { target: 'azure-uksouth', immutable: true },
					standbyRegion: 'ukwest',
				},
			},
			attachments: [{ project: 'lynxnet', database: 'main', prefix: 'DATABASE' }],
		});
		expect(blueprintHaKeys(doc)).toEqual([
			'cluster',
			'projects.lynxnet.placement',
			'projects.lynxnet.readinessPath',
			'projects.lynxnet.release',
			'projects.lynxnet.rollout',
			'projects.lynxnet.drainSeconds',
			'databases.main.replicas',
			'databases.main.durability',
			'databases.main.failover',
			'databases.main.spread',
			'databases.main.pitr',
			'databases.main.backups',
			'databases.main.standbyRegion',
		]);
	});

	test('refuses HA keys that cannot hold', () => {
		const issue = (doc: unknown) => blueprintSchema.safeParse(doc).error?.issues.map((item) => `${item.path.join('.')}: ${item.message}`) ?? [];
		const base = { apiVersion: 'yoal/v1', name: 'stack' };
		expect(issue({ ...base, databases: { main: { durability: 'sync', spread: 'region' } } }).join()).toContain('sync is only offered inside a region');
		expect(issue({ ...base, databases: { main: { durability: 'sync', replicas: 0 } } }).join()).toContain('needs at least one replica');
		expect(issue({ ...base, databases: { cache: { engine: 'redis', replicas: 1 } } }).join()).toContain('PostgreSQL only');
		expect(issue({ ...base, projects: { site: { runtime: 'static', placement: { spread: 'zone' } } } }).join()).toContain('Only app projects take a spread');
		expect(issue({ ...base, projects: { site: { runtime: 'static', rollout: { canary: 0 } } } }).join()).toContain('Static projects have no workload settings');
		expect(issue({ ...base, cluster: { requires: { racks: 2 } } }).length).toBeGreaterThan(0);
	});

	test('failover: auto is armed like the CLI: an async database needs acceptDataLoss, a sync one refuses it', () => {
		const issue = (database: unknown) =>
			blueprintSchema.safeParse({ apiVersion: 'yoal/v1', name: 'stack', databases: { main: database } }).error?.issues.map((item) => item.message).join() ?? '';
		expect(issue({ replicas: 1, failover: 'auto', acceptDataLoss: true })).toBe('');
		expect(issue({ replicas: 1, failover: 'auto' })).toBe('');
		expect(issue({ replicas: 1, durability: 'sync', failover: 'auto', acceptDataLoss: true })).toContain('sync database loses no acknowledged commit');
		expect(issue({ replicas: 1, acceptDataLoss: true })).toContain('only with failover: auto');
		const doc = blueprintSchema.parse({ apiVersion: 'yoal/v1', name: 'stack', databases: { main: { replicas: 1, failover: 'auto', acceptDataLoss: true } } });
		expect(blueprintHaKeys(doc)).toEqual(['databases.main.replicas', 'databases.main.failover', 'databases.main.acceptDataLoss']);
	});
});
