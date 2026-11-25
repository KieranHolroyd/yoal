import { builtinLogFields, LOG_QUERY_LIMITS, type LogFieldRef } from './log-query-ast.ts';
import {
	formatLogFieldRef,
	formatLogQueryValue,
	LOG_PATTERNS_COLUMNS,
	logAggregationFns,
	logPipeStageNames,
	parseLogFieldName,
	parseLogQuery,
} from './log-query.ts';
import { logRecordSources, logScopeKinds, logSeverities } from './log-record.ts';

/**
 * Autocomplete for the log-query language (docs/LOGS.md §6, §7.2). Pure: the dashboard editor and
 * the CLI both call it with the text, the caret and whatever field values they have to hand (the
 * `/fields` top values in the UI). It never parses the whole query for correctness; it looks at the
 * token under the caret and what comes right before it.
 *
 * Replacing `text.slice(from, to)` with an item's `insert` applies the suggestion.
 */

export type LogQuerySuggestionKind = 'field' | 'value' | 'operator' | 'keyword' | 'stage' | 'function';

export interface LogQuerySuggestion {
	/** What the menu shows. */
	label: string;
	/** What replaces `text.slice(from, to)`. */
	insert: string;
	kind: LogQuerySuggestionKind;
	detail?: string;
}

export interface LogQuerySuggestResult {
	/** Zero-based range of the token the suggestions replace. */
	from: number;
	to: number;
	items: LogQuerySuggestion[];
}

/**
 * Known values per field, keyed by the field's query name (`service`, `level`, `@http.status`,
 * `resource.host.name`). Keys starting with `@` or `resource.` are also offered as field names.
 */
export type LogQuerySuggestCatalog = Readonly<Record<string, readonly string[]>>;

const MAX_ITEMS = 50;
const FILTER_DELIMS = new Set([' ', '\t', '\n', '\r', '(', ')']);

const BUILTIN_VALUES: Partial<Record<string, readonly string[]>> = {
	level: logSeverities,
	source: logRecordSources,
	kind: logScopeKinds,
	channel: ['stdout', 'stderr', 'system'],
};

const STAGE_DETAIL: Record<(typeof logPipeStageNames)[number], string> = {
	fields: 'choose columns',
	stats: 'aggregate: count(), p95(@f) … by bin(5m), field',
	patterns: 'group by message template',
	dedup: 'collapse repeats of a field',
	sort: 'order rows',
	limit: 'keep the first n rows',
};

function isWs(ch: string | undefined): boolean {
	return ch !== undefined && /\s/.test(ch);
}

/**
 * Rank by prefix match, then (for two or more typed characters) substring match; case-insensitive;
 * stable within each group.
 */
function rank<T>(items: T[], partial: string, key: (item: T) => string): T[] {
	const needle = partial.toLowerCase();
	if (!needle) return items;
	const prefix: T[] = [];
	const contains: T[] = [];
	for (const item of items) {
		const text = key(item).toLowerCase();
		if (text.startsWith(needle)) prefix.push(item);
		else if (needle.length >= 2 && text.includes(needle)) contains.push(item);
	}
	return [...prefix, ...contains];
}

function done(from: number, to: number, items: LogQuerySuggestion[]): LogQuerySuggestResult {
	const seen = new Set<string>();
	const unique = items.filter((item) => {
		const key = `${item.kind}:${item.insert}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { from, to, items: unique.slice(0, MAX_ITEMS) };
}

function fieldNames(catalog: LogQuerySuggestCatalog): Array<{ name: string; detail: string }> {
	const names = Object.entries(builtinLogFields).map(([name, info]): { name: string; detail: string } => ({ name, detail: info.description }));
	for (const key of Object.keys(catalog)) {
		const ref = parseLogFieldName(key);
		if (ref && ref.kind !== 'builtin') names.push({ name: formatLogFieldRef(ref), detail: ref.kind === 'attribute' ? 'attribute' : 'resource field' });
	}
	return names;
}

function catalogValues(ref: LogFieldRef, typedName: string, catalog: LogQuerySuggestCatalog): string[] {
	const canonical = formatLogFieldRef(ref);
	const values = [
		...(ref.kind === 'builtin' ? (BUILTIN_VALUES[ref.name] ?? []) : []),
		...(catalog[canonical] ?? []),
		...(typedName !== canonical ? (catalog[typedName] ?? []) : []),
	];
	return [...new Set(values)];
}

/** Where the token under the caret ends (scanning forward). */
function tokenEnd(text: string, caret: number, stops: (ch: string) => boolean): number {
	let i = caret;
	while (i < text.length && !stops(text[i]!)) i++;
	return i;
}

interface ScanState {
	/** Index of the last unquoted `|` before the caret, or -1. */
	lastPipe: number;
	/** Start of an open quote containing the caret, or -1. */
	openQuote: number;
}

function scan(text: string, caret: number): ScanState {
	let lastPipe = -1;
	let openQuote = -1;
	for (let i = 0; i < caret; i++) {
		const ch = text[i]!;
		if (openQuote >= 0) {
			if (ch === '\\') i++;
			else if (ch === '"') openQuote = -1;
			continue;
		}
		if (ch === '\\') {
			i++;
			continue;
		}
		if (ch === '"') openQuote = i;
		else if (ch === '|') lastPipe = i;
	}
	return { lastPipe, openQuote };
}

/** Completion items for the token at `caret` in `text`. Pure and total. */
export function suggestLogQuery(text: string, caret: number, catalog: LogQuerySuggestCatalog = {}): LogQuerySuggestResult {
	const at = Math.max(0, Math.min(caret, text.length));
	const state = scan(text, at);
	if (state.lastPipe >= 0) return suggestPipe(text, at, state.lastPipe, catalog);
	if (state.openQuote >= 0) return suggestQuotedValue(text, at, state.openQuote, catalog);
	return suggestFilter(text, at, catalog);
}

function suggestQuotedValue(text: string, caret: number, quoteStart: number, catalog: LogQuerySuggestCatalog): LogQuerySuggestResult {
	// Only values have useful completions inside quotes: `service:"my a|`.
	let nameStart = quoteStart;
	while (nameStart > 0 && !FILTER_DELIMS.has(text[nameStart - 1]!)) nameStart--;
	if (text[nameStart] === '-') nameStart++;
	const head = text.slice(nameStart, quoteStart);
	if (!head.endsWith(':')) return done(caret, caret, []);
	const name = head.slice(0, -1);
	const ref = parseLogFieldName(name);
	if (!ref) return done(caret, caret, []);
	const partial = text.slice(quoteStart + 1, caret);
	let to = caret;
	while (to < text.length && text[to] !== '"') to += text[to] === '\\' ? 2 : 1;
	if (text[to] === '"') to++;
	const values = rank(catalogValues(ref, name, catalog), partial, (value) => value);
	return done(
		quoteStart,
		Math.min(to, text.length),
		values.map((value) => ({ label: value, insert: formatLogQueryValue(value), kind: 'value' })),
	);
}

function suggestFilter(text: string, caret: number, catalog: LogQuerySuggestCatalog): LogQuerySuggestResult {
	let start = caret;
	while (start > 0 && !FILTER_DELIMS.has(text[start - 1]!)) start--;
	if (text[start] === '-' && start < caret) start++;
	const end = tokenEnd(text, caret, (ch) => isWs(ch) || ch === '(' || ch === ')' || ch === '|' || ch === '"');
	const token = text.slice(start, caret);
	const colon = token.indexOf(':');

	if (colon > 0) {
		const name = token.slice(0, colon);
		const ref = parseLogFieldName(name);
		if (!ref) return done(caret, caret, []);
		let valueFrom = start + colon + 1;
		let partial = token.slice(colon + 1);
		const op = /^(>=|<=|>|<|=)/.exec(partial);
		if (op) {
			valueFrom += op[0].length;
			partial = partial.slice(op[0].length);
		}
		const isLevel = ref.kind === 'builtin' && ref.name === 'level';
		const numeric = ref.kind !== 'builtin' || ref.name === 'replica';
		const items: LogQuerySuggestion[] = [];
		const values = rank(catalogValues(ref, name, catalog), partial, (value) => value);
		for (const value of values) items.push({ label: value, insert: formatLogQueryValue(value), kind: 'value' });
		if (!op && partial === '') {
			if (isLevel) {
				items.push({ label: '=', insert: '=', kind: 'operator', detail: 'exactly this level' });
				items.push({ label: '>', insert: '>', kind: 'operator', detail: 'above this level' });
				items.push({ label: '<', insert: '<', kind: 'operator', detail: 'below this level' });
			} else {
				items.push({ label: '*', insert: '*', kind: 'operator', detail: 'has the field' });
				if (numeric) {
					for (const [label, detail] of [['>=', 'at least'], ['>', 'greater than'], ['<=', 'at most'], ['<', 'less than']] as const) {
						items.push({ label, insert: label, kind: 'operator', detail });
					}
				}
				items.push({ label: '/regex/', insert: '//', kind: 'operator', detail: 'regular expression (ClickHouse)' });
			}
		}
		return done(valueFrom, end, items);
	}

	const items: LogQuerySuggestion[] = [];
	const before = text.slice(0, start).trimEnd();
	const afterTerm = before !== '' && !before.endsWith('(') && !/(^|\s)(OR|AND|NOT)$/.test(before);
	const fields = rank(fieldNames(catalog), token.startsWith('@') ? token : token.replace(/^@/, ''), (field) => field.name).filter(
		(field) => !token.startsWith('@') || field.name.startsWith('@'),
	);
	for (const field of fields) items.push({ label: field.name, insert: `${field.name}:`, kind: 'field', detail: field.detail });
	const keywords = afterTerm ? (['OR', 'AND', 'NOT'] as const) : (['NOT'] as const);
	for (const keyword of keywords) {
		if (keyword.startsWith(token)) items.push({ label: keyword, insert: `${keyword} `, kind: 'keyword' });
	}
	if (afterTerm && token === '') items.push({ label: '|', insert: '| ', kind: 'operator', detail: 'add a pipe stage' });
	return done(start, end, items);
}

function suggestPipe(text: string, caret: number, pipeAt: number, catalog: LogQuerySuggestCatalog): LogQuerySuggestResult {
	const isStop = (ch: string) => isWs(ch) || ch === ',' || ch === '(' || ch === ')' || ch === '|';
	let start = caret;
	while (start > pipeAt + 1 && !isStop(text[start - 1]!)) start--;
	const end = tokenEnd(text, caret, isStop);
	const partial = text.slice(start, caret);
	const segment = text.slice(pipeAt + 1, start);
	const words = segment.split(/[\s,()]+/).filter(Boolean);
	const fieldItems = (extra: string[] = []): LogQuerySuggestion[] => [
		...rank(extra, partial, (name) => name).map((name): LogQuerySuggestion => ({ label: name, insert: name, kind: 'field' })),
		...rank(fieldNames(catalog), partial, (field) => field.name).map(
			(field): LogQuerySuggestion => ({ label: field.name, insert: field.name, kind: 'field', detail: field.detail }),
		),
	];

	if (words.length === 0) {
		const stages = rank([...logPipeStageNames], partial, (name) => name);
		return done(
			start,
			end,
			stages.map((name) => ({ label: name, insert: name === 'patterns' ? name : `${name} `, kind: 'stage', detail: STAGE_DETAIL[name] })),
		);
	}

	const stage = words[0]!.toLowerCase();
	const lastChar = text.slice(pipeAt + 1, start).trimEnd().slice(-1);
	switch (stage) {
		case 'fields':
			return done(start, end, fieldItems(['ts']));
		case 'dedup':
			return done(start, end, words.length > 1 ? [] : fieldItems());
		case 'limit':
			return done(start, end, words.length > 1 ? [] : rank(['100', '500', '1000', String(LOG_QUERY_LIMITS.maxLimit)], partial, (n) => n).map((n) => ({ label: n, insert: n, kind: 'value' })));
		case 'sort': {
			if (words.length > 1) {
				return done(start, end, rank(['asc', 'desc'], partial, (d) => d).map((d) => ({ label: d, insert: d, kind: 'keyword' })));
			}
			const previous = parseLogQuery(text.slice(0, pipeAt));
			if (previous.ok) {
				const stats = previous.ast.pipes.find((p) => p.type === 'stats');
				if (stats && stats.type === 'stats') {
					const aliases = [...stats.by.map((g) => g.alias), ...stats.aggregations.map((a) => a.alias)];
					return done(start, end, rank(aliases, partial, (a) => a).map((a) => ({ label: a, insert: a, kind: 'field' })));
				}
				if (previous.ast.pipes.some((p) => p.type === 'patterns')) {
					return done(start, end, rank([...LOG_PATTERNS_COLUMNS], partial, (c) => c).map((c) => ({ label: c, insert: c, kind: 'field' })));
				}
				if (previous.ast.pipes.some((p) => p.type === 'dedup')) return done(start, end, fieldItems(['ts', 'count']));
			}
			return done(start, end, fieldItems(['ts']));
		}
		case 'stats': {
			const byIndex = words.findIndex((word, index) => index > 0 && word.toLowerCase() === 'by');
			if (byIndex > 0) {
				const bins = ['bin(1m)', 'bin(5m)', 'bin(1h)', 'bin(1d)'];
				return done(start, end, [
					...rank(bins, partial, (b) => b).map((b): LogQuerySuggestion => ({ label: b, insert: b, kind: 'function', detail: 'time bucket' })),
					...fieldItems(),
				]);
			}
			if (words[words.length - 1]!.toLowerCase() === 'as') return done(start, end, []);
			const openCall = /\(\s*$/.test(text.slice(pipeAt + 1, start));
			if (openCall) return done(start, end, fieldItems());
			if (lastChar === ')' || (words.length > 1 && words[words.length - 2]?.toLowerCase() === 'as')) {
				return done(start, end, rank(['by', 'as'], partial, (k) => k).map((k) => ({ label: k, insert: `${k} `, kind: 'keyword' })));
			}
			return done(
				start,
				end,
				rank([...logAggregationFns], partial, (fn) => fn).map((fn) => ({
					label: fn === 'count' ? 'count()' : `${fn}(field)`,
					insert: fn === 'count' ? 'count()' : `${fn}(`,
					kind: 'function',
				})),
			);
		}
		default:
			return done(start, end, []);
	}
}
