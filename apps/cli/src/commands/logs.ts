import type { ApiClient } from '../api.ts';
import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec, type ParsedArgs } from '../args.ts';
import { ApiError, CliError, UsageError } from '../errors.ts';
import {
	formatRecordLine,
	parseBaseline,
	parseScopeArg,
	parseTimeArg,
	renderCompare,
	renderLogTable,
	resolveScopeArgs,
	wantColor,
	type LogCompareResultView,
	type LogContextResultView,
	type LogRecordView,
	type LogScopeEntryView,
	type LogScopeRefView,
	type LogSearchResultView,
	type LogTableResultView,
	type LogWarningView,
} from '../log-explorer.ts';
import { printJson } from '../output.ts';
import { readSse } from '../sse.ts';
import { authenticatedClient } from './common.ts';

/**
 * `yoal logs` (docs/LOGS.md §6, §11 L1/L7): every log the caller can read, through the unified
 * `/api/v1/logs/*` API. Scopes use the shorthand in `log-explorer.ts`; the query is validated with
 * the real grammar before any request; `-f` follows the SSE tail and resumes with `Last-Event-ID`
 * after a dropped connection.
 */

export const logsUsage = `Usage: yoal logs [scope…] [-q <query>] [--since 1h] [--until …] [-f] [--json] [--limit n] [--order asc|desc]
       yoal logs patterns [scope…] [-q <filter>] [--since 1h] [--limit n] [--json]
       yoal logs context <record id> [--before n] [--after n] [--json]
       yoal logs compare [scope…] [-q <filter>] --baseline previous|1d|7d|deploy:<id>|<from>..<to> [--since 1h] [--all] [--json]

Read logs from every project, service and pipeline you can see. With no scope, everything.

Scopes:
  <project>              A project, by slug (also project:<slug>)
  db:<name>              A managed database
  storage:<name>         An object storage instance
  broker:<name>          A queue broker
  k8s:<name>             A Kubernetes cluster
  pipeline:<repo>        A pipeline repository
  function:<project>     A function project
  platform:<node>        A node's platform services (platform admins)

Options:
  -q, --query <query>    Log query (docs: /observe/logs), e.g.
                           level:error -@path:/health "timeout"
                           service:api | stats count() by bin(5m), level
      --since <time>     Start: 15m, 1h, 24h, 7d, epoch ms or an ISO time
                         (default 24h for lines, 1h for patterns, compare and | stats)
      --until <time>     End (default now)
  -f, --follow           Keep printing new lines as they arrive; reconnects and resumes
  -n, --limit <n>        Lines to show (default 200; up to 10000; --lines also works)
      --order asc|desc   desc (default): the newest lines; asc: the oldest from --since
      --json             Print the API response (NDJSON records with -f)
      --no-color         No severity colours (also NO_COLOR=1)

Subcommands:
  patterns               Group the lines by template, most frequent first (needs ClickHouse)
  context <id>           The lines before and after one record, in its stream
  compare                What changed against a baseline: new, rising, falling and gone patterns
      --baseline <b>     previous (the window before), 1d / 7d (same window, shifted back),
                         deploy:<id> (before vs after that deploy), or <from>..<to>
      --all              Also list the steady patterns
  context: --before <n>, --after <n> (default 20 each, up to 500)

Examples:
  yoal logs api -q 'level:error' --since 1h
  yoal logs api db:main -f
  yoal logs -q '@http.status:>=500 | stats count() by bin(1m)' --since 6h
  yoal logs patterns api --since 24h
  yoal logs compare api --baseline deploy:dep_123`;

const readFlags: FlagSpec = {
	query: { type: 'string', short: 'q' },
	since: { type: 'string' },
	until: { type: 'string' },
	follow: { type: 'boolean', short: 'f' },
	limit: { type: 'string', short: 'n' },
	lines: { type: 'string' },
	order: { type: 'string' },
	json: { type: 'boolean' },
	color: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const patternsFlags: FlagSpec = {
	query: { type: 'string', short: 'q' },
	since: { type: 'string' },
	until: { type: 'string' },
	limit: { type: 'string', short: 'n' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const contextFlags: FlagSpec = {
	before: { type: 'string', short: 'B' },
	after: { type: 'string', short: 'A' },
	json: { type: 'boolean' },
	color: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const compareFlags: FlagSpec = {
	query: { type: 'string', short: 'q' },
	since: { type: 'string' },
	until: { type: 'string' },
	baseline: { type: 'string', short: 'b' },
	limit: { type: 'string', short: 'n' },
	all: { type: 'boolean' },
	json: { type: 'boolean' },
	color: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const SEARCH_PAGE_MAX = 1_000;
const LINES_MAX = 10_000;
const LINES_WINDOW_MS = 86_400_000;
const ANALYSIS_WINDOW_MS = 3_600_000;

export async function logsCommand(argv: string[]): Promise<void> {
	switch (argv[0]) {
		case 'patterns':
			return patternsCommand(argv.slice(1));
		case 'context':
			return contextCommand(argv.slice(1));
		case 'compare':
			return compareCommand(argv.slice(1));
	}
	const args = parseArgs(argv, readFlags);
	if (args.boolean('help')) {
		console.log(logsUsage);
		return;
	}
	const now = Date.now();
	const query = await validateQuery(args.string('query') ?? '');
	const follow = args.boolean('follow');
	const limitGiven = args.has('limit') || args.has('lines');
	const limit = parseLimit(args.string('limit') ?? args.string('lines'), 200, LINES_MAX, '--limit');
	const order = args.string('order') ?? 'desc';
	if (order !== 'asc' && order !== 'desc') throw new UsageError('--order must be asc or desc.');
	if (follow && query.pipes) throw new UsageError('-f follows lines; a query with | stages cannot be followed. Drop -f or the pipe.');
	if (follow && args.has('until')) throw new UsageError('-f reads up to now; drop --until.');
	const color = wantColor(args.has('color') ? args.boolean('color') : undefined);

	const client = await authenticatedClient();
	const scopes = await resolveScopes(client, args.positionals);
	const showScope = scopes.length !== 1;

	if (follow) {
		await followLogs(client, {
			q: query.text,
			scopes,
			backfill: limitGiven ? Math.min(limit, SEARCH_PAGE_MAX) : 20,
			json: args.boolean('json'),
			color,
			showScope,
		});
		return;
	}

	const window = timeWindow(args, now, query.pipes ? ANALYSIS_WINDOW_MS : LINES_WINDOW_MS);
	if (query.pipes) {
		const result = await postJson<LogTableResultView>(client, '/api/v1/logs/table', { q: query.text, scopes, ...window });
		if (args.boolean('json')) {
			printJson(result);
			return;
		}
		printWarnings(result.warnings);
		console.log(renderLogTable(result));
		return;
	}

	const result = await searchAll(client, { q: query.text, scopes, ...window, order: order as 'asc' | 'desc' }, limit);
	if (args.boolean('json')) {
		printJson(result);
		return;
	}
	printWarnings(result.warnings);
	if (result.records.length === 0) {
		process.stderr.write(`No logs match between ${new Date(window.from).toISOString()} and ${new Date(window.to).toISOString()}.\n`);
		return;
	}
	// Oldest first either way, like `tail`: desc only decides which lines (the newest).
	const records = order === 'desc' ? [...result.records].reverse() : result.records;
	for (const record of records) console.log(formatRecordLine(record, { color, scope: showScope }));
	if (order === 'desc' && result.cursor.older)
		process.stderr.write(`Showing the newest ${records.length}; use --limit or --since for more.\n`);
}

// --- subcommands ----------------------------------------------------------------------------

async function patternsCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, patternsFlags);
	if (args.boolean('help')) {
		console.log(logsUsage);
		return;
	}
	const query = await validateQuery(args.string('query') ?? '');
	if (query.pipes) throw new UsageError('patterns adds `| patterns` itself; pass only a filter with -q.');
	const limit = parseLimit(args.string('limit'), 50, 10_000, '--limit');
	const text = `${query.text.trim()} | patterns | limit ${limit}`.trim();
	await validateQuery(text);
	const client = await authenticatedClient();
	const scopes = await resolveScopes(client, args.positionals);
	const window = timeWindow(args, Date.now(), ANALYSIS_WINDOW_MS);
	const result = await postJson<LogTableResultView>(client, '/api/v1/logs/table', { q: text, scopes, ...window });
	if (args.boolean('json')) {
		printJson(result);
		return;
	}
	printWarnings(result.warnings);
	console.log(renderLogTable(result));
}

async function contextCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, contextFlags);
	if (args.boolean('help')) {
		console.log(logsUsage);
		return;
	}
	rejectExtraPositionals(args, 1, logsUsage);
	const id = requirePositional(args, 0, 'record id (from --json output, e.g. le:123)');
	const before = parseLimit(args.string('before'), 20, 500, '--before', 0);
	const after = parseLimit(args.string('after'), 20, 500, '--after', 0);
	const client = await authenticatedClient();
	const params = new URLSearchParams({ id, before: String(before), after: String(after) });
	const result = await getJson<LogContextResultView>(client, `/api/v1/logs/context?${params}`);
	if (args.boolean('json')) {
		printJson(result);
		return;
	}
	if (!result.anchor) throw new CliError(`No log record ${id} that you can read.`, { code: 'not_found' });
	const color = wantColor(args.has('color') ? args.boolean('color') : undefined);
	const line = (record: LogRecordView, marker: string) => console.log(formatRecordLine(record, { color, scope: false, marker }));
	for (const record of result.before) line(record, '  ');
	line(result.anchor, color ? '\x1b[1m> \x1b[0m' : '> ');
	for (const record of result.after) line(record, '  ');
}

async function compareCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, compareFlags);
	if (args.boolean('help')) {
		console.log(logsUsage);
		return;
	}
	const now = Date.now();
	const baselineText = args.string('baseline');
	if (!baselineText) throw new UsageError('compare needs --baseline previous|1d|7d|deploy:<id>|<from>..<to>.');
	const baseline = parseBaseline(baselineText, now);
	const query = await validateQuery(args.string('query') ?? '');
	if (query.pipes) throw new UsageError('compare groups by pattern itself; pass only a filter with -q.');
	const limit = parseLimit(args.string('limit'), 100, 500, '--limit');
	const client = await authenticatedClient();
	const scopes = await resolveScopes(client, args.positionals);
	const window = timeWindow(args, now, ANALYSIS_WINDOW_MS);
	const result = await postJson<LogCompareResultView>(client, '/api/v1/logs/compare', {
		q: query.text,
		scopes,
		...window,
		baseline,
		limit,
	});
	if (args.boolean('json')) {
		printJson(result);
		return;
	}
	printWarnings(result.warnings);
	const color = wantColor(args.has('color') ? args.boolean('color') : undefined);
	console.log(renderCompare(result, { color, all: args.boolean('all') }));
}

// --- shared ---------------------------------------------------------------------------------

/**
 * Parse the query with the same grammar the server uses (docs/LOGS.md §6), so a typo fails here
 * with a caret under it instead of after a round trip. Loaded lazily: the grammar pulls in the
 * contract schemas, which no other command needs.
 */
async function validateQuery(text: string): Promise<{ text: string; pipes: boolean }> {
	const { parseLogQuery } = await import('../../../../packages/contracts/src/log-query.ts');
	const parsed = parseLogQuery(text);
	if (!parsed.ok) {
		const { message, start, end, hint } = parsed.error;
		const width = Math.max(1, end - start);
		throw new UsageError(
			`Invalid log query: ${message}${hint ? ` (${hint})` : ''}\n  ${text}\n  ${' '.repeat(start)}${'^'.repeat(width)}`,
		);
	}
	return { text, pipes: parsed.ast.pipes.length > 0 };
}

function parseLimit(raw: string | undefined, fallback: number, max: number, flag: string, min = 1): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max)
		throw new UsageError(`${flag} must be a whole number between ${min} and ${max}.`);
	return value;
}

function timeWindow(args: ParsedArgs, now: number, defaultSpan: number): { from: number; to: number } {
	const to = args.string('until') ? parseTimeArg(args.string('until')!, now, '--until') : now;
	const from = args.string('since') ? parseTimeArg(args.string('since')!, now, '--since') : to - defaultSpan;
	if (from >= to) throw new UsageError('--since must be before --until.');
	return { from, to };
}

/** Typed scopes → ids, from the caller's readable scopes. No positionals means everything. */
async function resolveScopes(client: ApiClient, positionals: readonly string[]): Promise<LogScopeRefView[]> {
	if (positionals.length === 0) return [];
	const wanted = positionals.map(parseScopeArg);
	const capabilities = await getJson<{ scopes?: LogScopeEntryView[] }>(client, '/api/v1/logs/capabilities');
	return resolveScopeArgs(wanted, capabilities.scopes ?? []);
}

/** Newest (desc) or oldest (asc) `limit` lines, paging past the API's 1,000-row page. */
async function searchAll(
	client: ApiClient,
	input: { q: string; scopes: LogScopeRefView[]; from: number; to: number; order: 'asc' | 'desc' },
	limit: number,
): Promise<LogSearchResultView> {
	let merged: LogSearchResultView | null = null;
	let cursor: string | undefined;
	while (!merged || merged.records.length < limit) {
		const page: LogSearchResultView = await postJson<LogSearchResultView>(client, '/api/v1/logs/search', {
			...input,
			limit: Math.min(SEARCH_PAGE_MAX, limit - (merged?.records.length ?? 0)),
			...(cursor ? { cursor } : {}),
		});
		merged = merged
			? { ...page, records: [...merged.records, ...page.records], warnings: [...merged.warnings, ...page.warnings] }
			: page;
		cursor = (input.order === 'desc' ? page.cursor.older : page.cursor.newer) ?? undefined;
		if (!cursor || page.records.length === 0 || input.order === 'asc' && page.records.length < SEARCH_PAGE_MAX) break;
	}
	return merged;
}

async function postJson<T>(client: ApiClient, path: string, body: unknown): Promise<T> {
	const response = await client.raw('POST', path, {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json', accept: 'application/json' },
	});
	return (await response.json()) as T;
}

async function getJson<T>(client: ApiClient, path: string): Promise<T> {
	const response = await client.raw('GET', path, { headers: { accept: 'application/json' } });
	return (await response.json()) as T;
}

function printWarnings(warnings: readonly LogWarningView[] | undefined): void {
	const seen = new Set<string>();
	for (const warning of warnings ?? []) {
		if (seen.has(warning.message)) continue;
		seen.add(warning.message);
		process.stderr.write(`Note: ${warning.message}\n`);
	}
}

// --- live tail ------------------------------------------------------------------------------

interface FollowInput {
	q: string;
	scopes: LogScopeRefView[];
	backfill: number;
	json: boolean;
	color: boolean;
	showScope: boolean;
}

/** No bytes for this long (the server pings every 15 s) means the connection is gone. */
const IDLE_MS = 45_000;
const MAX_CONSECUTIVE_FAILURES = 8;

/**
 * Follow `/api/v1/logs/stream` until Ctrl-C. A drop reconnects with the last event id, so the
 * server replays exactly what was missed (or the newest lines plus a "skipped" notice past its
 * catch-up limit). A 4xx is final; anything else backs off and retries.
 */
async function followLogs(client: ApiClient, input: FollowInput): Promise<void> {
	const stop = new AbortController();
	const onSignal = () => stop.abort();
	const signals = process as NodeJS.EventEmitter;
	signals.once('SIGINT', onSignal);
	signals.once('SIGTERM', onSignal);
	let cursor: string | undefined;
	let failures = 0;
	let announced = false;
	try {
		while (!stop.signal.aborted) {
			const controller = new AbortController();
			const abort = () => controller.abort();
			stop.signal.addEventListener('abort', abort, { once: true });
			let idle: ReturnType<typeof setTimeout> | undefined;
			// The server closes every tail after its lifetime (`max_lifetime`); resume at once, quietly.
			let routine = false;
			const arm = () => {
				clearTimeout(idle);
				idle = setTimeout(abort, IDLE_MS);
			};
			try {
				const params = new URLSearchParams();
				if (input.q) params.set('q', input.q);
				for (const scope of input.scopes) params.append('scope', `${scope.kind}:${scope.id}`);
				if (!cursor && input.backfill > 0) params.set('backfill', String(input.backfill));
				arm();
				const response = await client.raw('GET', `/api/v1/logs/stream${params.size > 0 ? `?${params}` : ''}`, {
					headers: { accept: 'text/event-stream', ...(cursor ? { 'last-event-id': cursor } : {}) },
					signal: controller.signal,
				});
				if (!response.body) throw new CliError('The log stream had no body.', { code: 'protocol' });
				for await (const event of readSse(response.body, { onChunk: arm })) {
					failures = 0;
					const data = parseData(event.data);
					if (event.event === 'ready') {
						// Only the first open takes the server's position: on a resume, the catch-up
						// batch follows `ready`, and jumping ahead before it arrives would lose it.
						if (!cursor && typeof data?.cursor === 'string') cursor = data.cursor;
						if (!announced && !input.json) process.stderr.write('Following new lines (Ctrl-C to stop)…\n');
						announced = true;
					} else if (event.event === 'records' && Array.isArray(data?.records)) {
						for (const record of data.records as LogRecordView[])
							console.log(input.json ? JSON.stringify(record) : formatRecordLine(record, { color: input.color, scope: input.showScope }));
						cursor = event.id ?? (typeof data.cursor === 'string' ? data.cursor : cursor);
					} else if (event.event === 'sampled') {
						process.stderr.write(`… ${Number(data?.dropped ?? 0).toLocaleString('en-US')} lines skipped to keep up.\n`);
					} else if (event.event === 'end') {
						if (data?.code === 'max_lifetime') {
							routine = true;
							break;
						}
						process.stderr.write(`The stream ended: ${String(data?.reason ?? 'no reason given')}\n`);
						break;
					}
				}
			} catch (error) {
				if (stop.signal.aborted) return;
				if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)
					throw error;
				if (error instanceof CliError && !(error instanceof ApiError) && error.code !== 'network') throw error;
			} finally {
				clearTimeout(idle);
				stop.signal.removeEventListener('abort', abort);
				controller.abort();
			}
			if (stop.signal.aborted) return;
			if (routine) continue;
			failures += 1;
			if (failures > MAX_CONSECUTIVE_FAILURES) throw new CliError('Lost the log stream and could not reconnect.', { code: 'network' });
			process.stderr.write(`Reconnecting${cursor ? ' (resuming)' : ''}…\n`);
			await sleep(Math.min(500 * 2 ** (failures - 1), 15_000), stop.signal);
		}
	} finally {
		signals.removeListener('SIGINT', onSignal);
		signals.removeListener('SIGTERM', onSignal);
	}
}

function parseData(text: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		}
		signal.addEventListener('abort', done, { once: true });
	});
}
