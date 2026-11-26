import { describe, expect, test } from 'bun:test';
import { logAlertExplorerHref, logAlertQuery } from './alerts.ts';
import {
	andLogQueries,
	appErrorLogLink,
	deploymentCompareLogLink,
	deploymentLogLink,
	logExplorerHref,
	nodeLogLink,
	trafficErrorsLogLink,
} from './log-links.ts';
import { parseLogQuery } from './log-query.ts';

/** Explorer links (docs/LOGS.md §9.3): what each pivot opens, in the URL keys `/logs` decodes. */

const T = Date.parse('2026-11-26T12:00:00Z');
const params = (href: string) => new URL(href, 'https://control.test').searchParams;
const project = { kind: 'project' as const, id: 'prj_1' };

describe('logExplorerHref', () => {
	test('query, repeated scopes, absolute window, mode and baseline; defaults left out', () => {
		const href = logExplorerHref({
			q: 'level:error',
			scopes: [project, project, { kind: 'database', id: 'db_1' }],
			from: T - 60_000,
			to: T,
			mode: 'compare',
			baseline: { kind: 'offset', offsetMs: 86_400_000 },
		});
		expect(href.startsWith('/logs?')).toBe(true);
		const p = params(href);
		expect(p.get('q')).toBe('level:error');
		expect(p.getAll('scope')).toEqual(['project:prj_1', 'database:db_1']);
		expect([p.get('from'), p.get('to')]).toEqual([new Date(T - 60_000).toISOString(), new Date(T).toISOString()]);
		expect(p.get('mode')).toBe('compare');
		expect(p.get('baseline')).toBe('offset:86400000');
		expect(logExplorerHref({})).toBe('/logs');
		expect(logExplorerHref({ mode: 'stream', range: '1h' })).toBe('/logs?range=1h');
		expect(logExplorerHref({ from: T, to: null }, 'https://control.test/')).toBe(`https://control.test/logs?from=${encodeURIComponent(new Date(T).toISOString())}&to=now`);
	});

	test('queries are joined so an OR stays on its side', () => {
		expect(andLogQueries('a OR b', 'pattern:p1')).toBe('(a OR b) pattern:p1');
		expect(andLogQueries('', 'x', undefined)).toBe('x');
		expect(andLogQueries('(a OR b)', 'c')).toBe('(a OR b) c');
	});
});

describe('pivots', () => {
	test('traffic 5xx → server-error access lines over the chart window', () => {
		const p = params(logExplorerHref(trafficErrorsLogLink({ scopes: [project], from: T - 3_600_000, to: T })));
		expect(p.get('q')).toBe('source:access @http.status:>=500');
		expect(parseLogQuery(p.get('q')!).ok).toBe(true);
		expect(p.getAll('scope')).toEqual(['project:prj_1']);
	});

	test('app error event → the project ±60 s, or its request when the event has an id', () => {
		const around = params(logExplorerHref(appErrorLogLink({ projectId: 'prj_1', at: T })));
		expect(around.get('q')).toBeNull();
		expect([Date.parse(around.get('from')!), Date.parse(around.get('to')!)]).toEqual([T - 60_000, T + 60_000]);
		const request = params(logExplorerHref(appErrorLogLink({ projectId: 'prj_1', at: T, requestId: 'req 1' })));
		expect(request.get('q')).toBe('request:"req 1"');
		expect(parseLogQuery(request.get('q')!).ok).toBe(true);
	});

	test('deployment → its own lines, and Compare against the time before it went live', () => {
		const own = params(logExplorerHref(deploymentLogLink({ projectId: 'prj_1', deploymentId: 'dep_1', from: T })));
		expect([own.get('q'), own.get('to')]).toEqual(['deployment:dep_1', 'now']);
		const compare = params(logExplorerHref(deploymentCompareLogLink({ projectId: 'prj_1', deploymentId: 'dep_1', liveAt: T, now: T + 10 * 60_000 })));
		expect([compare.get('mode'), compare.get('baseline'), compare.get('to')]).toEqual(['compare', 'deploy:dep_1', 'now']);
		const old = params(logExplorerHref(deploymentCompareLogLink({ projectId: 'prj_1', deploymentId: 'dep_1', liveAt: T, now: T + 5 * 3_600_000 })));
		expect(Date.parse(old.get('to')!)).toBe(T + 3_600_000);
	});

	test('node → its platform scope', () => {
		expect(logExplorerHref(nodeLogLink({ nodeId: 'node_1' }))).toBe('/logs?scope=platform%3Anode_1&range=1h');
	});

	test('alert instance → the rule query at fire time; patterns open the Patterns tab', () => {
		const spec = { kind: 'log_count' as const, query: logAlertQuery({ q: 'level:error', scopes: [project] }) };
		const p = params(logAlertExplorerHref(spec, { from: T - 300_000, to: T })!);
		expect([p.get('q'), p.getAll('scope')[0], p.get('mode')]).toEqual(['level:error', 'project:prj_1', null]);
		const pattern = params(logAlertExplorerHref({ ...spec, kind: 'log_pattern_new' }, { from: T, to: null })!);
		expect(pattern.get('mode')).toBe('patterns');
		const one = params(logAlertExplorerHref({ ...spec, kind: 'log_pattern_new' }, { from: T, to: null }, 'pattern:p1')!);
		expect([one.get('q'), one.get('mode')]).toEqual(['level:error pattern:p1', null]);
		expect(logAlertExplorerHref({ kind: 'metric', query: spec.query }, { from: T, to: T })).toBeNull();
	});
});
