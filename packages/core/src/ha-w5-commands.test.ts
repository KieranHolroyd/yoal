import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	DATABASE_REPLICAS_CAPABILITY,
	DB_MEMBER_CAPABILITY,
	DEFAULT_FEATURES,
	ENDPOINTS_GATEWAY_CAPABILITY,
	HA_EPOCH_CAPABILITY,
	HA_INIT_FLAGS,
	HA_PROFILE_REQUIRED_CHECKS,
	INGRESS_SET_CAPABILITY,
	PITR_REWIND_CAPABILITY,
	RELEASE_PHASE_CAPABILITY,
	haCheckIds,
	type FeatureName,
	type HaCheck,
	type HaCheckId,
	type HaPreflightReport,
} from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { MemoryObjectStore } from './object-store/memory.ts';
import { buildPrincipal } from './orgs.ts';

/**
 * Wave 5 lane B (HA-PLAN H27, W14): `ha init`, the preflight and doctor checks, and the drill
 * runner, on fixture fleets built to pass and to fail each check.
 */
const NOW = Date.parse('2026-11-21T10:00:00Z');
const dirs: string[] = [];
const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const CAPS = [
	INGRESS_SET_CAPABILITY,
	ENDPOINTS_GATEWAY_CAPABILITY,
	RELEASE_PHASE_CAPABILITY,
	HA_EPOCH_CAPABILITY,
	DATABASE_REPLICAS_CAPABILITY,
	DB_MEMBER_CAPABILITY,
	PITR_REWIND_CAPABILITY,
];

interface Fleet {
	core: Core;
	sqlite: ReturnType<typeof createDb>['sqlite'];
	store: MemoryObjectStore | LocalObjectStore;
	ids: Record<string, string>;
	setFlags(names: readonly FeatureName[], value: boolean): void;
}

/** One node with flags off (`single`), or three healthy nodes in three zones (`ha`). */
async function fleet(shape: 'single' | 'ha', options: { localStore?: boolean } = {}): Promise<Fleet> {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-w5-b-'));
	dirs.push(dir);
	const opened = createDb({ path: ':memory:' });
	const store = options.localStore
		? new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123')
		: new MemoryObjectStore({ now: () => NOW });
	const core = createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '0.1.0',
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: store,
			...(options.localStore
				? {}
				: {
						platformStore: {
							kind: 'r2' as const,
							s3: {
								endpoint: 'https://r2.example.com',
								bucket: 'platform',
								region: 'auto',
								accessKeyId: 'PLATFORM_KEY',
								secretAccessKey: 'platform-secret-123',
								pathStyle: true,
							},
						},
					}),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
			now: () => NOW,
			features: { ...DEFAULT_FEATURES },
		},
	});
	const ids: Record<string, string> = {};
	const names = shape === 'single' ? ['a1'] : ['a1', 'a2', 'a3'];
	for (const [index, name] of names.entries()) {
		ids[name] = core.nodes.join({ token: core.nodes.createJoinToken(admin, name).token, name }).nodeId;
		opened.sqlite.run(
			`UPDATE nodes SET status = 'online', zone = ?, roles_json = ?, capabilities_json = ?, agent_version = '0.1.0',
			   last_heartbeat_at = ?, certificate_fingerprint = 'sha256:aaaa', network_mode = 'external' WHERE id = ?`,
			[`uksouth-${index + 1}`, JSON.stringify(['ingress', 'compute', 'data', 'control']), JSON.stringify(CAPS), NOW, ids[name]!],
		);
		core.ctx.haDoctor.recordClock(ids[name]!, NOW, NOW);
	}
	for (const from of names)
		for (const to of names)
			if (from !== to)
				opened.sqlite.run('INSERT INTO node_links (from_node_id, to_node_id, rtt_ms, sampled_at, updated_at) VALUES (?, ?, 1.2, ?, ?)', [
					ids[from]!,
					ids[to]!,
					NOW,
					NOW,
				]);
	const setFlags = (list: readonly FeatureName[], value: boolean) => {
		for (const name of list) (core.ctx.config.features as Record<string, boolean>)[name] = value;
	};
	return { core, sqlite: opened.sqlite, store, ids, setFlags };
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const entries = (report: HaPreflightReport, id: HaCheckId): HaCheck[] => report.checks.filter((check) => check.id === id);
const failing = (report: HaPreflightReport, id: HaCheckId): HaCheck[] => entries(report, id).filter((check) => check.status === 'fail');
const HA_FLAGS = HA_INIT_FLAGS.filter((name) => name !== 'REGIONS');

describe('single node, flags off', () => {
	test('yoal ha preflight says what is missing for ha, and changes nothing', async () => {
		const { core } = await fleet('single', { localStore: true });
		const before = JSON.stringify(core.cluster.get());
		await core.ctx.haDoctor.probeArbiter();
		const report = core.haDoctor.preflight(admin, 'ha');
		expect(report.ok).toBe(false);
		for (const id of haCheckIds) expect(entries(report, id).length).toBeGreaterThan(0);
		expect(failing(report, 'nodes')[0]?.evidence).toEqual(expect.arrayContaining([expect.stringContaining('ingress: 1 online (needs 2)')]));
		expect(failing(report, 'arbiter-conditional-writes')[0]?.fix?.kind).toBe('env');
		expect(failing(report, 'platform-store')[0]?.fix?.kind).toBe('env');
		expect(failing(report, 'steering')[0]?.fix?.value).toBe('YOAL_FEATURE_STEERING=1');
		expect(failing(report, 'certificates')[0]?.fix?.value).toBe('YOAL_FEATURE_SHARED_CERTIFICATES=1');
		// A skipped check never reads as a pass.
		for (const check of report.checks) if (check.status === 'skip') expect(check.fix).toBeNull();
		expect(JSON.stringify(core.cluster.get())).toBe(before);
		// Its own profile still checks out, and the init plan refuses with the env lines first.
		expect(core.haDoctor.preflight(admin, 'single').ok).toBe(true);
		const plan = core.haInit.plan(admin, { profile: 'ha' });
		expect(plan.ready).toBe(false);
		expect(plan.blockers[0]).toContain('YOAL_FEATURE_ENDPOINTS_GATEWAY=1');
		expect(plan.flagsToChange.map((flag) => flag.name)).toEqual([...HA_FLAGS]);
	});

	test('doctor checks the running single install: node health, and no HA-only check', async () => {
		const { core, sqlite, ids } = await fleet('single', { localStore: true });
		sqlite.run('UPDATE nodes SET stats_json = ? WHERE id = ?', [
			JSON.stringify({ cpuPercent: 1, memoryBytes: 1, memoryTotalBytes: 2, diskUsedBytes: 96, diskTotalBytes: 100, diskFreeBytes: 4, uptimeSeconds: 1, certs: [] }),
			ids.a1!,
		]);
		const report = core.haDoctor.doctor(admin);
		expect(report.mode).toBe('doctor');
		expect(report.profile).toBe('single');
		expect(entries(report, 'zones')).toMatchObject([{ status: 'skip', evidence: ['Not required by the single profile.'] }]);
		expect(entries(report, 'nodes')).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'pass', title: 'a1 is healthy' })]));
		expect(entries(report, 'headroom')).toEqual(
			expect.arrayContaining([expect.objectContaining({ status: 'fail', title: 'a1’s data disk is 96% full'.replace('’', "'") })]),
		);
		expect(report.ok).toBe(false);
		sqlite.run("UPDATE nodes SET status = 'offline' WHERE id = ?", [ids.a1!]);
		expect(entries(core.haDoctor.doctor(admin), 'nodes')).toMatchObject([{ status: 'fail', title: "a1's Caddy config is not applied" }]);
	});
});

describe('preflight on a fixture fleet', () => {
	test('a healthy three-zone fleet passes every check the ha profile requires', async () => {
		const { core, setFlags } = await fleet('ha');
		setFlags(HA_FLAGS, true);
		await core.ctx.haDoctor.probeArbiter();
		const report = core.haDoctor.preflight(admin, 'ha');
		const blocking = report.checks.filter((check) => HA_PROFILE_REQUIRED_CHECKS.ha.includes(check.id) && !['pass', 'warn'].includes(check.status));
		expect(blocking).toEqual([]);
		expect(report.ok).toBe(true);
		expect(entries(report, 'arbiter-conditional-writes')[0]?.status).toBe('pass');
	});

	test('a fleet built to fail each check reports that check id with a fail and the exact fix', async () => {
		const cases: Array<{ id: HaCheckId; breakIt: (fleet: Fleet) => unknown; fix: RegExp }> = [
			{ id: 'nodes', breakIt: ({ sqlite, ids }) => sqlite.run("UPDATE nodes SET status = 'offline' WHERE id <> ?", [ids.a1!]), fix: /node\.sh --roles/ },
			{
				id: 'node-capabilities',
				breakIt: ({ sqlite, ids }) => sqlite.run('UPDATE nodes SET capabilities_json = ? WHERE id = ?', [JSON.stringify([INGRESS_SET_CAPABILITY]), ids.a2!]),
				fix: /^yoal nodes update a2$/,
			},
			{ id: 'zones', breakIt: ({ sqlite }) => sqlite.run("UPDATE nodes SET zone = 'uksouth-1'"), fix: /Edit node → Zone/ },
			{ id: 'clocks', breakIt: ({ core, ids }) => core.ctx.haDoctor.recordClock(ids.a2!, NOW + 9_000, NOW), fix: /set-ntp/ },
			{
				id: 'overlay-links',
				breakIt: ({ sqlite, ids }) => sqlite.run('UPDATE node_links SET down_since = ? WHERE from_node_id = ? AND to_node_id = ?', [NOW - 60_000, ids.a1!, ids.a2!]),
				fix: /yoal fleet links/,
			},
			{
				id: 'arbiter-conditional-writes',
				breakIt: async ({ core, store }) => {
					// A store that accepts If-None-Match and ignores it: the probe catches what a 501 check would not.
					(store as MemoryObjectStore).writeConditional = async () => ({ status: 200, etag: '"same"', serverDate: null });
					await core.ctx.haDoctor.probeArbiter({ force: true });
				},
				fix: /YOAL_OBJECT_STORE=/,
			},
			{ id: 'certificates', breakIt: ({ sqlite, ids }) => sqlite.run("UPDATE nodes SET certificate_fingerprint = 'sha256:bbbb' WHERE id = ?", [ids.a3!]), fix: /restart the agent/ },
			{ id: 'steering', breakIt: ({ sqlite, ids }) => sqlite.run('UPDATE nodes SET last_heartbeat_at = NULL WHERE id = ?', [ids.a2!]), fix: /never sent a heartbeat/ },
			{ id: 'backups', breakIt: ({ core, ids }) => void core.databases.create(admin, { name: 'main', placement: ids.a1! }), fix: /yoal db backup main/ },
			{
				id: 'headroom',
				breakIt: ({ core, sqlite, ids }) => {
					core.databases.create(admin, { name: 'big', placement: ids.a1!, memoryMb: 512 } as never);
					sqlite.run('UPDATE nodes SET slice_memory_mb = 64 WHERE id <> ?', [ids.a1!]);
				},
				fix: /MiB of capacity/,
			},
			{
				id: 'flags-consistent',
				breakIt: ({ sqlite, ids }) =>
					sqlite.run("INSERT INTO control_state (node_id, role, epoch, updated_at, feature_flags_json) VALUES (?, 'standby', 1, 1, ?)", [
						ids.a2!,
						JSON.stringify({ ...DEFAULT_FEATURES, STEERING: false }),
					]),
				fix: /YOAL_FEATURE_STEERING/,
			},
			{ id: 'ha-dependents', breakIt: ({ core }) => void core.cluster.update(admin, { steering: { driver: 'external-lb' } }), fix: /steering\.driver = direct/ },
		];
		for (const item of cases) {
			const built = await fleet('ha');
			built.setFlags(HA_FLAGS, true);
			await built.core.ctx.haDoctor.probeArbiter();
			await item.breakIt(built);
			const report = built.core.haDoctor.preflight(admin, item.id === 'ha-dependents' ? 'single' : 'ha');
			const failed = failing(report, item.id);
			expect({ id: item.id, failed: failed.length > 0 }).toEqual({ id: item.id, failed: true });
			expect({ id: item.id, fix: failed.some((check) => item.fix.test(check.fix?.value ?? '')) }).toEqual({ id: item.id, fix: true });
			expect(report.ok).toBe(false);
		}
		// The W12 checks fail on their own fixture: a local platform store.
		const local = await fleet('ha', { localStore: true });
		expect(failing(local.core.haDoctor.preflight(admin, 'ha'), 'platform-store')[0]?.fix?.kind).toBe('env');
		local.sqlite.run("INSERT INTO settings (key, value, updated_at) VALUES ('registry.config', ?, 1)", [JSON.stringify({ enabled: true, nodeId: local.ids.a1 })]);
		expect(failing(local.core.haDoctor.preflight(admin, 'ha'), 'registry-storage').length).toBe(1);
	});

	test('a node with no clock reading is a skip with the reason, never a pass', async () => {
		const { core, ids, setFlags } = await fleet('ha');
		setFlags(HA_FLAGS, true);
		core.ctx.haDoctor.recordClock(ids.a3!, NOW - 3_600_000, NOW - 3_600_000);
		const report = core.haDoctor.preflight(admin, 'ha');
		expect(entries(report, 'clocks')).toMatchObject([{ status: 'skip', title: 'No clock reading from a3' }]);
		expect(report.ok).toBe(false);
	});
});

describe('ha init', () => {
	test('plan is refused while the running flags differ, then ha applies in one update and single restores the exact previous settings', async () => {
		const { core, setFlags } = await fleet('ha');
		core.cluster.update(admin, { failover: { enabled: false }, replicas: { spread: 'node' } });
		const before = core.cluster.get();
		await expect(core.haInit.apply(admin, { profile: 'ha', apply: true })).rejects.toMatchObject({
			status: 409,
			message: expect.stringContaining('YOAL_FEATURE_STEERING=1'),
		});
		expect(core.cluster.get()).toEqual(before);

		setFlags(HA_FLAGS, true);
		const plan = core.haInit.plan(admin, { profile: 'ha', answers: { steering: 'external-lb' } });
		expect(plan.blockers).toEqual([]);
		expect(plan.ready).toBe(true);
		expect(plan.settingsToChange.map((setting) => setting.path)).toEqual(['ha.profile', 'steering.driver', 'failover.enabled', 'replicas.spread']);

		const applied = await core.haInit.apply(admin, { profile: 'ha', apply: true, answers: { steering: 'external-lb' } });
		expect(applied.profile).toBe('ha');
		expect(applied.auditId).toMatch(/^aud_/);
		const after = core.cluster.get();
		expect(after.ha.profile).toBe('ha');
		expect(after.steering.driver).toBe('external-lb');
		expect(after.failover.enabled).toBe(true);
		expect(after.replicas.spread).toBe('zone');
		expect(after.ha.applied?.settings).toEqual([
			{ path: 'steering.driver', previous: 'direct' },
			{ path: 'failover.enabled', previous: false },
			{ path: 'replicas.spread', previous: 'node' },
		]);
		// Applying again changes nothing and keeps the original record.
		expect((await core.haInit.apply(admin, { profile: 'ha', apply: true, answers: { steering: 'external-lb' } })).applied).toEqual([]);

		// The way back: flags first (the plan prints =0 for the profile's set), then one update.
		const back = core.haInit.plan(admin, { profile: 'single' });
		expect(back.plan.flags.every((flag) => !flag.value)).toBe(true);
		expect(back.blockers[0]).toContain('YOAL_FEATURE_ENDPOINTS_GATEWAY=0');
		setFlags(HA_FLAGS, false);
		await core.haInit.apply(admin, { profile: 'single', apply: true });
		expect(core.cluster.get()).toEqual(before);
	});

	test('ha-dr applies and single restores the exact previous settings (regions check stubbed: lane A)', async () => {
		const { core, sqlite, ids, setFlags } = await fleet('ha');
		sqlite.run("UPDATE nodes SET region = 'ukwest', zone = 'ukwest-1' WHERE id = ?", [ids.a3!]);
		const before = core.cluster.get();
		setFlags(HA_INIT_FLAGS, true);
		await core.ctx.haDoctor.probeArbiter();
		const preflight = core.ctx.haDoctor.preflight.bind(core.ctx.haDoctor);
		core.ctx.haDoctor.preflight = (principal, profile, options) => {
			const report = preflight(principal, profile, options);
			const checks = report.checks.map((check) => (check.id === 'regions' ? { ...check, status: 'pass' as const } : check));
			return { ...report, checks };
		};
		const plan = core.haInit.plan(admin, { profile: 'ha-dr' });
		expect(plan.plan.standbyRegion).toBe('ukwest');
		expect(plan.blockers).toEqual([]);
		await core.haInit.apply(admin, { profile: 'ha-dr', apply: true });
		expect(core.cluster.get().steering).toMatchObject({ driver: 'external-lb', stacked: ['dns-failover'] });
		expect(core.cluster.get().ha.applied?.flags).toContain('REGIONS');
		setFlags(HA_INIT_FLAGS, false);
		// A node still in a named region strands nothing only once it is back in `default`; and the
		// stacked dns-failover wrote DNS records, so steering is withdrawn by hand first.
		expect(core.haInit.plan(admin, { profile: 'single' }).blockers).toEqual([
			expect.stringContaining('"region": "default"'),
			expect.stringContaining('withdraw what external-lb and dns-failover put at the provider'),
		]);
		sqlite.run("UPDATE nodes SET region = 'default' WHERE id = ?", [ids.a3!]);
		core.cluster.update(admin, { steering: { driver: 'direct', stacked: [] } });
		await core.haInit.apply(admin, { profile: 'single', apply: true });
		expect(core.cluster.get()).toEqual(before);
	});

	test('apply needs a platform admin session; an API key gets 403 and an operator may only plan', async () => {
		const { core } = await fleet('ha');
		const key = buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true, credential: 'apiKey' } as never);
		await expect(core.haInit.apply(key, { profile: 'ha', apply: true })).rejects.toMatchObject({ status: 403 });
		const member = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer', platformAdmin: false });
		expect(() => core.haInit.plan(member, { profile: 'ha' })).toThrow(expect.objectContaining({ status: 403 }));
	});
});

describe('drills', () => {
	test('lab-only scenarios are refused on a fleet with the reason; destructive ones need the name typed back', async () => {
		const { core } = await fleet('ha');
		await expect(core.haDrills.run(admin, { scenario: 'zone-offline', resource: 'uksouth-1' })).rejects.toMatchObject({
			status: 409,
			message: expect.stringContaining('lab only'),
		});
		await expect(core.haDrills.run(admin, { scenario: 'node-offline', resource: 'a2' })).rejects.toMatchObject({
			status: 422,
			message: expect.stringContaining('type the name "a2"'),
		});
		await expect(core.haDrills.run(admin, { scenario: 'node-offline', resource: 'a2', confirm: 'a3' })).rejects.toMatchObject({ status: 422 });
		await expect(core.haDrills.run(admin, { scenario: 'ingress-offline', resource: 'a2', confirm: 'a2' })).rejects.toMatchObject({
			message: expect.stringContaining('YOAL_FEATURE_INGRESS_SET=1'),
		});
	});

	test('a drill on a resource below its HA level is refused, and nothing runs', async () => {
		const { core, ids, setFlags } = await fleet('ha');
		core.databases.create(admin, { name: 'main', placement: ids.a1! });
		await expect(core.haDrills.run(admin, { scenario: 'stale-generation-promote', resource: 'main' })).rejects.toMatchObject({
			status: 409,
			message: expect.stringContaining('needs a resource at L2 or higher'),
		});
		setFlags(['RELEASE_PHASE'], true);
		const project = await core.projects.create(admin, {
			name: 'Shop',
			slug: 'shop',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		core.slos.setHaTarget(admin, project.slug, { target: 'L1' });
		await expect(core.haDrills.run(admin, { scenario: 'release-command-fail', resource: 'shop', confirm: 'shop' })).rejects.toMatchObject({
			status: 409,
			message: expect.stringContaining('declared at L3 or higher; this one is declared L1'),
		});
		expect(core.haDrills.list(admin)).toEqual([]);
	});

	test('node-offline hands the named node to the D235 drill and records it; the view reads its measurements', async () => {
		const { core, sqlite, ids } = await fleet('ha');
		sqlite.run('UPDATE nodes SET capabilities_json = ? ', [JSON.stringify([...CAPS, 'offline-drill'])]);
		sqlite.run('UPDATE nodes SET roles_json = ? WHERE id = ?', [JSON.stringify(['ingress', 'compute', 'data']), ids.a2!]);
		const run = await core.haDrills.run(admin, { scenario: 'node-offline', resource: 'a2', confirm: 'a2', durationSeconds: 120 });
		expect(run).toMatchObject({ scenario: 'node-offline', status: 'running', resource: { kind: 'node', id: ids.a2, name: 'a2' } });
		const drill = core.nodeDrills.view(admin).running;
		expect(drill?.nodeId).toBe(ids.a2);
		expect(run.recordId).toBe(drill!.id);
		expect(run.id).not.toBe(drill!.id);
		expect(core.haDrills.list(admin).map((item) => item.id)).toEqual([run.id]);
	});

	test('--all runs only fleet, non-destructive scenarios against named resources; confirm adds the confirm-level ones only', async () => {
		const { core, ids, setFlags } = await fleet('ha');
		sqlite_offline_capable(core);
		core.databases.create(admin, { name: 'main', placement: ids.a1! });
		setFlags(['SYNC_REPLICA'], true);
		const targets = [
			{ kind: 'node' as const, resource: 'a2' },
			{ kind: 'database' as const, resource: 'main', drillDatabase: 'main-copy' },
		];
		const plain = await core.haDrills.runAll(admin, { targets });
		const reasons = Object.fromEntries(plain.skipped.map((item) => [item.scenario, item.reason]));
		expect(reasons['node-offline']).toContain('typed confirmation');
		expect(reasons['zone-offline']).toContain('lab only');
		expect(reasons['database-failover']).toBe('Needs confirm: true.');
		// stale-generation-promote ran into the level refusal, which is a skip with its reason.
		expect(reasons['stale-generation-promote']).toContain('L2');
		expect(plain.runs).toEqual([]);
		expect(plain.passed).toBe(false);
		expect(core.nodeDrills.view(admin).running).toBeNull();

		const confirmed = await core.haDrills.runAll(admin, { targets, confirm: true });
		const after = Object.fromEntries(confirmed.skipped.map((item) => [item.scenario, item.reason]));
		expect(after['node-offline']).toContain('typed confirmation');
		// The W11 drill was tried, and its own refusal (no arbiter-backed copy here) is reported.
		expect(after['database-failover']).toContain('main:');
		expect(core.nodeDrills.view(admin).running).toBeNull();
	});
});

/** The D235 drill needs agents that can go dark. */
function sqlite_offline_capable(core: Core): void {
	core.ctx.sqlite.run('UPDATE nodes SET capabilities_json = ?', [JSON.stringify([...CAPS, 'offline-drill'])]);
}

describe('join with --zone and --roles (node.sh, HA-PLAN §8 step 2)', () => {
	test('the zone and roles land on the node; a zone other nodes use keeps their region; bad values are refused', async () => {
		const { core, sqlite, ids } = await fleet('ha');
		sqlite.run("UPDATE nodes SET region = 'ukwest' WHERE id = ?", [ids.a3!]);
		const joined = core.nodes.join({
			token: core.nodes.createJoinToken(admin, 'b1', { roles: ['ingress', 'compute'] }).token,
			name: 'b1',
			zone: 'uksouth-3',
			roles: ['ingress', 'compute'],
		});
		const row = sqlite.query<{ zone: string; region: string; roles_json: string }, [string]>('SELECT zone, region, roles_json FROM nodes WHERE id = ?').get(joined.nodeId);
		expect(row).toEqual({ zone: 'uksouth-3', region: 'ukwest', roles_json: '["ingress","compute"]' });
		const plain = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'b2').token, name: 'b2' });
		expect(sqlite.query<{ zone: string; roles_json: string | null }, [string]>('SELECT zone, roles_json FROM nodes WHERE id = ?').get(plain.nodeId)).toEqual({
			zone: 'default',
			roles_json: null,
		});
		expect(() => core.nodes.join({ token: core.nodes.createJoinToken(admin, 'b3').token, name: 'b3', zone: 'has space' })).toThrow(/Invalid zone/);
		expect(() => core.nodes.join({ token: core.nodes.createJoinToken(admin, 'b4').token, name: 'b4', roles: ['router' as never] })).toThrow(/Invalid roles/);
	});

	test('a join token carries the roles it allows: a join may take a subset, never more, and a token without roles allows none', async () => {
		const { core, sqlite } = await fleet('ha');
		const rolesOf = (id: string) => sqlite.query<{ roles_json: string | null }, [string]>('SELECT roles_json FROM nodes WHERE id = ?').get(id)?.roles_json;
		// A token made without roles: asking for ingress (which would hand over the wildcard key) is refused.
		const bare = core.nodes.createJoinToken(admin, 'c1');
		expect(() => core.nodes.join({ token: bare.token, name: 'c1', roles: ['ingress'] })).toThrow(/allows no roles.*ingress/);
		// The refusal does not spend the token: it still joins with today's defaults.
		expect(rolesOf(core.nodes.join({ token: bare.token, name: 'c1' }).nodeId)).toBeNull();
		// A token for compute and data cannot be used to become an ingress.
		const worker = core.nodes.createJoinToken(admin, 'c2', { roles: ['compute', 'data'] });
		expect(() => core.nodes.join({ token: worker.token, name: 'c2', roles: ['compute', 'ingress'] })).toThrow(/does not allow ingress/);
		expect(rolesOf(core.nodes.join({ token: worker.token, name: 'c2', roles: ['data'] }).nodeId)).toBe('["data"]');
		expect(() => core.nodes.createJoinToken(admin, 'c3', { roles: ['router' as never] })).toThrow(/Invalid roles/);
		expect(sqlite.query<{ roles_json: string | null }, []>("SELECT roles_json FROM node_join_tokens WHERE node_name = 'c2'").get()?.roles_json).toBe('["compute","data"]');
	});
});

describe('drill review fixes', () => {
	const operatorOf = (core: Core) => {
		core.ctx.platformIam.bind(admin, { userId: 'user_op', roleId: 'platform-operator' });
		return buildPrincipal({ kind: 'user', userId: 'user_op', orgId: 'org_1', role: 'viewer', platformAdmin: false });
	};

	test('the control plane’s host is refused without the explicit opt-in, and the refusal names it', async () => {
		const { core, sqlite } = await fleet('ha');
		sqlite.run('UPDATE nodes SET capabilities_json = ?', [JSON.stringify([...CAPS, 'offline-drill'])]);
		await expect(core.haDrills.run(admin, { scenario: 'node-offline', resource: 'a2', confirm: 'a2' })).rejects.toMatchObject({
			status: 409,
			message: expect.stringMatching(/a2 hosts the control plane.*includeControlNode/),
		});
		expect(core.nodeDrills.view(admin).running).toBeNull();
		const run = await core.haDrills.run(admin, { scenario: 'node-offline', resource: 'a2', confirm: 'a2', includeControlNode: true });
		expect(run.status).toBe('running');
	});

	test('destructive drills need a platform admin; an operator may still run the non-destructive ones', async () => {
		const { core, sqlite, ids } = await fleet('ha');
		const operator = operatorOf(core);
		sqlite.run('UPDATE nodes SET capabilities_json = ?, roles_json = ?', [JSON.stringify([...CAPS, 'offline-drill']), JSON.stringify(['compute', 'data'])]);
		await expect(core.haDrills.run(operator, { scenario: 'node-offline', resource: 'a2', confirm: 'a2' })).rejects.toMatchObject({
			status: 403,
			message: expect.stringContaining('platform admin'),
		});
		core.databases.create(admin, { name: 'main', placement: ids.a1! });
		// Past the permission check: refused on the HA level instead.
		await expect(core.haDrills.run(operator, { scenario: 'stale-generation-promote', resource: 'main' })).rejects.toMatchObject({ status: 409 });
		expect(core.haDrills.catalogue(operator).scenarios.length).toBeGreaterThan(0);
	});

	test('the D235 drill path needs a platform admin and the typed node name (or "random") server-side', async () => {
		const { core, sqlite, ids } = await fleet('ha');
		sqlite.run('UPDATE nodes SET capabilities_json = ?, roles_json = ?', [JSON.stringify([...CAPS, 'offline-drill']), JSON.stringify(['compute', 'data'])]);
		const operator = operatorOf(core);
		expect(() => core.haDrills.startNodeDrill(operator, { node: 'a2', confirm: 'a2' })).toThrow(expect.objectContaining({ status: 403 }));
		expect(() => core.haDrills.startNodeDrill(admin, { node: 'a2' })).toThrow(expect.objectContaining({ status: 422, message: expect.stringContaining('type the name "a2"') }));
		expect(() => core.haDrills.startNodeDrill(admin, { node: ids.a2!, confirm: 'a3' })).toThrow(expect.objectContaining({ status: 422 }));
		expect(() => core.haDrills.startNodeDrill(admin, {})).toThrow(expect.objectContaining({ status: 422, message: expect.stringContaining('"random"') }));
		expect(core.haDrills.startNodeDrill(admin, { node: ids.a2!, confirm: 'a2', durationSeconds: 120 }).nodeName).toBe('a2');
	});

	test('a database drill uses the operator’s own database, never a same-named one in another org, with generation -1', async () => {
		const { core, ids } = await fleet('ha');
		const other = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner', platformAdmin: false });
		const mine = core.databases.create(admin, { name: 'main', placement: ids.a1! });
		const theirs = core.databases.create(other, { name: 'main', placement: ids.a2! });
		for (const db of [mine, theirs])
			core.ctx.sqlite.run(
				`INSERT INTO database_replicas (id, database_id, node_id, status, slot, primary_generation, replay_lsn, reported_at, created_at, updated_at)
				 VALUES (?, ?, ?, 'streaming', ?, 0, '0/100', ?, 1, 1)`,
				[`dbr_${db.id}`, db.id, ids.a3!, `slot_${db.id}`, NOW],
			);
		// Both are L2, so only the resolution decides which one is drilled.
		const levels = core.ctx.topology.resourceLevels.bind(core.ctx.topology);
		core.ctx.topology.resourceLevels = () => {
			const real = levels();
			for (const db of [mine, theirs]) real.databases.set(db.id, { level: 'L2', blockers: [] } as never);
			return real;
		};
		const calls: Array<{ name: string; ifMatch: unknown; org: string }> = [];
		core.ctx.databaseReplicas.promote = (async (principal: { orgId: string }, name: string, _replica: string, _input: unknown, options: { ifMatch?: unknown }) => {
			calls.push({ name, ifMatch: options.ifMatch, org: principal.orgId });
			throw Object.assign(new Error('stale'), { code: 'precondition_failed', status: 412 });
		}) as never;
		// The other org's database, by id, is not the operator's to drill.
		await expect(core.haDrills.run(admin, { scenario: 'stale-generation-promote', resource: theirs.id })).rejects.toMatchObject({ status: 404 });
		const run = await core.haDrills.run(admin, { scenario: 'stale-generation-promote', resource: 'main' });
		expect(run.resource.id).toBe(mine.id);
		expect(calls).toEqual([{ name: 'main', ifMatch: -1, org: 'org_1' }]);
	});
});

describe('single: ordering and provider state (review 6)', () => {
	async function applied(driver: 'external-lb' | 'dns-failover') {
		const built = await fleet('ha');
		built.setFlags(HA_FLAGS, true);
		await built.core.ctx.haDoctor.probeArbiter();
		if (driver === 'dns-failover') {
			// dns-failover's own preflight needs a provider; this test is about the way back only.
			built.core.ctx.cluster.update(admin, {
				ha: { profile: 'ha', applied: { profile: 'ha', flags: [...HA_FLAGS], settings: [{ path: 'steering.driver', previous: 'direct' }] } },
				steering: { driver: 'dns-failover' },
			});
		} else await built.core.haInit.apply(admin, { profile: 'ha', apply: true, answers: { steering: driver } });
		return built;
	}

	test('the =0 lines appear only once nothing depends on an HA feature', async () => {
		const { core, ids } = await applied('external-lb');
		const db = core.databases.create(admin, { name: 'main', placement: ids.a1! });
		core.ctx.sqlite.run("UPDATE databases SET durability = 'sync' WHERE id = ?", [db.id]);
		const blocked = core.haInit.plan(admin, { profile: 'single' });
		expect(blocked.blockers.join(' ')).toContain('yoal db durability main --async');
		expect(blocked.blockers.join(' ')).not.toContain('=0');
		expect(blocked.flagsToChange).toEqual([]);
		expect(blocked.plan.envLines.some((line) => line.endsWith('=0'))).toBe(false);
		expect(blocked.plan.notes.join(' ')).toContain('once nothing depends on an HA feature');
		core.ctx.sqlite.run("UPDATE databases SET durability = 'async' WHERE id = ?", [db.id]);
		const ready = core.haInit.plan(admin, { profile: 'single' });
		expect(ready.blockers[0]).toContain('YOAL_FEATURE_ENDPOINTS_GATEWAY=0');
		expect(ready.plan.notes.join(' ')).toContain('provider');
	});

	test('a driver that writes provider state stays a blocker, with the way to withdraw it', async () => {
		const { core, setFlags } = await applied('dns-failover');
		setFlags(HA_FLAGS, false);
		const plan = core.haInit.plan(admin, { profile: 'single' });
		expect(plan.ready).toBe(false);
		expect(plan.blockers.join(' ')).toMatch(/steering to direct, then withdraw.*DNS records/);
		const check = core.haDoctor.preflight(admin, 'single').checks.find((item) => item.id === 'ha-dependents' && item.subject?.kind === 'platform');
		expect(check?.fix?.value).toMatch(/withdraw what dns-failover put at the provider/);
	});
});
