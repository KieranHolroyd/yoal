import type { LogQueryAst, LogQueryNode, LogQueryParseResult } from './log-query-ast.ts';
import type { LogRecord } from './log-record.ts';

/**
 * PLACEHOLDER (Logs Explorer foundation). Wave 1 lane Q replaces this file with the full grammar
 * (docs/LOGS.md §6, docs/build-plan/LOGS-WAVES.md). The exported signatures below are the contract
 * other lanes import; keep them stable.
 */

/** Parse query text into an AST. Total: never throws. */
export function parseLogQuery(text: string): LogQueryParseResult {
	const trimmed = text.trim();
	if (!trimmed) return { ok: true, ast: { filter: null, pipes: [] } };
	return { ok: true, ast: { filter: { type: 'text', value: trimmed, phrase: true }, pipes: [] } };
}

/** Canonical text for an AST (round-trips through `parseLogQuery`). */
export function formatLogQuery(ast: LogQueryAst): string {
	return ast.filter && ast.filter.type === 'text' ? ast.filter.value : '';
}

/** Compile a filter to a predicate for live tail and rule previews. */
export function compileLogPredicate(filter: LogQueryNode | null): (record: LogRecord) => boolean {
	if (!filter) return () => true;
	if (filter.type === 'text') {
		const needle = filter.value.toLowerCase();
		return (record) => record.body.toLowerCase().includes(needle);
	}
	return () => true;
}

/** Features an AST needs beyond lite mode (`regex`, `attributes`, `stats`, `patterns`). Empty = lite-safe. */
export function requiredLogFeatures(_ast: LogQueryAst): Array<'attributes' | 'regex' | 'stats' | 'patterns'> {
	return [];
}
