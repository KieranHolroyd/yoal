import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { desiredStateSchema, nodeLogRecordSchema, type NodeLogBatch, type WorkloadDesired } from '@yoal/contracts';
import { startAnalyticsSink } from './analytics-sink.ts';
import { NodeLogBatcher } from './log-records.ts';
import {
	OtlpLogsReceiver,
	mapOtlpLogsRequest,
	nanosToMs,
	otlpId,
	otlpIngestKey,
	otlpSeverityNumber,
	otlpWorkloadEnv,
} from './otlp-logs.ts';

const SECRET = Buffer.alloc(32, 3);
const NOW = 1_764_072_000_000;

/** The OTLP/JSON example from opentelemetry-proto (`examples/logs.json`). */
const SPEC_EXAMPLE = {
	resourceLogs: [
		{
			resource: { attributes: [{ key: 'service.name', value: { stringValue: 'my.service' } }] },
			scopeLogs: [
				{
					scope: {
						name: 'my.library',
						version: '1.0.0',
						attributes: [{ key: 'my.scope.attribute', value: { stringValue: 'some scope attribute' } }],
					},
					logRecords: [
						{
							timeUnixNano: '1544712660300000000',
							observedTimeUnixNano: '1544712660300000000',
							severityNumber: 10,
							severityText: 'Information',
							traceId: '5B8EFFF798038103D269B633813FC60C',
							spanId: 'EEE19B7EC3C1B174',
							body: { stringValue: 'Example log record' },
							attributes: [
								{ key: 'string.attribute', value: { stringValue: 'some string' } },
								{ key: 'boolean.attribute', value: { boolValue: true } },
								{ key: 'int.attribute', value: { intValue: '10' } },
								{ key: 'double.attribute', value: { doubleValue: 637.704 } },
								{ key: 'array.attribute', value: { arrayValue: { values: [{ stringValue: 'many' }, { stringValue: 'values' }] } } },
								{
									key: 'map.attribute',
									value: { kvlistValue: { values: [{ key: 'some.map.key', value: { stringValue: 'some value' } }] } },
								},
							],
						},
					],
				},
			],
		},
	],
};

describe('mapOtlpLogsRequest', () => {
	test('maps the spec example', () => {
		const result = mapOtlpLogsRequest(SPEC_EXAMPLE, { now: () => NOW });
		expect(result.rejected).toBe(0);
		expect(result.groups).toHaveLength(1);
		expect(result.groups[0]!.resource).toEqual({ 'service.name': 'my.service' });
		const record = result.groups[0]!.records[0]!;
		expect(record).toEqual({
			ts: 1_544_712_660_300,
			source: 'otlp',
			severityNumber: 10,
			body: 'Example log record',
			attributes: {
				'string.attribute': 'some string',
				'boolean.attribute': 'true',
				'int.attribute': '10',
				'double.attribute': '637.704',
				'array.attribute': '["many","values"]',
				'map.attribute.some.map.key': 'some value',
				'otel.scope.name': 'my.library',
				'otel.scope.version': '1.0.0',
			},
			resource: {},
			traceId: '5b8efff798038103d269b633813fc60c',
			spanId: 'eee19b7ec3c1b174',
		});
		expect(nodeLogRecordSchema.safeParse(record).success).toBe(true);
	});

	test('structured bodies become JSON; snake_case fields, enum names and observed time are accepted', () => {
		const result = mapOtlpLogsRequest(
			{
				resource_logs: [
					{
						scope_logs: [
							{
								log_records: [
									{
										observed_time_unix_nano: 1_544_712_660_000_000_000,
										severity_number: 'SEVERITY_NUMBER_WARN',
										body: { kvlistValue: { values: [{ key: 'msg', value: { stringValue: 'hi' } }, { key: 'n', value: { intValue: 3 } }] } },
										attributes: [{ key: 'request_id', value: { stringValue: 'req-42' } }],
									},
									{ severityText: 'ERROR', body: { arrayValue: { values: [{ boolValue: false }] } } },
									{},
									'not a record',
								],
							},
						],
					},
				],
			},
			{ now: () => NOW },
		);
		const [first, second, third] = result.groups[0]!.records;
		expect(first).toMatchObject({ ts: 1_544_712_660_000, severityNumber: 13, body: '{"msg":"hi","n":3}', requestId: 'req-42' });
		expect(second).toMatchObject({ ts: NOW, severityNumber: 17, body: '[false]' });
		expect(third).toMatchObject({ ts: NOW, severityNumber: 9, body: '' });
		expect(result.rejected).toBe(1);
	});

	test('the per-request cap rejects the rest', () => {
		const logRecords = Array.from({ length: 5 }, () => ({ body: { stringValue: 'x' } }));
		const result = mapOtlpLogsRequest({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] }, { maxRecords: 3 });
		expect(result.groups[0]!.records).toHaveLength(3);
		expect(result.rejected).toBe(2);
	});

	test('bodies and attributes are clipped to the contract', () => {
		const long = 'x'.repeat(20_000);
		const attributes = Array.from({ length: 200 }, (_, index) => ({ key: `k${index}`, value: { stringValue: long } }));
		const result = mapOtlpLogsRequest({
			resourceLogs: [
				{
					resource: { attributes: [{ key: 'service.name', value: { stringValue: long } }] },
					scopeLogs: [{ logRecords: [{ body: { stringValue: long }, attributes }] }],
				},
			],
		});
		const record = result.groups[0]!.records[0]!;
		expect(record.body.length).toBe(16_384);
		expect(Object.keys(record.attributes)).toHaveLength(128);
		expect(nodeLogRecordSchema.safeParse({ ...record, resource: result.groups[0]!.resource }).success).toBe(true);
	});
});

describe('field helpers', () => {
	test('ids: hex kept lower case, base64 converted, zeros dropped', () => {
		expect(otlpId('5B8EFFF798038103D269B633813FC60C', 16)).toBe('5b8efff798038103d269b633813fc60c');
		expect(otlpId(Buffer.from('5b8efff798038103d269b633813fc60c', 'hex').toString('base64'), 16)).toBe('5b8efff798038103d269b633813fc60c');
		expect(otlpId('00000000000000000000000000000000', 16)).toBeUndefined();
		expect(otlpId('eee19b7ec3c1b174', 16)).toBeUndefined();
		expect(otlpId('', 8)).toBeUndefined();
	});

	test('severity: number, enum name, text band, default', () => {
		expect(otlpSeverityNumber(21, 'x')).toBe(21);
		expect(otlpSeverityNumber('SEVERITY_NUMBER_DEBUG2', undefined)).toBe(6);
		expect(otlpSeverityNumber(0, 'warning')).toBe(13);
		expect(otlpSeverityNumber(undefined, 'nonsense')).toBe(9);
		expect(otlpSeverityNumber(99, undefined)).toBe(9);
	});

	test('nanoseconds', () => {
		expect(nanosToMs('1544712660300000000')).toBe(1_544_712_660_300);
		expect(nanosToMs('0')).toBeNull();
		expect(nanosToMs(undefined)).toBeNull();
	});
});

function workload(id: string, overrides: Record<string, unknown> = {}): WorkloadDesired {
	return desiredStateSchema.parse({
		version: 1,
		nodeId: 'nod_1',
		agentVersion: '0.1.0',
		generatedAt: '2026-11-25T00:00:00.000Z',
		contentDomain: 'example.com',
		releases: [],
		routes: [],
		workloads: [
			{
				id,
				projectId: 'prj_api',
				projectSlug: 'api',
				deploymentId: 'dep_1',
				runtime: 'process',
				status: 'running',
				release: 'a'.repeat(64),
				upstream: 'http://127.0.0.1:3000',
				memoryMb: 256,
				cpus: 1,
				port: 3000,
				healthPath: '/health',
				socketActivation: false,
				activationVersion: 'b'.repeat(64),
				env: {},
				...overrides,
			},
		],
	}).workloads[0]!;
}

describe('otlpWorkloadEnv', () => {
	const options = { secret: SECRET, port: 8085 };

	test('a process app gets the loopback endpoint, the logs endpoint and its service name', () => {
		const key = otlpIngestKey(SECRET, 'wl_api');
		expect(otlpWorkloadEnv(workload('wl_api'), {}, options)).toEqual({
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:8085/otlp/wl_api/${key}`,
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:8085/otlp/wl_api/${key}/v1/logs`,
			OTEL_SERVICE_NAME: 'api',
		});
		expect(key).toMatch(/^[0-9a-f]{32}$/);
	});

	test('a container reaches the host through host.containers.internal; each copy has its own key', () => {
		const env = otlpWorkloadEnv(workload('wl_api-r1', { runtime: 'container', image: 'ghcr.io/acme/api:1' }), {}, options);
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://host.containers.internal:8085/otlp/wl_api-r1/${otlpIngestKey(SECRET, 'wl_api-r1')}`);
		expect(otlpIngestKey(SECRET, 'wl_api-r1')).not.toBe(otlpIngestKey(SECRET, 'wl_api'));
	});

	test('never replaces what the app sets', () => {
		expect(otlpWorkloadEnv(workload('wl_api'), { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector:4318' }, options)).toEqual({ OTEL_SERVICE_NAME: 'api' });
		expect(otlpWorkloadEnv(workload('wl_api'), { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '' }, options)).toEqual({ OTEL_SERVICE_NAME: 'api' });
		expect(otlpWorkloadEnv(workload('wl_api'), { OTEL_SERVICE_NAME: 'mine' }, options)).not.toHaveProperty('OTEL_SERVICE_NAME');
		expect(otlpWorkloadEnv(workload('wl_api'), { OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=prod,service.name=mine' }, options)).not.toHaveProperty('OTEL_SERVICE_NAME');
	});

	test('a compose service\'s own endpoint counts as set (the stack env would override it)', () => {
		const stack = workload('wl_stack', {
			runtime: 'compose',
			compose: {
				services: [{ name: 'web', image: 'nginx', env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' } }],
				routes: [],
				volumes: [],
			},
		});
		expect(otlpWorkloadEnv(stack, {}, options)).toEqual({ OTEL_SERVICE_NAME: 'api' });
	});

	test('managed services and functions get nothing', () => {
		expect(otlpWorkloadEnv(workload('wl_fn', { runtime: 'function' }), {}, options)).toEqual({});
		expect(otlpWorkloadEnv(workload('db_1', { runtime: 'container', image: 'postgres', database: { engine: 'postgres', version: '18' } }), {}, options)).toEqual({});
	});
});

describe('OtlpLogsReceiver', () => {
	function harness(options: { enabled?: boolean } = {}) {
		const posted: NodeLogBatch[] = [];
		const batcher = new NodeLogBatcher({ post: async (batch) => void posted.push(batch) });
		const receiver = new OtlpLogsReceiver({
			batcher,
			secret: SECRET,
			workloadOnNode: (id) => id === 'wl_api' || id === 'wl_web',
			enabled: () => options.enabled ?? true,
			now: () => NOW,
		});
		return { posted, batcher, receiver };
	}

	const keyed = (id = 'wl_api', key = otlpIngestKey(SECRET, id), signal = 'logs') =>
		`http://127.0.0.1:8085/otlp/${id}/${key}/v1/${signal}`;

	function post(url: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): Request {
		return new Request(url, { method: 'POST', headers, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });
	}

	test('an authenticated request is mapped and batched for its workload', async () => {
		const { posted, batcher, receiver } = harness();
		const response = await receiver.handle(post(keyed(), SPEC_EXAMPLE));
		expect(response!.status).toBe(200);
		expect(await response!.json()).toEqual({});
		await batcher.flush();
		expect(posted).toHaveLength(1);
		expect(posted[0]!.target).toEqual({ kind: 'workload', workloadId: 'wl_api' });
		expect(posted[0]!.records[0]!.resource).toEqual({ 'service.name': 'my.service', 'yoal.workload.id': 'wl_api' });
	});

	test('the node stamps the workload; a resource naming another one is ignored', async () => {
		const { posted, batcher, receiver } = harness();
		const spoof = {
			resourceLogs: [
				{
					resource: { attributes: [{ key: 'yoal.workload.id', value: { stringValue: 'wl_web' } }] },
					scopeLogs: [{ logRecords: [{ body: { stringValue: 'x' } }] }],
				},
			],
		};
		await receiver.handle(post(keyed(), spoof));
		await batcher.flush();
		expect(posted[0]!.target).toEqual({ kind: 'workload', workloadId: 'wl_api' });
		expect(posted[0]!.records[0]!.resource['yoal.workload.id']).toBe('wl_api');
	});

	test('a wrong key, or a workload not on this node, is refused', async () => {
		const { receiver } = harness();
		expect((await receiver.handle(post(keyed('wl_api', otlpIngestKey(SECRET, 'wl_web')), SPEC_EXAMPLE)))!.status).toBe(401);
		expect((await receiver.handle(post(keyed('wl_gone'), SPEC_EXAMPLE)))!.status).toBe(401);
		expect(receiver.stats.unauthorized).toBe(2);
	});

	test('bare /v1/logs accepts nothing, whatever the resource claims', async () => {
		const { posted, batcher, receiver } = harness();
		const body = {
			resourceLogs: [
				{
					resource: { attributes: [{ key: 'service.instance.id', value: { stringValue: 'wl_web' } }] },
					scopeLogs: [{ logRecords: [{ body: { stringValue: 'claims wl_web' } }] }],
				},
				{
					resource: { attributes: [{ key: 'yoal.workload.id', value: { stringValue: 'wl_api' } }] },
					scopeLogs: [{ logRecords: [{ body: { stringValue: 'claims wl_api' } }] }],
				},
			],
		};
		const response = await receiver.handle(post('http://127.0.0.1:8085/v1/logs', body));
		expect(response!.status).toBe(401);
		expect(((await response!.json()) as { message: string }).message).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
		await batcher.flush();
		expect(posted).toEqual([]);
		expect(receiver.stats.unauthorized).toBe(1);
		expect(receiver.stats.records).toBe(0);
	});

	test('protobuf gets a clear 415; other media types too', async () => {
		const { receiver } = harness();
		const protobuf = await receiver.handle(post(keyed(), new Uint8Array([1, 2, 3]), { 'content-type': 'application/x-protobuf' }));
		expect(protobuf!.status).toBe(415);
		expect(((await protobuf!.json()) as { message: string }).message).toContain('http/json');
		expect((await receiver.handle(post(keyed(), 'x', { 'content-type': 'text/plain' })))!.status).toBe(415);
	});

	test('gzip bodies are accepted; malformed JSON is a 400', async () => {
		const { posted, batcher, receiver } = harness();
		const gz = gzipSync(Buffer.from(JSON.stringify(SPEC_EXAMPLE)));
		const response = await receiver.handle(post(keyed(), new Uint8Array(gz), { 'content-type': 'application/json', 'content-encoding': 'gzip' }));
		expect(response!.status).toBe(200);
		await batcher.flush();
		expect(posted).toHaveLength(1);
		expect((await receiver.handle(post(keyed(), '{not json')))!.status).toBe(400);
	});

	test('traces and metrics to the injected endpoint are accepted and discarded', async () => {
		const { posted, batcher, receiver } = harness();
		expect((await receiver.handle(post(keyed('wl_api', undefined, 'traces'), {})))!.status).toBe(200);
		expect((await receiver.handle(post('http://127.0.0.1:8085/v1/metrics', {})))!.status).toBe(404);
		await batcher.flush();
		expect(posted).toEqual([]);
		expect(receiver.stats.discarded).toBe(1);
	});

	test('other paths fall through; the kill switch answers 404; GET is 405', async () => {
		const on = harness().receiver;
		expect(await on.handle(post('http://127.0.0.1:8085/tail', {}))).toBeNull();
		expect((await on.handle(new Request(keyed())))!.status).toBe(405);
		const off = harness({ enabled: false }).receiver;
		expect((await off.handle(post(keyed(), SPEC_EXAMPLE)))!.status).toBe(404);
	});

	test('served on the analytics sink\'s loopback port next to /event', async () => {
		const { posted, batcher, receiver } = harness();
		const sink = startAnalyticsSink({ port: 0, record: () => undefined, otlp: receiver.handle });
		try {
			const logs = await fetch(`${sink.url}/otlp/wl_api/${otlpIngestKey(SECRET, 'wl_api')}/v1/logs`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(SPEC_EXAMPLE),
			});
			expect(logs.status).toBe(200);
			const event = await fetch(`${sink.url}/event`, { method: 'POST', body: '{}' });
			expect(event.status).toBe(400);
		} finally {
			sink.stop();
		}
		await batcher.flush();
		expect(posted).toHaveLength(1);
	});
});
