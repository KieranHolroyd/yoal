import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, HA_DRILL_CATALOGUE, haCheckIds } from '@yoal/contracts';
import { parseBlueprint } from './blueprints.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

/**
 * Wave 5 foundation (docs/build-plan/HA-WAVE-5.md): every region field is refused with REGIONS
 * off on every write path, old rows read unchanged, and every lane-owned service fails loudly
 * instead of pretending.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-w5-foundation-'));
const opened = createDb({ path: ':memory:' });
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
		now: () => Date.parse('2026-11-21T10:00:00Z'),
		features: { ...DEFAULT_FEATURES },
	},
});
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

const join1 = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'a1').token, name: 'a1' });
const join2 = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'a2').token, name: 'a2' });
opened.sqlite.run("UPDATE nodes SET status = 'online', zone = 'uksouth-1'");
core.databases.create(principal, { name: 'main', placement: join1.nodeId });
const app = await core.projects.create(principal, {
	name: 'App',
	slug: 'app-w5',
	runtime: 'process',
	placement: 'auto',
	productionAccess: 'public',
	previewAccess: 'platform',
});

function setFeature(name: keyof typeof DEFAULT_FEATURES, value: boolean): void {
	(core.ctx.config.features as Record<string, boolean>)[name] = value;
}

beforeEach(() => {
	setFeature('REGIONS', false);
	setFeature('RELEASE_PHASE', false);
	opened.sqlite.run("UPDATE nodes SET region = 'default', zone = 'uksouth-1'");
	opened.sqlite.run('UPDATE databases SET standby_region = NULL');
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const refusedWithFlag = { code: 'validation', message: expect.stringContaining('YOAL_FEATURE_REGIONS') };

describe('old data reads unchanged', () => {
	test('existing nodes are in the default region and databases have no standby region', () => {
		const rows = opened.sqlite.query<{ region: string }, []>('SELECT region FROM nodes').all();
		expect(rows).toEqual([{ region: 'default' }, { region: 'default' }]);
		expect(core.databases.get(principal, 'main').standbyRegion).toBeNull();
		expect(core.cluster.get().replicas.spread).toBe('node');
	});
});

describe('REGIONS off: every region write is refused', () => {
	test('node region (REST, dashboard)', () => {
		expect(() => core.nodes.update(principal, join1.nodeId, { region: 'ukwest' })).toThrow(expect.objectContaining(refusedWithFlag));
		// Naming the implicit region, or the stored one, is not a change.
		expect(core.nodes.update(principal, join1.nodeId, { region: 'default', zone: 'uksouth-1' }).zone).toBe('uksouth-1');
	});

	test('database standby region (REST, MCP, blueprints and config import create through the service)', () => {
		expect(() => core.databases.create(principal, { name: 'other', standbyRegion: 'ukwest' })).toThrow(expect.objectContaining(refusedWithFlag));
		expect(() => core.databases.update(principal, 'main', { standbyRegion: 'ukwest' })).toThrow(expect.objectContaining(refusedWithFlag));
		// Clearing is the way back and always allowed.
		expect(core.databases.update(principal, 'main', { standbyRegion: null }).standbyRegion).toBeNull();
	});

	test('cluster replicas.spread', () => {
		expect(() => core.cluster.update(principal, { replicas: { spread: 'region' } })).toThrow(expect.objectContaining(refusedWithFlag));
		expect(core.cluster.update(principal, { replicas: { spread: 'zone' } }).replicas.spread).toBe('zone');
		core.cluster.update(principal, { replicas: { spread: 'node' } });
	});

	test('project placementSpec.spread (create and update)', async () => {
		await expect(
			core.projects.create(principal, {
				name: 'Spread',
				slug: 'spread-w5',
				runtime: 'process',
				placement: 'auto',
				placementSpec: { spread: 'region' },
				productionAccess: 'public',
				previewAccess: 'platform',
			}),
		).rejects.toMatchObject(refusedWithFlag);
		await expect(core.projects.update(principal, app.slug, { placementSpec: { spread: 'region' } })).rejects.toMatchObject(refusedWithFlag);
		expect((await core.projects.update(principal, app.slug, { placementSpec: { spread: 'zone' } })).placementSpec).toEqual({ spread: 'zone' });
		await core.projects.update(principal, app.slug, { placementSpec: null });
	});

	test('workload placement.spread, even with the release phase on', () => {
		setFeature('RELEASE_PHASE', true);
		const project = core.projects.requireRow(principal, app.slug);
		expect(() => core.workloads.setSpec(principal, project, { runtime: 'process', placement: { spread: 'region' } })).toThrow(expect.objectContaining(refusedWithFlag));
	});

	test('blueprint HA keys validate but plan refuses them loudly until lane C', async () => {
		const document = {
			apiVersion: 'yoal/v1',
			name: 'w5-stack',
			databases: { main: { engine: 'postgres', standbyRegion: 'ukwest', spread: 'region' } },
		};
		expect(core.blueprints.validate(principal, document).document.databases.main?.standbyRegion).toBe('ukwest');
		await expect(core.blueprints.plan(principal, { document })).rejects.toMatchObject({
			code: 'not_built',
			message: expect.stringContaining('databases.main.spread, databases.main.standbyRegion'),
		});
	});
});

describe('REGIONS on', () => {
	test('a node region is stored, and a zone stays in one region', () => {
		setFeature('REGIONS', true);
		// a1 and a2 share zone uksouth-1, so neither can leave the default region alone.
		expect(() => core.nodes.update(principal, join1.nodeId, { region: 'uksouth' })).toThrow(
			expect.objectContaining({ message: expect.stringContaining('a zone belongs to exactly one region') }),
		);
		core.nodes.update(principal, join2.nodeId, { zone: 'ukwest-1', region: 'ukwest' });
		core.nodes.update(principal, join1.nodeId, { region: 'uksouth' });
		expect(() => core.nodes.update(principal, join1.nodeId, { zone: 'ukwest-1' })).toThrow(
			expect.objectContaining({ message: expect.stringContaining('Zone "ukwest-1" is in region "ukwest"') }),
		);
		const rows = opened.sqlite.query<{ name: string; zone: string; region: string }, []>('SELECT name, zone, region FROM nodes ORDER BY name').all();
		expect(rows).toEqual([
			{ name: 'a1', zone: 'uksouth-1', region: 'uksouth' },
			{ name: 'a2', zone: 'ukwest-1', region: 'ukwest' },
		]);
		// Turning the flag off again leaves stored regions alone and keeps re-sending them working.
		setFeature('REGIONS', false);
		expect(core.nodes.update(principal, join2.nodeId, { region: 'ukwest' }).zone).toBe('ukwest-1');
	});

	test('spread: region and standby regions are refused as not built (lane A), not silently stored', async () => {
		setFeature('REGIONS', true);
		const notBuilt = { code: 'not_built', status: 501 };
		expect(() => core.cluster.update(principal, { replicas: { spread: 'region' } })).toThrow(expect.objectContaining(notBuilt));
		expect(() => core.databases.update(principal, 'main', { standbyRegion: 'ukwest' })).toThrow(expect.objectContaining(notBuilt));
		await expect(core.projects.update(principal, app.slug, { placementSpec: { spread: 'region' } })).rejects.toMatchObject(notBuilt);
		expect(core.databases.get(principal, 'main').standbyRegion).toBeNull();
	});
});

describe('lane stubs', () => {
	test('lane A and lane B services refuse honestly', async () => {
		const notBuilt = { code: 'not_built', status: 501 };
		expect(() => core.regions.view(principal)).toThrow(expect.objectContaining(notBuilt));
		await expect(core.regions.promote(principal, 'ukwest', {})).rejects.toMatchObject(notBuilt);
		expect(() => core.haInit.plan(principal, { profile: 'ha' })).toThrow(expect.objectContaining(notBuilt));
		await expect(core.haInit.apply(principal, { profile: 'ha', apply: true })).rejects.toMatchObject(notBuilt);
		expect(() => core.haDoctor.doctor(principal)).toThrow(expect.objectContaining(notBuilt));
		await expect(core.haDrills.run(principal, { scenario: 'zone-offline', resource: 'uksouth-1' })).rejects.toMatchObject(notBuilt);
		await expect(core.haDrills.runAll(principal, {})).rejects.toMatchObject(notBuilt);
		expect(core.haDrills.catalogue(principal).scenarios).toBe(HA_DRILL_CATALOGUE);
	});

	test('the preflight already speaks HaCheck: W12 findings mapped, unbuilt checks skipped, never a false ok', () => {
		const findings = core.ha.view(principal).findings;
		const report = core.haDoctor.preflight(principal, 'ha');
		expect(report.mode).toBe('preflight');
		expect(report.ok).toBe(false);
		for (const id of haCheckIds) expect(report.checks.some((check) => check.id === id)).toBe(true);
		for (const finding of findings) {
			const check = report.checks.find((item) => item.id === finding.key && item.title === finding.title);
			expect(check?.evidence).toEqual([finding.detail]);
		}
		// The local platform store is a W12 blocker: a fail with its env fix.
		expect(report.checks.find((check) => check.id === 'platform-store')).toMatchObject({ status: 'fail', fix: { kind: 'env' } });
		expect(report.checks.find((check) => check.id === 'clocks')).toMatchObject({ status: 'skip', fix: null });
		expect(core.haDoctor.preflight(principal, 'single').ok).toBe(true);
	});
});

describe('old blueprint files', () => {
	test('a deployed blueprint parses unchanged and plans without HA keys', () => {
		const text = readFileSync(join(import.meta.dir, '../../../apps/usage/deploy/blueprint.yaml'), 'utf8');
		const doc = parseBlueprint(text);
		expect('cluster' in doc).toBe(false);
		for (const project of Object.values(doc.projects)) expect(project.placement === undefined || typeof project.placement === 'string').toBe(true);
	});
});
