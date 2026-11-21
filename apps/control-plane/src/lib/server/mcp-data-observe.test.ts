import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, nodeCapabilities } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/**
 * Read-only database and storage HA tools, SLO tools and alert-silence tools against a real core.
 * Failover, switchover, moves and storage replicas stay read-only over MCP (docs/CLUSTERING.md §12.4).
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-data-observe-'));
const opened = createDb({ path: ':memory:' });
const realCore: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(
			join(dir, 'objects'),
			'https://control.test',
			'object-secret-123'
		),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features: { ...DEFAULT_FEATURES, SLO_OBJECTS: true }
	}
});

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({
	platformOrigin: 'https://control.test',
	authSecret: 'test-secret'
}));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { yoalToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');
const { CONFIRM_TOOLS } = await import('./assistant/confirm-policy');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true
});
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

async function call(principal: typeof owner, name: string, args: Record<string, unknown>) {
	const tool = assistantTools(principal).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	return {
		ok: result.ok,
		text: result.text,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are free-form JSON
		body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null
	};
}

const annotations = () =>
	new Map(yoalToolDefinitions(owner).map((entry) => [entry.name, entry.config.annotations]));

describe('database and storage HA reads', () => {
	test('setup: a node and a postgres database', () => {
		const node = realCore.nodes.join({
			token: realCore.nodes.createJoinToken(owner, 'edge').token,
			name: 'edge'
		});
		realCore.nodes.update(owner, node.nodeId, { sliceMemoryMb: 4096 });
		realCore.nodes.heartbeat(node.token, {
			nodeId: node.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 0,
			status: 'online',
			caddyOk: true,
			releases: [],
			capabilities: [...nodeCapabilities]
		});
		realCore.databases.create(owner, { name: 'main-db', placement: node.nodeId });
		realCore.storage.create(owner, { name: 'files', placement: node.nodeId });
	});

	test('only reads are offered: no arm, drill, switchover, move, promote or storage replica writes', () => {
		const tools = annotations();
		for (const name of ['get_database_failover', 'plan_database_upgrade', 'list_storage_replicas'])
			expect(tools.get(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		const names = [...tools.keys()];
		expect(
			names.filter((name) =>
				/switchover|failover_(arm|drill)|arm_failover|move_database|promote_database|storage_replica(?!s$)/.test(
					name
				)
			)
		).toEqual([]);
		expect(names).not.toContain('add_storage_replica');
		expect(names).not.toContain('apply_database_upgrade');
	});

	test('get_database_failover returns the policy view, switchovers and the latest move', async () => {
		const result = await call(owner, 'get_database_failover', { database: 'main-db' });
		expect(result.ok).toBe(true);
		expect(result.body!.database).toBe('main-db');
		expect(result.body!.failover).toBeTruthy();
		expect(result.body!.switchovers).toEqual([]);
		expect(result.body!.latestMove).toBeNull();
		const missing = await call(owner, 'get_database_failover', { database: 'nope' });
		expect(missing.ok).toBe(false);
	});

	test('plan_database_upgrade plans and changes nothing; a viewer is refused', async () => {
		const before = realCore.databases.get(owner, 'main-db');
		expect(before.version).toBe('17');
		const plan = await call(owner, 'plan_database_upgrade', {
			database: 'main-db',
			targetVersion: '18'
		});
		expect(plan.ok).toBe(true);
		expect(plan.body!.plan).toMatchObject({
			fromVersion: '17',
			toVersion: '18',
			backupId: null,
			mode: 'dump-restore'
		});
		expect(['planned', 'blocked']).toContain(plan.body!.plan.status);
		const same = await call(owner, 'plan_database_upgrade', {
			database: 'main-db',
			targetVersion: '17'
		});
		expect(same.ok).toBe(false);
		expect(realCore.databases.listBackups(owner, 'main-db')).toHaveLength(0);
		expect(realCore.databases.get(owner, 'main-db').version).toBe(before.version);
		const denied = await call(viewer, 'plan_database_upgrade', {
			database: 'main-db',
			targetVersion: '18'
		}).catch((error: Error) => ({ ok: false, text: error.message, body: null }));
		expect(denied.ok).toBe(false);
	});

	test('list_storage_replicas lists links (none yet)', async () => {
		const result = await call(owner, 'list_storage_replicas', { storage: 'files' });
		expect(result.ok).toBe(true);
		expect(result.body!.replicas).toEqual([]);
	});
});

describe('SLO tools', () => {
	test('setup: a project', async () => {
		await realCore.projects.create(owner, {
			name: 'shop',
			slug: 'shop',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform'
		});
	});

	test('annotations and confirmation: delete is destructive, the rest are not', () => {
		const tools = annotations();
		expect(tools.get('list_slos')).toMatchObject({ readOnlyHint: true });
		expect(tools.get('evaluate_slos')).toMatchObject({ readOnlyHint: true });
		expect(tools.get('set_slo')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
		expect(tools.get('delete_slo')).toMatchObject({ destructiveHint: true });
	});

	test('set, list and delete through core', async () => {
		const set = await call(owner, 'set_slo', {
			project: 'shop',
			name: 'availability',
			indicator: 'http_availability',
			target: 0.999,
			windowSeconds: 30 * 24 * 3600,
			burnAlerts: [
				{ severity: 'critical', burnRate: 14.4, windowSeconds: 3600, shortWindowSeconds: 300 }
			]
		});
		expect(set.ok).toBe(true);
		expect(set.body!.slo).toMatchObject({ name: 'availability', target: 0.999, enabled: true });
		const id = set.body!.slo.id as string;

		// Same name replaces rather than duplicating.
		const replaced = await call(owner, 'set_slo', {
			project: 'shop',
			name: 'availability',
			indicator: 'http_availability',
			target: 0.99,
			windowSeconds: 7 * 24 * 3600
		});
		expect(replaced.body!.slo.id).toBe(id);

		const listed = await call(owner, 'list_slos', { project: 'shop' });
		expect(listed.body!.slos).toHaveLength(1);
		expect(listed.body!.slos[0]).toMatchObject({ id, target: 0.99 });

		const overview = await call(owner, 'list_slos', {});
		expect(overview.ok).toBe(true);
		expect(overview.body!.enabled).toBe(true);

		const removed = await call(owner, 'delete_slo', { project: 'shop', id });
		expect(removed.ok).toBe(true);
		expect((await call(owner, 'list_slos', { project: 'shop' })).body!.slos).toEqual([]);
	});

	test('a viewer can read but not write', async () => {
		expect((await call(viewer, 'list_slos', { project: 'shop' })).ok).toBe(true);
		const tools = assistantTools(viewer).map((entry) => entry.name);
		if (tools.includes('set_slo')) {
			const denied = await call(viewer, 'set_slo', {
				project: 'shop',
				name: 'x',
				indicator: 'http_availability',
				target: 0.9,
				windowSeconds: 3600
			});
			expect(denied.ok).toBe(false);
		} else {
			expect(tools).not.toContain('delete_slo');
		}
	});
});

describe('alert silence tools', () => {
	test('list then remove a silence created through core', async () => {
		const silence = realCore.alerts.createSilence(owner, {
			ruleId: null,
			matchers: [],
			durationMinutes: 60,
			comment: 'maintenance'
		});
		const listed = await call(owner, 'list_alert_silences', {});
		expect(listed.ok).toBe(true);
		expect(listed.body!.silences.map((entry: { id: string }) => entry.id)).toContain(silence.id);

		const removed = await call(owner, 'remove_alert_silence', { id: silence.id });
		expect(removed.ok).toBe(true);
		expect((await call(owner, 'list_alert_silences', {})).body!.silences).toEqual([]);
		const expired = await call(owner, 'list_alert_silences', { includeExpired: true });
		expect(expired.body!.silences.map((entry: { id: string }) => entry.id)).toContain(silence.id);

		const again = await call(owner, 'remove_alert_silence', { id: silence.id });
		expect(again.ok).toBe(false);
	});

	test('a viewer cannot end a silence', async () => {
		const silence = realCore.alerts.createSilence(owner, {
			ruleId: null,
			matchers: [],
			durationMinutes: 60,
			comment: ''
		});
		const denied = await call(viewer, 'remove_alert_silence', { id: silence.id });
		expect(denied.ok).toBe(false);
		realCore.alerts.expireSilence(owner, silence.id);
	});

	test('annotations; none of the new tools stop for a click in the assistant except via destructiveHint', () => {
		const tools = annotations();
		expect(tools.get('list_alert_silences')).toMatchObject({ readOnlyHint: true });
		expect(tools.get('remove_alert_silence')).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false
		});
		for (const name of [
			'get_database_failover',
			'plan_database_upgrade',
			'list_storage_replicas',
			'list_slos',
			'evaluate_slos',
			'set_slo',
			'list_alert_silences',
			'remove_alert_silence'
		])
			expect(CONFIRM_TOOLS.has(name)).toBe(false);
	});
});

describe('feature gate', () => {
	test('SLO tools are not offered while SLO_OBJECTS is off', () => {
		const features = realCore.ctx.config.features as Record<string, boolean>;
		features.SLO_OBJECTS = false;
		try {
			const names = yoalToolDefinitions(owner).map((entry) => entry.name);
			for (const name of ['list_slos', 'evaluate_slos', 'set_slo', 'delete_slo'])
				expect(names).not.toContain(name);
			expect(names).toContain('list_alert_silences');
		} finally {
			features.SLO_OBJECTS = true;
		}
	});
});
