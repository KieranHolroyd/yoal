import {
	canViewPlatform,
	compileLogPredicate,
	formatLogScope,
	logContextInputSchema,
	logFieldsInputSchema,
	logHistogramInputSchema,
	logReadInputSchema,
	logSearchInputSchema,
	parseLogQuery,
	requiredLogFeatures,
	type logCompareInputSchema,
	type logWhyInputSchema,
	type LogCapabilities,
	type LogCompareResult,
	type LogWhyResult,
	type LogContextResult,
	type LogEngine,
	type LogFieldsResult,
	type LogHistogramMarker,
	type LogHistogramResult,
	type LogQueryAst,
	type LogRecord,
	type LogScopeKind,
	type LogScopeRef,
	type LogSearchResult,
	type LogTableResult,
	type LogWarning,
	type Permission,
	type Principal,
} from '@yoal/contracts';
import type * as z from 'zod';
import type { CoreContext } from './context.ts';
import { CoreError, ForbiddenError, ValidationError } from './errors.ts';
import { compareLogs, whyLogs, type LogAnalysisHost } from './log-analysis.ts';
import { LogSavedQueryService } from './log-saved-queries.ts';
import { appendListener } from './logs.ts';
import { LogStoreUnsupported, type LogReadBoundary, type LogStore, type LogStoreRead } from './log-store/types.ts';
import {
	decodeTailCursor,
	encodeTailCursor,
	InvalidLogCursorError,
	lookupLogScopeNames,
	SqliteLogStore,
	type LogSeqVector,
} from './log-store/sqlite-store.ts';
import { LogTailBus, type LogTailSubscription } from './log-tail-bus.ts';
import { effectiveRuntime } from './runtime-tier.ts';

/**
 * The Logs Explorer service (docs/LOGS.md §6–§7, §10.5). Every surface (REST, SSE, CLI, MCP, the
 * dashboard) reads logs through here:
 *
 * - It resolves the read boundary from the principal: `logs:read` on each project, database,
 *   storage instance, broker, Kubernetes cluster and pipeline repository in the org (function
 *   projects also read as `function` scopes). Requested scopes are intersected with that; a scope
 *   the caller cannot read is silently dropped, so naming another org's scope returns nothing and
 *   never confirms it exists (§15). `platform` and `edge` scopes are for platform admins only, are
 *   never part of the default "everything", and each read of them is audited as
 *   `logs.read_platform`.
 * - It parses the query once, picks the store (ClickHouse when the context carries a healthy one,
 *   otherwise SQLite lite mode), and maps what a store cannot answer to a 422 `needs_clickhouse`.
 * - It owns the live-tail bus and saved queries.
 */

/**
 * Inputs are validated here with the contract schema, so callers may pass the typed shape or an
 * untyped object decoded from a request.
 */
type ExplorerInput<S extends z.ZodType> = z.input<S> | Record<string, unknown>;

/** A scope the caller may read, for the picker and for `scopeName`. */
export interface LogScopeEntry extends LogScopeRef {
	name: string;
	parent: string | null;
	deleted: boolean;
}

/**
 * Optional hooks the ClickHouse lane fills on the context (`ctx.logStoreClickhouse`,
 * `ctx.logIndexer`). Read structurally so this service does not depend on that lane's types.
 */
interface ClickHouseLogHooks {
	logStoreClickhouse?: (LogStore & { healthy?: () => boolean }) | null;
	logIndexer?: { lagMs?: () => number | null } | null;
}

export interface LogTailOpenInput {
	q?: string;
	scopes?: LogScopeRef[];
	/** `Last-Event-ID` from a reconnecting client: an opaque tail cursor. */
	lastEventId?: string | null;
	/** Newest N matching lines (of the last 24 h) to send first on a fresh connection; 0–1,000. */
	backfill?: number;
}

export interface LogTailBatch {
	records: LogRecord[];
	dropped: number;
	cursor: string;
}

/** An open live tail: the catch-up batch, then `next()` until the client goes away. */
export interface LogTailSession {
	engine: LogEngine;
	/** Resume cursor as of the open (send as the first event id). */
	cursor: string;
	initial: LogTailBatch;
	next(timeoutMs: number, signal?: AbortSignal): Promise<LogTailBatch>;
	close(): void;
}

/** A reconnect that missed more than this many lines gets the newest ones and a sampled marker. */
export const LOG_TAIL_CATCH_UP_LIMIT = 2_000;
const MAX_PICKER_SCOPES = 1_000;
const DEFAULT_WINDOW_MS = 3_600_000;
const BACKFILL_WINDOW_MS = 86_400_000;
const PLATFORM_KINDS: ReadonlySet<LogScopeKind> = new Set<LogScopeKind>(['platform', 'edge']);

interface ResolvedBoundary {
	boundary: LogReadBoundary;
	names: Map<string, string>;
	/** The platform/edge scopes in the boundary (audited). */
	platform: LogScopeRef[];
}

interface PreparedRead extends ResolvedBoundary {
	read: LogStoreRead;
	q: string;
}

export class LogExplorerService {
	readonly sqliteStore: SqliteLogStore;
	readonly tailBus = new LogTailBus();
	readonly saved: LogSavedQueryService;

	constructor(private readonly ctx: CoreContext) {
		this.sqliteStore = new SqliteLogStore(ctx.sqlite);
		this.saved = new LogSavedQueryService(ctx);
		// Every append path publishes what it inserted; the bus fans it out to live tails (§4.4).
		ctx.logs.onAppend.push(
			appendListener(
				(rows) => this.tailBus.publish(rows),
				() => this.tailBus.size > 0,
			),
		);
	}

	// ---------------------------------------------------------------- boundary

	/**
	 * Every tenant scope in the principal's org it may read logs in (with `permissions` all held
	 * on the scope). Platform scopes are not included; see `platformScopes`.
	 */
	readableScopes(principal: Principal, permissions: readonly Permission[] = ['logs:read']): LogScopeEntry[] {
		const can = (ref: { type: 'project' | 'database' | 'storage' | 'broker' | 'kubernetesCluster' | 'pipelineRepository'; id: string }) =>
			permissions.every((permission) => this.ctx.iam.can(principal, permission, ref));
		const out: LogScopeEntry[] = [];
		const orgId = principal.orgId;
		const projects = this.ctx.sqlite
			.query<{ id: string; slug: string; runtime: string; runtime_name: string | null; deleted_at: number | null }, [string]>(
				'SELECT id, slug, runtime, runtime_name, deleted_at FROM projects WHERE org_id = ? ORDER BY slug',
			)
			.all(orgId);
		for (const project of projects) {
			if (!can({ type: 'project', id: project.id })) continue;
			const deleted = project.deleted_at !== null;
			out.push({ kind: 'project', id: project.id, name: project.slug, parent: null, deleted });
			if (effectiveRuntime({ runtime: project.runtime, runtimeName: project.runtime_name }) === 'function')
				out.push({ kind: 'function', id: project.id, name: project.slug, parent: `project:${project.id}`, deleted });
		}
		const resources: Array<{
			kind: LogScopeKind;
			type: 'database' | 'storage' | 'broker' | 'kubernetesCluster' | 'pipelineRepository';
			sql: string;
		}> = [
			{ kind: 'database', type: 'database', sql: 'SELECT id, name, deleted_at FROM databases WHERE org_id = ? ORDER BY name' },
			{ kind: 'storage', type: 'storage', sql: 'SELECT id, name, deleted_at FROM storage_instances WHERE org_id = ? ORDER BY name' },
			{ kind: 'broker', type: 'broker', sql: 'SELECT id, name, deleted_at FROM brokers WHERE org_id = ? ORDER BY name' },
			{ kind: 'k8s', type: 'kubernetesCluster', sql: 'SELECT id, name, deleted_at FROM k8s_clusters WHERE org_id = ? ORDER BY name' },
			{
				kind: 'pipeline',
				type: 'pipelineRepository',
				sql: 'SELECT id, name, NULL AS deleted_at FROM pipeline_repositories WHERE org_id = ? ORDER BY name',
			},
		];
		for (const resource of resources) {
			const rows = this.ctx.sqlite
				.query<{ id: string; name: string; deleted_at: number | null }, [string]>(resource.sql)
				.all(orgId);
			for (const row of rows) {
				if (!can({ type: resource.type, id: row.id })) continue;
				out.push({ kind: resource.kind, id: row.id, name: row.name, parent: null, deleted: row.deleted_at !== null });
			}
		}
		return out;
	}

	/** One `platform` scope per node, for platform admins only (LP5). */
	platformScopes(principal: Principal): LogScopeEntry[] {
		if (!canViewPlatform(principal)) return [];
		return this.ctx.sqlite
			.query<{ id: string; name: string }, []>('SELECT id, name FROM nodes ORDER BY name')
			.all()
			.map((node) => ({ kind: 'platform' as const, id: node.id, name: node.name, parent: null, deleted: false }));
	}

	/**
	 * The server-chosen boundary for a read (types.ts). Empty `requested` means every tenant scope
	 * the caller may read. An empty result is "nothing", never an error, so a scope id from another
	 * org reads exactly like one that does not exist.
	 */
	resolveBoundary(
		principal: Principal,
		requested: readonly LogScopeRef[] = [],
		permissions: readonly Permission[] = ['logs:read'],
	): ResolvedBoundary {
		for (const permission of permissions) this.requireSomewhere(principal, permission);
		const readable = this.readableScopes(principal, permissions);
		const names = new Map<string, string>();
		for (const entry of readable) names.set(formatLogScope(entry), entry.name);
		const platformAdmin = canViewPlatform(principal);
		const seen = new Set<string>();
		const scopes: LogScopeRef[] = [];
		const platform: LogScopeRef[] = [];
		const add = (scope: LogScopeRef): void => {
			const key = formatLogScope(scope);
			if (seen.has(key)) return;
			seen.add(key);
			scopes.push({ kind: scope.kind, id: scope.id });
			if (PLATFORM_KINDS.has(scope.kind)) platform.push({ kind: scope.kind, id: scope.id });
		};
		if (requested.length === 0) for (const entry of readable) add(entry);
		else
			for (const scope of requested) {
				if (PLATFORM_KINDS.has(scope.kind)) {
					if (platformAdmin) add(scope);
				} else if (names.has(formatLogScope(scope))) add(scope);
			}
		if (platform.length > 0)
			for (const [key, name] of lookupLogScopeNames(this.ctx.sqlite, platform)) names.set(key, name);
		return {
			boundary: { orgId: principal.orgId, scopes, crossOrg: platformAdmin && platform.length > 0 },
			names,
			platform,
		};
	}

	// ---------------------------------------------------------------- reads

	async capabilities(principal: Principal): Promise<LogCapabilities> {
		this.requireSomewhere(principal, 'logs:read');
		const hooks = this.ctx as CoreContext & ClickHouseLogHooks;
		const clickhouse = this.clickhouse();
		const installed = Boolean(hooks.logStoreClickhouse);
		let indexLagMs: number | null = null;
		try {
			indexLagMs = hooks.logIndexer?.lagMs?.() ?? null;
		} catch {
			indexLagMs = null;
		}
		const full = clickhouse !== null;
		const scopes = [...this.readableScopes(principal).filter((entry) => !entry.deleted), ...this.platformScopes(principal)]
			.slice(0, MAX_PICKER_SCOPES)
			.map(({ kind, id, name, parent }) => ({ kind, id, name, parent }));
		return {
			engine: full ? 'clickhouse' : 'sqlite',
			clickhouse: { installed, healthy: full, indexLagMs },
			features: {
				attributes: full,
				regex: full,
				stats: full,
				patterns: full,
				compare: full,
				why: full,
				archive: false,
			},
			scopes,
			platformAdmin: canViewPlatform(principal),
		};
	}

	/** Rows, newest first by default, paged by opaque cursor. Pipe queries go to `table`. */
	async search(principal: Principal, input: ExplorerInput<typeof logSearchInputSchema>): Promise<LogSearchResult> {
		const value = parseInput(logSearchInputSchema, input);
		const prepared = this.prepare(principal, value);
		if (prepared.read.ast.pipes.length > 0)
			throw new CoreError(
				'pipes_need_table',
				'This query has pipe stages; run it through /api/v1/logs/table instead of search.',
				422,
			);
		this.auditPlatform(principal, prepared, 'search');
		const result = await this.run(prepared, (store) =>
			store.search(prepared.read, { limit: value.limit, cursor: value.cursor, order: value.order }),
		);
		this.name(result.records, prepared.names);
		return result;
	}

	/** Pipe-stage queries (`| stats`, `| patterns`…). Needs `logs:query` as well as `logs:read`. */
	async table(principal: Principal, input: ExplorerInput<typeof logReadInputSchema>): Promise<LogTableResult> {
		const value = parseInput(logReadInputSchema, input);
		const prepared = this.prepare(principal, value, ['logs:read', 'logs:query']);
		if (prepared.read.ast.pipes.length === 0)
			throw new CoreError('pipes_required', 'A table query needs at least one pipe stage, e.g. `| stats count() by bin(5m)`.', 422);
		this.auditPlatform(principal, prepared, 'table');
		return this.run(prepared, (store) => store.table(prepared.read));
	}

	async histogram(principal: Principal, input: ExplorerInput<typeof logHistogramInputSchema>): Promise<LogHistogramResult> {
		const value = parseInput(logHistogramInputSchema, input);
		const prepared = this.prepare(principal, value);
		this.auditPlatform(principal, prepared, 'histogram');
		const read = { ...prepared.read, ast: { filter: prepared.read.ast.filter, pipes: [] } };
		const result = await this.run(prepared, (store) => store.histogram(read, { buckets: value.buckets }));
		return { ...result, markers: this.markers(principal, prepared.boundary, read.from, read.to) };
	}

	async fields(principal: Principal, input: ExplorerInput<typeof logFieldsInputSchema>): Promise<LogFieldsResult> {
		const value = parseInput(logFieldsInputSchema, input);
		const prepared = this.prepare(principal, value);
		this.auditPlatform(principal, prepared, 'fields');
		const read = { ...prepared.read, ast: { filter: prepared.read.ast.filter, pipes: [] } };
		const result = await this.run(prepared, (store) =>
			store.fields(read, { fields: value.fields, topValues: value.topValues }),
		);
		const service = result.fields.find((field) => field.name === 'service');
		if (service && result.engine !== 'sqlite')
			service.topValues = service.topValues.map((entry) => ({ ...entry, value: prepared.names.get(entry.value) ?? entry.value }));
		return result;
	}

	/** Lines around one record, in its stream. Platform admins can open platform records too. */
	async context(principal: Principal, input: ExplorerInput<typeof logContextInputSchema>): Promise<LogContextResult> {
		const value = parseInput(logContextInputSchema, input);
		const resolved = this.anyRecordBoundary(principal);
		const result = await this.runStore((store) => store.context(resolved.boundary, value));
		if (result.anchor && PLATFORM_KINDS.has(result.anchor.scope.kind))
			this.auditPlatform(principal, { ...resolved, q: '', platform: [result.anchor.scope] }, 'context');
		this.name([...(result.anchor ? [result.anchor] : []), ...result.before, ...result.after], resolved.names);
		return result;
	}

	/** One record by id, or null when it does not exist or is outside what the caller may read. */
	async get(principal: Principal, id: string): Promise<LogRecord | null> {
		const resolved = this.anyRecordBoundary(principal);
		const record = await this.runStore((store) => store.get(resolved.boundary, id));
		if (!record) return null;
		if (PLATFORM_KINDS.has(record.scope.kind))
			this.auditPlatform(principal, { ...resolved, q: '', platform: [record.scope] }, 'get');
		this.name([record], resolved.names);
		return record;
	}

	// ---------------------------------------------------------------- analysis (log-analysis.ts)

	/** Patterns new/rising/falling/gone against a baseline window (§8.2). ClickHouse; `logs:query`. */
	async compare(principal: Principal, input: ExplorerInput<typeof logCompareInputSchema>): Promise<LogCompareResult> {
		return compareLogs(this.analysisHost(), principal, input);
	}

	/** Field values over-represented in a brushed selection (§8.3). ClickHouse; `logs:query`. */
	async why(principal: Principal, input: ExplorerInput<typeof logWhyInputSchema>): Promise<LogWhyResult> {
		return whyLogs(this.analysisHost(), principal, input);
	}

	private analysisHost(): LogAnalysisHost {
		return {
			ctx: this.ctx,
			prepare: (principal, input) => this.prepare(principal, input, ['logs:read', 'logs:query']),
			audit: (principal, prepared, op) => this.auditPlatform(principal, prepared, op),
			clickhouse: () => this.clickhouse(),
		};
	}

	// ---------------------------------------------------------------- live tail

	/**
	 * Open a live tail (§4.4). The subscription is registered before the catch-up read and given a
	 * floor at the current seq vector, so nothing written in between is lost or sent twice. A
	 * reconnect (`lastEventId`) replays what it missed from SQLite; past the catch-up limit it gets
	 * the newest lines and a `dropped` count for the sampled notice.
	 */
	openTail(principal: Principal, input: LogTailOpenInput = {}): LogTailSession {
		const q = input.q ?? '';
		const parsed = parseLogQuery(q);
		if (!parsed.ok) throw queryError(parsed.error);
		const resolved = this.resolveBoundary(principal, input.scopes ?? []);
		const filter = parsed.ast.filter;
		const subscription = this.tailBus.subscribe({ boundary: resolved.boundary, predicate: compileLogPredicate(filter) });
		let initial: LogTailBatch;
		let upTo: LogSeqVector;
		try {
			upTo = this.sqliteStore.maxSeqVector();
			subscription.setFloor(upTo);
			const ast: LogQueryAst = { filter, pipes: [] };
			const resume = decodeTailCursor(input.lastEventId);
			const backfill = Math.max(0, Math.min(Math.floor(input.backfill ?? 0), 1_000));
			let records: LogRecord[] = [];
			let dropped = 0;
			try {
				if (resume) {
					const caughtUp = this.sqliteStore.tailCatchUp(
						{ boundary: resolved.boundary, ast, from: 0, to: Number.MAX_SAFE_INTEGER },
						resume,
						upTo,
						LOG_TAIL_CATCH_UP_LIMIT,
						{ count: true },
					);
					records = caughtUp.records;
					dropped = Math.max(0, caughtUp.total - caughtUp.records.length);
				} else if (backfill > 0) {
					const now = this.ctx.now();
					records = this.sqliteStore.tailCatchUp(
						{ boundary: resolved.boundary, ast, from: now - BACKFILL_WINDOW_MS, to: Number.MAX_SAFE_INTEGER },
						{},
						upTo,
						backfill,
					).records;
				}
			} catch (error) {
				// Lite mode cannot replay a regex query; the bus still filters it with the JS predicate.
				if (!(error instanceof LogStoreUnsupported)) throw error;
			}
			this.name(records, resolved.names);
			initial = { records, dropped, cursor: encodeTailCursor(upTo) };
		} catch (error) {
			subscription.close();
			throw error;
		}
		this.auditPlatform(principal, { platform: resolved.platform, q }, 'tail');
		return this.session(subscription, resolved.names, initial);
	}

	private session(subscription: LogTailSubscription, names: Map<string, string>, initial: LogTailBatch): LogTailSession {
		return {
			engine: 'sqlite',
			cursor: initial.cursor,
			initial,
			next: async (timeoutMs, signal) => {
				await subscription.wait(timeoutMs, signal);
				const { records, dropped } = subscription.take();
				this.name(records, names);
				return { records, dropped, cursor: encodeTailCursor(subscription.vector) };
			},
			close: () => subscription.close(),
		};
	}

	// ---------------------------------------------------------------- helpers

	private requireSomewhere(principal: Principal, permission: Permission): void {
		const grants = this.ctx.iam.compiledFor(principal).index.get(permission);
		if (!grants || grants.length === 0) throw new ForbiddenError(permission);
	}

	/** Every scope the caller can read, plus platform scopes for admins: for lookups by record id. */
	private anyRecordBoundary(principal: Principal): ResolvedBoundary {
		const resolved = this.resolveBoundary(principal);
		const platform = this.platformScopes(principal);
		if (platform.length === 0) return resolved;
		for (const entry of platform) resolved.names.set(formatLogScope(entry), entry.name);
		return {
			boundary: {
				...resolved.boundary,
				scopes: [...resolved.boundary.scopes, ...platform.map(({ kind, id }) => ({ kind, id }))],
				crossOrg: true,
			},
			names: resolved.names,
			platform: [],
		};
	}

	private prepare(
		principal: Principal,
		input: { q: string; scopes: LogScopeRef[]; from?: number; to?: number },
		permissions: readonly Permission[] = ['logs:read'],
	): PreparedRead {
		const parsed = parseLogQuery(input.q);
		if (!parsed.ok) throw queryError(parsed.error);
		const resolved = this.resolveBoundary(principal, input.scopes, permissions);
		const now = this.ctx.now();
		const to = input.to ?? now;
		const from = input.from ?? to - DEFAULT_WINDOW_MS;
		return {
			...resolved,
			q: input.q,
			read: { boundary: resolved.boundary, ast: parsed.ast, from: Math.min(from, to), to: Math.max(from, to) },
		};
	}

	/** ClickHouse when the context carries a healthy store, else null (lite mode). */
	private clickhouse(): (LogStore & { healthy?: () => boolean }) | null {
		const store = (this.ctx as CoreContext & ClickHouseLogHooks).logStoreClickhouse;
		if (!store) return null;
		try {
			if (typeof store.healthy === 'function' && !store.healthy()) return null;
		} catch {
			return null;
		}
		return store;
	}

	/**
	 * Run a read on the chosen store. A ClickHouse failure that is not "unsupported" falls back to
	 * SQLite with a `partial` warning (fail-open, LP2); lite-mode gaps become a 422.
	 */
	private async run<T extends { engine: LogEngine; warnings: LogWarning[] }>(
		prepared: PreparedRead,
		op: (store: LogStore) => Promise<T>,
	): Promise<T> {
		const result = await this.runStore(op);
		if (result.engine === 'sqlite' && requiredLogFeatures(prepared.read.ast).includes('attributes'))
			result.warnings.push({
				code: 'needs_clickhouse',
				message: 'In lite mode, attribute fields only match sources that store attributes (pipelines and new sources).',
			});
		return result;
	}

	private async runStore<T>(op: (store: LogStore) => Promise<T>): Promise<T> {
		const clickhouse = this.clickhouse();
		if (clickhouse) {
			try {
				return await op(clickhouse);
			} catch (error) {
				if (error instanceof LogStoreUnsupported) throw needsClickhouse(error);
				if (error instanceof InvalidLogCursorError) throw invalidCursor(error);
				console.error('[logs] ClickHouse read failed; answering from SQLite', error);
				const fallback = await this.runSqlite(op);
				if (fallback && typeof fallback === 'object' && Array.isArray((fallback as { warnings?: unknown }).warnings))
					(fallback as unknown as { warnings: LogWarning[] }).warnings.push({
						code: 'partial',
						message: 'The search index did not answer; these results come from the recent hot tail only.',
					});
				return fallback;
			}
		}
		return this.runSqlite(op);
	}

	private async runSqlite<T>(op: (store: LogStore) => Promise<T>): Promise<T> {
		try {
			return await op(this.sqliteStore);
		} catch (error) {
			if (error instanceof LogStoreUnsupported) throw needsClickhouse(error);
			if (error instanceof InvalidLogCursorError) throw invalidCursor(error);
			throw error;
		}
	}

	private name(records: LogRecord[], names: Map<string, string>): void {
		for (const record of records) record.scopeName = names.get(formatLogScope(record.scope)) ?? record.scopeName;
	}

	private auditPlatform(principal: Principal, resolved: Pick<PreparedRead, 'platform' | 'q'>, op: string): void {
		if (resolved.platform.length === 0) return;
		this.ctx.audit.record({
			principal,
			action: 'logs.read_platform',
			resource: 'logs',
			args: { op, scopes: resolved.platform.map(formatLogScope), q: resolved.q.slice(0, 500) },
			result: 'ok',
		});
	}

	/** Deploys (and fired alerts, when the caller can read alerts) inside the range (§7.2). */
	private markers(principal: Principal, boundary: LogReadBoundary, from: number, to: number): LogHistogramMarker[] {
		const markers: LogHistogramMarker[] = [];
		try {
			const projectIds = [
				...new Set(
					boundary.scopes.filter((scope) => scope.kind === 'project' || scope.kind === 'function').map((scope) => scope.id),
				),
			];
			for (let index = 0; index < projectIds.length && markers.length < 200; index += 500) {
				const chunk = projectIds.slice(index, index + 500);
				const statement = this.ctx.sqlite.prepare<
					{ id: string; short_id: string | null; project_id: string; slug: string; at: number },
					Array<string | number>
				>(
					`SELECT d.id, d.short_id, d.project_id, p.slug, COALESCE(d.activated_at, d.created_at) AS at
					 FROM deployments d JOIN projects p ON p.id = d.project_id
					 WHERE d.org_id = ? AND d.project_id IN (${chunk.map(() => '?').join(', ')})
					   AND COALESCE(d.activated_at, d.created_at) BETWEEN ? AND ?
					 ORDER BY at DESC LIMIT 200`,
				);
				try {
					for (const row of statement.all(boundary.orgId, ...chunk, from, to))
						markers.push({
							ts: row.at,
							kind: 'deploy',
							label: `Deploy ${row.short_id ?? row.id.slice(-8)} · ${row.slug}`,
							href: `/projects/${row.slug}/deployments/${row.id}`,
							scope: { kind: 'project', id: row.project_id },
						});
				} finally {
					statement.finalize();
				}
			}
			if (boundary.scopes.length > 0 && this.ctx.iam.can(principal, 'alert:read', { type: 'org' })) {
				const alerts = this.ctx.sqlite
					.query<{ rule_id: string | null; title: string | null; at: number }, [string, number, number]>(
						`SELECT rule_id, title, at FROM alert_events
						 WHERE org_id = ? AND to_state = 'firing' AND at BETWEEN ? AND ? ORDER BY at DESC LIMIT 100`,
					)
					.all(boundary.orgId, from, to);
				for (const alert of alerts)
					markers.push({
						ts: alert.at,
						kind: 'alert',
						label: alert.title ?? 'Alert fired',
						href: alert.rule_id ? `/alerts/rules/${alert.rule_id}` : '/alerts',
						scope: null,
					});
			}
		} catch (error) {
			// Markers decorate the histogram; a failure here must never fail the read.
			console.error('[logs] histogram markers failed', error);
		}
		return markers.sort((a, b) => a.ts - b.ts);
	}
}

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
	const parsed = schema.safeParse(input ?? {});
	if (!parsed.success) throw new ValidationError('Invalid log read.', parsed.error.issues);
	return parsed.data;
}

function queryError(error: { message: string; start: number; end: number; hint?: string }): CoreError {
	return new ValidationError(`Query error at ${error.start}–${error.end}: ${error.message}${error.hint ? ` (${error.hint})` : ''}`, [
		{ path: ['q'], message: error.message, start: error.start, end: error.end, hint: error.hint },
	]);
}

function needsClickhouse(error: LogStoreUnsupported): CoreError {
	const failure = new CoreError('needs_clickhouse', error.message, 422);
	(failure as CoreError & { feature?: string }).feature = error.feature;
	return failure;
}

function invalidCursor(error: InvalidLogCursorError): CoreError {
	return new CoreError('invalid_cursor', error.message, 400);
}
