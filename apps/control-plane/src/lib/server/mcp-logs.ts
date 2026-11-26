import * as z from 'zod';
import {
	formatLogScope,
	levelForSeverityNumber,
	logTimeRangeSchema,
	parseLogQuery,
	resolveLogTimeRange,
	type LogCompareInput,
	type LogCompareResult,
	type LogLevel,
	type LogRecord,
	type LogScopeKind,
	type LogScopeRef,
	type LogWhyInput,
	type LogWhyResult,
	type Principal
} from '@yoal/contracts';
import { CoreError, ValidationError } from '@yoal/core';
import { stripAnsi } from '../logs/ansi';
import { core } from './core';

/**
 * The MCP log tools (docs/LOGS.md §6, §11 L7; LOGS-WAVES lane M). Registration stays in `mcp.ts`
 * so the catalogue greps find every tool there; the logic is here. Every read goes through
 * `core.logExplorer`, so the tenancy boundary is the one REST, the CLI and the dashboard use:
 * a scope the caller cannot read is simply not resolvable, and these tools never write.
 */

// --- shared input pieces ----------------------------------------------------------------------

/** Scopes as an agent writes them: the `yoal logs` shorthand, by name or id. */
export const logScopesInput = z
	.array(z.string().min(1).max(200))
	.max(50)
	.default([])
	.describe(
		'Where to read. Each entry is a project slug (`api`), or `db:<name>`, `storage:<name>`, `broker:<name>`, `k8s:<name>`, ' +
			'`pipeline:<repo>`, `function:<project>`, `platform:<node>` (platform admins); an id works in place of a name. ' +
			'Empty means every scope you may read.'
	);

export const logInstantInput = z
	.union([z.number().int().nonnegative(), z.string().min(1).max(40)])
	.describe('Epoch milliseconds or an ISO 8601 time');

export const logWindowInput = {
	from: logInstantInput.optional(),
	to: logInstantInput.optional().describe('Epoch milliseconds or an ISO 8601 time; default now'),
	range: z
		.string()
		.regex(/^\d{1,4}(s|m|h|d|w)$/)
		.optional()
		.describe(
			'Relative window ending now, e.g. 15m, 1h, 24h, 7d (default 1h). Ignored when `from` is given.'
		)
};

export interface LogWindowArgs {
	from?: number | string;
	to?: number | string;
	range?: string;
}

/** Prefixes the scope shorthand accepts, as in `yoal logs`. */
const SCOPE_PREFIXES: Readonly<Record<string, LogScopeKind>> = {
	project: 'project',
	db: 'database',
	database: 'database',
	storage: 'storage',
	broker: 'broker',
	k8s: 'k8s',
	kubernetes: 'k8s',
	pipeline: 'pipeline',
	function: 'function',
	platform: 'platform',
	edge: 'edge'
};

const SHORT_PREFIX: Readonly<Record<LogScopeKind, string>> = {
	project: '',
	database: 'db:',
	storage: 'storage:',
	broker: 'broker:',
	k8s: 'k8s:',
	pipeline: 'pipeline:',
	function: 'function:',
	edge: 'edge:',
	platform: 'platform:'
};

/**
 * Resolve shorthand scopes against what the caller may read (`readableScopes` plus, for platform
 * admins, `platformScopes`). An entry that matches nothing is an error listing what the caller
 * can read of that kind, so an agent can correct itself; it never reveals another org's names.
 */
export function resolveLogScopes(principal: Principal, entries: readonly string[]): LogScopeRef[] {
	if (entries.length === 0) return [];
	const available = [
		...core.logExplorer.readableScopes(principal),
		...core.logExplorer.platformScopes(principal)
	];
	const out: LogScopeRef[] = [];
	const seen = new Set<string>();
	for (const raw of entries) {
		const text = raw.trim();
		const colon = text.indexOf(':');
		const kind = colon === -1 ? 'project' : SCOPE_PREFIXES[text.slice(0, colon).toLowerCase()];
		const ref = colon === -1 ? text : text.slice(colon + 1).trim();
		if (!kind || !ref)
			throw new ValidationError(
				`"${raw}" is not a scope. Use a project slug, or one of ${Object.keys(SCOPE_PREFIXES)
					.map((prefix) => `${prefix}:<name>`)
					.join(', ')}.`
			);
		const candidates = available.filter((entry) => entry.kind === kind);
		const match =
			candidates.find((entry) => entry.id === ref) ??
			candidates.find((entry) => entry.name === ref) ??
			candidates.find((entry) => entry.name.toLowerCase() === ref.toLowerCase());
		if (!match) {
			const names = [
				...new Set(
					candidates
						.filter((entry) => !('deleted' in entry) || !entry.deleted)
						.map((entry) => entry.name)
				)
			];
			throw new CoreError(
				'not_found',
				names.length > 0
					? `No ${kind} "${ref}" that you can read logs in. Readable: ${names
							.slice(0, 20)
							.map((name) => `${SHORT_PREFIX[kind]}${name}`)
							.join(', ')}${names.length > 20 ? ', …' : ''}.`
					: `No ${kind} "${ref}" that you can read logs in.`,
				404
			);
		}
		const key = formatLogScope(match);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ kind: match.kind, id: match.id });
	}
	return out;
}

function toMs(value: number | string, field: string): number {
	if (typeof value === 'number') return value;
	const parsed = /^\d{1,15}$/.test(value) ? Number(value) : Date.parse(value);
	if (!Number.isFinite(parsed))
		throw new ValidationError(`${field} must be epoch milliseconds or an ISO 8601 time.`);
	return parsed;
}

/** `from`/`to`/`range` → absolute bounds (default: the last hour). */
export function resolveLogWindow(
	args: LogWindowArgs,
	now: number,
	fallback = '1h'
): { from: number; to: number } {
	const to = args.to === undefined ? now : toMs(args.to, 'to');
	if (args.from !== undefined) {
		const from = toMs(args.from, 'from');
		return { from: Math.min(from, to), to: Math.max(from, to) };
	}
	const relative = logTimeRangeSchema.parse({ relative: args.range ?? fallback }) as {
		relative: string;
	};
	const span = resolveLogTimeRange(relative, now);
	return { from: to - (span.to - span.from), to };
}

/** True when the query text has pipe stages (they need `logs:query`). Unparseable text is false: the service reports it. */
export function queryHasPipes(q: unknown): boolean {
	if (typeof q !== 'string' || !q.includes('|')) return false;
	const parsed = parseLogQuery(q);
	return parsed.ok && parsed.ast.pipes.length > 0;
}

/**
 * Window for `explain_log_spike`: what the caller gave, else the hour before the selection to 30
 * minutes after it (never past now), so "the rest of the window" is a fair baseline.
 */
export function spikeWindow(
	args: LogWindowArgs,
	selection: { from: number; to: number },
	now: number
): { from: number; to: number } {
	if (args.from !== undefined || args.range !== undefined) return resolveLogWindow(args, now);
	const to =
		args.to === undefined
			? Math.max(selection.to, Math.min(now, selection.to + 1_800_000))
			: toMs(args.to, 'to');
	return { from: Math.min(selection.from - 3_600_000, to), to: Math.max(to, selection.to) };
}

/** A dashboard link that opens the Explorer on this query, scope and window (§7.2 URL state). */
export function explorerUrl(
	q: string,
	scopes: readonly LogScopeRef[],
	window: { from: number; to: number },
	options: { row?: string; mode?: 'patterns' | 'compare' } = {}
): string {
	const params = new URLSearchParams();
	if (q) params.set('q', q);
	for (const scope of scopes) params.append('scope', formatLogScope(scope));
	params.set('from', new Date(window.from).toISOString());
	params.set('to', new Date(window.to).toISOString());
	if (options.mode) params.set('mode', options.mode);
	if (options.row) params.set('row', options.row);
	return `${core.ctx.config.platformOrigin.replace(/\/$/, '')}/logs?${params}`;
}

const BODY_MAX = 2_000;

/**
 * A record as an agent sees it: the fields that answer questions, without empty ones, and the
 * body capped so one huge line cannot fill the context. `id` feeds `get_log_context`.
 */
export function compactLogRecord(record: LogRecord): Record<string, unknown> {
	const body = record.ansi ? stripAnsi(record.body) : record.body;
	const out: Record<string, unknown> = {
		id: record.id,
		time: new Date(record.ts).toISOString(),
		severity: record.severity,
		scope: `${SHORT_PREFIX[record.scope.kind] ?? `${record.scope.kind}:`}${record.scopeName ?? record.scope.id}`,
		source: record.source,
		body:
			body.length > BODY_MAX
				? `${body.slice(0, BODY_MAX)}… (${body.length} chars; get_log_context shows it whole)`
				: body
	};
	if (record.stream) out.stream = record.stream;
	if (record.channel && record.channel !== 'stdout') out.channel = record.channel;
	if (record.deploymentId) out.deploymentId = record.deploymentId;
	if (record.nodeId) out.nodeId = record.nodeId;
	if (record.replica !== null && record.replica !== undefined) out.replica = record.replica;
	if (record.requestId) out.requestId = record.requestId;
	if (record.traceId) out.traceId = record.traceId;
	if (record.patternId) out.patternId = record.patternId;
	if (Object.keys(record.attributes ?? {}).length > 0) out.attributes = record.attributes;
	return out;
}

// --- Compare and Why? (Lane A) ---------------------------------------------------------------

/**
 * `compare` and `why` land on `LogExplorerService` with Lane A (docs/LOGS.md §8.2–§8.3). Read
 * through this narrow accessor so the tools compile and fail clearly until then.
 */
interface LogAnalysis {
	compare?: (principal: Principal, input: LogCompareInput) => Promise<LogCompareResult>;
	why?: (principal: Principal, input: LogWhyInput) => Promise<LogWhyResult>;
}

export function logAnalysis<K extends keyof LogAnalysis>(name: K): NonNullable<LogAnalysis[K]> {
	const service = core.logExplorer as unknown as LogAnalysis;
	const method = service[name];
	if (typeof method !== 'function')
		throw new CoreError(
			'not_available',
			`Log ${name === 'why' ? 'Why?' : 'Compare'} is not available on this control plane yet.`,
			501
		);
	return method.bind(core.logExplorer) as NonNullable<LogAnalysis[K]>;
}

/** `previous`, a shift such as `1d`/`7d`, `deploy:<id>` or `<from>..<to>` → the contract's baseline. */
export function parseLogBaseline(text: string, now: number): LogCompareInput['baseline'] {
	const value = text.trim();
	if (value === 'previous') return { kind: 'previous' };
	const shift = /^(\d{1,4})(m|h|d|w)$/.exec(value);
	if (shift) {
		const relative = resolveLogTimeRange({ relative: value }, now);
		return { kind: 'offset', offsetMs: relative.to - relative.from };
	}
	if (value.startsWith('deploy:') && value.length > 'deploy:'.length)
		return { kind: 'deploy', deploymentId: value.slice('deploy:'.length) };
	const range = /^(.+)\.\.(.+)$/.exec(value);
	if (range) {
		const from = toMs(range[1]!, 'baseline');
		const to = toMs(range[2]!, 'baseline');
		return { kind: 'range', from: Math.min(from, to), to: Math.max(from, to) };
	}
	throw new ValidationError(
		'baseline must be previous, a shift such as 1d or 7d, deploy:<deployment id>, or <from>..<to>.'
	);
}

// --- the per-resource tools, as thin wrappers ------------------------------------------------

export interface LegacyLogTarget {
	kind: 'project' | 'database' | 'storage' | 'broker';
	id: string;
}

export interface LegacyLogInput {
	after?: number;
	limit?: number;
	level?: LogLevel;
	q?: string;
	source?: 'runtime' | 'build';
	buildId?: string;
	deploymentId?: string;
}

/** The SQLite table whose `seq` a legacy `after` cursor counts (log-store/sqlite-sources.ts). */
const LEGACY_TAG: Readonly<Record<LegacyLogTarget['kind'], string>> = {
	project: 'le',
	database: 'sle',
	storage: 'sle',
	broker: 'ble'
};

const LEGACY_DEFAULT_LIMIT = 200;
/** Legacy reads had no time window; this one covers any retention a platform policy allows. */
const LEGACY_WINDOW_MS = 400 * 86_400_000;

function phrase(text: string): string {
	return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The legacy filters written as a log query, so `get_logs({ level: 'warn', q: 'timeout' })` reads
 * exactly what `query_logs({ q: 'level:warn "timeout"' })` does. Project reads leave job output
 * out (it is read per run), and a build read keeps that build's lifecycle lines.
 */
export function legacyLogQuery(target: LegacyLogTarget, input: LegacyLogInput): string {
	const parts: string[] = [];
	if (target.kind === 'project') {
		parts.push('-job:*');
		if (input.buildId) parts.push(`build:${phrase(input.buildId)}`);
		if (input.source && !(input.source === 'build' && input.buildId))
			parts.push(`source:${input.source}`);
		if (input.deploymentId) parts.push(`deployment:${phrase(input.deploymentId)}`);
	}
	if (input.level) parts.push(`level:${input.level}`);
	const q = input.q?.trim();
	if (q) parts.push(phrase(q.slice(0, 200)));
	return parts.join(' ');
}

function legacySeq(id: string, tag: string): number | null {
	const match = /^([a-z]+):(\d+)$/.exec(id);
	return match && match[1] === tag ? Number(match[2]) : null;
}

/**
 * `get_logs`, `get_database_logs`, `get_storage_logs` and `get_broker_logs` keep their params and
 * answer shape (`events`, `cursor`, `hasMore`) but read through the Explorer. `after` is still the
 * legacy table's seq: the newest page comes back oldest first, and a tail call reads forward from
 * the record that cursor names.
 */
export async function legacyLogRead(
	principal: Principal,
	target: LegacyLogTarget,
	input: LegacyLogInput
) {
	const tag = LEGACY_TAG[target.kind];
	const limit = Math.max(1, Math.min(Math.floor(input.limit ?? LEGACY_DEFAULT_LIMIT), 1_000));
	const q = legacyLogQuery(target, input);
	const scopes: LogScopeRef[] = [{ kind: target.kind, id: target.id }];
	const now = core.ctx.now();
	let records: LogRecord[];
	let hasMore: boolean;
	if (input.after === undefined) {
		const page = await core.logExplorer.search(principal, {
			q,
			scopes,
			from: now - LEGACY_WINDOW_MS,
			to: now,
			limit,
			order: 'desc'
		});
		records = page.records.filter((record) => legacySeq(record.id, tag) !== null).reverse();
		hasMore = page.cursor.older !== null;
	} else {
		const anchor = await core.logExplorer.get(principal, `${tag}:${input.after}`);
		const from = anchor ? anchor.ts : now - LEGACY_WINDOW_MS;
		// Lines sharing the anchor's millisecond come back too; read a little extra and drop them.
		const page = await core.logExplorer.search(principal, {
			q,
			scopes,
			from,
			to: now,
			limit: Math.min(1_000, limit + 50),
			order: 'asc'
		});
		const after = input.after;
		const fresh = page.records.filter((record) => (legacySeq(record.id, tag) ?? -1) > after);
		records = fresh.slice(0, limit);
		hasMore =
			fresh.length > limit ||
			(page.cursor.newer !== null && page.records.length >= Math.min(1_000, limit + 50));
	}
	const cursor = records.reduce(
		(max, record) => Math.max(max, legacySeq(record.id, tag) ?? 0),
		input.after ?? 0
	);
	const events = records.map((record) => {
		const base = {
			seq: legacySeq(record.id, tag)!,
			ts: record.ts,
			source: record.source,
			stream: record.channel ?? 'stdout',
			level: levelForSeverityNumber(record.severityNumber),
			message: record.ansi ? stripAnsi(record.body) : record.body
		};
		return target.kind === 'project'
			? {
					...base,
					projectId: target.id,
					deploymentId: record.deploymentId,
					buildId: record.buildId
				}
			: { ...base, kind: target.kind, serviceId: target.id };
	});
	return { events, cursor, hasMore, query: q };
}
