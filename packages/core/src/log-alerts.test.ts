import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	alertRuleInputSchema,
	alertRuleProblem,
	alertRuleTemplate,
	logAlertQuery,
	type AlertRuleInput,
	type LogScopeRef,
	type LogTableResult,
	type Principal,
} from '@yoal/contracts';
import { createDb } from '@yoal/db';
import type { AlertMessage, Notifier } from './config.ts';
import { createCore, type Core } from './index.ts';
import { LogAlertEvaluator } from './log-alerts.ts';
import type { LogStore, LogStoreRead } from './log-store/types.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

/**
 * Log alert rules (docs/LOGS.md §9.1): `log_count` evaluated through the Logs Explorer in lite mode
 * (no telemetry store at all), and `log_pattern_new` against a stand-in ClickHouse log store, with
 * tenancy, validation and the Explorer links notifications carry.
 */

const MINUTE = 60_000;
const dir = mkdtempSync(join(tmpdir(), 'yoal-log-alerts-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-26T10:00:00Z');
const sent: AlertMessage[] = [];
const notifier: Notifier = {
	name: 'webhook',
	async notify(alert) {
		sent.push(alert);
	},
};
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
		notifiers: [notifier],
		now: () => clock,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_owner', orgId: 'org_1', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_viewer', orgId: 'org_1', role: 'viewer' });
const outsider = buildPrincipal({ kind: 'user', userId: 'user_other', orgId: 'org_2', role: 'owner' });
const ids: Record<string, string> = {};

async function project(principal: Principal, slug: string): Promise<string> {
	await core.projects.create(principal, {
		name: slug,
		slug,
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	return core.projects.requireRow(principal, slug).id;
}

function line(orgId: string, projectId: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
	clock += 10;
	core.logs.appendSystem({ orgId, projectId, message, level });
}

const errorsRule = (scopes: LogScopeRef[], extra: Partial<AlertRuleInput> = {}): AlertRuleInput => ({
	name: 'Errors',
	kind: 'log_count',
	query: logAlertQuery({ q: 'level:error', scopes }),
	condition: { op: 'gt', threshold: 1 },
	windowSeconds: 300,
	forSeconds: 0,
	...extra,
});

beforeAll(async () => {
	ids.shop = await project(owner, 'shop');
	ids.blog = await project(owner, 'blog');
	ids.vault = await project(outsider, 'vault');
});

afterAll(() => {
	core.logExplorer.tailBus.closeAll();
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('contracts', () => {
	test('kinds must match their query; log filters take no pipes and no platform scopes', () => {
		const parse = (input: AlertRuleInput) => alertRuleInputSchema.parse(input);
		expect(alertRuleProblem(parse(errorsRule([])))).toBeNull();
		expect(alertRuleProblem(parse({ ...errorsRule([]), kind: 'metric' }))?.path).toBe('kind');
		expect(alertRuleProblem(parse({ ...errorsRule([]), query: logAlertQuery({ q: 'level:error | stats count()' }) }))?.message).toContain('pipe');
		expect(alertRuleProblem(parse({ ...errorsRule([]), query: logAlertQuery({ q: 'level:(' }) }))?.path).toBe('query.builder.logs.q');
		expect(alertRuleProblem(parse({ ...errorsRule([{ kind: 'platform', id: 'node_1' }]) }))?.message).toContain('platform');
		const pattern = parse({ ...errorsRule([]), kind: 'log_pattern_new', condition: { op: 'lt', threshold: 5 } });
		expect(alertRuleProblem(pattern)?.path).toBe('condition');
		for (const id of ['log_errors', 'log_new_pattern_after_deploy'])
			expect(alertRuleProblem(parse(alertRuleTemplate(id)!.rule))).toBeNull();
	});
});

describe('log_count in lite mode', () => {
	test('a count over the window fires once, links to the Explorer, and other orgs never count', async () => {
		expect(core.ctx.telemetry ?? null).toBeNull();
		const rule = core.alerts.createRule(owner, errorsRule([{ kind: 'project', id: ids.shop! }]));
		expect(rule.kind).toBe('log_count');

		line('org_1', ids.shop!, 'boom one', 'error');
		line('org_2', ids.vault!, 'their boom', 'error');
		line('org_2', ids.vault!, 'their boom again', 'error');
		line('org_1', ids.blog!, 'blog boom', 'error');
		clock += MINUTE;
		let report = await core.alerts.evaluateDue();
		expect(report).toMatchObject({ evaluated: 1, failed: 0, notifications: 0 });
		let view = core.alerts.getRule(owner, rule.id);
		expect(view.health).toBe('ok');
		expect(view.instances.map((instance) => [instance.state, instance.value])).toEqual([['normal', 1]]);

		line('org_1', ids.shop!, 'boom two', 'error');
		line('org_1', ids.shop!, 'fine', 'info');
		clock += MINUTE;
		sent.length = 0;
		report = await core.alerts.evaluateDue();
		expect(report.notifications).toBe(1);
		view = core.alerts.getRule(owner, rule.id);
		expect(view.instances[0]).toMatchObject({ state: 'firing', value: 2 });
		expect(sent).toHaveLength(1);
		const logs = /Logs: (\S+)/.exec(sent[0]!.detail)?.[1];
		expect(logs).toBeDefined();
		const url = new URL(logs!);
		expect(url.origin + url.pathname).toBe('https://control.test/logs');
		expect(url.searchParams.get('q')).toBe('level:error');
		expect(url.searchParams.getAll('scope')).toEqual([`project:${ids.shop}`]);
		expect(Date.parse(url.searchParams.get('to')!)).toBe(clock);
		expect(Date.parse(url.searchParams.get('from')!)).toBe(clock - 300_000);

		// The preview reports the log query that ran.
		const preview = await core.alerts.preview(owner, { ruleId: rule.id });
		expect(preview.sql).toBe('level:error | stats count()');
		expect(preview.series).toEqual([expect.objectContaining({ value: 2, met: true, state: 'firing' })]);
		core.alerts.deleteRule(owner, rule.id);
	});

	test('a quiet window is a count of 0, not "no data"; grouped counts give one series per group', async () => {
		clock += 60 * MINUTE;
		const quiet = core.alerts.createRule(owner, errorsRule([], { condition: { op: 'lt', threshold: 1 }, name: 'Quiet' }));
		await core.alerts.evaluateDue();
		expect(core.alerts.getRule(owner, quiet.id).instances).toEqual([expect.objectContaining({ state: 'firing', value: 0 })]);
		core.alerts.deleteRule(owner, quiet.id);

		line('org_1', ids.shop!, 'w1', 'warn');
		line('org_1', ids.shop!, 'e1', 'error');
		line('org_1', ids.blog!, 'e2', 'error');
		clock += MINUTE;
		const grouped = core.alerts.createRule(owner, {
			...errorsRule([], { name: 'By level' }),
			query: logAlertQuery({ q: 'level:warn', groupBy: ['level'] }),
			condition: { op: 'gte', threshold: 2 },
		});
		await core.alerts.evaluateDue();
		const instances = core.alerts.getRule(owner, grouped.id).instances;
		expect(instances.map((instance) => [instance.labels.level, instance.state, instance.value]).sort()).toEqual([
			['error', 'firing', 2],
			['warn', 'normal', 1],
		]);
		core.alerts.deleteRule(owner, grouped.id);
	});

	test('a new-pattern rule in lite mode reports why it cannot evaluate, keeping its states', async () => {
		const rule = core.alerts.createRule(owner, { ...alertRuleTemplate('log_new_pattern_after_deploy')!.rule, pattern: { afterDeployMinutes: null, lookbackDays: 7 } });
		clock += MINUTE;
		await core.alerts.evaluateDue();
		const view = core.alerts.getRule(owner, rule.id);
		expect(view.health).toBe('error');
		expect(view.lastError).toContain('ClickHouse');
		core.alerts.deleteRule(owner, rule.id);
	});

	test('only rule writers create log rules, and only over scopes the author can read', () => {
		expect(() => core.alerts.createRule(viewer, errorsRule([]))).toThrow('owners and admins');
		// Another org's scope is not readable, so it is refused rather than silently dropped.
		expect(() => core.alerts.createRule(owner, errorsRule([{ kind: 'project', id: ids.vault! }]))).toThrow('cannot read logs');
		expect(() => core.alerts.createRule(owner, errorsRule([{ kind: 'edge', id: 'node_1' }]))).toThrow('edge');
	});
});

describe('log_pattern_new', () => {
	const hooks = core.ctx as unknown as { logStoreClickhouse?: unknown };
	afterAll(() => {
		delete hooks.logStoreClickhouse;
	});

	/** A stand-in ClickHouse store: `| patterns` lists three patterns; the lookback has seen `p_old`. */
	function patternStore(reads: LogStoreRead[]): LogStore {
		const unsupported = async (): Promise<never> => {
			throw new Error('not in this fake');
		};
		return {
			engine: 'clickhouse',
			async table(read): Promise<LogTableResult> {
				reads.push(read);
				const base = { engine: 'clickhouse' as const, warnings: [], elapsedMs: 1 };
				if (read.ast.pipes[0]?.type === 'patterns')
					return {
						...base,
						columns: [
							{ name: 'pattern', type: 'string' },
							{ name: 'template', type: 'string' },
							{ name: 'count', type: 'number' },
						],
						rows: [
							['p_old', 'cache miss for <*>', 40],
							['p_new', 'payment <*> failed: <*>', 7],
							['p_rare', 'rare <*>', 2],
						],
					};
				return {
					...base,
					columns: [
						{ name: 'pattern', type: 'string' },
						{ name: 'count', type: 'number' },
					],
					rows: [['p_old', 12]],
				};
			},
			search: unsupported,
			histogram: unsupported,
			fields: unsupported,
			context: unsupported,
			get: unsupported,
		};
	}

	test('fires for patterns unseen before the window that meet the count, one series each', async () => {
		const reads: LogStoreRead[] = [];
		hooks.logStoreClickhouse = patternStore(reads);
		const rule = core.alerts.createRule(owner, {
			...alertRuleTemplate('log_new_pattern_after_deploy')!.rule,
			query: logAlertQuery({ q: 'level:error', scopes: [{ kind: 'project', id: ids.shop! }] }),
			pattern: { afterDeployMinutes: null, lookbackDays: 7 },
		});
		clock += MINUTE;
		sent.length = 0;
		await core.alerts.evaluateDue();
		const view = core.alerts.getRule(owner, rule.id);
		expect(view.health).toBe('ok');
		expect(view.instances.map((instance) => [instance.labels.pattern, instance.labels.template, instance.state, instance.value])).toEqual([
			['p_new', 'payment <*> failed: <*>', 'firing', 7],
		]);
		// Current window, then the lookback before it, both inside the rule's org and scope.
		expect(reads).toHaveLength(2);
		const [current, lookback] = reads as [LogStoreRead, LogStoreRead];
		expect(current.boundary).toMatchObject({ orgId: 'org_1', scopes: [{ kind: 'project', id: ids.shop }], crossOrg: false });
		expect([current.from, current.to]).toEqual([clock - 300_000, clock]);
		expect(lookback.to).toBe(current.from - 1);
		expect(lookback.from).toBe(current.from - 7 * 86_400_000);
		expect(lookback.boundary.scopes).toEqual(current.boundary.scopes);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.detail).toContain('payment <*> failed');
		const link = new URL(/Logs: (\S+)/.exec(sent[0]!.detail)![1]!);
		expect(link.searchParams.get('q')).toBe('level:error pattern:p_new');
		core.alerts.deleteRule(owner, rule.id);
	});

	test('after a deploy: no recent deploy means nothing to look for; otherwise the window starts at go-live', async () => {
		const reads: LogStoreRead[] = [];
		const evaluator = new LogAlertEvaluator(core.ctx);
		hooks.logStoreClickhouse = patternStore(reads);
		const spec = alertRuleInputSchema.parse({
			...alertRuleTemplate('log_new_pattern_after_deploy')!.rule,
			query: logAlertQuery({ q: 'level:error', scopes: [{ kind: 'project', id: ids.shop! }] }),
		});
		const system = buildPrincipal({ kind: 'user', userId: 'user_owner', orgId: 'org_1', role: 'owner' });
		const none = await evaluator.observe(system, spec, clock);
		expect(none.series).toEqual([]);
		expect(none.notice).toContain('No deploy');
		expect(reads).toHaveLength(0);

		const liveAt = clock - 20 * MINUTE;
		evaluator.latestDeploy = (orgId, scopes, from, to) => {
			expect([orgId, scopes.map((scope) => scope.id), to - from]).toEqual(['org_1', [ids.shop!], 30 * MINUTE]);
			return liveAt;
		};
		const observed = await evaluator.observe(system, spec, clock);
		expect(observed.window).toEqual({ from: liveAt, to: clock });
		expect(reads[1]!.to).toBe(liveAt - 1);
		expect(observed.series.map((series) => series.labels.pattern)).toEqual(['p_new']);
	});

	test('the latest go-live comes from deployments in scope', () => {
		opened.sqlite.run('PRAGMA foreign_keys = OFF');
		opened.sqlite.run(
			`INSERT INTO deployments (id, org_id, project_id, release_id, config_snapshot_id, short_id, preview_host, created_by, created_at, activated_at, status)
			 VALUES ('dep_a', 'org_1', ?, 'rel', 'cfg', 'a1', 'a.sites.test', 'user_owner', ?, ?, 'active'),
			        ('dep_b', 'org_1', ?, 'rel', 'cfg', 'b1', 'b.sites.test', 'user_owner', ?, ?, 'active')`,
			[ids.shop!, clock - 10 * MINUTE, clock - 10 * MINUTE, ids.blog!, clock - 5 * MINUTE, clock - 5 * MINUTE],
		);
		opened.sqlite.run('PRAGMA foreign_keys = ON');
		const evaluator = new LogAlertEvaluator(core.ctx);
		const shop = [{ kind: 'project' as const, id: ids.shop! }];
		expect(evaluator.latestDeploy('org_1', shop, clock - 30 * MINUTE, clock)).toBe(clock - 10 * MINUTE);
		expect(evaluator.latestDeploy('org_1', [], clock - 30 * MINUTE, clock)).toBe(clock - 5 * MINUTE);
		expect(evaluator.latestDeploy('org_1', shop, clock - 2 * MINUTE, clock)).toBeNull();
		expect(evaluator.latestDeploy('org_2', [], clock - 30 * MINUTE, clock)).toBeNull();
		expect(evaluator.latestDeploy('org_1', [{ kind: 'database', id: 'db_1' }], clock - 30 * MINUTE, clock)).toBeNull();
	});
});
