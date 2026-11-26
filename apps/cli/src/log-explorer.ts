/**
 * `yoal logs` on the unified Logs Explorer API (docs/LOGS.md §6, §11 L1/L7). The pure parts live
 * here so they can be tested without a server: scope shorthand, times, compare baselines, and the
 * terminal rendering. The command itself is `commands/logs.ts`.
 *
 * The CLI ships without `@yoal/contracts` as a dependency, so the response shapes below mirror
 * `packages/contracts/src/log-record.ts`, kept to the fields the CLI prints. The query grammar is
 * the one exception: `commands/logs.ts` imports the real parser so a typo fails before any request.
 */
import { UsageError } from './errors.ts';
import { renderTable } from './output.ts';

// --- mirrored shapes ------------------------------------------------------------------------

export const LOG_SCOPE_KINDS = [
	'project',
	'database',
	'storage',
	'broker',
	'k8s',
	'pipeline',
	'function',
	'edge',
	'platform',
] as const;
export type LogScopeKindView = (typeof LOG_SCOPE_KINDS)[number];

export interface LogScopeRefView {
	kind: LogScopeKindView;
	id: string;
}

export interface LogScopeEntryView extends LogScopeRefView {
	name: string;
	parent?: string | null;
}

export type LogSeverityView = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogRecordView {
	id: string;
	ts: number;
	scope: LogScopeRefView;
	scopeName: string | null;
	stream: string | null;
	source: string;
	channel?: string | null;
	severity: LogSeverityView;
	body: string;
	ansi?: boolean;
	attributes?: Record<string, string>;
	requestId?: string | null;
	traceId?: string | null;
}

export interface LogWarningView {
	code: string;
	message: string;
}

export interface LogSearchResultView {
	records: LogRecordView[];
	cursor: { older: string | null; newer: string | null };
	engine: string;
	warnings: LogWarningView[];
}

export interface LogTableResultView {
	columns: Array<{ name: string; type: 'string' | 'number' | 'time' }>;
	rows: Array<Array<string | number | null>>;
	sampleIds?: Array<string | null>;
	engine: string;
	warnings: LogWarningView[];
}

export interface LogContextResultView {
	anchor: LogRecordView | null;
	before: LogRecordView[];
	after: LogRecordView[];
	engine: string;
}

export interface LogCompareRowView {
	patternId: string;
	template: string;
	current: number;
	baseline: number;
	change: 'new' | 'gone' | 'rising' | 'falling' | 'steady';
	ratio: number | null;
	sampleId: string | null;
}

export interface LogCompareResultView {
	current: { from: number; to: number; total: number };
	baseline: { from: number; to: number; total: number };
	rows: LogCompareRowView[];
	engine: string;
	warnings: LogWarningView[];
}

/** `logCompareInputSchema.baseline` in @yoal/contracts. */
export type LogBaseline =
	| { kind: 'previous' }
	| { kind: 'offset'; offsetMs: number }
	| { kind: 'deploy'; deploymentId: string }
	| { kind: 'range'; from: number; to: number };

// --- scope shorthand ------------------------------------------------------------------------

/**
 * Prefixes `yoal logs` accepts before a colon. A bare word is a project slug, so `yoal logs api`
 * reads project `api`; `project:` is there for a slug that clashes with a subcommand.
 */
export const SCOPE_PREFIXES: Readonly<Record<string, LogScopeKindView>> = {
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
	edge: 'edge',
};

/** The short form `yoal logs` prints and accepts for a kind. */
const SHORT_PREFIX: Readonly<Record<LogScopeKindView, string>> = {
	project: '',
	database: 'db:',
	storage: 'storage:',
	broker: 'broker:',
	k8s: 'k8s:',
	pipeline: 'pipeline:',
	function: 'function:',
	edge: 'edge:',
	platform: 'platform:',
};

export interface ScopeArg {
	kind: LogScopeKindView;
	/** A name (slug, database name, node name…) or an id. */
	ref: string;
	/** As typed, for messages. */
	text: string;
}

/** `api` → project api; `db:main` → database main; `platform:edge-a` → the node's platform scope. */
export function parseScopeArg(text: string): ScopeArg {
	const value = text.trim();
	if (!value) throw new UsageError('An empty scope; name a project, or e.g. db:<name>.');
	const colon = value.indexOf(':');
	if (colon === -1) return { kind: 'project', ref: value, text: value };
	const prefix = value.slice(0, colon).toLowerCase();
	const ref = value.slice(colon + 1).trim();
	const kind = SCOPE_PREFIXES[prefix];
	if (!kind)
		throw new UsageError(
			`Unknown scope kind "${prefix}" in "${value}". Use a project slug, or one of ${Object.keys(SCOPE_PREFIXES)
				.map((name) => `${name}:`)
				.join(', ')}.`,
		);
	if (!ref) throw new UsageError(`"${value}" names no ${kind}; e.g. ${SHORT_PREFIX[kind] || 'project:'}<name>.`);
	return { kind, ref, text: value };
}

/**
 * Map typed scopes onto the ids the API takes, from the scope list `GET /api/v1/logs/capabilities`
 * returns (only scopes the caller may read). A name the list lacks is an error naming what the
 * caller can read instead, never a silent "everything".
 */
export function resolveScopeArgs(args: readonly ScopeArg[], available: readonly LogScopeEntryView[]): LogScopeRefView[] {
	const out: LogScopeRefView[] = [];
	const seen = new Set<string>();
	for (const arg of args) {
		const candidates = available.filter((entry) => entry.kind === arg.kind);
		const match =
			candidates.find((entry) => entry.id === arg.ref) ??
			candidates.find((entry) => entry.name === arg.ref) ??
			candidates.find((entry) => entry.name.toLowerCase() === arg.ref.toLowerCase());
		if (!match) {
			const names = [...new Set(candidates.map((entry) => entry.name))].slice(0, 12);
			const label = arg.kind === 'database' ? 'database' : arg.kind === 'k8s' ? 'Kubernetes cluster' : arg.kind;
			throw new UsageError(
				names.length > 0
					? `No ${label} "${arg.ref}" that you can read logs in. Yours: ${names.map((name) => `${SHORT_PREFIX[arg.kind]}${name}`).join(', ')}${candidates.length > names.length ? ', …' : ''}.`
					: `No ${label} "${arg.ref}" that you can read logs in.`,
			);
		}
		const key = `${match.kind}:${match.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ kind: match.kind, id: match.id });
	}
	return out;
}

// --- time -----------------------------------------------------------------------------------

const UNIT_MS: Readonly<Record<string, number>> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
};

/** `15m`, `1h`, `7d` → milliseconds; null for anything else. */
export function parseDuration(value: string): number | null {
	const match = /^(\d{1,6})(ms|s|m|h|d|w)$/.exec(value.trim());
	if (!match) return null;
	const ms = Number(match[1]) * UNIT_MS[match[2]!]!;
	return ms > 0 ? ms : null;
}

/** `--since` / `--until`: a duration back from now, epoch ms, or an ISO 8601 time. */
export function parseTimeArg(value: string, now: number, flag: string): number {
	const text = value.trim();
	if (text === 'now') return now;
	const duration = parseDuration(text);
	if (duration !== null) return now - duration;
	if (/^\d{10,15}$/.test(text)) return Number(text);
	const parsed = Date.parse(text);
	if (!Number.isNaN(parsed)) return parsed;
	throw new UsageError(`${flag} takes a duration (15m, 1h, 7d), "now", epoch ms or an ISO time; got "${value}".`);
}

/** `--baseline`: previous | <duration> (shift back) | deploy:<id> | <from>..<to>. */
export function parseBaseline(value: string, now: number): LogBaseline {
	const text = value.trim();
	if (text === 'previous' || text === 'prev') return { kind: 'previous' };
	const offset = parseDuration(text);
	if (offset !== null) return { kind: 'offset', offsetMs: offset };
	if (text.startsWith('deploy:')) {
		const deploymentId = text.slice('deploy:'.length).trim();
		if (!deploymentId) throw new UsageError('--baseline deploy: needs a deployment id, e.g. deploy:dep_123.');
		return { kind: 'deploy', deploymentId };
	}
	const range = /^(.+)\.\.(.+)$/.exec(text);
	if (range) {
		const from = parseTimeArg(range[1]!, now, '--baseline');
		const to = parseTimeArg(range[2]!, now, '--baseline');
		return { kind: 'range', from: Math.min(from, to), to: Math.max(from, to) };
	}
	throw new UsageError(
		`--baseline takes previous, a shift such as 1d or 7d, deploy:<deployment id>, or <from>..<to>; got "${value}".`,
	);
}

// --- rendering ------------------------------------------------------------------------------

const SEVERITY_SHORT: Readonly<Record<LogSeverityView, string>> = {
	trace: 'TRC',
	debug: 'DBG',
	info: 'INF',
	warn: 'WRN',
	error: 'ERR',
	fatal: 'FTL',
};

/** SGR codes per severity (docs/LOGS.md §7.2 "severity colouring"). */
const SEVERITY_SGR: Readonly<Record<LogSeverityView, string>> = {
	trace: '2',
	debug: '2',
	info: '36',
	warn: '33',
	error: '31',
	fatal: '1;31',
};

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

/** Colour when stdout is a terminal, unless `NO_COLOR` is set or `--no-color` was given. */
export function wantColor(flag: boolean | undefined, stream: { isTTY?: boolean } = process.stdout): boolean {
	if (flag === false) return false;
	if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
	return flag === true || Boolean(stream.isTTY);
}

function paint(text: string, sgr: string, color: boolean): string {
	return color ? `\x1b[${sgr}m${text}\x1b[0m` : text;
}

/** `2026-11-26 14:02:11.204`, UTC. */
export function formatLogTime(ts: number): string {
	return new Date(ts).toISOString().replace('T', ' ').slice(0, 23);
}

/** How a record's scope prints: a project by slug, the rest with their shorthand prefix. */
export function scopeLabel(record: Pick<LogRecordView, 'scope' | 'scopeName'>): string {
	return `${SHORT_PREFIX[record.scope.kind] ?? `${record.scope.kind}:`}${record.scopeName ?? record.scope.id}`;
}

export interface LineOptions {
	color: boolean;
	/** Print the scope column (off when exactly one scope was asked for). */
	scope: boolean;
	/** Mark this line (context anchor). */
	marker?: string;
}

/** One record as a terminal line; continuation lines of a multi-line body are indented. */
export function formatRecordLine(record: LogRecordView, options: LineOptions): string {
	const severity = SEVERITY_SHORT[record.severity] ?? record.severity.slice(0, 3).toUpperCase();
	const head = [
		paint(formatLogTime(record.ts), '2', options.color),
		paint(severity, SEVERITY_SGR[record.severity] ?? '0', options.color),
		...(options.scope ? [paint(scopeLabel(record), '35', options.color)] : []),
	].join(' ');
	const body = options.color && record.ansi ? record.body : stripAnsi(record.body);
	const [first = '', ...rest] = body.replace(/\r\n?/g, '\n').split('\n');
	const prefix = options.marker ?? '';
	const lines = [`${prefix}${head}  ${first}`];
	const pad = ' '.repeat(Math.min(prefix.length + 30, 40));
	for (const line of rest) lines.push(`${pad}${line}`);
	return lines.join('\n');
}

/** Pipe-stage results (`| stats`, `| patterns`…) as an aligned table. Time columns print as UTC. */
export function renderLogTable(result: LogTableResultView): string {
	if (result.rows.length === 0) return 'No rows.';
	const headers = result.columns.map((column) => column.name);
	const rows = result.rows.map((row) =>
		row.map((cell, index) => {
			if (cell === null || cell === undefined) return '-';
			if (result.columns[index]?.type === 'time' && typeof cell === 'number') return formatLogTime(cell);
			return String(cell).replace(/\s+/g, ' ');
		}),
	);
	return renderTable(headers, rows);
}

const CHANGE_ORDER: ReadonlyArray<LogCompareRowView['change']> = ['new', 'rising', 'falling', 'gone', 'steady'];

/** Compare (§8.2): new, rising, falling and gone groups; steady ones only with `all`. */
export function renderCompare(result: LogCompareResultView, options: { color: boolean; all: boolean }): string {
	const window = (side: { from: number; to: number; total: number }) =>
		`${formatLogTime(side.from)} → ${formatLogTime(side.to)} (${side.total.toLocaleString('en-US')} lines)`;
	const out = [`Current   ${window(result.current)}`, `Baseline  ${window(result.baseline)}`];
	const tones: Record<LogCompareRowView['change'], string> = {
		new: '31',
		rising: '33',
		falling: '32',
		gone: '2',
		steady: '0',
	};
	let shown = 0;
	for (const change of CHANGE_ORDER) {
		if (change === 'steady' && !options.all) continue;
		const rows = result.rows.filter((row) => row.change === change);
		if (rows.length === 0) continue;
		shown += rows.length;
		out.push('', paint(`${change.toUpperCase()} (${rows.length})`, tones[change], options.color));
		out.push(
			renderTable(
				['NOW', 'BEFORE', 'RATIO', 'PATTERN', 'TEMPLATE'],
				rows.map((row) => [
					String(row.current),
					String(row.baseline),
					row.ratio === null ? '-' : `${row.ratio >= 10 ? row.ratio.toFixed(0) : row.ratio.toFixed(1)}x`,
					row.patternId,
					row.template.replace(/\s+/g, ' '),
				]),
			),
		);
	}
	if (shown === 0) out.push('', options.all ? 'No patterns in either window.' : 'Nothing changed: every pattern is steady.');
	return out.join('\n');
}
