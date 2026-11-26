import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertRuleInputSchema, logAlertQuery, type AlertRuleInput, type BuilderSpec } from '@yoal/contracts';
import { createDb } from '@yoal/db';
import { buildSystemPrincipal } from './iam/system.ts';
import { createCore, type Core } from './index.ts';
import { LogAlertEvaluator } from './log-alerts.ts';
import { LogIndexer } from './log-indexer.ts';
import { ClickHouseLogStore } from './log-store/clickhouse-store.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import type { TelemetryStore } from './telemetry.ts';
import { disposeTelemetryStore, hasClickHouse, testTelemetryStore } from './test-clickhouse.ts';

/**
 * Log alerts and the logs dashboards dataset against a real ClickHouse (docs/LOGS.md §9.1–§9.2):
 * lines go through the indexer into `yoal.logs` / `yoal.log_patterns`, and the rules read them
 * through the Logs Explorer with the org's boundary, exactly as in production.
 */
describe.skipIf(!hasClickHouse)('log alerts on ClickHouse', () => {
	const MINUTE = 60_000;
	const NOW = Date.now();
	const dir = mkdtempSync(join(tmpdir(), 'yoal-log-alerts-ch-'));
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
			now: () => NOW,
		},
	});
	const owner = buildPrincipal({ kind: 'user', userId: 'user_owner', orgId: 'org_1', role: 'owner' });
	const outsider = buildPrincipal({ kind: 'user', userId: 'user_other', orgId: 'org_2', role: 'owner' });
	const system = buildSystemPrincipal('system:alerts', 'org_1');
	let telemetry: TelemetryStore;
	let shop = '';
	let vault = '';

	beforeAll(async () => {
		telemetry = testTelemetryStore();
		expect(await telemetry.logsReady()).toBe(true);
		for (const [principal, slug] of [
			[owner, 'shop'],
			[outsider, 'vault'],
		] as const)
			await core.projects.create(principal, { name: slug, slug, runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
		shop = core.projects.requireRow(owner, 'shop').id;
		vault = core.projects.requireRow(outsider, 'vault').id;
		// Two days ago: the cache line is known. In the last five minutes: a payment failure the scope
		// has never logged, the same cache line, and the other org's own "new" failure.
		const lines: Array<[string, string, string, string, number]> = [
			['org_1', shop, 'warn', 'cache miss for key 1', NOW - 2 * 86_400_000],
			['org_1', shop, 'error', 'payment 1 failed: card declined', NOW - 3 * MINUTE],
			['org_1', shop, 'error', 'payment 2 failed: card declined', NOW - 2 * MINUTE],
			['org_1', shop, 'error', 'payment 3 failed: card declined', NOW - MINUTE],
			['org_1', shop, 'warn', 'cache miss for key 9', NOW - MINUTE],
			['org_2', vault, 'error', 'vault 1 exploded', NOW - MINUTE],
			['org_2', vault, 'error', 'vault 2 exploded', NOW - MINUTE],
			['org_2', vault, 'error', 'vault 3 exploded', NOW - MINUTE],
		];
		for (const [org, project, level, message, ts] of lines)
			opened.sqlite.run(
				`INSERT INTO log_events (org_id, project_id, deployment_id, node_id, source, stream, level, message, ts) VALUES (?, ?, 'dep_1', 'node_1', 'runtime', 'stdout', ?, ?, ?)`,
				[org, project, level, message, ts],
			);
		const template = (body: string) =>
			body.startsWith('payment') ? { id: 'p_payment', template: 'payment <*> failed: card declined' } : body.startsWith('cache') ? { id: 'p_cache', template: 'cache miss for key <*>' } : { id: 'p_vault', template: 'vault <*> exploded' };
		const indexer = new LogIndexer({ sqlite: opened.sqlite, config: { features: {} } as never, now: () => Date.now() }, telemetry, {
			miner: { patternFor: (_scope, body) => template(body) },
		});
		expect((await indexer.tick()).indexed).toBe(lines.length);
		(core.ctx as unknown as { logStoreClickhouse: ClickHouseLogStore }).logStoreClickhouse = new ClickHouseLogStore(telemetry);
	});

	afterAll(async () => {
		delete (core.ctx as unknown as { logStoreClickhouse?: unknown }).logStoreClickhouse;
		core.logExplorer.tailBus.closeAll();
		await disposeTelemetryStore(telemetry);
		opened.sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const rule = (input: Partial<AlertRuleInput>) =>
		alertRuleInputSchema.parse({ name: 'r', condition: { op: 'gte', threshold: 2 }, windowSeconds: 300, ...input });

	test('log_pattern_new: only the pattern unseen before the window, in this org only', async () => {
		const evaluator = new LogAlertEvaluator(core.ctx);
		const observed = await evaluator.observe(system, rule({ kind: 'log_pattern_new', query: logAlertQuery() }), NOW);
		expect(observed.series.map((series) => [series.labels.pattern, series.labels.template, series.value])).toEqual([
			['p_payment', 'payment <*> failed: card declined', 3],
		]);
		expect(observed.series[0]!.link).toContain('pattern%3Ap_payment');
		// A higher bar than the new pattern reaches: nothing.
		const strict = await evaluator.observe(system, rule({ kind: 'log_pattern_new', query: logAlertQuery(), condition: { op: 'gte', threshold: 4 } }), NOW);
		expect(strict.series).toEqual([]);
	});

	test('log_count on ClickHouse: attribute-free count and a grouped count, tenancy applied', async () => {
		const evaluator = new LogAlertEvaluator(core.ctx);
		const errors = await evaluator.observe(system, rule({ kind: 'log_count', query: logAlertQuery({ q: 'level:error' }) }), NOW);
		expect(errors.series).toEqual([expect.objectContaining({ labels: {}, value: 3 })]);
		const byLevel = await evaluator.observe(system, rule({ kind: 'log_count', query: logAlertQuery({ q: 'level:warn', groupBy: ['level'] }) }), NOW);
		expect(byLevel.series.map((series) => [series.labels.level, series.value]).sort()).toEqual([
			['error', 3],
			['warn', 1],
		]);
	});

	test('the logs dataset: count_distinct and time buckets through the ClickHouse compiler', async () => {
		const builder = (input: Partial<BuilderSpec>): BuilderSpec => ({ dataset: 'logs', metrics: [{ field: 'count', agg: 'count' }], groupBy: [], filters: [], timeSeries: false, interval: 'auto', ...input });
		const range = { from: new Date(NOW - 10 * MINUTE).toISOString(), to: new Date(NOW).toISOString() };
		const distinct = await core.observability.query(owner, {
			query: { mode: 'builder', builder: builder({ metrics: [{ field: 'count_distinct', agg: 'count', of: 'pattern' }] }) },
			range,
			maxDataPoints: 60,
			variables: {},
		});
		expect(distinct.rows).toEqual([[2]]);
		const series = await core.observability.query(outsider, {
			query: { mode: 'builder', builder: builder({ timeSeries: true, interval: '1m', logs: { q: 'level:error', scopes: [] } }) },
			range,
			maxDataPoints: 60,
			variables: {},
		});
		expect(series.columns.map((column) => [column.name, column.kind])).toEqual([
			['time', 'time'],
			['count', 'number'],
		]);
		expect(series.rows.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(3);
	});
});
