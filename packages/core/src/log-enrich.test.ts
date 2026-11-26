import { describe, expect, test } from 'bun:test';
import type { LogRecord } from '@yoal/contracts';
import { ENRICH_MAX_ATTRIBUTES, ENRICH_MAX_VALUE, enrichRecord, parseStructuredBody } from './log-enrich.ts';

function record(overrides: Partial<LogRecord> = {}): LogRecord {
	return {
		id: 'le:1',
		ts: 1_000,
		observedTs: null,
		orgId: 'org_1',
		scope: { kind: 'project', id: 'prj_1' },
		scopeName: null,
		stream: 'deployment:dep_1',
		source: 'runtime',
		channel: 'stdout',
		severityNumber: 9,
		severity: 'info',
		body: 'hello',
		attributes: {},
		resource: {},
		traceId: null,
		spanId: null,
		requestId: null,
		patternId: null,
		projectId: 'prj_1',
		deploymentId: 'dep_1',
		buildId: null,
		jobRunId: null,
		nodeId: null,
		replica: 0,
		...overrides,
	};
}

describe('enrichRecord', () => {
	test('a JSON body becomes flattened, stringified attributes and its message becomes the body', () => {
		const out = enrichRecord(
			record({ body: '{"level":"error","msg":"upstream timeout","http":{"status":502,"route":"/v1/orders"},"tags":["a","b"],"ok":false,"n":null}' }),
		);
		expect(out.body).toBe('upstream timeout');
		expect(out.attributes).toEqual({
			level: 'error',
			msg: 'upstream timeout',
			'http.status': '502',
			'http.route': '/v1/orders',
			tags: '["a","b"]',
			ok: 'false',
		});
		expect(out.severity).toBe('error');
		expect(out.severityNumber).toBe(17);
	});

	test('message keys are tried in order: msg, message, event, error', () => {
		expect(enrichRecord(record({ body: '{"message":"m","event":"e"}' })).body).toBe('m');
		expect(enrichRecord(record({ body: '{"event":"e","error":"x"}' })).body).toBe('e');
		expect(enrichRecord(record({ body: '{"error":"boom","code":1}' })).body).toBe('boom');
		// No message key: the original text stays the body.
		expect(enrichRecord(record({ body: '{"a":1}' })).body).toBe('{"a":1}');
	});

	test('logfmt with at least two pairs becomes attributes; one pair or prose does not', () => {
		const out = enrichRecord(record({ body: 'level=warn msg="disk almost full" used=91%' }));
		expect(out.attributes).toEqual({ level: 'warn', msg: 'disk almost full', used: '91%' });
		expect(out.body).toBe('disk almost full');
		expect(out.severity).toBe('warn');
		expect(parseStructuredBody('user=bob')).toBeNull();
		expect(parseStructuredBody('user=bob logged in at=noon')).toBeNull();
		expect(enrichRecord(record({ body: 'plain words here' })).attributes).toEqual({});
	});

	test('the raw line is parsed when the adapter already cleaned the body', () => {
		const out = enrichRecord(record({ body: 'boom', severityNumber: 17, severity: 'error' }), {
			rawBody: '{"level":"error","msg":"boom","user":{"id":42}}',
		});
		expect(out.body).toBe('boom');
		expect(out.attributes['user.id']).toBe('42');
	});

	test('attributes the source set win over parsed ones', () => {
		const out = enrichRecord(record({ body: '{"pipeline.step":"9","msg":"x"}', attributes: { 'pipeline.step': '2' } }));
		expect(out.attributes['pipeline.step']).toBe('2');
	});

	test('caps keys at 64 and values at 4 KiB', () => {
		const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
		expect(Object.keys(enrichRecord(record({ body: JSON.stringify(wide) })).attributes)).toHaveLength(ENRICH_MAX_ATTRIBUTES);
		const long = enrichRecord(record({ body: JSON.stringify({ big: 'x'.repeat(10_000), msg: 'm' }) }));
		expect(long.attributes.big).toHaveLength(ENRICH_MAX_VALUE);
	});

	test('severity comes from level, severity, lvl or log.level, as words, pino or OTel numbers', () => {
		expect(enrichRecord(record({ body: '{"lvl":"WARNING"}' })).severity).toBe('warn');
		expect(enrichRecord(record({ body: '{"log":{"level":"fatal"}}' })).severity).toBe('fatal');
		expect(enrichRecord(record({ body: '{"level":50,"msg":"pino"}' })).severity).toBe('error');
		expect(enrichRecord(record({ body: '{"level":20,"msg":"pino"}' })).severity).toBe('debug');
		expect(enrichRecord(record({ body: '{"severity":"14"}' })).severityNumber).toBe(14);
		// Nothing declared: the record keeps the severity it had (heuristic or stream).
		expect(enrichRecord(record({ body: '{"msg":"x"}', severityNumber: 13, severity: 'warn' })).severity).toBe('warn');
		// A declared level overrides a heuristic one.
		expect(enrichRecord(record({ body: '{"level":"info","msg":"Error: not really"}', severityNumber: 17, severity: 'error' })).severity).toBe('info');
	});

	test('trace and span ids come from traceparent or the id keys, lower-cased', () => {
		const traceparent = enrichRecord(record({ body: '{"traceparent":"00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01","msg":"x"}' }));
		expect(traceparent.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
		expect(traceparent.spanId).toBe('00f067aa0ba902b7');
		const keys = enrichRecord(record({ body: '{"traceId":"ABC123","spanId":"DEF","msg":"x"}' }));
		expect(keys).toMatchObject({ traceId: 'abc123', spanId: 'def' });
		const datadog = enrichRecord(record({ body: '{"dd":{"trace_id":"123","span_id":"456"},"msg":"x"}' }));
		expect(datadog).toMatchObject({ traceId: '123', spanId: '456' });
		// An id the node already set is kept.
		expect(enrichRecord(record({ body: '{"trace_id":"aaa"}', traceId: 'bbb' })).traceId).toBe('bbb');
	});

	test('request ids come from the common keys, case-insensitively', () => {
		for (const key of ['request_id', 'requestId', 'req_id', 'X-Request-Id', 'http.request_id']) {
			const body = key === 'http.request_id' ? '{"http":{"request_id":"r1"}}' : JSON.stringify({ [key]: 'r1' });
			expect(enrichRecord(record({ body })).requestId).toBe('r1');
		}
		expect(enrichRecord(record({ body: 'request_id=r2 msg=hi' })).requestId).toBe('r2');
	});

	test('never changes the event time or tenancy, and leaves the input untouched', () => {
		const input = record({ body: '{"ts":"2020-01-01T00:00:00Z","org":"evil","msg":"x"}' });
		const out = enrichRecord(input);
		expect(out.ts).toBe(1_000);
		expect(out.orgId).toBe('org_1');
		expect(out.scope).toEqual({ kind: 'project', id: 'prj_1' });
		expect(input.attributes).toEqual({});
		expect(input.body).toContain('"msg":"x"');
	});

	test('malformed JSON stays text', () => {
		const out = enrichRecord(record({ body: '{"msg": broken' }));
		expect(out.body).toBe('{"msg": broken');
		expect(out.attributes).toEqual({});
	});
});
