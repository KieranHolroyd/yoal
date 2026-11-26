import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, LOG_SETTINGS_DEFAULTS, type FeatureFlags } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { resolveLogSettings } from './log-settings.ts';
import { searchPruneStatements } from './log-retention.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-log-settings-'));
const opened = createDb({ path: ':memory:' });
let clock = 1_764_000_000_000;
const features: { -readonly [K in keyof FeatureFlags]: FeatureFlags[K] } = { ...DEFAULT_FEATURES };
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
		features,
		now: () => clock,
	},
});

const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const owner2 = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_2', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_1', role: 'viewer' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function project(principal: typeof admin, slug: string) {
	await core.projects.create(principal, { name: slug, slug, runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
	return core.projects.requireRow(principal, slug);
}

describe('resolveLogSettings (docs/LOGS.md §10.1–§10.3)', () => {
	test('defaults: search 14 d, archive off, 10% edge sample, hot tail 3 d with the index and 7 without', () => {
		const withIndex = resolveLogSettings({ platform: {}, org: null, project: null, searchIndex: true, hotDaysFallback: 7 });
		expect(withIndex.hotDays).toBe(3);
		expect(withIndex.searchDays).toBe(14);
		expect(withIndex.archiveEnabled).toBe(false);
		expect(withIndex.edgeSampleRate).toBe(0.1);
		expect(withIndex.sources.hotDays).toBe('default');
		expect(resolveLogSettings({ platform: {}, org: null, project: null, searchIndex: false, hotDaysFallback: 7 }).hotDays).toBe(7);
	});

	test('platform → org → project inheritance, with each key only at its levels', () => {
		const result = resolveLogSettings({
			platform: { searchDays: 30, edgeSampleRate: 0.2 },
			org: { searchDays: 20, hotDays: 5 },
			// hotDays is per org only: ignored on a project row.
			project: { edgeSampleRate: 1, hotDays: 1 } as never,
			searchIndex: true,
			hotDaysFallback: 7,
		});
		expect(result.searchDays).toBe(20);
		expect(result.sources.searchDays).toBe('org');
		expect(result.hotDays).toBe(5);
		expect(result.edgeSampleRate).toBe(1);
		expect(result.sources.edgeSampleRate).toBe('project');
	});

	test('an org or project can only lower an ingest quota, and a project keeps no more search days than its org', () => {
		const result = resolveLogSettings({
			platform: { ingestLinesPerSecond: 100 },
			org: { ingestLinesPerSecond: 1_000, ingestMbPerDay: 10, searchDays: 7 },
			project: { ingestMbPerDay: 50, searchDays: 30 },
			searchIndex: true,
			hotDaysFallback: 7,
		});
		expect(result.ingestLinesPerSecond).toBe(100);
		expect(result.sources.ingestLinesPerSecond).toBe('platform');
		expect(result.ingestMbPerDay).toBe(10);
		expect(result.searchDays).toBe(7);
		expect(result.ingestBurst).toBe(LOG_SETTINGS_DEFAULTS.ingestBurst);
	});
});

describe('LogSettingsService', () => {
	test('the platform row needs a platform admin; an org row needs logs:configure', async () => {
		expect(() => core.logSettings.update(owner2, { level: 'platform' }, { searchDays: 30 })).toThrow(/platform admin/);
		expect(() => core.logSettings.update(viewer, { level: 'org' }, { searchDays: 3 })).toThrow();
		core.logSettings.update(admin, { level: 'platform' }, { searchDays: 30 });
		core.logSettings.update(admin, { level: 'org' }, { searchDays: 10 });
		expect(core.logSettings.effective('org_1').searchDays).toBe(10);
		expect(core.logSettings.effective('org_2').searchDays).toBe(30);
		// null clears a key so it inherits again.
		core.logSettings.update(admin, { level: 'org' }, { searchDays: null });
		expect(core.logSettings.effective('org_1').searchDays).toBe(30);
		core.logSettings.update(admin, { level: 'platform' }, { searchDays: null });
	});

	test('a key set at a level that does not have it is a 422, and a project of another org is a 404', async () => {
		const row = await project(admin, 'settings-api');
		expect(() => core.logSettings.update(admin, { level: 'project', project: row }, { hotDays: 2 })).toThrow(/cannot be set/);
		expect(() => core.logSettings.update(owner2, { level: 'project', project: row }, { searchDays: 2 })).toThrow(/not found/);
		const view = core.logSettings.view(admin, { level: 'project', project: row });
		expect(view.canEdit).toBe(true);
		expect(view.effective.hotDays).toBe(7);
	});

	test('the edge sample rate reaches the project routes in desired state only when it differs from 10%', async () => {
		const row = await project(admin, 'edge-sampled');
		await core.deployments.deployEntries(admin, row, [{ path: 'index.html', data: new TextEncoder().encode('<h1>hi</h1>') }], { promote: true });
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'edge').token, name: 'edge' });
		const routesFor = async () => (await core.nodes.desiredState(joined.token)).routes.filter((route) => route.projectId === row.id);
		expect((await routesFor()).length).toBeGreaterThan(0);
		expect((await routesFor()).every((route) => route.accessLogSampleRate === undefined)).toBe(true);
		const version = core.projects.stateVersion();
		core.logSettings.update(admin, { level: 'project', project: row }, { edgeSampleRate: 1 });
		expect(core.projects.stateVersion()).toBeGreaterThan(version);
		expect(core.logSettings.edgeSampleRateFor(row.orgId, row.id)).toBe(1);
		expect((await routesFor()).every((route) => route.accessLogSampleRate === 1)).toBe(true);
	});

	test('search-index retention: one DELETE on the platform window, one per org and per shorter project', async () => {
		const row = await project(admin, 'short-search');
		core.logSettings.update(admin, { level: 'org' }, { searchDays: 10 });
		core.logSettings.update(admin, { level: 'project', project: row }, { searchDays: 2 });
		const statements = searchPruneStatements(core.logSettings, clock);
		expect(statements[0]!.sql).toContain('org_id NOT IN');
		expect(statements[0]!.params.orgs).toEqual(['org_1']);
		expect(statements.some((s) => s.params.org === 'org_1' && !('project' in s.params))).toBe(true);
		const projectDelete = statements.find((s) => s.params.project === row.id);
		expect(projectDelete?.sql).toContain('project_id = {project:String}');
		expect(projectDelete?.params.cutoff).toBe(new Date(clock - 2 * 86_400_000).toISOString().slice(0, 23).replace('T', ' '));
		core.logSettings.update(admin, { level: 'org' }, { searchDays: null });
		core.logSettings.update(admin, { level: 'project', project: row }, { searchDays: null });
	});

	test('hot-tail prune uses each org’s hot days', () => {
		const insert = (org: string, project: string, ts: number) =>
			opened.sqlite.run(
				`INSERT INTO log_events (org_id, project_id, deployment_id, node_id, source, stream, level, message, ts) VALUES (?, ?, NULL, NULL, 'runtime', 'stdout', 'info', 'x', ?)`,
				[org, project, ts],
			);
		clock += 30 * 86_400_000;
		insert('org_1', 'prj_a', clock - 2 * 86_400_000);
		insert('org_2', 'prj_b', clock - 2 * 86_400_000);
		core.logSettings.update(admin, { level: 'org' }, { hotDays: 1 });
		core.logs.prune(clock);
		const left = opened.sqlite.query<{ org_id: string }, []>("SELECT org_id FROM log_events WHERE project_id IN ('prj_a', 'prj_b')").all();
		expect(left.map((r) => r.org_id)).toEqual(['org_2']);
		core.logSettings.update(admin, { level: 'org' }, { hotDays: null });
	});
});
