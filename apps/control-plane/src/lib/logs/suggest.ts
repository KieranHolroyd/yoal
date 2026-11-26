import {
	builtinLogFields,
	logRecordSources,
	logScopeKinds,
	logSeverities,
	type LogAggregationFn
} from '@yoal/contracts';
import { lexLogQuery } from './query-text.js';

/**
 * Autocomplete for the query editor.
 *
 * INTEGRATION SEAM: Lane Q ships `suggestLogQuery(text, caret, catalog)` in
 * `@yoal/contracts` (`log-query-suggest.ts`). Until it merges, this module is a small local
 * stand-in with the same call shape, so the switch is one import:
 *
 *   export { suggestLogQuery } from '@yoal/contracts';
 *
 * (mapping its item fields onto `LogQuerySuggestion` here if they differ). Keep the editor
 * importing from this file only.
 */

export type LogQuerySuggestionKind =
	'field' | 'value' | 'operator' | 'pipe' | 'function' | 'keyword';

export interface LogQuerySuggestion {
	label: string;
	/** Text that replaces `[from, to)`. */
	insertText: string;
	kind: LogQuerySuggestionKind;
	detail?: string;
}

export interface LogQuerySuggestResult {
	items: LogQuerySuggestion[];
	/** The token range the chosen item replaces. */
	from: number;
	to: number;
}

/** Known values per field name (`level`, `service`, `@http.status`…), e.g. from `/fields`. */
export type LogQueryCatalog = Record<string, readonly string[]>;

const STAGES: ReadonlyArray<{ name: string; detail: string; insert: string }> = [
	{ name: 'stats', detail: 'aggregate: count() by bin(5m), level', insert: 'stats ' },
	{ name: 'patterns', detail: 'group lines by template', insert: 'patterns' },
	{ name: 'fields', detail: 'choose columns', insert: 'fields ' },
	{ name: 'dedup', detail: 'collapse repeats', insert: 'dedup ' },
	{ name: 'sort', detail: 'sort by a column', insert: 'sort ' },
	{ name: 'limit', detail: 'cap the rows', insert: 'limit ' }
];

const AGGREGATIONS: readonly LogAggregationFn[] = [
	'count',
	'count_distinct',
	'sum',
	'avg',
	'min',
	'max',
	'p50',
	'p90',
	'p95',
	'p99'
];

const BUILTIN_VALUES: Record<string, readonly string[]> = {
	level: logSeverities,
	source: logRecordSources,
	kind: logScopeKinds,
	channel: ['stdout', 'stderr', 'system']
};

function matches(candidate: string, prefix: string): boolean {
	return prefix === '' || candidate.toLowerCase().startsWith(prefix.toLowerCase());
}

/** Pure: the completions at `caret`, plus the range they replace. */
export function suggestLogQuery(
	text: string,
	caret: number,
	catalog: LogQueryCatalog = {}
): LogQuerySuggestResult {
	const at = Math.max(0, Math.min(caret, text.length));
	const before = text.slice(0, at);
	// The word under the caret: back to whitespace or a paren, forward to the same.
	const startMatch = /[^\s()|,]*$/.exec(before);
	const from = at - (startMatch?.[0].length ?? 0);
	const endMatch = /^[^\s()|,]*/.exec(text.slice(at));
	const to = at + (endMatch?.[0].length ?? 0);
	const word = text.slice(from, at);

	const tokens = lexLogQuery(before.slice(0, from));
	const pipeAt = tokens.findLastIndex((token) => token.kind === 'pipe');
	if (pipeAt >= 0) {
		const afterPipe = tokens.slice(pipeAt + 1).filter((token) => token.kind !== 'ws');
		if (afterPipe.length === 0) {
			return {
				from,
				to,
				items: STAGES.filter((stage) => matches(stage.name, word)).map((stage) => ({
					label: stage.name,
					insertText: stage.insert,
					kind: 'pipe',
					detail: stage.detail
				}))
			};
		}
		const stage = afterPipe[0]!.text.toLowerCase();
		const items: LogQuerySuggestion[] = [];
		if (stage === 'stats') {
			const sawBy = afterPipe.some(
				(token) => token.kind === 'keyword' && token.text.toLowerCase() === 'by'
			);
			if (!sawBy)
				for (const fn of AGGREGATIONS)
					if (matches(fn, word))
						items.push({
							label: `${fn}()`,
							insertText: fn === 'count' ? 'count()' : `${fn}(`,
							kind: 'function'
						});
			if (sawBy && matches('bin', word))
				items.push({
					label: 'bin(5m)',
					insertText: 'bin(5m)',
					kind: 'function',
					detail: 'time bucket'
				});
			if (!sawBy && afterPipe.length > 1 && matches('by', word))
				items.push({ label: 'by', insertText: 'by ', kind: 'keyword' });
		}
		if (stage === 'sort')
			for (const dir of ['asc', 'desc'])
				if (matches(dir, word)) items.push({ label: dir, insertText: dir, kind: 'keyword' });
		if (['stats', 'fields', 'dedup', 'sort'].includes(stage))
			items.push(...fieldItems(word, catalog, false));
		return { from, to, items: items.slice(0, 50) };
	}

	// `field:val…` → values for that field.
	const negated = word.startsWith('-') ? '-' : '';
	const bare = negated ? word.slice(1) : word;
	const colon = bare.indexOf(':');
	if (colon > 0) {
		const field = bare.slice(0, colon);
		const typed = bare.slice(colon + 1).replace(/^(>=|<=|>|<|=)/, '');
		const op = bare.slice(colon + 1, colon + 1 + (bare.length - colon - 1 - typed.length));
		const known =
			catalog[field] ?? catalog[field.toLowerCase()] ?? BUILTIN_VALUES[field.toLowerCase()] ?? [];
		const items = known
			.filter((value) => matches(value, typed.replace(/^"/, '')))
			.slice(0, 50)
			.map((value) => ({
				label: value,
				insertText: `${negated}${field}:${op}${/^[A-Za-z0-9_.\-/:@*]+$/.test(value) ? value : `"${value.replace(/["\\]/g, '\\$&')}"`}`,
				kind: 'value' as const
			}));
		return { from, to, items };
	}

	const items: LogQuerySuggestion[] = fieldItems(bare, catalog, true).map((item) => ({
		...item,
		insertText: `${negated}${item.insertText}`
	}));
	if (bare === '' || matches('OR', bare))
		items.push({ label: 'OR', insertText: 'OR ', kind: 'operator' });
	if (bare === '' || matches('NOT', bare))
		items.push({ label: 'NOT', insertText: 'NOT ', kind: 'operator' });
	if (bare === '' || bare === '|')
		items.push({ label: '|', insertText: '| ', kind: 'pipe', detail: 'pipe stage' });
	return { from, to, items: items.slice(0, 50) };
}

function fieldItems(
	prefix: string,
	catalog: LogQueryCatalog,
	withColon: boolean
): LogQuerySuggestion[] {
	const names = new Set<string>(Object.keys(builtinLogFields));
	for (const key of Object.keys(catalog)) names.add(key);
	const out: LogQuerySuggestion[] = [];
	for (const name of names) {
		if (!matches(name, prefix)) continue;
		const builtin = (builtinLogFields as Record<string, { description: string }>)[name];
		out.push({
			label: name,
			insertText: withColon ? `${name}:` : name,
			kind: 'field',
			detail: builtin?.description
		});
	}
	return out;
}
