import { timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
	SEVERITY_NUMBER,
	severityForText,
	type NodeLogRecord,
	type WorkloadDesired,
} from '@yoal/contracts';
import { logsHmac, type NodeLogBatcher } from './log-records.ts';

/**
 * OTLP/HTTP logs receiver (docs/LOGS.md §5 "OTLP logs", LP7; DESIGN §8, D16).
 *
 * It is served on the agent's existing loopback listener (the function analytics/tail sink,
 * `127.0.0.1:8085`), JSON encoding only for now: protobuf gets a clear 415 until spike S4.
 *
 * Who is calling. The tail sink trusts the workload id its caller names. This receiver asks for a
 * little more: the agent injects an endpoint that names the workload *and* carries an ingest key,
 * `…/otlp/<workloadId>/<key>`, where the key is an HMAC of the workload id under a node-local
 * secret (`logs.key`). So an SDK posts to `…/otlp/<workloadId>/<key>/v1/logs`, and another
 * workload on the same node cannot write as this one without reading its environment. The id must
 * also be a workload in this node's desired state.
 *
 * Only the keyed path accepts records. A bare `POST /v1/logs` (an app that configured
 * `http://127.0.0.1:8085` itself) is refused with 401: a resource attribute can be set by any
 * workload on the node, so it never names who is calling. The control plane still resolves org and
 * project from the workload.
 *
 * Mapping (OTel logs data model → `NodeLogRecord`): time (event, else observed, else now) in ms;
 * `severityNumber` (or the band of `severityText`, else info); the body as text, structured bodies
 * as JSON; attributes and resource flattened with dots; `traceId`/`spanId` as lower-case hex (a
 * base64 id from a non-conformant exporter is converted); `requestId` from the usual attribute
 * names. Records go to the control plane with `target: { kind: 'workload', workloadId }`.
 */

export const OTLP_KEYED_PREFIX = '/otlp';
/** Compressed and decompressed body caps. SDK batches default to 512 records. */
export const OTLP_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const OTLP_MAX_DECODED_BYTES = 16 * 1024 * 1024;
/** Records accepted from one request; the rest are reported as rejected. */
export const OTLP_MAX_RECORDS_PER_REQUEST = 5_000;

const MAX_BODY_CHARS = 16_384;
const MAX_ATTRIBUTES = 128;
const MAX_KEY_CHARS = 256;
const MAX_ATTRIBUTE_VALUE_CHARS = 4_096;
const MAX_RESOURCE_VALUE_CHARS = 1_024;
const MAX_DEPTH = 8;
const WORKLOAD_ID = /^[A-Za-z0-9._-]{3,128}$/;
const KEYED_PATH = /^\/otlp\/([A-Za-z0-9._-]{3,128})\/([A-Za-z0-9_-]{16,128})\/v1\/(logs|traces|metrics)\/?$/;
const BARE_PATH = /^\/v1\/(logs|traces|metrics)\/?$/;

// --- ingest keys and workload env -------------------------------------------

/** The per-workload ingest key the endpoint path carries: 32 hex chars of an HMAC under `logs.key`. */
export function otlpIngestKey(secret: Buffer, workloadId: string): string {
	return logsHmac(secret, 'otlp-ingest', workloadId).slice(0, 32);
}

export function verifyOtlpIngestKey(secret: Buffer, workloadId: string, presented: string): boolean {
	const expected = Buffer.from(otlpIngestKey(secret, workloadId));
	const given = Buffer.from(presented);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Variables the agent may add; listed so tests and docs agree. */
export const OTLP_ENV = {
	endpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
	logsEndpoint: 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
	serviceName: 'OTEL_SERVICE_NAME',
	resourceAttributes: 'OTEL_RESOURCE_ATTRIBUTES',
} as const;

/** True for an app workload the receiver serves: a process, container or compose app. */
export function otlpEligible(workload: WorkloadDesired): boolean {
	if (workload.runtime === 'function') return false;
	return !(
		workload.database ||
		workload.objectStorage ||
		workload.broker ||
		workload.kubernetes ||
		workload.registry ||
		workload.cloudShell ||
		workload.runner
	);
}

/**
 * The OTEL_* variables to add to a workload's activation env (docs/LOGS.md LP7). `env` is what the
 * workload already gets (public env plus activation env); nothing in it is ever replaced:
 *
 * - The two endpoint variables are added only when the app sets neither, so an app that ships to
 *   its own collector keeps doing so for every signal.
 * - `OTEL_SERVICE_NAME` (the project slug) only when neither it nor a `service.name` in
 *   `OTEL_RESOURCE_ATTRIBUTES` is set.
 *
 * A process app reaches the loopback port directly; a container reaches it through
 * `host.containers.internal`, the same path the workload-identity endpoint uses.
 */
export function otlpWorkloadEnv(
	workload: WorkloadDesired,
	env: Readonly<Record<string, string>>,
	options: { secret: Buffer; port: number },
): Record<string, string> {
	if (!otlpEligible(workload) || !WORKLOAD_ID.test(workload.id)) return {};
	// A compose service's own env loses to the stack's activation env in the helper, so a name any
	// service sets counts as set.
	if (workload.compose) {
		const merged: Record<string, string> = {};
		for (const service of workload.compose.services) Object.assign(merged, service.env ?? {});
		env = { ...merged, ...env };
	}
	const added: Record<string, string> = {};
	if (!(OTLP_ENV.endpoint in env) && !(OTLP_ENV.logsEndpoint in env)) {
		const host = workload.runtime === 'process' ? '127.0.0.1' : 'host.containers.internal';
		const base = `http://${host}:${options.port}${OTLP_KEYED_PREFIX}/${workload.id}/${otlpIngestKey(options.secret, workload.id)}`;
		added[OTLP_ENV.endpoint] = base;
		added[OTLP_ENV.logsEndpoint] = `${base}/v1/logs`;
	}
	const resourceAttributes = env[OTLP_ENV.resourceAttributes] ?? '';
	const namesService = resourceAttributes.split(',').some((pair) => pair.trim().startsWith('service.name='));
	if (!(OTLP_ENV.serviceName in env) && !namesService && workload.projectSlug) added[OTLP_ENV.serviceName] = workload.projectSlug;
	return added;
}

// --- OTLP/JSON → NodeLogRecord ----------------------------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** protobuf JSON accepts both the lowerCamelCase and the original field name. */
function field(object: Json, camel: string, snake: string): unknown {
	return object[camel] !== undefined ? object[camel] : object[snake];
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** An OTLP `AnyValue` as a plain JavaScript value. */
export function anyValueToJs(value: unknown, depth = 0): unknown {
	if (!isObject(value) || depth > MAX_DEPTH) return null;
	const string = field(value, 'stringValue', 'string_value');
	if (typeof string === 'string') return string;
	const bool = field(value, 'boolValue', 'bool_value');
	if (typeof bool === 'boolean') return bool;
	const int = field(value, 'intValue', 'int_value');
	if (int !== undefined) {
		const number = typeof int === 'number' ? int : Number(int);
		// int64 travels as a string; keep the digits when a double would round them.
		return Number.isSafeInteger(number) ? number : typeof int === 'string' ? int : null;
	}
	const double = field(value, 'doubleValue', 'double_value');
	if (double !== undefined) {
		const number = typeof double === 'number' ? double : Number(double);
		return Number.isFinite(number) ? number : String(double);
	}
	const array = field(value, 'arrayValue', 'array_value');
	if (isObject(array)) return list(array.values).map((item) => anyValueToJs(item, depth + 1));
	const kvlist = field(value, 'kvlistValue', 'kvlist_value');
	if (isObject(kvlist)) {
		const object: Json = {};
		for (const entry of list(kvlist.values)) {
			if (isObject(entry) && typeof entry.key === 'string') object[entry.key] = anyValueToJs(entry.value, depth + 1);
		}
		return object;
	}
	const bytes = field(value, 'bytesValue', 'bytes_value');
	if (typeof bytes === 'string') return bytes;
	return null;
}

function scalarText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return '';
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

/**
 * Flatten `KeyValue[]` into dotted string keys: a nested kvlist becomes `a.b`, an array becomes its
 * JSON text. Keys and values are clipped to the contract's caps; past `MAX_ATTRIBUTES` the rest are
 * ignored.
 */
export function flattenAttributes(keyValues: unknown, maxValueChars = MAX_ATTRIBUTE_VALUE_CHARS): Record<string, string> {
	const out: Record<string, string> = {};
	let count = 0;
	const visit = (prefix: string, value: unknown, depth: number): void => {
		if (count >= MAX_ATTRIBUTES) return;
		if (isObject(value) && depth < MAX_DEPTH) {
			const entries = Object.entries(value);
			if (entries.length > 0 && !Array.isArray(value)) {
				for (const [key, child] of entries) visit(`${prefix}.${key}`, child, depth + 1);
				return;
			}
		}
		const key = prefix.slice(0, MAX_KEY_CHARS);
		if (!key) return;
		out[key] = scalarText(value).slice(0, maxValueChars);
		count += 1;
	};
	for (const entry of list(keyValues)) {
		if (!isObject(entry) || typeof entry.key !== 'string' || !entry.key) continue;
		visit(entry.key, anyValueToJs(entry.value), 0);
	}
	return out;
}

const SEVERITY_NAMES: Record<string, number> = {
	TRACE: 1, TRACE2: 2, TRACE3: 3, TRACE4: 4,
	DEBUG: 5, DEBUG2: 6, DEBUG3: 7, DEBUG4: 8,
	INFO: 9, INFO2: 10, INFO3: 11, INFO4: 12,
	WARN: 13, WARN2: 14, WARN3: 15, WARN4: 16,
	ERROR: 17, ERROR2: 18, ERROR3: 19, ERROR4: 20,
	FATAL: 21, FATAL2: 22, FATAL3: 23, FATAL4: 24,
};

/** `severityNumber` (an integer, or the enum name some exporters send), else the band of `severityText`, else info. */
export function otlpSeverityNumber(number: unknown, text: unknown): number {
	let value = typeof number === 'number' ? number : typeof number === 'string' && /^\d+$/.test(number) ? Number(number) : Number.NaN;
	if (Number.isNaN(value) && typeof number === 'string') value = SEVERITY_NAMES[number.replace(/^SEVERITY_NUMBER_/, '')] ?? Number.NaN;
	if (Number.isInteger(value) && value >= 1 && value <= 24) return value;
	const band = severityForText(typeof text === 'string' ? text : null);
	return band ? SEVERITY_NUMBER[band] : SEVERITY_NUMBER.info;
}

/** Unix nanoseconds (number or int64 string) → epoch ms; null when absent or zero. */
export function nanosToMs(value: unknown): number | null {
	if (typeof value === 'string' && /^\d{1,30}$/.test(value)) {
		const ms = Number(BigInt(value) / 1_000_000n);
		return ms > 0 ? ms : null;
	}
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value / 1_000_000);
	return null;
}

/**
 * OTLP/JSON ids are hex. Some exporters send the protobuf default (base64) instead; convert it.
 * All-zero ids mean "none".
 */
export function otlpId(value: unknown, bytes: 8 | 16): string | undefined {
	if (typeof value !== 'string' || !value) return undefined;
	let hex: string | null = null;
	if (new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) hex = value.toLowerCase();
	else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
		const decoded = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
		if (decoded.length === bytes) hex = decoded.toString('hex');
	}
	if (!hex || /^0+$/.test(hex)) return undefined;
	return hex;
}

const REQUEST_ID_ATTRIBUTES = [
	'request_id',
	'requestId',
	'req_id',
	'http.request_id',
	'x-request-id',
	'http.request.header.x-request-id',
];

function requestIdFrom(attributes: Record<string, string>): string | undefined {
	for (const key of REQUEST_ID_ATTRIBUTES) {
		let value = attributes[key];
		if (!value) continue;
		// Semantic conventions record header values as string arrays.
		if (value.startsWith('[')) {
			try {
				const parsed = JSON.parse(value) as unknown;
				value = Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : '';
			} catch {
				value = '';
			}
		}
		const trimmed = value.trim();
		if (trimmed && trimmed.length <= 128) return trimmed;
	}
	return undefined;
}

export interface OtlpResourceGroup {
	/** Flattened resource attributes, as sent. */
	resource: Record<string, string>;
	records: NodeLogRecord[];
}

export interface OtlpParseResult {
	groups: OtlpResourceGroup[];
	/** Records that could not be read (not an object) or were over the per-request cap. */
	rejected: number;
}

/** Map one `ExportLogsServiceRequest` (already JSON-parsed). Never throws. */
export function mapOtlpLogsRequest(
	payload: unknown,
	options: { now?: () => number; maxRecords?: number } = {},
): OtlpParseResult {
	const now = options.now ?? Date.now;
	const maxRecords = options.maxRecords ?? OTLP_MAX_RECORDS_PER_REQUEST;
	const groups: OtlpResourceGroup[] = [];
	let rejected = 0;
	let accepted = 0;
	if (!isObject(payload)) return { groups, rejected };
	for (const resourceLogs of list(field(payload, 'resourceLogs', 'resource_logs'))) {
		if (!isObject(resourceLogs)) continue;
		const resourceObject = resourceLogs.resource;
		const resource = flattenAttributes(isObject(resourceObject) ? resourceObject.attributes : undefined, MAX_RESOURCE_VALUE_CHARS);
		const records: NodeLogRecord[] = [];
		for (const scopeLogs of list(field(resourceLogs, 'scopeLogs', 'scope_logs'))) {
			if (!isObject(scopeLogs)) continue;
			const scope = isObject(scopeLogs.scope) ? scopeLogs.scope : null;
			for (const logRecord of list(field(scopeLogs, 'logRecords', 'log_records'))) {
				if (!isObject(logRecord)) {
					rejected += 1;
					continue;
				}
				if (accepted >= maxRecords) {
					rejected += 1;
					continue;
				}
				accepted += 1;
				records.push(mapLogRecord(logRecord, scope, now));
			}
		}
		groups.push({ resource, records });
	}
	return { groups, rejected };
}

function mapLogRecord(logRecord: Json, scope: Json | null, now: () => number): NodeLogRecord {
	const ts =
		nanosToMs(field(logRecord, 'timeUnixNano', 'time_unix_nano')) ??
		nanosToMs(field(logRecord, 'observedTimeUnixNano', 'observed_time_unix_nano')) ??
		now();
	const bodyValue = anyValueToJs(logRecord.body);
	const body = (typeof bodyValue === 'string' ? bodyValue : bodyValue === null ? '' : JSON.stringify(bodyValue)).slice(0, MAX_BODY_CHARS);
	const attributes = flattenAttributes(logRecord.attributes);
	const room = () => Object.keys(attributes).length < MAX_ATTRIBUTES;
	if (scope && typeof scope.name === 'string' && scope.name && room()) attributes['otel.scope.name'] = scope.name.slice(0, MAX_ATTRIBUTE_VALUE_CHARS);
	if (scope && typeof scope.version === 'string' && scope.version && room()) attributes['otel.scope.version'] = scope.version.slice(0, MAX_ATTRIBUTE_VALUE_CHARS);
	const eventName = field(logRecord, 'eventName', 'event_name');
	if (typeof eventName === 'string' && eventName && room()) attributes['event.name'] = eventName.slice(0, MAX_ATTRIBUTE_VALUE_CHARS);
	const traceId = otlpId(field(logRecord, 'traceId', 'trace_id'), 16);
	const spanId = otlpId(field(logRecord, 'spanId', 'span_id'), 8);
	const requestId = requestIdFrom(attributes);
	return {
		ts,
		source: 'otlp',
		severityNumber: otlpSeverityNumber(
			field(logRecord, 'severityNumber', 'severity_number'),
			field(logRecord, 'severityText', 'severity_text'),
		),
		body,
		attributes,
		resource: {},
		...(traceId ? { traceId } : {}),
		...(spanId ? { spanId } : {}),
		...(requestId ? { requestId } : {}),
	};
}

// --- HTTP handler -----------------------------------------------------------

export interface OtlpLogsReceiverOptions {
	batcher: NodeLogBatcher;
	secret: Buffer;
	/** True when the id is a workload in this node's desired state. */
	workloadOnNode: (workloadId: string) => boolean;
	/** The kill switch (`YOAL_FEATURE_OTLP_LOGS`); off answers 404 like any unknown path. */
	enabled?: () => boolean;
	now?: () => number;
}

export interface OtlpLogsReceiverStats {
	requests: number;
	records: number;
	rejected: number;
	unauthorized: number;
	discarded: number;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
	});
}

/**
 * The receiver. `handle(request)` answers OTLP paths and returns null for any other path, so the
 * sink falls through to its own routes.
 */
export class OtlpLogsReceiver {
	private readonly options: OtlpLogsReceiverOptions;
	private counters: OtlpLogsReceiverStats = { requests: 0, records: 0, rejected: 0, unauthorized: 0, discarded: 0 };

	constructor(options: OtlpLogsReceiverOptions) {
		this.options = options;
	}

	get stats(): OtlpLogsReceiverStats {
		return { ...this.counters };
	}

	readonly handle = async (request: Request): Promise<Response | null> => {
		const path = new URL(request.url).pathname;
		const keyed = KEYED_PATH.exec(path);
		const bare = keyed ? null : BARE_PATH.exec(path);
		if (!keyed && !bare) return null;
		if (this.options.enabled && !this.options.enabled()) return json({ error: 'not_found' }, 404);
		if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
		if (!keyed) {
			// The unkeyed path names no caller, so it accepts nothing (traces and metrics included).
			if (bare![1] !== 'logs') return json({ error: 'not_found' }, 404);
			this.counters.unauthorized += 1;
			return json(
				{ error: 'unauthorized', message: 'Send OTLP logs to the OTEL_EXPORTER_OTLP_ENDPOINT Yoal sets for this workload.' },
				401,
			);
		}

		const workloadId = keyed[1]!;
		if (!this.options.workloadOnNode(workloadId) || !verifyOtlpIngestKey(this.options.secret, workloadId, keyed[2]!)) {
			this.counters.unauthorized += 1;
			return json({ error: 'unauthorized', message: 'Unknown workload or ingest key for this node.' }, 401);
		}

		if (keyed[3] !== 'logs') {
			// The injected OTEL_EXPORTER_OTLP_ENDPOINT also points an SDK's traces and metrics here.
			// Before this receiver they failed against a collector that was never there; answering
			// 200 keeps that outcome without an export error in the app's own logs every interval.
			this.counters.discarded += 1;
			return json({}, 200);
		}

		const media = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
		if (media === 'application/x-protobuf' || media === 'application/protobuf') {
			return json(
				{
					error: 'unsupported_media_type',
					message: 'This node accepts OTLP/HTTP JSON only for now. Set OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json.',
				},
				415,
				{ accept: 'application/json' },
			);
		}
		if (media !== 'application/json') {
			return json({ error: 'unsupported_media_type', message: 'Send OTLP/HTTP JSON (application/json).' }, 415, { accept: 'application/json' });
		}

		const decoded = await readBody(request);
		if (!decoded.ok) return decoded.response;
		let payload: unknown;
		try {
			payload = JSON.parse(decoded.text);
		} catch {
			return json({ error: 'invalid_json' }, 400);
		}
		if (!isObject(payload)) return json({ error: 'invalid_request' }, 400);

		this.counters.requests += 1;
		const parsed = mapOtlpLogsRequest(payload, this.options.now ? { now: this.options.now } : {});
		const rejected = parsed.rejected;
		for (const group of parsed.groups) {
			// The node stamps the workload it authenticated; a resource attribute never names another.
			const resource = { ...group.resource, 'yoal.workload.id': workloadId };
			const records = group.records.map((record) => ({ ...record, resource }));
			this.options.batcher.add({ kind: 'workload', workloadId }, records);
			this.counters.records += records.length;
		}
		this.counters.rejected += rejected;
		if (rejected === 0) return json({}, 200);
		return json(
			{
				partialSuccess: {
					rejectedLogRecords: String(rejected),
					errorMessage: 'Malformed records, or more than the per-request limit, were rejected.',
				},
			},
			200,
		);
	};
}

type BodyResult = { ok: true; text: string } | { ok: false; response: Response };

async function readBody(request: Request): Promise<BodyResult> {
	const declared = Number(request.headers.get('content-length') ?? Number.NaN);
	if (Number.isFinite(declared) && declared > OTLP_MAX_BODY_BYTES) return { ok: false, response: json({ error: 'body_too_large' }, 413) };
	let bytes: Buffer;
	try {
		bytes = Buffer.from(await request.arrayBuffer());
	} catch {
		return { ok: false, response: json({ error: 'invalid_body' }, 400) };
	}
	if (bytes.length > OTLP_MAX_BODY_BYTES) return { ok: false, response: json({ error: 'body_too_large' }, 413) };
	const encoding = (request.headers.get('content-encoding') ?? '').trim().toLowerCase();
	if (encoding === 'gzip') {
		try {
			bytes = gunzipSync(bytes, { maxOutputLength: OTLP_MAX_DECODED_BYTES });
		} catch {
			return { ok: false, response: json({ error: 'invalid_body', message: 'gzip body could not be decoded within the size limit' }, 400) };
		}
	} else if (encoding && encoding !== 'identity') {
		return { ok: false, response: json({ error: 'unsupported_media_type', message: `Content-Encoding ${encoding} is not supported` }, 415) };
	}
	return { ok: true, text: bytes.toString('utf8') };
}
