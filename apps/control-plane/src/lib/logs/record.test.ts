import { describe, expect, test } from 'bun:test';
import type { LogRecord } from '@yoal/contracts';
import { logShortcutFor } from './keyboard';
import { jsonBody, primaryField, recordFields, recordPivots } from './record';

const base: LogRecord = {
	id: 'le:7',
	ts: 1_000,
	observedTs: null,
	orgId: 'org_1',
	scope: { kind: 'project', id: 'prj_1' },
	scopeName: 'api',
	stream: 'deployment:dep_1',
	source: 'runtime',
	channel: 'stderr',
	severityNumber: 17,
	severity: 'error',
	body: 'boom',
	attributes: { 'http.status': '502' },
	resource: { 'host.id': 'node_1' },
	traceId: null,
	spanId: null,
	requestId: 'req_9',
	patternId: null,
	projectId: 'prj_1',
	deploymentId: 'dep_1',
	buildId: null,
	jobRunId: null,
	nodeId: 'node_1',
	replica: 1
};

describe('record fields and pivots', () => {
	test('fields use query names, built-ins first', () => {
		const fields = recordFields(base).map((field) => `${field.field}=${field.value}`);
		expect(fields.slice(0, 4)).toEqual([
			'level=error',
			'scope=project:prj_1',
			'service=api',
			'kind=project'
		]);
		expect(fields).toContain('@http.status=502');
		expect(fields).toContain('resource.host.id=node_1');
		expect(fields).toContain('request=req_9');
		expect(fields.some((field) => field.startsWith('trace='))).toBe(false);
	});

	test('pivots filter by request, deployment, node and stream, and link to the deployment', () => {
		const pivots = recordPivots(base);
		expect(pivots.filter((pivot) => pivot.query).map((pivot) => pivot.query)).toEqual([
			'request:req_9',
			'deployment:dep_1',
			'node:node_1',
			'stream:deployment:dep_1'
		]);
		expect(pivots.find((pivot) => pivot.href?.includes('/deployments/'))?.href).toBe(
			'/projects/api/deployments/dep_1'
		);
	});

	test('the focused value defaults to the stream', () => {
		expect(primaryField(base)).toEqual({ field: 'stream', value: 'deployment:dep_1' });
		expect(primaryField({ ...base, stream: null, deploymentId: null })).toEqual({
			field: 'scope',
			value: 'project:prj_1'
		});
	});

	test('JSON bodies are detected', () => {
		expect(jsonBody('{"a":1}')).toEqual({ a: 1 });
		expect(jsonBody('{not json}')).toBeNull();
		expect(jsonBody('plain')).toBeNull();
	});
});

describe('keyboard map', () => {
	const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({
		key: k,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...extra
	});

	test('single keys act only when not typing', () => {
		expect(logShortcutFor(key('j'), false)).toBe('next');
		expect(logShortcutFor(key('j'), true)).toBeNull();
		expect(logShortcutFor(key(' '), false)).toBe('toggleLive');
		expect(logShortcutFor(key('['), false)).toBe('shiftBack');
	});

	test('⌘↵, ⌘K and Escape work while typing', () => {
		expect(logShortcutFor(key('Enter', { metaKey: true }), true)).toBe('run');
		expect(logShortcutFor(key('k', { ctrlKey: true }), true)).toBe('palette');
		expect(logShortcutFor(key('Escape'), true)).toBe('close');
	});
});
