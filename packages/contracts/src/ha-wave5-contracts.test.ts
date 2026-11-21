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
	haCheckIds,
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
	haDrillRunRequestSchema,
	haDrillScenario,
	haDrillScenarioIds,
} from './ha-drill.ts';
import { HA_INIT_FLAGS, haInitAnswersSchema, haInitPlan } from './ha-init.ts';
import { nodeUpdateSchema } from './api.ts';
import {
	DEFAULT_REGION,
	REGION_FIELDS,
	REGION_PROMOTION_ORDER,
	autoPromotionAllowedAcrossRegion,
	nextRegionPromotionStage,
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

	test('region promotion runs control plane, databases, steering, after the fence', () => {
		expect([...REGION_PROMOTION_ORDER]).toEqual(['control-plane', 'databases', 'steering']);
		const path: RegionPromotionStage[] = ['awaiting-confirmation'];
		for (let next = nextRegionPromotionStage(path[0]!); next; next = nextRegionPromotionStage(next)) path.push(next);
		expect(path).toEqual(['awaiting-confirmation', 'fencing', 'control-plane', 'databases', 'steering', 'completed']);
		expect(nextRegionPromotionStage('failed')).toBeNull();
		expect(nextRegionPromotionStage('cancelled')).toBeNull();
	});

	test('a promotion request plans without confirm and needs every confirmation field to run', () => {
		expect(regionPromoteRequestSchema.safeParse({}).success).toBe(true);
		const missing = regionPromoteRequestSchema.safeParse({ confirm: 'ukwest' });
		expect(missing.success).toBe(false);
		expect(missing.error?.issues.map((issue) => issue.path.join('.')).sort()).toEqual(['acceptDataLoss', 'expectedGeneration', 'reason']);
		expect(
			regionPromoteRequestSchema.safeParse({ confirm: 'ukwest', expectedGeneration: 4, acceptDataLoss: true, reason: 'uksouth is down' }).success,
		).toBe(true);
		expect(regionPromoteRequestSchema.safeParse({ unknown: 1 }).success).toBe(false);
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

describe('ha init profile plans', () => {
	test('are pure and deterministic', () => {
		for (const profile of ['single', 'ha', 'ha-dr'] as const) {
			const facts = { platformStoreKind: 'azure', otherRegions: ['ukwest'] };
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

	test('ask at most four questions, each with its default', () => {
		expect(haInitPlan('single').questions).toEqual([]);
		const ha = haInitPlan('ha');
		expect(ha.questions.map((question) => [question.id, question.default])).toEqual([
			['steering', 'external-lb'],
			['arbiter', 's3'],
			['certificates', 'shared'],
		]);
		expect(ha.unanswered).toEqual([]);
		const dr = haInitPlan('ha-dr', {}, { otherRegions: ['ukwest'] });
		expect(dr.questions.length).toBe(4);
		expect(dr.questions[3]).toMatchObject({ id: 'standbyRegion', default: 'ukwest', value: 'ukwest' });
		expect(dr.standbyRegion).toBe('ukwest');
		expect(haInitPlan('ha-dr', {}, { otherRegions: ['a', 'b'] }).unanswered).toEqual(['standbyRegion']);
		expect(haInitPlan('ha-dr', { standbyRegion: 'b' }, { otherRegions: ['a', 'b'] }).unanswered).toEqual([]);
		expect(haInitPlan('ha', {}, { platformStoreKind: 'gcs' }).questions[1]?.value).toBe('gcs');
		expect(haInitAnswersSchema.safeParse({ steering: 'direct' }).success).toBe(false);
	});

	test('set the profile flags and settings; single reverses ha', () => {
		const ha = haInitPlan('ha');
		const on = (plan: ReturnType<typeof haInitPlan>) => plan.flags.filter((flag) => flag.value).map((flag) => flag.name);
		expect(on(ha)).toEqual([
			'ENDPOINTS_GATEWAY',
			'RELEASE_PHASE',
			'INGRESS_SET',
			'SHARED_CERTIFICATES',
			'STEERING',
			'CONTROL_STANDBY',
			'SYNC_REPLICA',
			'PITR_REWIND',
			'DB_AUTO_PROMOTE',
		]);
		expect(ha.cluster).toEqual({
			ha: { profile: 'ha' },
			steering: { driver: 'external-lb', stacked: [] },
			failover: { enabled: true },
			replicas: { spread: 'zone' },
		});
		expect(ha.envLines).toContain('YOAL_FEATURE_INGRESS_SET=1');
		expect(ha.envLines).toContain('YOAL_FEATURE_REGIONS=0');
		expect(on(haInitPlan('ha-dr', {}, { otherRegions: ['ukwest'] }))).toContain('REGIONS');
		expect(haInitPlan('ha-dr', {}, { otherRegions: ['ukwest'] }).cluster.steering).toEqual({ driver: 'external-lb', stacked: ['dns-failover'] });
		expect(on(haInitPlan('ha', { certificates: 'per-node' }))).not.toContain('SHARED_CERTIFICATES');
		expect(on(haInitPlan('ha', { arbiter: 'azure' }))).toContain('OBJECT_STORE_AZURE');

		const single = haInitPlan('single');
		expect(on(single)).toEqual([]);
		expect(single.flags.map((flag) => flag.name)).toEqual([...HA_INIT_FLAGS]);
		for (const flag of haInitPlan('ha-dr', { arbiter: 'gcs' }, { otherRegions: ['x'] }).flags)
			if (flag.value && !flag.name.startsWith('OBJECT_STORE_')) expect(single.flags.find((item) => item.name === flag.name)?.value).toBe(false);
		// Every managed cluster setting goes back to its registry default.
		const defaults = clusterRow();
		expect(single.cluster).toEqual({
			ha: { profile: defaults.ha.profile },
			steering: { driver: defaults.steering.driver, stacked: defaults.steering.stacked },
			failover: { enabled: defaults.failover.enabled },
			replicas: { spread: defaults.replicas.spread },
		});
		for (const plan of [single, ha]) expect(clusterConfigUpdateSchema.safeParse(plan.cluster).success).toBe(true);
		expect(single.preflight).toEqual([]);
		expect(ha.preflight).toEqual(HA_PROFILE_REQUIRED_CHECKS.ha);
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
		for (const id of ['nodes', 'zones', 'regions', 'clocks', 'overlay-links', 'arbiter-conditional-writes', 'certificates', 'steering', 'backups', 'headroom'])
			expect(haCheckIds).toContain(id as (typeof haCheckIds)[number]);
		for (const ids of Object.values(HA_PROFILE_REQUIRED_CHECKS)) for (const id of ids) expect(haCheckIds).toContain(id);
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
		expect(summarizeHaChecks('single', []).ok).toBe(true);
		expect(haCheckSchema.safeParse({ ...pass('nodes'), fix: { kind: 'command', value: 'yoal nodes list' } }).success).toBe(true);
	});
});

describe('drill catalogue', () => {
	test('covers every scenario id once and reconciles with the existing drills', () => {
		expect(HA_DRILL_CATALOGUE.map((entry) => entry.id).sort()).toEqual([...haDrillScenarioIds].sort());
		expect(haDrillScenario('node-offline')).toMatchObject({ recordsIn: 'node_drills', resourceKind: 'node', availability: 'fleet' });
		expect(haDrillScenario('database-failover')).toMatchObject({
			recordsIn: 'database_failover_drills',
			confirmation: 'confirm',
			flags: ['SYNC_REPLICA'],
		});
		expect(haDrillScenario('region-failover')).toMatchObject({ flags: ['REGIONS'], inAll: false, destructive: true });
	});

	test('destructive scenarios need a typed confirmation and every scenario measures something', () => {
		for (const entry of HA_DRILL_CATALOGUE) {
			if (entry.destructive) expect(entry.confirmation).toBe('typed');
			expect(entry.measures.length).toBeGreaterThan(0);
			if (entry.bound.rpo !== null) expect(entry.measures).toContain('rpo');
		}
		expect(haDrillConfirmationIssue(haDrillScenario('zone-offline'), 'uksouth-1', 'uksouth-1')).toBeNull();
		expect(haDrillConfirmationIssue(haDrillScenario('zone-offline'), 'uksouth-1', true)).toContain('type the name');
		expect(haDrillConfirmationIssue(haDrillScenario('database-failover'), 'main', true)).toBeNull();
		expect(haDrillConfirmationIssue(haDrillScenario('database-failover'), 'main', undefined)).toContain('confirm: true');
		expect(haDrillConfirmationIssue(haDrillScenario('node-offline'), 'a', undefined)).toBeNull();
		expect(haDrillRunRequestSchema.safeParse({ scenario: 'node-offline' }).success).toBe(true);
		expect(haDrillRunRequestSchema.safeParse({ scenario: 'nope' }).success).toBe(false);
		expect(haDrillAllRequestSchema.safeParse({ includeDestructive: true }).success).toBe(false);
		expect(haDrillAllRequestSchema.safeParse({ includeDestructive: true, confirm: 'all' }).success).toBe(true);
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
});
