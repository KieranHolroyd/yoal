import type {
	LogContextInput,
	LogContextResult,
	LogEngine,
	LogFieldsInput,
	LogFieldsResult,
	LogHistogramInput,
	LogHistogramResult,
	LogQueryAst,
	LogRecord,
	LogScopeRef,
	LogSearchInput,
	LogSearchResult,
	LogTableResult,
} from '@yoal/contracts';

/**
 * The LogStore seam (docs/LOGS.md §4, LP2). Two implementations answer the same reads:
 * `SqliteLogStore` (lite mode, adapters over the hot-tail tables) and `ClickHouseLogStore`
 * (`yoal.logs`). `LogExplorerService` picks one per request and never lets a store decide tenancy.
 */

/**
 * The resolved, server-chosen read boundary. Stores AND it into every statement; it is never built
 * from client input. `scopes` is the full allow-list for this read (already intersected with any
 * scopes the caller asked for); an empty list means "nothing", never "everything".
 */
export interface LogReadBoundary {
	orgId: string;
	scopes: LogScopeRef[];
	/** True only for platform admins reading `platform`/`edge` scopes across orgs. */
	crossOrg: boolean;
}

/** A read after parsing: the AST plus absolute bounds. Query text never reaches a store. */
export interface LogStoreRead {
	boundary: LogReadBoundary;
	ast: LogQueryAst;
	from: number;
	to: number;
}

export interface LogStore {
	readonly engine: LogEngine;
	/** Row reads; `ast.pipes` must be empty (the service routes pipe queries to `table`). */
	search(read: LogStoreRead, page: Pick<LogSearchInput, 'limit' | 'cursor' | 'order'>): Promise<LogSearchResult>;
	/** Pipe-stage queries (`| stats`, `| patterns`, `| dedup`, `| fields`). Lite mode supports a subset. */
	table(read: LogStoreRead): Promise<LogTableResult>;
	histogram(read: LogStoreRead, input: Pick<LogHistogramInput, 'buckets'>): Promise<Omit<LogHistogramResult, 'markers'>>;
	fields(read: LogStoreRead, input: Pick<LogFieldsInput, 'fields' | 'topValues'>): Promise<LogFieldsResult>;
	/** Lines around one record in the same stream. The boundary still applies to the anchor. */
	context(boundary: LogReadBoundary, input: LogContextInput): Promise<LogContextResult>;
	/** One record by id, inside the boundary, or null. */
	get(boundary: LogReadBoundary, id: string): Promise<LogRecord | null>;
}

/** Thrown by a store for a query it cannot answer (lite mode + regex/stats/patterns…). */
export class LogStoreUnsupported extends Error {
	constructor(
		message: string,
		readonly feature: 'attributes' | 'regex' | 'stats' | 'patterns' | 'compare' | 'why' | 'archive',
	) {
		super(message);
		this.name = 'LogStoreUnsupported';
	}
}
