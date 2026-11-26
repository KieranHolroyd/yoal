/**
 * Text-level helpers for log queries (docs/LOGS.md §6) that the Explorer needs before or without
 * a parse: a lexer for syntax highlighting, splitting filters from pipe stages, ANDing a page's
 * locked preset in, toggling `field:value` clauses from facets, and the bare search terms to
 * highlight in rows. The grammar itself (and its errors) lives in `@yoal/contracts`; nothing here
 * decides what a query means.
 */

export type QueryTokenKind =
	| 'ws'
	| 'text'
	| 'string'
	| 'field'
	| 'attr'
	| 'op'
	| 'value'
	| 'regex'
	| 'keyword'
	| 'neg'
	| 'paren'
	| 'pipe'
	| 'stage'
	| 'fn'
	| 'punct'
	| 'number';

export interface QueryToken {
	kind: QueryTokenKind;
	text: string;
	start: number;
}

const STAGES = new Set(['fields', 'stats', 'patterns', 'dedup', 'sort', 'limit', 'filter']);
const PIPE_KEYWORDS = new Set(['by', 'as', 'asc', 'desc']);
const BOOL = new Set(['OR', 'AND', 'NOT']);
const FIELD = /^@?[A-Za-z_][\w.-]*:/;

/** Index just past a `"…"` starting at `i` (handles `\"`); the end of text when unterminated. */
function scanString(text: string, i: number): number {
	let j = i + 1;
	while (j < text.length) {
		if (text[j] === '\\') j += 2;
		else if (text[j] === '"') return j + 1;
		else j += 1;
	}
	return text.length;
}

/** Index just past a `/…/` regex starting at `i`. */
function scanRegex(text: string, i: number): number {
	let j = i + 1;
	while (j < text.length) {
		if (text[j] === '\\') j += 2;
		else if (text[j] === '/') return j + 1;
		else j += 1;
	}
	return text.length;
}

/** Index just past a bare word starting at `i`. */
function scanWord(text: string, i: number, stopAtComma: boolean): number {
	let j = i;
	while (j < text.length) {
		const ch = text[j]!;
		if (
			/\s/.test(ch) ||
			ch === '(' ||
			ch === ')' ||
			ch === '|' ||
			ch === '"' ||
			(stopAtComma && ch === ',')
		)
			break;
		j += 1;
	}
	return j;
}

/**
 * Tokens covering the whole text (their concatenation is the input), for the editor's highlight
 * layer. Tolerant: half-typed queries still lex.
 */
export function lexLogQuery(text: string): QueryToken[] {
	const tokens: QueryToken[] = [];
	let i = 0;
	let inPipe = false;
	let expectStage = false;
	const push = (kind: QueryTokenKind, end: number) => {
		if (end <= i) end = i + 1;
		tokens.push({ kind, text: text.slice(i, end), start: i });
		i = end;
	};
	while (i < text.length) {
		const ch = text[i]!;
		const rest = text.slice(i);
		if (/\s/.test(ch)) {
			const match = /^\s+/.exec(rest)!;
			push('ws', i + match[0].length);
			continue;
		}
		if (ch === '|') {
			inPipe = true;
			expectStage = true;
			push('pipe', i + 1);
			continue;
		}
		if (ch === '"') {
			push('string', scanString(text, i));
			continue;
		}
		if (ch === '(' || ch === ')') {
			push('paren', i + 1);
			continue;
		}
		if (inPipe) {
			if (ch === ',') {
				push('punct', i + 1);
				continue;
			}
			const end = scanWord(text, i, true);
			const word = text.slice(i, end);
			if (expectStage) {
				expectStage = false;
				push(STAGES.has(word.toLowerCase()) ? 'stage' : 'text', end);
			} else if (text[end] === '(') push('fn', end);
			else if (PIPE_KEYWORDS.has(word.toLowerCase())) push('keyword', end);
			else if (/^-?\d+(\.\d+)?$/.test(word)) push('number', end);
			else if (word.startsWith('@')) push('attr', end);
			else push('text', end);
			continue;
		}
		if (ch === '-' && i + 1 < text.length && !/\s/.test(text[i + 1]!)) {
			push('neg', i + 1);
			continue;
		}
		const field = FIELD.exec(rest);
		if (field) {
			push(field[0].startsWith('@') ? 'attr' : 'field', i + field[0].length);
			const op = /^(>=|<=|>|<|=)/.exec(text.slice(i));
			if (op) push('op', i + op[0].length);
			if (text[i] === '"') push('string', scanString(text, i));
			else if (text[i] === '/') push('regex', scanRegex(text, i));
			else if (i < text.length && !/\s/.test(text[i]!) && text[i] !== ')')
				push('value', scanWord(text, i, false));
			continue;
		}
		const end = scanWord(text, i, false);
		const word = text.slice(i, end);
		push(BOOL.has(word) ? 'keyword' : 'text', end);
	}
	return tokens;
}

/** Where the pipe stages start: the first `|` outside quotes and regexes, or -1. */
export function pipeIndex(text: string): number {
	for (const token of lexLogQuery(text)) if (token.kind === 'pipe') return token.start;
	return -1;
}

/** `level:error "x" | stats count()` → `{ filter: 'level:error "x"', pipes: '| stats count()' }`. */
export function splitPipes(text: string): { filter: string; pipes: string } {
	const at = pipeIndex(text);
	if (at < 0) return { filter: text.trim(), pipes: '' };
	return { filter: text.slice(0, at).trim(), pipes: text.slice(at).trim() };
}

export function hasPipes(text: string): boolean {
	return pipeIndex(text) >= 0;
}

function wrap(filter: string): string {
	return lexLogQuery(filter).some((token) => token.kind === 'keyword' && token.text === 'OR')
		? `(${filter})`
		: filter;
}

/**
 * The query actually sent: a page's locked preset ANDed with what the reader typed. Each side is
 * parenthesised when it has a top-level `OR`, so `a OR b` + `c` reads `(a OR b) c`. Pipe stages
 * from the reader's text stay at the end.
 */
export function combineQuery(base: string, user: string): string {
	const preset = base.trim();
	const { filter, pipes } = splitPipes(user);
	const parts: string[] = [];
	if (preset) parts.push(wrap(preset));
	if (filter) parts.push(preset ? wrap(filter) : filter);
	return [parts.join(' '), pipes].filter(Boolean).join(' ');
}

/** Replace the pipe stages, keeping the filter (`| patterns`, `| stats …` for the mode tabs). */
export function withPipes(text: string, pipes: string): string {
	const { filter } = splitPipes(text);
	return [filter, pipes.trim()].filter(Boolean).join(' ');
}

const SAFE_VALUE = /^[A-Za-z0-9_.\-/:@]+$/;

/** A value as written after `field:`, quoted when it would otherwise parse as something else. */
export function formatFilterValue(value: string): string {
	if (value !== '' && SAFE_VALUE.test(value) && !/^[-<>=]/.test(value)) return value;
	return `"${value.replace(/["\\]/g, (ch) => `\\${ch}`)}"`;
}

/** `level:error`, `-@http.status:500`, `stream:"pod:a b"`. */
export function formatFilterClause(field: string, value: string, negate = false): string {
	return `${negate ? '-' : ''}${field}:${formatFilterValue(value)}`;
}

/** Top-level, whitespace-separated terms of a filter, keeping quotes and parentheses intact. */
function splitTerms(filter: string): string[] {
	const terms: string[] = [];
	let depth = 0;
	let current = '';
	for (const token of lexLogQuery(filter)) {
		if (token.kind === 'paren') depth += token.text === '(' ? 1 : -1;
		if (token.kind === 'ws' && depth <= 0) {
			if (current) terms.push(current);
			current = '';
			continue;
		}
		current += token.text;
	}
	if (current) terms.push(current);
	return terms;
}

/**
 * Click a facet value: add `field:value`; click it again to remove it. Alt-click excludes
 * (`-field:value`), and flips an existing include to an exclude (and back).
 */
export function toggleFilterClause(
	text: string,
	field: string,
	value: string,
	negate = false
): string {
	const { filter, pipes } = splitPipes(text);
	const clause = formatFilterClause(field, value, negate);
	const opposite = formatFilterClause(field, value, !negate);
	const terms = splitTerms(filter);
	let next: string[];
	if (terms.includes(clause)) next = terms.filter((term) => term !== clause);
	else if (terms.includes(opposite))
		next = terms.map((term) => (term === opposite ? clause : term));
	else next = [...terms, clause];
	return [next.join(' '), pipes].filter(Boolean).join(' ');
}

/** Is `field:value` (or its negation, with `negate`) already a top-level term? */
export function hasFilterClause(
	text: string,
	field: string,
	value: string,
	negate = false
): boolean {
	return splitTerms(splitPipes(text).filter).includes(formatFilterClause(field, value, negate));
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
		return value.slice(1, -1).replace(/\\(.)/g, '$1');
	if (value.startsWith('"')) return value.slice(1);
	return value;
}

/**
 * Words and phrases the reader searched the body for, to highlight in rows: bare tokens,
 * "phrases", and `body:`/`message:` values, but never negated ones or wildcards.
 */
export function searchTerms(text: string): string[] {
	const { filter } = splitPipes(text);
	const tokens = lexLogQuery(filter);
	const out = new Set<string>();
	let negated = false;
	let bodyField = false;
	for (const token of tokens) {
		if (token.kind === 'ws' || token.kind === 'paren') {
			// `-(a b)` keeps the negation into the group's first term; a space or `)` ends it.
			if (token.kind === 'ws' || token.text === ')') negated = false;
			bodyField = false;
			continue;
		}
		if (token.kind === 'neg' || (token.kind === 'keyword' && token.text === 'NOT')) {
			negated = true;
			continue;
		}
		if (token.kind === 'field') {
			bodyField = /^(body|message):$/i.test(token.text);
			continue;
		}
		if (token.kind === 'attr' || token.kind === 'op') continue;
		const isFree = token.kind === 'text' || (token.kind === 'string' && !bodyField);
		const isBodyValue = bodyField && (token.kind === 'value' || token.kind === 'string');
		if (!negated && (isFree || isBodyValue)) {
			const term = unquote(token.text).replace(/\*/g, '').trim();
			if (term.length >= 2 || (term.length === 1 && token.kind === 'string'))
				out.add(term.toLowerCase());
		}
		negated = false;
		bodyField = false;
	}
	return [...out];
}

export interface HighlightPart {
	text: string;
	match: boolean;
}

/** Split `text` around case-insensitive matches of any term (longest first). */
export function highlightMatches(text: string, terms: readonly string[]): HighlightPart[] {
	if (terms.length === 0 || !text) return text ? [{ text, match: false }] : [];
	const sorted = [...terms].filter(Boolean).sort((a, b) => b.length - a.length);
	if (sorted.length === 0) return [{ text, match: false }];
	const escaped = sorted.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	const pattern = new RegExp(escaped.join('|'), 'gi');
	const parts: HighlightPart[] = [];
	let last = 0;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		if (match[0].length === 0) {
			pattern.lastIndex += 1;
			continue;
		}
		if (match.index > last) parts.push({ text: text.slice(last, match.index), match: false });
		parts.push({ text: match[0], match: true });
		last = match.index + match[0].length;
	}
	if (last < text.length) parts.push({ text: text.slice(last), match: false });
	return parts;
}
