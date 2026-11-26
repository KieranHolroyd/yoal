import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, nodeLogBatchSchema, type FeatureFlags, type NodeLogBatch } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';
import type { UnifiedLogRow } from './log-store/sqlite-sources.ts';
import { unifiedRowToLogRecord } from './log-store/sqlite-sources.ts';
import { normalizeLogHost, PLATFORM_LOG_ORG_ID } from './log-record-ingest.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-log-records-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const clock = 1_764_000_000_000;
const features: { -readonly [K in keyof FeatureFlags]: FeatureFlags[K] } = { ...DEFAULT_FEATURES };

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features,
		now: () => clock,
	},
});

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function joinNode(name: string): string {
	return core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name }).nodeId;
}

async function project(slug: string): Promise<{ id: string; orgId: string; deploymentId: string }> {
	await core.projects.create(principal, {
		name: slug,
		slug,
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	const row = core.projects.requireRow(principal, slug);
	const deployment = await core.deployments.deployEntries(
		principal,
		row,
		[{ path: 'index.html', data: new TextEncoder().encode('<h1>hi</h1>') }],
		{ promote: true },
	);
	return { id: row.id, orgId: row.orgId, deploymentId: deployment.id };
}

function addWorkload(id: string, p: { id: string; orgId: string; deploymentId: string }, nodeId: string): void {
	opened.sqlite.run(
		`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, cpus, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'process', 'running', '{}', 128, 1, ?, ?)`,
		[id, p.orgId, p.id, p.deploymentId, nodeId, clock, clock],
	);
}

function batch(input: unknown): NodeLogBatch {
	return nodeLogBatchSchema.parse(input);
}

function rows(where: string, ...params: string[]): Array<Record<string, unknown>> {
	return opened.sqlite.query(`SELECT * FROM log_records WHERE ${where} ORDER BY seq`).all(...params) as Array<Record<string, unknown>>;
}

function failure(fn: () => unknown): { status?: number; message: string } {
	try {
		fn();
	} catch (error) {
		return error as { status?: number; message: string };
	}
	throw new Error('expected a failure');
}

describe('normalizeLogHost', () => {
	test('lowercases and drops the port and trailing dot', () => {
		expect(normalizeLogHost('Blog.Example.COM.:443')).toBe('blog.example.com');
		expect(normalizeLogHost('api.sites.test')).toBe('api.sites.test');
		expect(normalizeLogHost('[::1]:8080')).toBe('[::1]');
	});
});

describe('LogService.appendRecords', () => {
	test('a workload batch lands in its project, only from the node that runs it', async () => {
		const nodeId = joinNode('worker-a');
		const p = await project('records-app');
		addWorkload('wld_records', p, nodeId);
		const seen: UnifiedLogRow[][] = [];
		core.logs.onAppend.push((inserted) => seen.push(inserted));
		try {
			const result = core.logs.appendRecords(
				nodeId,
				batch({
					target: { kind: 'workload', workloadId: 'wld_records-r1' },
					records: [
						{
							ts: clock - 5,
							source: 'otlp',
							severityNumber: 17,
							body: '\u001b[31mcharge failed\u001b[0m\u0000',
							attributes: { 'http.route': '/v1/orders' },
							resource: { 'service.name': 'spoofed', 'deployment.id': 'dep_spoofed', 'telemetry.sdk.language': 'nodejs' },
							traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
							spanId: '00f067aa0ba902b7',
							requestId: 'req-1',
							channel: 'stderr',
						},
					],
				}),
			);
			expect(result).toEqual({ stored: 1 });
		} finally {
			core.logs.onAppend.pop();
		}
		const [row] = rows('scope_id = ?', p.id);
		expect(row).toMatchObject({
			org_id: p.orgId,
			scope_kind: 'project',
			stream: `deployment:${p.deploymentId}`,
			source: 'otlp',
			channel: 'stderr',
			severity_number: 17,
			body: 'charge failed',
			trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
			span_id: '00f067aa0ba902b7',
			request_id: 'req-1',
			project_id: p.id,
			deployment_id: p.deploymentId,
			node_id: nodeId,
			ts: clock - 5,
			observed_ts: clock,
		});
		// Server-stamped resource keys win over the node's payload; other keys are kept.
		expect(JSON.parse(String(row!.resource))).toEqual({
			'service.name': 'records-app',
			'deployment.id': p.deploymentId,
			'telemetry.sdk.language': 'nodejs',
			replica: '1',
			'host.id': nodeId,
			'host.name': 'worker-a',
		});
		expect(JSON.parse(String(row!.attributes))).toEqual({ 'http.route': '/v1/orders' });

		// The listener got the inserted rows with their seq, readable as LogRecords.
		expect(seen).toHaveLength(1);
		const record = unifiedRowToLogRecord(seen[0]![0]!);
		expect(record).toMatchObject({
			id: `lr:${row!.seq}`,
			orgId: p.orgId,
			scope: { kind: 'project', id: p.id },
			severity: 'error',
			body: 'charge failed',
			requestId: 'req-1',
		});

		// Another node may not write into this workload.
		const other = joinNode('worker-b');
		const refused = failure(() =>
			core.logs.appendRecords(other, batch({ target: { kind: 'workload', workloadId: 'wld_records' }, records: [{ ts: clock, source: 'otlp', body: 'x' }] })),
		);
		expect(refused.status).toBe(403);
		expect(rows('scope_id = ?', p.id)).toHaveLength(1);

		// An unknown workload (removed between read and POST) is an empty, successful drain.
		expect(core.logs.appendRecords(nodeId, batch({ target: { kind: 'workload', workloadId: 'wld_gone' }, records: [{ ts: clock, source: 'otlp', body: 'x' }] }))).toEqual({ stored: 0 });
	});

	test('a node cannot claim a server-only source for a workload', async () => {
		const nodeId = joinNode('worker-c');
		const p = await project('records-src');
		addWorkload('wld_src', p, nodeId);
		core.logs.appendRecords(nodeId, batch({ target: { kind: 'workload', workloadId: 'wld_src' }, records: [{ ts: clock, source: 'audit', body: 'fake audit' }] }));
		expect(rows('scope_id = ?', p.id).map((row) => row.source)).toEqual(['runtime']);
	});

	test('site hosts resolve to the project that serves them', async () => {
		joinNode('edge-a');
		// The ingress (the first edge node) serves every site.
		const nodeId = core.ingressSet.nodes()[0]!;
		const p = await project('shop');
		opened.sqlite.run(
			`INSERT INTO domains (id, org_id, project_id, hostname, kind, status, redirect_www, created_at) VALUES ('dom_1', ?, ?, 'shop.example.com', 'apex', 'active', 1, ?)`,
			[p.orgId, p.id, clock],
		);
		const access = (host: string) =>
			core.logs.appendRecords(
				nodeId,
				batch({
					target: { kind: 'site', host },
					records: [{ ts: clock, source: 'access', severityNumber: 17, body: 'GET /cart 502 31ms', attributes: { 'http.status': '502' } }],
					dropped: 9,
				}),
			);
		expect(access('shop.sites.test')).toEqual({ stored: 1 });
		expect(access('Shop.Example.com:443')).toEqual({ stored: 1 });
		expect(access('www.shop.example.com')).toEqual({ stored: 1 });

		const stored = rows('scope_id = ?', p.id);
		expect(stored.map((row) => row.stream)).toEqual(['site:shop.sites.test', 'site:shop.example.com', 'site:www.shop.example.com']);
		expect(stored.every((row) => row.org_id === p.orgId && row.scope_kind === 'project' && row.deployment_id === p.deploymentId)).toBe(true);
		expect(JSON.parse(String(stored[1]!.resource))).toMatchObject({ 'http.host': 'shop.example.com', 'service.name': 'shop' });

		// Sampled-out lines are counted per scope per minute, reason `node`.
		const drops = opened.sqlite.query('SELECT * FROM log_drop_counts WHERE scope_id = ?').all(p.id);
		expect(drops).toEqual([
			{ org_id: p.orgId, scope_kind: 'project', scope_id: p.id, minute: Math.floor(clock / 60_000) * 60_000, reason: 'node', lines: 27, bytes: 0 },
		]);

		// A host no project serves stays platform-only, on this node's edge scope.
		expect(access('control.example.net')).toEqual({ stored: 1 });
		expect(rows("stream = 'site:control.example.net'")).toEqual([
			expect.objectContaining({ org_id: PLATFORM_LOG_ORG_ID, scope_kind: 'edge', scope_id: nodeId, project_id: null }),
		]);
	});

	test('only a node that serves the host may post its access lines', async () => {
		const edge = core.ingressSet.nodes()[0]!;
		const worker = joinNode('worker-site');
		expect(core.ingressSet.isIngress(worker)).toBe(false);
		const p = await project('spoofed');
		const post = (nodeId: string) =>
			core.logs.appendRecords(
				nodeId,
				batch({
					target: { kind: 'site', host: 'spoofed.sites.test' },
					records: [{ ts: clock, source: 'access', severityNumber: 13, body: 'GET /x 404 1ms' }],
					dropped: 50,
				}),
			);
		// A worker without the project's route is refused, and nothing is stored or counted.
		expect(failure(() => post(worker))).toMatchObject({ status: 403 });
		expect(rows('scope_id = ?', p.id)).toEqual([]);
		expect(opened.sqlite.query('SELECT * FROM log_drop_counts WHERE scope_id = ?').all(p.id)).toEqual([]);
		expect(opened.sqlite.query("SELECT * FROM log_ingest_daily WHERE scope_id = ?").all(p.id)).toEqual([]);
		// The ingress serves every site.
		expect(post(edge)).toEqual({ stored: 1 });
		// A worker holding the project's workload serves its route too.
		addWorkload('wl_site_1', p, worker);
		expect(post(worker)).toEqual({ stored: 1 });
		// A host no project serves lands on the posting node's own edge scope.
		const other = joinNode('worker-stray');
		expect(
			core.logs.appendRecords(other, batch({ target: { kind: 'site', host: 'stray.example.org' }, records: [{ ts: clock, source: 'access', severityNumber: 9, body: 'GET / 200 1ms' }] })),
		).toEqual({ stored: 1 });
		expect(rows("stream = 'site:stray.example.org'")).toEqual([expect.objectContaining({ org_id: PLATFORM_LOG_ORG_ID, scope_kind: 'edge', scope_id: other })]);
	});

	test('platform units land in the node platform scope under the sentinel org', () => {
		const nodeId = joinNode('control-1');
		const result = core.logs.appendRecords(
			nodeId,
			batch({
				target: { kind: 'platform', unit: 'yoal-control-plane' },
				records: [
					{ ts: clock, source: 'platform', severityNumber: 17, body: 'database is locked\n    at run (core.js:1:1)', channel: 'stderr' },
					{ ts: clock, source: 'runtime', severityNumber: 0, body: 'tick' },
				],
			}),
		);
		expect(result).toEqual({ stored: 2 });
		const stored = rows('scope_kind = ? AND scope_id = ?', 'platform', nodeId);
		expect(stored).toHaveLength(2);
		expect(stored[0]).toMatchObject({
			org_id: PLATFORM_LOG_ORG_ID,
			stream: 'unit:yoal-control-plane',
			source: 'platform',
			severity_number: 17,
			body: 'database is locked\n    at run (core.js:1:1)',
			project_id: null,
			node_id: nodeId,
		});
		// The node cannot relabel a platform record, and "unspecified" severity reads as info.
		expect(stored[1]).toMatchObject({ source: 'platform', severity_number: 9 });
		expect(JSON.parse(String(stored[0]!.resource))).toEqual({ 'service.name': 'yoal-control-plane', 'host.id': nodeId, 'host.name': 'control-1' });
	});

	test('refuses a platform unit outside the allow-list', () => {
		const nodeId = joinNode('control-2');
		const refused = failure(() =>
			core.logs.appendRecords(nodeId, batch({ target: { kind: 'platform', unit: 'sshd' }, records: [{ ts: clock, source: 'platform', body: 'x' }] })),
		);
		expect(refused.status).toBe(400);
		expect(rows('scope_id = ?', nodeId)).toEqual([]);
	});

	test('the PLATFORM_LOGS kill switch discards platform batches and says so', () => {
		const nodeId = joinNode('control-3');
		features.PLATFORM_LOGS = false;
		try {
			expect(
				core.logs.appendRecords(nodeId, batch({ target: { kind: 'platform', unit: 'caddy' }, records: [{ ts: clock, source: 'platform', body: 'x' }] })),
			).toEqual({ stored: 0, disabled: true });
		} finally {
			features.PLATFORM_LOGS = true;
		}
		expect(rows('scope_id = ?', nodeId)).toEqual([]);
		expect(core.logs.appendRecords(nodeId, batch({ target: { kind: 'platform', unit: 'caddy' }, records: [] }))).toEqual({ stored: 0 });
	});

	test('a listener that throws never fails ingest', () => {
		const nodeId = joinNode('control-4');
		core.logs.onAppend.push(() => {
			throw new Error('subscriber bug');
		});
		const original = console.error;
		console.error = () => undefined;
		try {
			expect(
				core.logs.appendRecords(nodeId, batch({ target: { kind: 'platform', unit: 'yoal-agent' }, records: [{ ts: clock, source: 'platform', body: 'ok' }] })),
			).toEqual({ stored: 1 });
		} finally {
			console.error = original;
			core.logs.onAppend.pop();
		}
	});

	test('a full batch inserts in chunks and pairs every seq in order', () => {
		const nodeId = joinNode('control-5');
		const seen: UnifiedLogRow[] = [];
		core.logs.onAppend.push((inserted) => seen.push(...inserted));
		try {
			const records = Array.from({ length: 1_000 }, (_, index) => ({ ts: clock + index, source: 'platform', body: `line ${index}` }));
			expect(core.logs.appendRecords(nodeId, batch({ target: { kind: 'platform', unit: 'yoal-helper' }, records }))).toEqual({ stored: 1_000 });
		} finally {
			core.logs.onAppend.pop();
		}
		const stored = rows('scope_id = ?', nodeId);
		expect(seen.map((row) => `${row.seq}:${row.body}`)).toEqual(stored.map((row) => `${String(row.seq)}:${String(row.body)}`));
		expect(seen[999]!.body).toBe('line 999');
	});
});
