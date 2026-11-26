import { SEVERITY_NUMBER, severityForNumber, severityForText, type LogRecord, type LogSeverity } from '@yoal/contracts';

/**
 * Index-time enrichment (docs/LOGS.md §4.3, LP2). Pure: the indexer runs it on every record it
 * copies into ClickHouse, and tests run it without a server.
 *
 * In index order: a JSON-object or logfmt body becomes attributes (§4.3.2), its message key becomes
 * the body, a declared level sets the severity (§4.3.3), and trace, span and request ids are lifted
 * out of the attributes (§4.3.4). Multiline joining happens on the node and redaction at ingest, so
 * neither is done here. Event time is never changed: the SQLite row and its ClickHouse copy must
 * share `ts`, or context and cursors would disagree between engines.
 */

/** At most this many attributes come out of one body (§4.3.2). */
export const ENRICH_MAX_ATTRIBUTES = 64;
/** Each attribute value is cut to this many characters. */
export const ENRICH_MAX_VALUE = 4_096;
/** Deeper objects are kept as JSON text under their parent key. */
const MAX_DEPTH = 6;
/** Bodies larger than this are not parsed (the line cap is 16 KiB; this is a safety bound). */
const MAX_PARSE_CHARS = 65_536;
/** logfmt needs at least this many `k=v` pairs to count (§4.3.2). */
const MIN_LOGFMT_PAIRS = 2;

const MESSAGE_KEYS = ['msg', 'message', 'event', 'error'] as const;
const LEVEL_KEYS = ['level', 'severity', 'lvl', 'log.level'] as const;
const TRACE_KEYS = ['traceid', 'trace_id', 'dd.trace_id', 'trace.id'];
const SPAN_KEYS = ['spanid', 'span_id', 'dd.span_id', 'span.id'];
const REQUEST_KEYS = ['request_id', 'requestid', 'req_id', 'x-request-id', 'x_request_id', 'http.request_id', 'request.id'];

export interface EnrichOptions {
	/**
	 * The line as stored, when the record's `body` was already cleaned on the way out (the SQLite
	 * adapters replace a JSON line with its message). Parsing reads this so attributes are not lost.
	 */
	rawBody?: string;
}

/**
 * Enrich one record. Returns a new record; the input is not changed. Attributes the source
 * already set (pipeline step, OTLP attributes, edge fields) win over parsed ones.
 */
export function enrichRecord(record: LogRecord, options: EnrichOptions = {}): LogRecord {
	const raw = options.rawBody ?? record.body;
	const parsed = parseStructuredBody(raw);
	const attributes: Record<string, string> = { ...record.attributes };
	let body = record.body;
	if (parsed) {
		let added = Object.keys(attributes).length;
		for (const [key, value] of parsed.attributes) {
			if (key in attributes) continue;
			if (added >= ENRICH_MAX_ATTRIBUTES) break;
			attributes[key] = value;
			added += 1;
		}
		const message = firstPresent(parsed.attributes, MESSAGE_KEYS);
		// The message key wins; otherwise the original text stays the body (§4.3.2).
		body = message !== undefined ? message : raw;
	}

	let severityNumber = record.severityNumber;
	const declared = declaredSeverity(attributes);
	if (declared !== null) severityNumber = declared;

	const lower = lowerKeyIndex(attributes);
	let traceId = record.traceId;
	let spanId = record.spanId;
	const traceparent = lower.get('traceparent');
	if (traceparent) {
		const match = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(traceparent.trim());
		if (match) {
			traceId ??= match[1]!.toLowerCase();
			spanId ??= match[2]!.toLowerCase();
		}
	}
	traceId ??= normalizeId(firstLower(lower, TRACE_KEYS), true);
	spanId ??= normalizeId(firstLower(lower, SPAN_KEYS), true);
	const requestId = record.requestId ?? normalizeId(firstLower(lower, REQUEST_KEYS), false);

	return {
		...record,
		body,
		severityNumber,
		severity: severityForNumber(severityNumber),
		attributes,
		traceId,
		spanId,
		requestId,
	};
}

export interface StructuredBody {
	format: 'json' | 'logfmt';
	attributes: Map<string, string>;
}

/** A body parsed into flattened attributes, or null when it is neither JSON nor logfmt. */
export function parseStructuredBody(text: string): StructuredBody | null {
	if (!text || text.length > MAX_PARSE_CHARS) return null;
	const trimmed = text.trim();
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			return null;
		}
		if (!isRecord(value)) return null;
		const attributes = new Map<string, string>();
		flatten(value, '', 0, attributes);
		return { format: 'json', attributes };
	}
	const pairs = parseLogfmtPairs(trimmed);
	if (!pairs || pairs.size < MIN_LOGFMT_PAIRS) return null;
	return { format: 'logfmt', attributes: pairs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(value: string): string {
	return value.length > ENRICH_MAX_VALUE ? value.slice(0, ENRICH_MAX_VALUE) : value;
}

/** `{ http: { status: 500 } }` → `http.status = "500"`. Arrays and deep objects stay JSON text. */
function flatten(value: Record<string, unknown>, prefix: string, depth: number, out: Map<string, string>): void {
	for (const [key, entry] of Object.entries(value)) {
		if (out.size >= ENRICH_MAX_ATTRIBUTES) return;
		if (!key) continue;
		const name = prefix ? `${prefix}.${key}` : key;
		if (entry === null || entry === undefined) continue;
		if (isRecord(entry) && depth + 1 < MAX_DEPTH) {
			flatten(entry, name, depth + 1, out);
			continue;
		}
		const text = typeof entry === 'string' ? entry : JSON.stringify(entry);
		if (text === undefined) continue;
		out.set(name, clip(text));
	}
}

/**
 * Quote-aware logfmt: `key=value key="quoted value"`. The whole line must be pairs, as in
 * `parseLogLine`, so prose with one `=` in it is never read as fields.
 */
function parseLogfmtPairs(line: string): Map<string, string> | null {
	const fields = new Map<string, string>();
	let index = 0;
	const length = line.length;
	while (index < length) {
		while (index < length && (line[index] === ' ' || line[index] === '\t')) index++;
		if (index >= length) break;
		const keyStart = index;
		while (index < length && line[index] !== '=' && line[index] !== ' ' && line[index] !== '\t') {
			if (line[index] === '"') return null;
			index++;
		}
		const key = line.slice(keyStart, index);
		if (!key || line[index] !== '=' || !/^[A-Za-z_@][\w.@-]*$/.test(key)) return null;
		index++;
		let value = '';
		if (line[index] === '"') {
			index++;
			let closed = false;
			while (index < length) {
				const char = line[index++]!;
				if (char === '"') {
					closed = true;
					break;
				}
				if (char === '\\' && index < length) {
					const escape = line[index++]!;
					value += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape;
					continue;
				}
				value += char;
			}
			if (!closed) return null;
			if (index < length && line[index] !== ' ' && line[index] !== '\t') return null;
		} else {
			const valueStart = index;
			while (index < length && line[index] !== ' ' && line[index] !== '\t') index++;
			value = line.slice(valueStart, index);
		}
		if (fields.size < ENRICH_MAX_ATTRIBUTES) fields.set(key, clip(value));
	}
	return fields;
}

function firstPresent(attributes: Map<string, string>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = attributes.get(key);
		if (value !== undefined && value.trim() !== '') return value;
	}
	return undefined;
}

function lowerKeyIndex(attributes: Record<string, string>): Map<string, string> {
	const index = new Map<string, string>();
	for (const [key, value] of Object.entries(attributes)) {
		const lower = key.toLowerCase();
		if (!index.has(lower)) index.set(lower, value);
	}
	return index;
}

function firstLower(index: Map<string, string>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = index.get(key);
		if (value !== undefined && value.trim() !== '') return value;
	}
	return undefined;
}

/** Ids are trimmed and capped; trace and span ids are hex, so they are lower-cased. */
function normalizeId(value: string | undefined, hex: boolean): string | null {
	if (value === undefined) return null;
	const trimmed = value.trim().slice(0, 128);
	if (!trimmed) return null;
	return hex && /^[0-9a-f]+$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/**
 * A level the line declares (§4.3.3): `level`, `severity`, `lvl` or `log.level`, as a word, a pino
 * number (10–60) or an OTel severity number (1–24). Null when nothing usable is declared.
 */
function declaredSeverity(attributes: Record<string, string>): number | null {
	for (const key of LEVEL_KEYS) {
		const value = attributes[key];
		if (value === undefined) continue;
		const word = severityForText(value.replace(/^\[|\]$/g, ''));
		if (word) return SEVERITY_NUMBER[word as LogSeverity];
		if (/^\d{1,2}$/.test(value.trim())) {
			const n = Number(value.trim());
			if (n >= 10 && n <= 60 && n % 10 === 0) return pinoSeverity(n);
			if (key === 'severity' && n >= 1 && n <= 24) return n;
		}
	}
	return null;
}

function pinoSeverity(n: number): number {
	if (n <= 10) return SEVERITY_NUMBER.trace;
	if (n <= 20) return SEVERITY_NUMBER.debug;
	if (n <= 30) return SEVERITY_NUMBER.info;
	if (n <= 40) return SEVERITY_NUMBER.warn;
	if (n <= 50) return SEVERITY_NUMBER.error;
	return SEVERITY_NUMBER.fatal;
}
