import { describe, expect, test } from 'bun:test';
import { suggestLogQuery, type LogQuerySuggestCatalog } from './log-query-suggest.ts';

const catalog: LogQuerySuggestCatalog = {
	service: ['api', 'worker', 'my app'],
	'@http.status': ['200', '502'],
	'@http.route': ['/v1/orders'],
	'resource.host.name': ['edge-a'],
};

/** Suggest with the caret at `|` in the template (or at the end when absent). */
function suggest(template: string, cat: LogQuerySuggestCatalog = catalog) {
	const caret = template.indexOf('‸');
	const text = caret >= 0 ? template.replace('‸', '') : template;
	return { text, ...suggestLogQuery(text, caret >= 0 ? caret : text.length, cat) };
}

function labels(template: string, cat?: LogQuerySuggestCatalog): string[] {
	return suggest(template, cat).items.map((item) => item.label);
}

function apply(template: string, label: string): string {
	const result = suggest(template);
	const item = result.items.find((candidate) => candidate.label === label);
	if (!item) throw new Error(`no item ${label} in ${JSON.stringify(result.items.map((i) => i.label))}`);
	return result.text.slice(0, result.from) + item.insert + result.text.slice(result.to);
}

describe('suggestLogQuery: filter', () => {
	test('empty query offers fields and NOT', () => {
		const result = suggest('');
		expect(result.from).toBe(0);
		expect(result.to).toBe(0);
		expect(result.items.find((item) => item.label === 'level')).toMatchObject({ insert: 'level:', kind: 'field' });
		expect(result.items.some((item) => item.label === 'NOT')).toBe(true);
		expect(result.items.some((item) => item.label === 'OR')).toBe(false);
		expect(result.items.some((item) => item.label === '|')).toBe(false);
	});

	test('field names by prefix, with discovered attributes', () => {
		expect(labels('lev')).toEqual(['level']);
		expect(labels('dep')).toEqual(['deployment']);
		expect(labels('@')).toEqual(['@http.status', '@http.route']);
		expect(labels('@http.s')).toEqual(['@http.status']);
		expect(labels('reso')).toContain('resource.host.name');
		expect(apply('lev', 'level')).toBe('level:');
		expect(apply('a -ser‸ b', 'service')).toBe('a -service: b');
	});

	test('after a term: keywords and the pipe', () => {
		const items = labels('timeout ');
		expect(items).toContain('OR');
		expect(items).toContain('AND');
		expect(items).toContain('|');
		expect(labels('timeout O')).toContain('OR');
		expect(labels('timeout OR ')).not.toContain('OR');
		expect(labels('(')).not.toContain('OR');
	});

	test('values from built-ins and the catalog', () => {
		expect(labels('level:')).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal', '=', '>', '<']);
		expect(labels('level:w')).toEqual(['warn']);
		expect(labels('level:=e')).toEqual(['error']);
		expect(labels('source:ru')).toEqual(['runtime']);
		expect(labels('kind:k')).toEqual(['k8s']);
		expect(labels('service:w')).toEqual(['worker']);
		expect(labels('SERVICE:w')).toEqual(['worker']);
		expect(labels('@http.status:5')).toEqual(['502']);
		expect(labels('resource.host.name:')).toContain('edge-a');
		expect(labels('@resource.host.name:e')).toEqual(['edge-a']);
		expect(apply('service:w', 'worker')).toBe('service:worker');
		expect(apply('service:m‸ level:error', 'my app')).toBe('service:"my app" level:error');
		expect(apply('-service:a', 'api')).toBe('-service:api');
	});

	test('operators when the value is empty', () => {
		const status = labels('@http.status:');
		expect(status).toEqual(['200', '502', '*', '>=', '>', '<=', '<', '/regex/']);
		const service = labels('service:');
		expect(service).toContain('*');
		expect(service).not.toContain('>=');
		expect(labels('replica:')).toContain('>');
		expect(labels('@http.status:>')).toEqual(['200', '502']);
	});

	test('substring matches rank after prefix matches', () => {
		expect(labels('service:ap')).toEqual(['api', 'my app']);
		// One character only matches prefixes.
		expect(labels('service:a')).toEqual(['api']);
	});

	test('the replaced range covers the whole token under the caret', () => {
		const result = suggest('serv‸ice:api');
		expect(result.items[0]?.label).toBe('service');
		const value = suggest('service:wo‸rk level:error');
		expect(value.from).toBe('service:'.length);
		expect(value.to).toBe('service:work'.length);
		expect(apply('service:wo‸rk level:error', 'worker')).toBe('service:worker level:error');
	});

	test('inside a quoted value', () => {
		const result = suggest('service:"my a‸');
		expect(result.items.map((item) => item.label)).toEqual(['my app']);
		expect(apply('service:"my a‸" x', 'my app')).toBe('service:"my app" x');
		expect(labels('"free text ‸')).toEqual([]);
	});

	test('unknown fields give nothing', () => {
		expect(labels('nope:')).toEqual([]);
	});
});

describe('suggestLogQuery: pipes', () => {
	test('stage names', () => {
		expect(labels('x | ')).toEqual(['fields', 'stats', 'patterns', 'dedup', 'sort', 'limit']);
		expect(labels('x | st')).toEqual(['stats']);
		expect(apply('x | st', 'stats')).toBe('x | stats ');
		expect(apply('x | pa', 'patterns')).toBe('x | patterns');
		expect(labels('| s')).toEqual(['stats', 'sort']);
	});

	test('stats: functions, fields inside calls, by and bins', () => {
		expect(labels('| stats ')).toContain('count()');
		expect(labels('| stats p9')).toEqual(['p90(field)', 'p95(field)', 'p99(field)']);
		expect(apply('| stats p9', 'p95(field)')).toBe('| stats p95(');
		expect(labels('| stats p95(@')).toEqual(['@http.status', '@http.route']);
		expect(labels('| stats count() ')).toEqual(['by', 'as']);
		expect(labels('| stats count() as ')).toEqual([]);
		expect(labels('| stats count() as n ')).toEqual(['by', 'as']);
		expect(labels('| stats count(), ')).toContain('count()');
		const by = labels('| stats count() by ');
		expect(by.slice(0, 4)).toEqual(['bin(1m)', 'bin(5m)', 'bin(1h)', 'bin(1d)']);
		expect(by).toContain('level');
		expect(labels('| stats count() by bin(5m), lev')).toEqual(['level']);
	});

	test('fields, dedup, sort, limit', () => {
		expect(labels('| fields ')).toContain('ts');
		expect(labels('| fields level, @http.r')).toEqual(['@http.route']);
		expect(labels('| dedup bo')).toEqual(['body']);
		expect(labels('| sort ')).toContain('ts');
		expect(labels('| sort ts ')).toEqual(['asc', 'desc']);
		expect(labels('| sort ts d')).toEqual(['desc']);
		expect(labels('| limit ')).toEqual(['100', '500', '1000', '10000']);
	});

	test('sort keys come from the stats aliases or pattern columns', () => {
		expect(labels('| stats count() as n, p95(@d) by level | sort ')).toEqual(['level', 'n', 'p95(@d)']);
		expect(labels('| stats count() by level | sort c')).toEqual(['count']);
		expect(labels('| patterns | sort ')).toEqual(['pattern', 'template', 'count']);
		expect(labels('| dedup body | sort ')).toContain('count');
	});

	test('a pipe inside quotes is not a stage boundary', () => {
		expect(labels('"a | b" lev')).toEqual(['level']);
	});

	test('totality: any caret on any text', () => {
		const texts = ['', 'a', '| stats count() by bin(5m) | sort count desc', '"unterminated', 'level:=warn -(@x:/re|x/ OR "q\\"q")', '\\'];
		for (const text of texts) {
			for (let caret = -1; caret <= text.length + 1; caret++) {
				const result = suggestLogQuery(text, caret, catalog);
				expect(result.from).toBeGreaterThanOrEqual(0);
				expect(result.to).toBeGreaterThanOrEqual(result.from);
				expect(result.to).toBeLessThanOrEqual(text.length);
				expect(result.items.length).toBeLessThanOrEqual(50);
			}
		}
	});
});
