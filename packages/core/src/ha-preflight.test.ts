import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { mergeTelemetryGaps } from './telemetry-spool-gaps.ts';
import { emptyTrafficReport } from './telemetry.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-ha-deps-'));
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
		features: DEFAULT_FEATURES,
		now: () => Date.UTC(2026, 10, 20, 12),
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const stranger = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function addNode(name: string, capabilities: string[], publicAddress: string | null = null) {
	const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, name).token, name });
	opened.sqlite.run('UPDATE nodes SET capabilities_json = ?, public_address = ?, status = ? WHERE id = ?', [
		JSON.stringify(capabilities),
		publicAddress,
		'online',
		node.nodeId,
	]);
	return node.nodeId;
}

describe('HA profile preflight (HA-PLAN H27/H28, W12)', () => {
	test('defaults to single and reports the local platform store as a blocker', () => {
		expect(core.cluster.get().ha).toEqual({ profile: 'single', applied: null });
		const view = core.ha.view(owner);
		expect(view.profile).toBe('single');
		const blocker = view.findings.find((finding) => finding.key === 'platform-store')!;
		expect(blocker).toMatchObject({ severity: 'blocker' });
		expect(blocker.fix).toMatch(/YOAL_OBJECT_STORE/);
	});

	test('refuses the ha profile while the platform store is local, and names the fix', () => {
		expect(() => core.cluster.update(owner, { ha: { profile: 'ha' } })).toThrow(/profile is refused.*platform object store is on one node/i);
		expect(core.cluster.get().ha.profile).toBe('single');
	});

	test('turns on once the platform store is external; the preflight is then clear', () => {
		core.ctx.config.platformStore = {
			kind: 'r2',
			s3: {
				endpoint: 'https://r2.example.com',
				bucket: 'platform',
				region: 'auto',
				accessKeyId: 'AK',
				secretAccessKey: 'SK',
				pathStyle: true,
			},
		};
		expect(core.cluster.update(owner, { ha: { profile: 'ha' } }).ha.profile).toBe('ha');
		const view = core.ha.view(owner);
		expect(view.ok).toBe(true);
		expect(view.dependencies.platformStore).toMatchObject({ kind: 'r2', bucket: 'platform', survivesNodeLoss: true });
		expect(view.findings.some((finding) => finding.key === 'platform-store' && finding.severity === 'blocker')).toBe(false);
		core.cluster.update(owner, { ha: { profile: 'single' } });
	});

	test('the platform store is a view/HA fact, not a mutable dashboard setting', () => {
		expect(() => core.ha.view(stranger)).toThrow(/High availability is for platform operators/);
		expect(() => core.ha.setProfile(stranger, 'ha')).toThrow(/platform admin/i);
	});
});

describe('movable identity and mail (HA-PLAN H28, W12)', () => {
	test('identity is a node setting and a move re-renders desired state', async () => {
		const first = addNode('id-a', ['identity']);
		const second = addNode('id-b', ['identity']);
		core.projects.bump();
		const before = core.nodes.stateVersion();
		const moved = await core.ha.move(owner, { identityNode: second });
		expect(moved.dependencies.identity).toMatchObject({ nodeId: second, nodeName: 'id-b', movable: true });
		expect(
			opened.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get('identity.node_id')?.value,
		).toBe(second);
		expect(core.nodes.stateVersion()).toBeGreaterThan(before);
		// Clearing the pin returns identity to automatic placement (the edge/first capable node).
		await core.ha.move(owner, { identityNode: null });
		expect(
			opened.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get('identity.node_id')?.value,
		).toBeUndefined();
		expect(first).toBeTruthy();
	});

	test('refuses a node whose agent cannot run identity', async () => {
		const plain = addNode('plain', []);
		await expect(core.ha.move(owner, { identityNode: plain })).rejects.toThrow(/without identity support/);
	});

	test('mail moves through the same setting the Email page uses', async () => {
		const mail = addNode('mail-a', ['mail'], '203.0.113.10');
		const moved = await core.ha.move(owner, { mailNode: mail });
		expect(moved.dependencies.mail).toMatchObject({ configured: true, nodeId: mail, nodeName: 'mail-a', movable: true });
		expect(core.email.settings().nodeId).toBe(mail);
		await core.ha.move(owner, { mailNode: null });
		expect(core.email.settings().nodeId).toBeNull();
	});
});

describe('telemetry spool gaps (HA-PLAN H28, W12)', () => {
	test('records agent gaps, merges overlaps and filters by host and window', () => {
		const node = addNode('spool', []);
		const from = Date.UTC(2026, 10, 20, 10);
		core.telemetrySpool.record(node, {
			queued: 4,
			bytes: 1024,
			dropped: 6,
			gaps: [
				{ host: 'shop.test', from, to: from + 60_000, buckets: 1 },
				{ host: 'shop.test', from: from + 60_000, to: from + 120_000, buckets: 1 },
				{ host: 'other.test', from, to: from + 60_000, buckets: 2 },
			],
		});
		expect(core.telemetrySpool.gapsFor(['shop.test'], from, from + 180_000)).toEqual([
			{ host: 'shop.test', from, to: from + 120_000, buckets: 2 },
		]);
		// A fleet view sees every host; a project only sees its own.
		expect(core.telemetrySpool.gapsFor(null, from, from + 180_000)).toHaveLength(2);
		expect(core.telemetrySpool.nodes().find((state) => state.nodeId === node)).toMatchObject({ queued: 4, dropped: 6 });
	});

	test('drops gaps outside the query window and merges per host', () => {
		const merged = mergeTelemetryGaps([
			{ host: 'a', from: 0, to: 10, buckets: 1 },
			{ host: 'a', from: 5, to: 20, buckets: 1 },
			{ host: 'b', from: 0, to: 5, buckets: 1 },
		]);
		expect(merged).toEqual([
			{ host: 'a', from: 0, to: 20, buckets: 2 },
			{ host: 'b', from: 0, to: 5, buckets: 1 },
		]);
	});

	test('the traffic view shades only the hosts in its own report', async () => {
		const project = await core.projects.create(owner, {
			name: 'gaps',
			slug: 'gaps',
			runtime: 'container',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const from = Date.UTC(2026, 10, 20, 10);
		const to = from + 60 * 60_000;
		core.telemetrySpool.record('nod_gap', {
			queued: 0,
			bytes: 0,
			dropped: 2,
			gaps: [
				{ host: 'gaps.sites.test', from, to: from + 120_000, buckets: 2 },
				{ host: 'someone-else.test', from, to: from + 120_000, buckets: 2 },
			],
		});
		const report = {
			...emptyTrafficReport(),
			hosts: [{ key: 'gaps.sites.test', requests: 1, bytes: 1, status4xx: 0, status5xx: 0, durationP95Ms: 1 }],
		};
		core.ctx.telemetry = {
			ready: async () => true,
			installed: true,
			error: null,
			report: async () => report,
		} as unknown as typeof core.ctx.telemetry;
		const view = await core.metrics.trafficForProject(owner, project.slug, {
			from,
			to,
			interval: '1m',
		});
		expect(view.gaps).toEqual([{ host: 'gaps.sites.test', from, to: from + 120_000, buckets: 2 }]);
	});
});
