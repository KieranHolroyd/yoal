import {
	builtinLogFields,
	LOG_QUERY_LIMITS,
	type BuiltinLogField,
	type LogAggregation,
	type LogAggregationFn,
	type LogFieldOp,
	type LogFieldRef,
	type LogGroupBy,
	type LogPipeStage,
	type LogQueryAst,
	type LogQueryError,
	type LogQueryNode,
	type LogQueryParseResult,
} from './log-query-ast.ts';
import {
	logSeverities,
	SEVERITY_NUMBER,
	severityForNumber,
	severityForText,
	type LogRecord,
	type LogSeverity,
} from './log-record.ts';
import { checkRegexSafety, logRegexSubject } from './log-regex.ts';

/**
 * The log-query language (docs/LOGS.md §6, LP3): parser, canonical formatter, JS predicate and
 * feature detection. This comment is the SEMANTIC REFERENCE every compiler must match (SQLite lite
 * mode, ClickHouse, the live-tail predicate). When an engine cannot match a rule it must refuse the
 * query (`LogStoreUnsupported` → `needs_clickhouse`), never silently answer something different.
 *
 * ─── Syntax (§6.1) ────────────────────────────────────────────────────────────────────────────────
 *
 *   timeout                 text term: body has the whole token "timeout" (see "Leaves")
 *   "connection reset"      phrase: body contains the phrase (`\"` and `\\` escape inside quotes)
 *   level:error             severity ≥ error;  level:=warn exactly the warn band
 *   level:>warn level:<=info   band comparisons (see "level" below)
 *   service:api             built-in field (names in `builtinLogFields`; `message` is an alias of `body`)
 *   @http.status:>=500      attribute; comparisons > >= < <= are numeric
 *   resource.host.name:x    resource field (also `@resource.host.name:x`)
 *   @path:/api/*            wildcard (unquoted value with `*`)
 *   @msg:/time(out|d out)/  regex (`\/` escapes a slash)
 *   @user.id:*              the field exists (present and non-empty)
 *   @k:=a*b                 `:=` is exact equality; `*` is literal there
 *   -term  NOT term         negation;  a b  a AND b  implicit/explicit AND;  a OR b;  ( … )
 *
 *   Precedence: NOT/`-` binds tightest, then AND (implicit or explicit), then OR. `AND`, `OR`, `NOT`
 *   are keywords only in upper case; `or` is an ordinary text term and `"OR"` searches for the
 *   upper-case word. A word whose prefix looks like
 *   `name:` is a field term, so `http://x` is an "unknown field" error: quote it ("http://x") or
 *   escape the colon (http\://x). Unquoted words accept backslash escapes for the characters the
 *   grammar would otherwise interpret (whitespace ( ) " | \ * - @ : > < = /); `\` before any other
 *   character is a literal backslash. A word starting with `@` must be a field term (`@k:v`).
 *   Field and stage names, function names and keywords inside pipes are case-insensitive. Attribute
 *   and resource KEYS are case-sensitive, exactly as stored.
 *
 * ─── Pipe stages (§6.2) ───────────────────────────────────────────────────────────────────────────
 *
 *   | fields a, b             record columns to show (`ts` is always shown, so it is accepted and dropped)
 *   | stats agg[ as x], … [by bin(5m)[ as t], field[ as y], …]
 *                             aggs: count() (also count(*)), count_distinct(f), sum/avg/min/max(f),
 *                             p50/p90/p95/p99(f). bin units: ms s m h d, clamped to [1s, 1d].
 *   | patterns                group by Drain template
 *   | dedup f                 one record per distinct value of f
 *   | sort key [asc|desc]     default direction is asc (the formatter always writes it)
 *   | limit n                 1 … LOG_QUERY_LIMITS.maxLimit
 *
 *   Stages must appear in this order, each at most once: fields, dedup, stats|patterns, sort, limit.
 *   `stats` and `patterns` are exclusive with each other and with `fields`/`dedup`.
 *
 * ─── AST semantics (what compilers implement) ─────────────────────────────────────────────────────
 *
 * Values and missing fields
 *   - Every field has zero or more values for a record (see "Field values"). An EMPTY STRING counts
 *     as missing everywhere (ClickHouse maps return '' for absent keys; this rule makes the engines
 *     agree). A leaf on a missing field is false.
 *   - Logic is TWO-VALUED: `not` is plain negation, so `-@k:v` matches records without `k`. SQL
 *     compilers must make every leaf a definite boolean (e.g. `coalesce(<leaf>, 0)`), never NULL.
 *   - `and` with no children is true, `or` with no children is false (the parser never emits these;
 *     it flattens nested and/or and unwraps single children).
 *
 * Field values (the record → value mapping; a field matches when ANY of its values matches)
 *   level → effective severity number (severityNumber, with ≤ 0 read as 9 = info)
 *   body → body · service → scopeName (display name; SQL engines resolve names to scope ids from the
 *   boundary before compiling) · scope → `${scope.kind}:${scope.id}` · kind → scope.kind
 *   project → projectId, and also scopeName when scope.kind = 'project' (so id or slug both match)
 *   deployment → deploymentId · build → buildId · job → jobRunId · node → nodeId (a server may rewrite
 *   node names to ids before compiling) · replica → replica (number) · source · stream · channel ·
 *   pattern → patternId · trace → traceId · span → spanId · request → requestId
 *   @key → attributes[key] · resource.key → resource[key]
 *
 * Leaves
 *   text {value, phrase}    body search, case-insensitive for ASCII letters. Non-ASCII letters
 *                           compare exactly here and in SQLite (`lower` folds ASCII only); a
 *                           ClickHouse ILIKE substring may also fold them. Two forms:
 *                           - TOKEN: `phrase` false and the value is one run of letters/digits
 *                             (`isLogTokenSearch`, /^[\p{L}\p{N}]+$/u). Matches when the body has
 *                             that whole token, where body tokens are the maximal runs between
 *                             ASCII characters that are not letters or digits (`_` separates;
 *                             non-ASCII characters are token characters), like ClickHouse
 *                             `hasToken` over lower(body). `time` does NOT match `timeout`;
 *                             `timeout` matches `upstream-Timeout:` but not `UpstreamTimeout`.
 *                           - SUBSTRING: a quoted phrase, or a bare word with any other character
 *                             (`user@example.com`, `foo*`, `12:30`). Matches when the body
 *                             contains the value.
 *                           `logTextMatches` is the reference implementation. SQLite emulates
 *                           tokens with `' ' || <lower(body), separators → spaces> || ' ' LIKE
 *                           '% tok %'`; ClickHouse uses hasToken / hasTokenCaseInsensitive
 *                           (substrings: ILIKE or positionCaseInsensitive).
 *   field eq, string value  case-insensitive equality of the whole value. A `body` eq node only
 *                           comes from `body:=x` and means the WHOLE body equals x (`body:x` parses
 *                           to a text node).
 *   field eq, number value  numeric equality (only `replica`); the stored value is parsed as a number.
 *   wildcard                glob anchored at both ends, case-insensitive; `*` = any run of
 *                           characters (including none); every other character is literal (no `?`).
 *                           Use `splitLogGlob` to build LIKE/ILIKE patterns with your own escaping.
 *   regex                   unanchored search (`RegExp.test`, ClickHouse `match`), CASE-SENSITIVE
 *                           unless the pattern starts with RE2 flags like `(?i)` (see
 *                           `logRegexSource`). The parser rejects patterns over
 *                           LOG_REGEX_MAX_LENGTH, invalid ones, and anything outside the safe
 *                           subset of `checkRegexSafety` (log-regex.ts): lookaround, backreferences,
 *                           repeated groups holding `|` or a quantifier (`(a+)+`, `(a|aa)*`), more
 *                           than 2 unbounded repeats, and overlapping repeats like `.*x.*y`.
 *                           The JS predicate tests only the first LOG_REGEX_JS_SUBJECT_MAX (2 KiB)
 *                           characters of each value; ClickHouse (RE2, linear) tests all of it, so
 *                           a match past 2 KiB shows in search but not in live tail or rules.
 *                           Search: ClickHouse only.
 *   gt/gte/lt/lte           numeric: the stored value is parsed with `parseLogNumber` (decimal,
 *                           optional sign/fraction/exponent, surrounding whitespace ignored); a
 *                           value that is not a number is false. AST value is a number.
 *   exists                  the field has at least one non-empty value. `level:*` is rejected.
 *
 * `level` (value is always a severity band name in the AST; input accepts `severityForText`
 * words like `warning`/`err` and OTel numbers 1–24). With lo = SEVERITY_NUMBER[band] and hi = the next
 * band's lo (25 after fatal), on the effective severity number n — see `logLevelBounds`:
 *   gte (`level:warn`) n ≥ lo · eq (`level:=warn`) lo ≤ n < hi · gt n ≥ hi · lt n < lo · lte n < hi
 *
 * Pipes (record order before any sort: newest first, ts desc)
 *   fields        output columns: ts, then each field in order. level → band name, replica → number.
 *   dedup f       newest record per distinct value of f (records missing f form one group), plus a
 *                 `count` column of records collapsed into it; output columns: the record + count.
 *   stats         one row per distinct by-key; columns are the `by` aliases in order, then the
 *                 aggregation aliases in order. Group key values: level → band name; bin → bucket
 *                 start (epoch ms, floor(ts / interval) * interval, UTC); missing → null key.
 *                 count() counts rows; count_distinct(f) counts distinct non-missing values;
 *                 sum/avg/min/max/pNN parse values as numbers and ignore missing or non-numeric ones
 *                 (null when none). pNN is a quantile (engines may approximate). Numeric aggregations
 *                 accept attributes, resource fields, `replica` and `level` (severity number) only.
 *                 Unsorted stats: by bin ascending when grouped by bin, else by the first
 *                 aggregation descending.
 *   patterns      columns `LOG_PATTERNS_COLUMNS` = pattern (id), template, count; with one sample
 *                 record id per row (`LogTableResult.sampleIds`). Unsorted: count descending.
 *   sort key      after stats: `key` is one of the stats aliases (the parser resolves `sort p95`
 *                 to the single `p95(...)` alias); after patterns: a pattern column; otherwise `ts`,
 *                 `count` (only after dedup) or canonical field text (`level`, `@http.status`,
 *                 `resource.host.name`). Field sorts: ts by time, level by severity number, replica
 *                 numerically, attributes/resource numerically where the value parses as a number
 *                 (then the rest by string), other fields by string. Missing values sort last.
 *   limit n       at most n rows. Without a limit, table results are capped at
 *                 LOG_QUERY_LIMITS.maxLimit by the store.
 *
 * Aliases: the default alias of an aggregation is its canonical text (`count`, `p95(@duration_ms)`,
 * `count_distinct(service)`), of a bin `bin(5m)`, of a field group its canonical field text. Custom
 * aliases are identifiers. Aliases are unique, case-insensitively.
 *
 * Limits: LOG_QUERY_LIMITS. `maxNodes` counts filter AST nodes; `maxDepth` bounds both syntactic
 * nesting (groups and negations) and the depth of the filter tree (a single leaf is depth 1).
 *
 * Features (`requiredLogFeatures`): `attributes` = any attribute or resource field anywhere;
 * `regex` = any regex leaf; `stats` = any stats, dedup or fields stage; `patterns` = the patterns
 * stage or any reference to the `pattern` field.
 */

// ─── Public helpers other lanes share ─────────────────────────────────────────────────────────────

export const logAggregationFns: readonly LogAggregationFn[] = [
	'count',
	'count_distinct',
	'sum',
	'avg',
	'min',
	'max',
	'p50',
	'p90',
	'p95',
	'p99',
];

export const logPipeStageNames = ['fields', 'stats', 'patterns', 'dedup', 'sort', 'limit'] as const;
export type LogPipeStageName = (typeof logPipeStageNames)[number];

/** Output columns of `| patterns`, in order. */
export const LOG_PATTERNS_COLUMNS = ['pattern', 'template', 'count'] as const;

/** Longest regex the parser accepts (characters of the pattern between the slashes). */
export const LOG_REGEX_MAX_LENGTH = 512;

/** Query-name aliases for built-in fields. */
export const LOG_FIELD_ALIASES: Readonly<Record<string, BuiltinLogField>> = { message: 'body' };

/** Aggregations that take a number (everything except count and count_distinct). */
export const NUMERIC_LOG_AGGREGATIONS: readonly LogAggregationFn[] = [
	'sum',
	'avg',
	'min',
	'max',
	'p50',
	'p90',
	'p95',
	'p99',
];

const NUMBER_RE = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/** A bare search word that matches whole body tokens: one run of letters and digits (§6.1). */
export const LOG_TOKEN_WORD_RE = /^[\p{L}\p{N}]+$/u;

/** One or more body-token separators: every ASCII character that is not a letter or digit. */
export const LOG_TOKEN_SEPARATOR_RE = /[\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/;

/** ASCII codes of the body-token separators (NUL excluded), for SQL compilers that emulate tokens. */
export const LOG_TOKEN_SEPARATOR_CODES: readonly number[] = Array.from({ length: 127 }, (_, i) => i + 1).filter(
	(code) => !((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)),
);

/** Whether a text leaf is a whole-token search (bare, one letters/digits run) rather than a substring. */
export function isLogTokenSearch(node: { value: string; phrase: boolean }): boolean {
	return !node.phrase && LOG_TOKEN_WORD_RE.test(node.value);
}

/** Lower-case ASCII letters only, the case folding every engine shares (SQLite `lower`, ClickHouse `lower`). */
export function foldLogCase(text: string): string {
	return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/** The case-folded tokens of a body, split on `LOG_TOKEN_SEPARATOR_RE`. */
export function logBodyTokens(body: string): string[] {
	return foldLogCase(body)
		.split(LOG_TOKEN_SEPARATOR_RE)
		.filter((token) => token.length > 0);
}

/** Reference semantics of a text leaf (see "Leaves" above). An empty value matches everything. */
export function logTextMatches(body: string | null | undefined, value: string, phrase: boolean): boolean {
	if (!value) return true;
	const haystack = foldLogCase(body ?? '');
	const needle = foldLogCase(value);
	if (!isLogTokenSearch({ value, phrase })) return haystack.includes(needle);
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at < 0) return false;
		const before = at === 0 ? '' : haystack[at - 1]!;
		const after = haystack[at + needle.length] ?? '';
		if ((before === '' || LOG_TOKEN_SEPARATOR_RE.test(before)) && (after === '' || LOG_TOKEN_SEPARATOR_RE.test(after))) return true;
		from = at + 1;
	}
}

/** Strict number parse used for comparisons and numeric aggregations (`''`, `0x10`, `1e` → null). */
export function parseLogNumber(text: string): number | null {
	if (!NUMBER_RE.test(text)) return null;
	const n = Number(text);
	return Number.isFinite(n) ? n : null;
}

/**
 * Severity-number bounds for a `level` leaf: match when `n >= gte` (if set) and `n < lt` (if set).
 * Null when the value is not a band.
 */
export function logLevelBounds(op: LogFieldOp, value: string | number): { gte?: number; lt?: number } | null {
	const band = typeof value === 'number' ? severityForNumber(value) : severityForText(value);
	if (!band) return null;
	const lo = SEVERITY_NUMBER[band];
	const index = logSeverities.indexOf(band);
	const next = logSeverities[index + 1];
	const hi = next ? SEVERITY_NUMBER[next] : 25;
	switch (op) {
		case 'gte':
			return { gte: lo };
		case 'eq':
			return { gte: lo, lt: hi };
		case 'gt':
			return { gte: hi };
		case 'lt':
			return { lt: lo };
		case 'lte':
			return { lt: hi };
		default:
			return null;
	}
}

/** The literal segments of a glob, split on `*`: `a*b*` → ['a', 'b', '']. */
export function splitLogGlob(glob: string): string[] {
	return glob.split('*');
}

/** A glob as an anchored, case-insensitive RegExp. */
export function logGlobToRegExp(glob: string): RegExp {
	const source = splitLogGlob(glob)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
		.join('[\\s\\S]*');
	return new RegExp(`^${source}$`, 'i');
}

/**
 * Split RE2 leading inline flags (`(?i)`, `(?s)`, `(?m)`, combined like `(?is)`) into JS flags.
 * ClickHouse passes the pattern through unchanged; JS needs them as RegExp flags.
 */
export function logRegexSource(pattern: string): { source: string; flags: string } {
	const match = /^\(\?([ims]+)\)/.exec(pattern);
	if (!match) return { source: pattern, flags: '' };
	return { source: pattern.slice(match[0].length), flags: [...new Set(match[1])].join('') };
}

const ATTR_KEY_RE = /^[A-Za-z0-9_][\w.\-]*$/;

/** Resolve a field name as written in a query (`level`, `Message`, `@http.status`, `resource.x`). */
export function parseLogFieldName(name: string): LogFieldRef | null {
	if (name.startsWith('@')) {
		const key = name.slice(1);
		if (/^resource\./i.test(key)) {
			const rest = key.slice('resource.'.length);
			return ATTR_KEY_RE.test(rest) ? { kind: 'resource', key: rest } : null;
		}
		return ATTR_KEY_RE.test(key) ? { kind: 'attribute', key } : null;
	}
	if (/^resource\./i.test(name)) {
		const rest = name.slice('resource.'.length);
		return ATTR_KEY_RE.test(rest) ? { kind: 'resource', key: rest } : null;
	}
	const lower = name.toLowerCase();
	const alias = LOG_FIELD_ALIASES[lower];
	if (alias) return { kind: 'builtin', name: alias };
	if (Object.hasOwn(builtinLogFields, lower)) return { kind: 'builtin', name: lower as BuiltinLogField };
	return null;
}

/** Canonical text of a field reference. */
export function formatLogFieldRef(ref: LogFieldRef): string {
	if (ref.kind === 'builtin') return ref.name;
	if (ref.kind === 'attribute') return `@${ref.key}`;
	return `resource.${ref.key}`;
}

/** The non-empty values of a field on a record (see "Field values" above). */
export function logFieldValues(record: LogRecord, ref: LogFieldRef): Array<string | number> {
	const out: Array<string | number> = [];
	const push = (value: string | number | null | undefined) => {
		if (value === null || value === undefined || value === '') return;
		out.push(value);
	};
	if (ref.kind === 'attribute') {
		push(record.attributes?.[ref.key]);
		return out;
	}
	if (ref.kind === 'resource') {
		push(record.resource?.[ref.key]);
		return out;
	}
	switch (ref.name) {
		case 'level':
			push(effectiveSeverityNumber(record));
			break;
		case 'body':
			push(record.body);
			break;
		case 'service':
			push(record.scopeName);
			break;
		case 'scope':
			push(`${record.scope.kind}:${record.scope.id}`);
			break;
		case 'kind':
			push(record.scope.kind);
			break;
		case 'project':
			push(record.projectId);
			if (record.scope.kind === 'project') push(record.scopeName);
			break;
		case 'deployment':
			push(record.deploymentId);
			break;
		case 'build':
			push(record.buildId);
			break;
		case 'job':
			push(record.jobRunId);
			break;
		case 'node':
			push(record.nodeId);
			break;
		case 'replica':
			push(record.replica);
			break;
		case 'source':
			push(record.source);
			break;
		case 'stream':
			push(record.stream);
			break;
		case 'channel':
			push(record.channel);
			break;
		case 'pattern':
			push(record.patternId);
			break;
		case 'trace':
			push(record.traceId);
			break;
		case 'span':
			push(record.spanId);
			break;
		case 'request':
			push(record.requestId);
			break;
	}
	return out;
}

function effectiveSeverityNumber(record: LogRecord): number {
	const n = record.severityNumber;
	return Number.isFinite(n) && n > 0 ? n : SEVERITY_NUMBER.info;
}

/** Parse a level value (`warn`, `WARNING`, `err`, `17`) into its band. */
export function parseLogLevelValue(text: string): LogSeverity | null {
	const n = parseLogNumber(text);
	if (n !== null) return Number.isInteger(n) && n >= 1 && n <= 24 ? severityForNumber(n) : null;
	return severityForText(text);
}

// ─── Parser ───────────────────────────────────────────────────────────────────────────────────────

class ParseFailure extends Error {
	constructor(readonly error: LogQueryError) {
		super(error.message);
	}
}

/** `name:` at a term start. Bare names start with a letter or `_` so `12:30:00` stays text. */
const FIELD_NAME_RE = /(?:@[A-Za-z0-9_][\w.\-]*|[A-Za-z_][\w.\-]*):/y;
const WORD_STOP = new Set(['(', ')', '"', '|']);
const WORD_ESCAPABLE = new Set(['(', ')', '"', '|', '\\', '*', '-', '@', ':', '>', '<', '=', '/']);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ALIASES = new Set(['by', 'as', 'asc', 'desc']);
const DURATION_RE = /^(\d{1,9})(ms|s|m|h|d)$/i;
const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const STAGE_ORDER: Record<LogPipeStageName, number> = { fields: 0, dedup: 1, stats: 2, patterns: 2, sort: 3, limit: 4 };

function isWs(ch: string | undefined): boolean {
	return ch !== undefined && /\s/.test(ch);
}

/** End of a term: end of input, whitespace, `)` or `|`. */
function isTerminator(ch: string | undefined): boolean {
	return ch === undefined || isWs(ch) || ch === ')' || ch === '|';
}

interface Word {
	value: string;
	/** An unescaped `*` appeared. */
	star: boolean;
	start: number;
	end: number;
}

interface PipeToken {
	kind: 'word' | '(' | ')' | ',' | '|' | 'end';
	text: string;
	start: number;
	end: number;
}

class Parser {
	pos = 0;
	nesting = 0;

	constructor(readonly src: string) {}

	fail(message: string, start: number, end: number = start + 1, hint?: string): never {
		const len = this.src.length;
		const s = Math.max(0, Math.min(start, len));
		const e = Math.max(s, Math.min(end, len));
		throw new ParseFailure(hint ? { message, start: s, end: e, hint } : { message, start: s, end: e });
	}

	peek(offset = 0): string | undefined {
		return this.src[this.pos + offset];
	}

	skipWs(): void {
		while (isWs(this.src[this.pos])) this.pos++;
	}

	keywordAt(word: 'OR' | 'AND' | 'NOT'): boolean {
		if (!this.src.startsWith(word, this.pos)) return false;
		const after = this.src[this.pos + word.length];
		return after === undefined || isWs(after) || WORD_STOP.has(after);
	}

	parse(): LogQueryAst {
		this.skipWs();
		let filter: LogQueryNode | null = null;
		const filterStart = this.pos;
		if (this.pos < this.src.length && this.peek() !== '|') {
			filter = this.parseOr();
			this.skipWs();
			if (this.peek() === ')') this.fail('Unmatched `)`', this.pos);
			checkFilterLimits(filter, this, filterStart);
		}
		const pipes: LogPipeStage[] = [];
		const seen = new Set<LogPipeStageName>();
		let lastOrder = -1;
		let lastName: LogPipeStageName | null = null;
		while (this.pos < this.src.length) {
			const barAt = this.pos;
			this.pos++; // the `|`
			const { stage, name, start, end } = this.parseStage(pipes);
			if (seen.has(name) || (name === 'stats' && seen.has('patterns')) || (name === 'patterns' && seen.has('stats'))) {
				this.fail(
					name === 'stats' || name === 'patterns' ? 'Only one `stats` or `patterns` stage is allowed' : `Only one \`${name}\` stage is allowed`,
					start,
					end,
				);
			}
			if ((name === 'stats' || name === 'patterns') && (seen.has('fields') || seen.has('dedup'))) {
				this.fail(`\`${name}\` can't be combined with \`${seen.has('fields') ? 'fields' : 'dedup'}\``, start, end);
			}
			if (STAGE_ORDER[name] < lastOrder && lastName) {
				this.fail(`\`${name}\` must come before \`${lastName}\``, start, end, 'stage order: fields, dedup, stats or patterns, sort, limit');
			}
			seen.add(name);
			lastOrder = STAGE_ORDER[name];
			lastName = name;
			pipes.push(stage);
			if (pipes.length > LOG_QUERY_LIMITS.maxPipes) this.fail(`More than ${LOG_QUERY_LIMITS.maxPipes} pipe stages`, barAt, end);
			this.skipWs();
		}
		return { filter, pipes };
	}

	// ── Filter ──

	parseOr(): LogQueryNode {
		const children = [this.parseAnd()];
		for (;;) {
			this.skipWs();
			if (!this.keywordAt('OR')) break;
			const at = this.pos;
			this.pos += 2;
			this.skipWs();
			if (isTerminator(this.peek()) || this.keywordAt('OR') || this.keywordAt('AND')) {
				this.fail('Expected a term after `OR`', at, at + 2);
			}
			children.push(this.parseAnd());
		}
		return combine('or', children);
	}

	parseAnd(): LogQueryNode {
		const children: LogQueryNode[] = [];
		for (;;) {
			this.skipWs();
			const ch = this.peek();
			if (ch === undefined || ch === ')' || ch === '|') break;
			if (this.keywordAt('OR')) {
				if (children.length === 0) this.fail('Expected a term before `OR`', this.pos, this.pos + 2);
				break;
			}
			if (this.keywordAt('AND')) {
				const at = this.pos;
				if (children.length === 0) this.fail('Expected a term before `AND`', at, at + 3);
				this.pos += 3;
				this.skipWs();
				if (isTerminator(this.peek()) || this.keywordAt('OR') || this.keywordAt('AND')) {
					this.fail('Expected a term after `AND`', at, at + 3);
				}
			}
			children.push(this.parseUnary());
		}
		if (children.length === 0) this.fail('Expected a search term', this.pos, this.pos + 1);
		return combine('and', children);
	}

	parseUnary(): LogQueryNode {
		this.skipWs();
		const start = this.pos;
		if (this.peek() === '-') {
			if (isTerminator(this.peek(1))) {
				this.fail('Nothing to negate after `-`', start, start + 1, 'quote it to search for a literal "-"');
			}
			this.pos++;
			return this.negate(start);
		}
		if (this.keywordAt('NOT')) {
			this.pos += 3;
			this.skipWs();
			if (isTerminator(this.peek()) || this.keywordAt('OR') || this.keywordAt('AND')) {
				this.fail('Expected a term after `NOT`', start, start + 3);
			}
			return this.negate(start);
		}
		return this.parsePrimary();
	}

	negate(start: number): LogQueryNode {
		this.enter(start);
		const child = this.parseUnary();
		this.nesting--;
		return { type: 'not', child };
	}

	enter(start: number): void {
		this.nesting++;
		if (this.nesting > LOG_QUERY_LIMITS.maxDepth) {
			this.fail(`Nested more than ${LOG_QUERY_LIMITS.maxDepth} levels deep`, start, start + 1);
		}
	}

	parsePrimary(): LogQueryNode {
		const start = this.pos;
		const ch = this.peek();
		if (ch === '(') {
			this.pos++;
			this.enter(start);
			this.skipWs();
			if (this.peek() === ')') this.fail('Empty group `()`', start, this.pos + 1);
			const inner = this.parseOr();
			this.skipWs();
			if (this.peek() !== ')') this.fail('Missing `)`', start, start + 1, 'close the group opened here');
			this.pos++;
			this.nesting--;
			return inner;
		}
		if (ch === ')') this.fail('Unexpected `)`', start);
		if (ch === '"') {
			const quoted = this.readQuoted();
			if (!quoted) this.fail('Empty phrase `""`', start, this.pos);
			return { type: 'text', value: quoted, phrase: true };
		}
		if (this.keywordAt('OR')) this.fail('Expected a term before `OR`', start, start + 2);
		if (this.keywordAt('AND')) this.fail('Expected a term before `AND`', start, start + 3);
		FIELD_NAME_RE.lastIndex = start;
		const match = FIELD_NAME_RE.exec(this.src);
		if (match) return this.parseFieldTerm(match[0].slice(0, -1));
		const word = this.readWord();
		if (this.src[start] === '@') {
			this.fail('An attribute needs a value', start, word.end, `write ${this.src.slice(start, word.end)}:value, or ${this.src.slice(start, word.end)}:* for "has the field"`);
		}
		return { type: 'text', value: word.value, phrase: false };
	}

	/** Reads `"…"` at pos; returns the unescaped content. */
	readQuoted(): string {
		const start = this.pos;
		this.pos++;
		let value = '';
		while (this.pos < this.src.length) {
			const ch = this.src[this.pos]!;
			if (ch === '\\') {
				const next = this.src[this.pos + 1];
				if (next === '"' || next === '\\') {
					value += next;
					this.pos += 2;
					continue;
				}
				value += '\\';
				this.pos++;
				continue;
			}
			if (ch === '"') {
				this.pos++;
				return value;
			}
			value += ch;
			this.pos++;
		}
		return this.fail('Unterminated quote', start, this.src.length, 'close it with "');
	}

	/** Reads an unquoted word at pos (stops at whitespace and ( ) " |; handles `\` escapes). */
	readWord(): Word {
		const start = this.pos;
		let value = '';
		let star = false;
		while (this.pos < this.src.length) {
			const ch = this.src[this.pos]!;
			if (isWs(ch) || WORD_STOP.has(ch)) break;
			if (ch === '\\') {
				const next = this.src[this.pos + 1];
				if (next !== undefined && (isWs(next) || WORD_ESCAPABLE.has(next))) {
					value += next;
					this.pos += 2;
					continue;
				}
				value += '\\';
				this.pos++;
				continue;
			}
			if (ch === '*') star = true;
			value += ch;
			this.pos++;
		}
		return { value, star, start, end: this.pos };
	}

	/** At a `/`: reads `/…/` when the closing slash ends the term; otherwise leaves pos and returns null. */
	tryReadRegex(): string | null {
		const start = this.pos;
		let i = start + 1;
		let value = '';
		while (i < this.src.length) {
			const ch = this.src[i]!;
			if (ch === '\\') {
				const next = this.src[i + 1];
				if (next === '/') {
					value += '/';
					i += 2;
					continue;
				}
				value += next === undefined ? '\\' : `\\${next}`;
				i += next === undefined ? 1 : 2;
				continue;
			}
			if (ch === '/') {
				if (!isTerminator(this.src[i + 1])) return null;
				this.pos = i + 1;
				return value;
			}
			value += ch;
			i++;
		}
		return null;
	}

	resolveField(name: string, start: number): LogFieldRef {
		const ref = parseLogFieldName(name);
		if (ref) return ref;
		const end = start + name.length;
		if (name.startsWith('@') || /^resource\./i.test(name)) this.fail(`Invalid field name \`${name}\``, start, end);
		const suggestion = suggestLogQueryName(name.toLowerCase(), [...Object.keys(builtinLogFields), ...Object.keys(LOG_FIELD_ALIASES)]);
		this.fail(
			`Unknown field \`${name}\``,
			start,
			end,
			suggestion
				? `did you mean \`${suggestion}\`?`
				: `write \`@${name}\` for an attribute, or quote text that contains a colon`,
		);
	}

	parseFieldTerm(name: string): LogQueryNode {
		const nameStart = this.pos;
		const ref = this.resolveField(name, nameStart);
		this.pos += name.length + 1;
		const isLevel = ref.kind === 'builtin' && ref.name === 'level';
		const isReplica = ref.kind === 'builtin' && ref.name === 'replica';
		const isBody = ref.kind === 'builtin' && ref.name === 'body';
		const label = formatLogFieldRef(ref);

		if (isTerminator(this.peek())) {
			this.fail(`Missing value after \`${name}:\``, nameStart, this.pos, `e.g. ${name}:value, or ${name}:* for "has the field"`);
		}
		let op: 'gt' | 'gte' | 'lt' | 'lte' | 'exact' | null = null;
		const opStart = this.pos;
		if (this.src.startsWith('>=', this.pos)) op = 'gte';
		else if (this.src.startsWith('<=', this.pos)) op = 'lte';
		else if (this.peek() === '>') op = 'gt';
		else if (this.peek() === '<') op = 'lt';
		else if (this.peek() === '=') op = 'exact';
		if (op) {
			this.pos += op === 'gte' || op === 'lte' ? 2 : 1;
			if (isTerminator(this.peek())) this.fail('Missing value after the operator', opStart, this.pos);
		}

		const valueStart = this.pos;
		let value: string;
		let quoted = false;
		let star = false;
		let regex = false;
		if (this.peek() === '"') {
			value = this.readQuoted();
			quoted = true;
		} else {
			const re = !op && this.peek() === '/' ? this.tryReadRegex() : null;
			if (re !== null) {
				value = re;
				regex = true;
			} else {
				const word = this.readWord();
				value = word.value;
				star = word.star;
			}
		}
		const valueEnd = this.pos;
		const termEnd = valueEnd;
		if (value === '') {
			if (regex) this.fail('Empty regex `//`', valueStart, valueEnd);
			this.fail('Empty value', valueStart, valueEnd, `use -${name}:* for "field is missing"`);
		}

		if (regex) {
			if (isLevel || isReplica) this.fail(`\`${label}\` can't be matched with a regex`, nameStart, termEnd);
			const problem = checkLogRegex(value);
			if (problem) this.fail(problem, valueStart, valueEnd);
			return { type: 'field', field: ref, op: 'regex', value };
		}

		if (isLevel) {
			if (!quoted && value === '*' && op === null) {
				this.fail('`level` takes a severity', nameStart, termEnd, 'e.g. level:warn (warn or worse) or level:=warn (exactly warn)');
			}
			const band = parseLogLevelValue(value);
			if (!band) {
				this.fail(`Unknown level \`${value}\``, valueStart, valueEnd, `one of ${logSeverities.join(', ')}`);
			}
			const levelOp: LogFieldOp = op === null ? 'gte' : op === 'exact' ? 'eq' : op;
			return { type: 'field', field: ref, op: levelOp, value: band };
		}

		if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
			if (ref.kind === 'builtin' && !isReplica) {
				this.fail(`\`${label}\` is not numeric, so it can't be compared with ${this.src.slice(opStart, valueStart)}`, nameStart, termEnd, 'comparisons work on attributes, resource fields, replica and level');
			}
			const n = parseLogNumber(value);
			if (n === null) this.fail(`\`${value}\` is not a number`, valueStart, valueEnd);
			return { type: 'field', field: ref, op, value: n };
		}

		if (isReplica) {
			if (!quoted && value === '*' && op === null) return { type: 'exists', field: ref };
			const n = parseLogNumber(value);
			if (n === null) this.fail('`replica` is a number', valueStart, valueEnd, 'e.g. replica:0 or replica:>0');
			return { type: 'field', field: ref, op: 'eq', value: n };
		}

		if (op === 'exact') return { type: 'field', field: ref, op: 'eq', value };
		if (!quoted && value === '*') return { type: 'exists', field: ref };
		if (!quoted && star) return { type: 'field', field: ref, op: 'wildcard', value };
		if (isBody) return { type: 'text', value, phrase: quoted };
		return { type: 'field', field: ref, op: 'eq', value };
	}

	// ── Pipes ──

	nextToken(): PipeToken {
		this.skipWs();
		const start = this.pos;
		const ch = this.src[start];
		if (ch === undefined) return { kind: 'end', text: '', start, end: start };
		if (ch === '(' || ch === ')' || ch === ',' || ch === '|') {
			this.pos++;
			return { kind: ch, text: ch, start, end: this.pos };
		}
		while (this.pos < this.src.length) {
			const c = this.src[this.pos]!;
			if (isWs(c) || c === '(' || c === ')' || c === ',' || c === '|') break;
			this.pos++;
		}
		return { kind: 'word', text: this.src.slice(start, this.pos), start, end: this.pos };
	}

	peekToken(): PipeToken {
		const saved = this.pos;
		const token = this.nextToken();
		this.pos = saved;
		return token;
	}

	expect(kind: PipeToken['kind'], what: string): PipeToken {
		const token = this.nextToken();
		if (token.kind !== kind) this.fail(`Expected ${what}`, token.start, Math.max(token.end, token.start + 1));
		return token;
	}

	peekKeyword(word: string): boolean {
		const token = this.peekToken();
		return token.kind === 'word' && token.text.toLowerCase() === word;
	}

	parseStage(previous: LogPipeStage[]): { stage: LogPipeStage; name: LogPipeStageName; start: number; end: number } {
		const head = this.nextToken();
		if (head.kind !== 'word') {
			this.fail('Expected a pipe stage after `|`', head.start, Math.max(head.end, head.start + 1), `one of ${logPipeStageNames.join(', ')}`);
		}
		const lower = head.text.toLowerCase();
		if (!(logPipeStageNames as readonly string[]).includes(lower)) {
			const suggestion = suggestLogQueryName(lower, logPipeStageNames);
			this.fail(`Unknown stage \`${head.text}\``, head.start, head.end, suggestion ? `did you mean \`${suggestion}\`?` : `one of ${logPipeStageNames.join(', ')}`);
		}
		const name = lower as LogPipeStageName;
		let stage: LogPipeStage;
		switch (name) {
			case 'fields':
				stage = this.parseFieldsStage(head);
				break;
			case 'stats':
				stage = this.parseStatsStage();
				break;
			case 'patterns':
				stage = { type: 'patterns' };
				break;
			case 'dedup':
				stage = { type: 'dedup', field: this.parsePipeField(this.expect('word', 'a field to dedup by')) };
				break;
			case 'sort':
				stage = this.parseSortStage(previous);
				break;
			case 'limit': {
				const token = this.expect('word', 'a row count');
				if (!/^\d+$/.test(token.text)) this.fail('`limit` takes a whole number', token.start, token.end);
				const count = Number(token.text);
				if (count < 1 || count > LOG_QUERY_LIMITS.maxLimit) {
					this.fail(`\`limit\` must be between 1 and ${LOG_QUERY_LIMITS.maxLimit}`, token.start, token.end);
				}
				stage = { type: 'limit', count };
				break;
			}
		}
		const after = this.peekToken();
		if (after.kind !== '|' && after.kind !== 'end') {
			this.fail(`Unexpected \`${after.text}\``, after.start, after.end, after.kind === ',' ? undefined : 'separate stages with |');
		}
		return { stage, name, start: head.start, end: this.pos };
	}

	parsePipeField(token: PipeToken): LogFieldRef {
		if (token.kind !== 'word') this.fail('Expected a field', token.start, Math.max(token.end, token.start + 1));
		return this.resolveField(token.text, token.start);
	}

	parseFieldsStage(head: PipeToken): LogPipeStage {
		const fields: LogFieldRef[] = [];
		let sawTs = false;
		for (;;) {
			const token = this.expect('word', 'a field name');
			const lower = token.text.toLowerCase();
			if (lower === 'ts' || lower === 'timestamp') sawTs = true;
			else fields.push(this.parsePipeField(token));
			if (this.peekToken().kind !== ',') break;
			this.nextToken();
		}
		if (fields.length === 0) {
			this.fail(sawTs ? '`ts` is always shown; list the other fields to show' : 'Expected a field name', head.start, this.pos);
		}
		if (fields.length > 30) this.fail('`fields` takes at most 30 fields', head.start, this.pos);
		return { type: 'fields', fields };
	}

	parseStatsStage(): LogPipeStage {
		const aggregations: LogAggregation[] = [];
		const by: LogGroupBy[] = [];
		const aliases = new Map<string, number>();
		const claim = (alias: string, start: number, end: number) => {
			const key = alias.toLowerCase();
			if (aliases.has(key)) this.fail(`Duplicate column \`${alias}\``, start, end, 'give one of them a different name with `as`');
			aliases.set(key, start);
		};
		for (;;) {
			const start = this.peekToken().start;
			const agg = this.parseAggregation();
			claim(agg.alias, start, this.pos);
			aggregations.push(agg);
			if (aggregations.length > LOG_QUERY_LIMITS.maxAggregations) {
				this.fail(`At most ${LOG_QUERY_LIMITS.maxAggregations} aggregations`, start, this.pos);
			}
			if (this.peekToken().kind !== ',') break;
			this.nextToken();
		}
		if (this.peekKeyword('by')) {
			this.nextToken();
			let sawBin = false;
			for (;;) {
				const start = this.peekToken().start;
				const group = this.parseGroupBy();
				if (group.type === 'bin') {
					if (sawBin) this.fail('Only one `bin()` per stats', start, this.pos);
					sawBin = true;
				}
				claim(group.alias, start, this.pos);
				by.push(group);
				if (by.length > LOG_QUERY_LIMITS.maxGroupBy) this.fail(`At most ${LOG_QUERY_LIMITS.maxGroupBy} group-by keys`, start, this.pos);
				if (this.peekToken().kind !== ',') break;
				this.nextToken();
			}
		}
		return { type: 'stats', aggregations, by };
	}

	parseAlias(fallback: string): string {
		if (!this.peekKeyword('as')) return fallback;
		this.nextToken();
		const token = this.expect('word', 'a column name after `as`');
		if (!IDENT_RE.test(token.text) || RESERVED_ALIASES.has(token.text.toLowerCase())) {
			this.fail(`\`${token.text}\` is not a valid column name`, token.start, token.end, 'use letters, digits and _');
		}
		return token.text;
	}

	parseAggregation(): LogAggregation {
		const token = this.expect('word', 'an aggregation such as count()');
		const fnName = token.text.toLowerCase();
		if (!(logAggregationFns as readonly string[]).includes(fnName)) {
			const suggestion = suggestLogQueryName(fnName, logAggregationFns);
			this.fail(`Unknown aggregation \`${token.text}\``, token.start, token.end, suggestion ? `did you mean \`${suggestion}()\`?` : `one of ${logAggregationFns.join(', ')}`);
		}
		const fn = fnName as LogAggregationFn;
		this.expect('(', `\`(\` after ${fn}`);
		let field: LogFieldRef | undefined;
		if (fn === 'count') {
			const inner = this.peekToken();
			if (inner.kind === 'word') {
				if (inner.text !== '*') this.fail('`count()` takes no field', inner.start, inner.end, 'use count_distinct(field) to count distinct values');
				this.nextToken();
			}
		} else {
			const inner = this.nextToken();
			if (inner.kind !== 'word' || inner.text === '*') this.fail(`\`${fn}\` needs a field`, inner.start, Math.max(inner.end, inner.start + 1));
			field = this.parsePipeField(inner);
			if (NUMERIC_LOG_AGGREGATIONS.includes(fn) && field.kind === 'builtin' && field.name !== 'replica' && field.name !== 'level') {
				this.fail(`\`${fn}\` needs a numeric field`, inner.start, inner.end, 'use an attribute (@duration_ms), a resource field, replica or level');
			}
		}
		this.expect(')', '`)`');
		const alias = this.parseAlias(defaultLogAggregationAlias({ fn, field }));
		return field ? { fn, field, alias } : { fn, alias };
	}

	parseGroupBy(): LogGroupBy {
		const token = this.expect('word', 'a group-by field or bin(…)');
		if (token.text.toLowerCase() === 'bin' && this.peekToken().kind === '(') {
			this.nextToken();
			const dur = this.expect('word', 'an interval like 5m');
			const match = DURATION_RE.exec(dur.text);
			if (!match) this.fail(`\`${dur.text}\` is not an interval`, dur.start, dur.end, 'e.g. 30s, 5m, 1h, 1d');
			const raw = Number(match[1]) * DURATION_UNITS[match[2]!.toLowerCase()]!;
			const intervalMs = Math.min(LOG_QUERY_LIMITS.maxBinMs, Math.max(LOG_QUERY_LIMITS.minBinMs, raw));
			this.expect(')', '`)`');
			return { type: 'bin', intervalMs, alias: this.parseAlias(`bin(${formatLogDuration(intervalMs)})`) };
		}
		const field = this.parsePipeField(token);
		return { type: 'field', field, alias: this.parseAlias(formatLogFieldRef(field)) };
	}

	parseSortStage(previous: LogPipeStage[]): LogPipeStage {
		const token = this.expect('word', 'a sort key');
		const text = token.text;
		let call: { name: string; arg: string | null } | null = null;
		if (this.peekToken().kind === '(') {
			this.nextToken();
			const inner = this.nextToken();
			let arg: string | null = null;
			if (inner.kind === 'word') {
				arg = inner.text;
				this.expect(')', '`)`');
			} else if (inner.kind !== ')') {
				this.fail('Expected `)`', inner.start, Math.max(inner.end, inner.start + 1));
			}
			call = { name: token.text.toLowerCase(), arg };
		}
		const keyEnd = this.pos;
		const key = this.resolveSortKey(previous, text, call, token.start, keyEnd);
		let direction: 'asc' | 'desc' = 'asc';
		const dir = this.peekToken();
		if (dir.kind === 'word' && (dir.text.toLowerCase() === 'asc' || dir.text.toLowerCase() === 'desc')) {
			this.nextToken();
			direction = dir.text.toLowerCase() as 'asc' | 'desc';
		}
		return { type: 'sort', key, direction };
	}

	resolveSortKey(previous: LogPipeStage[], text: string, call: { name: string; arg: string | null } | null, start: number, end: number): string {
		const stats = previous.find((stage) => stage.type === 'stats');
		const patterns = previous.some((stage) => stage.type === 'patterns');
		const dedup = previous.some((stage) => stage.type === 'dedup');

		// Canonical text of what was written, for alias matching.
		let canonical = text;
		if (call) {
			if (call.name === 'bin') {
				const match = call.arg ? DURATION_RE.exec(call.arg) : null;
				if (!match) this.fail('Expected an interval inside bin()', start, end);
				const raw = Number(match[1]) * DURATION_UNITS[match[2]!.toLowerCase()]!;
				canonical = `bin(${formatLogDuration(Math.min(LOG_QUERY_LIMITS.maxBinMs, Math.max(LOG_QUERY_LIMITS.minBinMs, raw)))})`;
			} else if (call.name === 'count') {
				canonical = 'count';
			} else {
				const fieldRef = call.arg ? parseLogFieldName(call.arg) : null;
				canonical = `${call.name}(${fieldRef ? formatLogFieldRef(fieldRef) : (call.arg ?? '')})`;
			}
		} else {
			const fieldRef = parseLogFieldName(text);
			if (fieldRef) canonical = formatLogFieldRef(fieldRef);
		}

		if (stats && stats.type === 'stats') {
			const aliases = [...stats.by.map((group) => group.alias), ...stats.aggregations.map((agg) => agg.alias)];
			const exact = aliases.find((alias) => alias.toLowerCase() === canonical.toLowerCase() || alias.toLowerCase() === text.toLowerCase());
			if (exact) return exact;
			if (!call) {
				const byFn = stats.aggregations.filter((agg) => agg.fn === text.toLowerCase());
				if (byFn.length === 1) return byFn[0]!.alias;
				if (byFn.length > 1) this.fail(`\`${text}\` is ambiguous`, start, end, `one of ${byFn.map((agg) => agg.alias).join(', ')}`);
			}
			const suggestion = suggestLogQueryName(canonical.toLowerCase(), aliases.map((alias) => alias.toLowerCase()));
			this.fail(`\`${text}\` is not a column of the stats result`, start, end, suggestion ? `did you mean \`${aliases.find((a) => a.toLowerCase() === suggestion)}\`?` : `one of ${aliases.join(', ')}`);
		}
		if (call) this.fail(`\`${text}(…)\` can only be sorted on after \`stats\``, start, end);
		if (patterns) {
			const column = LOG_PATTERNS_COLUMNS.find((name) => name === text.toLowerCase());
			if (!column) this.fail(`\`${text}\` is not a column of patterns`, start, end, `one of ${LOG_PATTERNS_COLUMNS.join(', ')}`);
			return column;
		}
		const lower = text.toLowerCase();
		if (lower === 'ts' || lower === 'timestamp') return 'ts';
		if (lower === 'count' && dedup) return 'count';
		return formatLogFieldRef(this.resolveField(text, start));
	}
}

function combine(type: 'and' | 'or', children: LogQueryNode[]): LogQueryNode {
	const flat: LogQueryNode[] = [];
	for (const child of children) {
		if (child.type === type) flat.push(...child.children);
		else flat.push(child);
	}
	return flat.length === 1 ? flat[0]! : { type, children: flat };
}

function countNodes(node: LogQueryNode): number {
	if (node.type === 'and' || node.type === 'or') return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
	if (node.type === 'not') return 1 + countNodes(node.child);
	return 1;
}

function treeDepth(node: LogQueryNode): number {
	if (node.type === 'and' || node.type === 'or') return 1 + Math.max(0, ...node.children.map(treeDepth));
	if (node.type === 'not') return 1 + treeDepth(node.child);
	return 1;
}

function checkFilterLimits(filter: LogQueryNode, parser: Parser, start: number): void {
	const nodes = countNodes(filter);
	if (nodes > LOG_QUERY_LIMITS.maxNodes) {
		parser.fail(`The query is too complex (${nodes} terms; the limit is ${LOG_QUERY_LIMITS.maxNodes})`, start, parser.pos);
	}
	if (treeDepth(filter) > LOG_QUERY_LIMITS.maxDepth) {
		parser.fail(`The query is nested more than ${LOG_QUERY_LIMITS.maxDepth} levels deep`, start, parser.pos);
	}
}

/** RE2-compatibility and safety checks for a regex leaf (the safe subset in log-regex.ts); null when acceptable. */
export function checkLogRegex(pattern: string): string | null {
	if (pattern.length > LOG_REGEX_MAX_LENGTH) return `Regex is longer than ${LOG_REGEX_MAX_LENGTH} characters`;
	const { source, flags } = logRegexSource(pattern);
	try {
		new RegExp(source, flags);
	} catch (error) {
		return `Invalid regex: ${error instanceof Error ? error.message.replace(/^Invalid regular expression: /, '') : 'syntax error'}`;
	}
	return checkRegexSafety(source, flags);
}

function levenshtein(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0]!;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = row[j]!;
			row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return row[b.length]!;
}

/** The closest candidate within a small edit distance (or a unique prefix match), else null. */
export function suggestLogQueryName(input: string, candidates: readonly string[]): string | null {
	if (!input) return null;
	let best: string | null = null;
	let bestDistance = Infinity;
	for (const candidate of candidates) {
		const distance = levenshtein(input, candidate);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	const allowed = input.length <= 3 ? 1 : 2;
	if (best && bestDistance <= allowed) return best;
	const prefixed = candidates.filter((candidate) => candidate.startsWith(input) || input.startsWith(candidate));
	return prefixed.length === 1 ? prefixed[0]! : null;
}

/** Parse query text into an AST. Total: never throws. */
export function parseLogQuery(text: string): LogQueryParseResult {
	if (text.length > LOG_QUERY_LIMITS.maxLength) {
		return {
			ok: false,
			error: {
				message: `The query is longer than ${LOG_QUERY_LIMITS.maxLength} characters`,
				start: LOG_QUERY_LIMITS.maxLength,
				end: text.length,
			},
		};
	}
	try {
		return { ok: true, ast: new Parser(text).parse() };
	} catch (error) {
		if (error instanceof ParseFailure) return { ok: false, error: error.error };
		return { ok: false, error: { message: 'Could not parse the query', start: 0, end: text.length } };
	}
}

// ─── Formatter ────────────────────────────────────────────────────────────────────────────────────

/** `300000` → `5m`; picks the largest unit that divides evenly. */
export function formatLogDuration(ms: number): string {
	for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1_000]] as const) {
		if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
	}
	return `${ms}ms`;
}

/** The alias an aggregation gets without `as`. */
export function defaultLogAggregationAlias(agg: { fn: LogAggregationFn; field?: LogFieldRef }): string {
	if (agg.fn === 'count') return 'count';
	return `${agg.fn}(${agg.field ? formatLogFieldRef(agg.field) : ''})`;
}

function quote(value: string): string {
	return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/** Would a value starting with `/` be read as a regex? Mirrors `tryReadRegex` on the written text. */
function looksLikeRegex(written: string): boolean {
	if (written[0] !== '/') return false;
	for (let i = 1; i < written.length; i++) {
		if (written[i] === '\\') {
			i++;
			continue;
		}
		if (written[i] === '/') return isTerminator(written[i + 1]);
	}
	return false;
}

function escapeWordChars(value: string, alsoStar: boolean): string {
	let out = '';
	for (const ch of value) {
		if (ch === '\\' || isWs(ch) || WORD_STOP.has(ch) || (alsoStar && ch === '*')) out += `\\${ch}`;
		else out += ch;
	}
	return out;
}

function formatBareText(value: string): string {
	// The parser never yields a bare keyword as text, so quoting it loses nothing that round-trips.
	if (value === '' || value === 'OR' || value === 'AND' || value === 'NOT') return quote(value);
	let out = escapeWordChars(value, false);
	if (out[0] === '-' || out[0] === '@') out = `\\${out}`;
	const name = /^[A-Za-z_][\w.\-]*:/.exec(out);
	if (name) out = `${name[0].slice(0, -1)}\\:${out.slice(name[0].length)}`;
	return out;
}

/** A value as written after `field:` for an exact match: bare when safe, otherwise quoted. */
export function formatLogQueryValue(value: string): string {
	const bare =
		value !== '' &&
		!/[\s()"|\\*]/.test(value) &&
		!/^[<>=]/.test(value) &&
		!(value[0] === '/' && value.length > 1 && value.indexOf('/', 1) === value.length - 1);
	return bare ? value : quote(value);
}

function formatGlobValue(value: string): string {
	let out = escapeWordChars(value, false);
	if (/^[<>="]/.test(out)) out = `\\${out}`;
	if (looksLikeRegex(out)) out = `\\${out}`;
	return out;
}

function formatRegexValue(value: string): string {
	let out = '';
	for (let i = 0; i < value.length; i++) {
		const ch = value[i]!;
		if (ch === '\\' && i + 1 < value.length) {
			out += ch + value[i + 1];
			i++;
		} else if (ch === '/') out += '\\/';
		else out += ch;
	}
	return `/${out}/`;
}

const OP_TEXT: Record<'gt' | 'gte' | 'lt' | 'lte', string> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };

function formatLeaf(node: Extract<LogQueryNode, { type: 'field' }>): string {
	const name = formatLogFieldRef(node.field);
	const isLevel = node.field.kind === 'builtin' && node.field.name === 'level';
	const value = node.value;
	if (isLevel && node.op !== 'wildcard' && node.op !== 'regex') {
		const band = (typeof value === 'number' ? severityForNumber(value) : parseLogLevelValue(value)) ?? String(value);
		if (node.op === 'gte') return `level:${band}`;
		if (node.op === 'eq') return `level:=${band}`;
		return `level:${OP_TEXT[node.op]}${band}`;
	}
	switch (node.op) {
		case 'eq':
			if (typeof value === 'number') return `${name}:${value}`;
			if (node.field.kind === 'builtin' && node.field.name === 'body') return `body:=${formatLogQueryValue(value)}`;
			if (node.field.kind === 'builtin' && node.field.name === 'replica') return `${name}:=${quote(value)}`;
			return `${name}:${formatLogQueryValue(value)}`;
		case 'wildcard':
			return `${name}:${formatGlobValue(String(value))}`;
		case 'regex':
			return `${name}:${formatRegexValue(String(value))}`;
		default:
			return `${name}:${OP_TEXT[node.op]}${value}`;
	}
}

/** Canonical text of one filter node (used for "filter to this value" in the UI too). */
export function formatLogFilter(node: LogQueryNode): string {
	const wrap = (child: LogQueryNode, when: boolean) => (when ? `(${formatLogFilter(child)})` : formatLogFilter(child));
	switch (node.type) {
		case 'or':
			return node.children.map((child) => wrap(child, child.type === 'or')).join(' OR ');
		case 'and':
			return node.children.map((child) => wrap(child, child.type === 'or' || child.type === 'and')).join(' ');
		case 'not':
			return `-${wrap(node.child, node.child.type === 'or' || node.child.type === 'and')}`;
		case 'text':
			return node.phrase ? quote(node.value) : formatBareText(node.value);
		case 'exists':
			return `${formatLogFieldRef(node.field)}:*`;
		case 'field':
			return formatLeaf(node);
	}
}

function formatStage(stage: LogPipeStage): string {
	switch (stage.type) {
		case 'fields':
			return `fields ${stage.fields.map(formatLogFieldRef).join(', ')}`;
		case 'stats': {
			const aggs = stage.aggregations.map((agg) => {
				const base = agg.fn === 'count' ? 'count()' : defaultLogAggregationAlias(agg);
				return agg.alias === defaultLogAggregationAlias(agg) ? base : `${base} as ${agg.alias}`;
			});
			const by = stage.by.map((group) => {
				const base = group.type === 'bin' ? `bin(${formatLogDuration(group.intervalMs)})` : formatLogFieldRef(group.field);
				return group.alias === base ? base : `${base} as ${group.alias}`;
			});
			return `stats ${aggs.join(', ')}${by.length ? ` by ${by.join(', ')}` : ''}`;
		}
		case 'patterns':
			return 'patterns';
		case 'dedup':
			return `dedup ${formatLogFieldRef(stage.field)}`;
		case 'sort':
			return `sort ${stage.key} ${stage.direction}`;
		case 'limit':
			return `limit ${stage.count}`;
	}
}

/**
 * Canonical text for an AST. For any AST from `parseLogQuery`, parsing the result gives back an
 * identical AST; a hand-built AST formats to an equivalent query.
 */
export function formatLogQuery(ast: LogQueryAst): string {
	const filter = ast.filter ? formatLogFilter(ast.filter) : '';
	const pipes = ast.pipes.map(formatStage);
	if (pipes.length === 0) return filter;
	return filter ? `${filter} | ${pipes.join(' | ')}` : `| ${pipes.join(' | ')}`;
}

// ─── JS predicate (live tail, rule previews) ──────────────────────────────────────────────────────

type Predicate = (record: LogRecord) => boolean;

function compileField(node: Extract<LogQueryNode, { type: 'field' }>): Predicate {
	const ref = node.field;
	const isLevel = ref.kind === 'builtin' && ref.name === 'level';
	if (isLevel && node.op !== 'wildcard' && node.op !== 'regex') {
		const bounds = logLevelBounds(node.op, node.value);
		if (!bounds) return () => false;
		return (record) => {
			const n = effectiveSeverityNumber(record);
			return (bounds.gte === undefined || n >= bounds.gte) && (bounds.lt === undefined || n < bounds.lt);
		};
	}
	const values = isLevel
		? (record: LogRecord): Array<string | number> => [severityForNumber(effectiveSeverityNumber(record))]
		: (record: LogRecord) => logFieldValues(record, ref);
	const any = (test: (value: string | number) => boolean): Predicate => (record) => values(record).some(test);
	switch (node.op) {
		case 'eq': {
			if (typeof node.value === 'number') {
				const target = node.value;
				return any((value) => (typeof value === 'number' ? value : parseLogNumber(value)) === target);
			}
			const target = node.value.toLowerCase();
			return any((value) => String(value).toLowerCase() === target);
		}
		case 'wildcard': {
			const re = logGlobToRegExp(String(node.value));
			return any((value) => re.test(String(value)));
		}
		case 'regex': {
			let re: RegExp;
			try {
				if (checkLogRegex(String(node.value))) return () => false;
				const { source, flags } = logRegexSource(String(node.value));
				re = new RegExp(source, flags);
			} catch {
				return () => false;
			}
			// Backtracking JS only sees the head of a value; ClickHouse (RE2) sees all of it.
			return any((value) => re.test(logRegexSubject(String(value))));
		}
		default: {
			const target = typeof node.value === 'number' ? node.value : parseLogNumber(node.value);
			if (target === null) return () => false;
			const op = node.op;
			return any((value) => {
				const n = typeof value === 'number' ? value : parseLogNumber(value);
				if (n === null) return false;
				if (op === 'gt') return n > target;
				if (op === 'gte') return n >= target;
				if (op === 'lt') return n < target;
				return n <= target;
			});
		}
	}
}

function compileNode(node: LogQueryNode): Predicate {
	switch (node.type) {
		case 'and': {
			const children = node.children.map(compileNode);
			return (record) => {
				for (const child of children) if (!child(record)) return false;
				return true;
			};
		}
		case 'or': {
			const children = node.children.map(compileNode);
			return (record) => {
				for (const child of children) if (child(record)) return true;
				return false;
			};
		}
		case 'not': {
			const child = compileNode(node.child);
			return (record) => !child(record);
		}
		case 'text': {
			const { value, phrase } = node;
			return (record) => logTextMatches(record.body, value, phrase);
		}
		case 'exists': {
			const ref = node.field;
			if (ref.kind === 'builtin' && ref.name === 'level') return () => true;
			return (record) => logFieldValues(record, ref).length > 0;
		}
		case 'field':
			return compileField(node);
	}
}

/** Compile a filter to a predicate for live tail and rule previews. */
export function compileLogPredicate(filter: LogQueryNode | null): (record: LogRecord) => boolean {
	if (!filter) return () => true;
	return compileNode(filter);
}

// ─── Feature detection ────────────────────────────────────────────────────────────────────────────

export type LogQueryFeature = 'attributes' | 'regex' | 'stats' | 'patterns';

/** Features an AST needs beyond lite mode (`regex`, `attributes`, `stats`, `patterns`). Empty = lite-safe. */
export function requiredLogFeatures(ast: LogQueryAst): Array<'attributes' | 'regex' | 'stats' | 'patterns'> {
	const found = new Set<LogQueryFeature>();
	const ref = (field: LogFieldRef | undefined) => {
		if (!field) return;
		if (field.kind !== 'builtin') found.add('attributes');
		else if (field.name === 'pattern') found.add('patterns');
	};
	const walk = (node: LogQueryNode) => {
		switch (node.type) {
			case 'and':
			case 'or':
				node.children.forEach(walk);
				break;
			case 'not':
				walk(node.child);
				break;
			case 'field':
				if (node.op === 'regex') found.add('regex');
				ref(node.field);
				break;
			case 'exists':
				ref(node.field);
				break;
			case 'text':
				break;
		}
	};
	if (ast.filter) walk(ast.filter);
	const tabular = ast.pipes.some((stage) => stage.type === 'stats' || stage.type === 'patterns');
	for (const stage of ast.pipes) {
		switch (stage.type) {
			case 'fields':
				found.add('stats');
				stage.fields.forEach(ref);
				break;
			case 'dedup':
				found.add('stats');
				ref(stage.field);
				break;
			case 'stats':
				found.add('stats');
				for (const agg of stage.aggregations) ref(agg.field);
				for (const group of stage.by) if (group.type === 'field') ref(group.field);
				break;
			case 'patterns':
				found.add('patterns');
				break;
			case 'sort':
				if (!tabular) {
					const field = parseLogFieldName(stage.key);
					if (field) ref(field);
				}
				break;
			case 'limit':
				break;
		}
	}
	return (['attributes', 'regex', 'stats', 'patterns'] as const).filter((feature) => found.has(feature));
}
