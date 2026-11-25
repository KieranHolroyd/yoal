/**
 * The log-query AST (docs/LOGS.md §6, LP3). One grammar is parsed here (`log-query.ts`) and
 * compiled server-side to SQLite (lite mode), ClickHouse SQL, or a JS predicate for live tail.
 * Compilers never see query text, only this tree, and they AND the caller's tenancy in themselves.
 */

/** Fields every record has. Query names are the keys; `level` compares by severity band. */
export const builtinLogFields = {
	level: { type: 'severity', description: 'Severity band; `level:warn` means warn or worse, `level:=warn` exactly warn.' },
	body: { type: 'string', description: 'The message text (bare words and "phrases" also search it).' },
	service: { type: 'string', description: 'Scope display name: project slug, database or broker name.' },
	scope: { type: 'string', description: 'Scope as kind:id, e.g. project:prj_123.' },
	kind: { type: 'string', description: 'Scope kind: project, database, storage, broker, k8s, pipeline, function, edge, platform.' },
	project: { type: 'string', description: 'Project id or slug.' },
	deployment: { type: 'string', description: 'Deployment id.' },
	build: { type: 'string', description: 'Build id.' },
	job: { type: 'string', description: 'Job run id.' },
	node: { type: 'string', description: 'Node id or name.' },
	replica: { type: 'number', description: 'Replica index (0 for the first copy).' },
	source: { type: 'string', description: 'runtime, build, job, pipeline, system, access, otlp, audit, platform, email.' },
	stream: { type: 'string', description: 'The stream inside the scope, e.g. deployment:dep_1 or pod:ns/pod/container.' },
	channel: { type: 'string', description: 'stdout, stderr or system.' },
	pattern: { type: 'string', description: 'Drain template id (ClickHouse only).' },
	trace: { type: 'string', description: 'Trace id.' },
	span: { type: 'string', description: 'Span id.' },
	request: { type: 'string', description: 'Request id (X-Request-Id).' },
} as const satisfies Record<string, { type: 'severity' | 'string' | 'number'; description: string }>;
export type BuiltinLogField = keyof typeof builtinLogFields;

/**
 * A field reference. Attributes are written `@http.status`; resource fields `resource.host.name`
 * (or `@resource.host.name`). Unknown bare names are a parse error with a suggestion.
 */
export type LogFieldRef =
	| { kind: 'builtin'; name: BuiltinLogField }
	| { kind: 'attribute'; key: string }
	| { kind: 'resource'; key: string };

/**
 * Comparison operators. `eq` is case-insensitive equality for strings (exact for numbers);
 * `wildcard` is a glob with `*` (and `?`); `regex` is RE2-compatible and ClickHouse-only;
 * the ordered operators compare numerically (or by band for `level`).
 */
export type LogFieldOp = 'eq' | 'wildcard' | 'regex' | 'gt' | 'gte' | 'lt' | 'lte';

export type LogQueryNode =
	| { type: 'and'; children: LogQueryNode[] }
	| { type: 'or'; children: LogQueryNode[] }
	| { type: 'not'; child: LogQueryNode }
	/** Body search. `phrase: false` is one token; matching is case-insensitive substring. */
	| { type: 'text'; value: string; phrase: boolean }
	| { type: 'field'; field: LogFieldRef; op: LogFieldOp; value: string | number }
	/** `@key:*` — the field is present (non-empty). */
	| { type: 'exists'; field: LogFieldRef };

export type LogAggregationFn =
	| 'count'
	| 'count_distinct'
	| 'sum'
	| 'avg'
	| 'min'
	| 'max'
	| 'p50'
	| 'p90'
	| 'p95'
	| 'p99';

export interface LogAggregation {
	fn: LogAggregationFn;
	/** Required for every function except `count`. */
	field?: LogFieldRef;
	/** Output column name: the `as` alias, or e.g. `count`, `p95(@duration_ms)`. */
	alias: string;
}

export type LogGroupBy =
	| { type: 'bin'; intervalMs: number; alias: string }
	| { type: 'field'; field: LogFieldRef; alias: string };

export type LogPipeStage =
	| { type: 'fields'; fields: LogFieldRef[] }
	| { type: 'stats'; aggregations: LogAggregation[]; by: LogGroupBy[] }
	| { type: 'patterns' }
	| { type: 'dedup'; field: LogFieldRef }
	/** Sort by an output column alias (after stats) or a field (before). */
	| { type: 'sort'; key: string; direction: 'asc' | 'desc' }
	| { type: 'limit'; count: number };

export interface LogQueryAst {
	/** Null matches every record. */
	filter: LogQueryNode | null;
	pipes: LogPipeStage[];
}

/** A parse failure with a position for the editor to underline. */
export interface LogQueryError {
	message: string;
	/** Zero-based character offsets into the query text. */
	start: number;
	end: number;
	/** e.g. "did you mean `deployment`?" */
	hint?: string;
}

export type LogQueryParseResult =
	| { ok: true; ast: LogQueryAst }
	| { ok: false; error: LogQueryError };

/** Hard limits every compiler can rely on (the parser enforces them). */
export const LOG_QUERY_LIMITS = {
	maxLength: 4_000,
	maxNodes: 200,
	maxDepth: 16,
	maxPipes: 8,
	maxGroupBy: 4,
	maxAggregations: 8,
	maxLimit: 10_000,
	/** `bin()` intervals are clamped to [1s, 1d]. */
	minBinMs: 1_000,
	maxBinMs: 86_400_000,
} as const;
