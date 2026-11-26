import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { brokerLogEvents, brokers, builds, databases, k8sMachines, logEvents, projects, serviceLogEvents, storageInstances, workloads } from '@yoal/db';
import {
	levelForBuildLine,
	parseLogLine,
	parseWorkloadReplicaId,
	type BuildLogChunk,
	type LogEventView,
	type LogLevel,
	type LogQuery,
	type LogQueryResult,
	type Principal,
	type ServiceLogEvent,
	type ServiceLogKind,
	type ServiceLogQuery,
	type ServiceLogQueryResult,
	type RuntimeLogBatch,
	type NodeLogBatch,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';
import type { ProjectRow } from './projects.ts';
import { JOB_LOG_LINES_MAX } from './jobs.ts';
import { sqliteLogSource, type SqliteLogTag, type UnifiedLogRow } from './log-store/sqlite-sources.ts';
import { insertNodeLogRecords, resolveNodeLogTarget } from './log-record-ingest.ts';
import { featureEnabled } from './config.ts';
import { messageRowAccess, type GuardAccess, type GuardOptions } from './log-ingest-guard.ts';
import type { LogIngestScope } from './log-quotas.ts';
import { LOG_SCOPE_ROW_CAP } from './log-retention.ts';

const LOG_LIMIT = 2_000_000;
const LOG_TAIL = 8_000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2_000;
/**
 * Per-scope ceiling on hot-tail rows, per table (docs/LOGS.md §10.2, LP9); retention lives in
 * `log-retention.ts`.
 */
export { LOG_SCOPE_ROW_CAP } from './log-retention.ts';
/** Most rows one append can publish to the live-tail bus in one read. */
const PUBLISH_BATCH = 5_000;
const LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

interface LogEventLike {
	message: string;
	level?: LogLevel;
	source?: string;
	stream?: string;
	ts?: number;
	deploymentId?: string | null;
	buildId?: string | null;
	jobRunId?: string | null;
	nodeId?: string | null;
}

/** `log_events` rows as the ingest guard sees them (stream and source as the adapter derives). */
const logEventAccess = <T extends LogEventLike>() =>
	messageRowAccess<T>('le', (row) => ({
		source: row.jobRunId ? 'job' : (row.source ?? 'runtime'),
		stream: row.jobRunId
			? `job:${row.jobRunId}`
			: row.buildId && row.source !== 'runtime'
				? `build:${row.buildId}`
				: row.deploymentId
					? `deployment:${row.deploymentId}`
					: null,
		deployment_id: row.deploymentId ?? null,
		build_id: row.buildId ?? null,
		job_run_id: row.jobRunId ?? null,
		node_id: row.nodeId ?? null,
	}));
const serviceEventAccess = <T extends LogEventLike>() => messageRowAccess<T>('sle', (row) => ({ node_id: row.nodeId ?? null }));

const projectScope = (orgId: string, projectId: string): LogIngestScope => ({ orgId, scopeKind: 'project', scopeId: projectId, projectId });


/**
 * The log drain (DESIGN §8). Builders and agents append small batches, the dashboard tails the
 * monotonic `seq` cursor over SSE, and every read goes through `logs:read` like any other surface.
 */
/**
 * An `onAppend` listener that reports whether it currently wants rows, so appends skip the
 * publish read while no live tail is open.
 */
export function appendListener(
	listener: (rows: UnifiedLogRow[]) => void,
	active: () => boolean,
): (rows: UnifiedLogRow[]) => void {
	return Object.assign(listener, { active });
}

export class LogService {
	/**
	 * Live-tail listeners (docs/LOGS.md §4.4). Every append path calls each one with the rows it
	 * inserted, already projected onto the unified columns. `LogExplorerService` registers the
	 * tail bus here; node record ingest (`appendRecords`) calls the same list. A listener must not
	 * throw into an append: errors are swallowed.
	 *
	 * A listener may carry an `active()` property (see `appendListener`): while every listener says
	 * it is inactive (no live tail open), append paths skip the extra read entirely.
	 */
	readonly onAppend: Array<(rows: UnifiedLogRow[]) => void> = [];

	constructor(private readonly ctx: CoreContext) {}

	/**
	 * Rules, quota and redaction for one batch (docs/LOGS.md §10.2–§10.4, `LogIngestGuard`): every
	 * append path stores only what this returns.
	 */
	private guard<T>(scope: LogIngestScope, rows: T[], access: GuardAccess<T>, options?: GuardOptions): T[] {
		const guard = this.ctx.logGuard;
		return guard ? guard.admit(scope, rows, access, options) : rows;
	}

	/**
	 * Publish the rows of one hot-tail table inserted after `afterSeq`. Append paths in other
	 * services (pipeline steps, Kubernetes pod logs) can call this after their own insert.
	 */
	publishInserted(tag: SqliteLogTag, afterSeq: number): void {
		if (!this.appendWanted()) return;
		const source = sqliteLogSource(tag);
		if (!source) return;
		const rows = this.ctx.sqlite
			.query<UnifiedLogRow, [number, number]>(`${source.select} WHERE t.seq > ? ORDER BY t.seq LIMIT ?`)
			.all(afterSeq, PUBLISH_BATCH);
		if (rows.length > 0) this.emitAppended(rows);
	}

	/** True when some listener wants inserted rows now. */
	appendWanted(): boolean {
		return this.onAppend.some((listener) => {
			const active = (listener as { active?: () => boolean }).active;
			return typeof active !== 'function' || active();
		});
	}

	/** Call every listener; one failing listener never breaks ingest or the others. */
	emitAppended(rows: UnifiedLogRow[]): void {
		for (const listener of this.onAppend) {
			try {
				listener(rows);
			} catch (error) {
				console.error('[logs] live-tail listener failed', error);
			}
		}
	}

	/** The newest seq in a hot-tail table (an O(1) rowid read). */
	maxSeq(tag: SqliteLogTag): number {
		const source = sqliteLogSource(tag);
		if (!source) return 0;
		return this.ctx.sqlite.query<{ seq: number | null }, []>(`SELECT MAX(seq) AS seq FROM ${source.table}`).get()?.seq ?? 0;
	}

	/**
	 * Run a write and publish what it inserted into `tag`'s table. With no listener it is just the
	 * write. The re-read is a primary-key range read of the rows just written, so the published
	 * shape is exactly what the store's adapters return.
	 */
	private tracked<T>(tag: SqliteLogTag, write: () => T): T {
		if (!this.appendWanted()) return write();
		const before = this.maxSeq(tag);
		const result = write();
		this.publishInserted(tag, before);
		return result;
	}

	/**
	 * Append one Builder chunk. The node must own the build and the build must still be running;
	 * returns false so the agent route can answer 404 without leaking another org's build.
	 */
	appendBuild(nodeId: string, buildId: string, chunk: BuildLogChunk): boolean {
		const build = this.ctx.db
			.select()
			.from(builds)
			.where(eq(builds.id, buildId))
			.get();
		if (!build || build.nodeId !== nodeId || build.status !== 'building')
			return false;
		const lines = chunk.lines.map((line) => sanitize(line));
		if (lines.length === 0) return true;
		const now = this.ctx.now();
		// The build's text summary is redacted like the rows (§10.4); it keeps every line.
		const redact = (line: string) => this.ctx.logGuard?.redact(build.orgId, build.projectId, line) ?? line;
		const text = `${lines.map((line) => (chunk.stream === 'stderr' ? `[stderr] ${redact(line)}` : redact(line))).join('\n')}\n`;
		const log = `${build.log ?? ''}${text}`.slice(-LOG_LIMIT);
		const parsedRows = lines.map((line) => {
			const parsed = parseLogLine(line);
			return {
				orgId: build.orgId,
				projectId: build.projectId,
				deploymentId: null,
				buildId: build.id,
				nodeId,
				source: 'build' as const,
				stream: chunk.stream,
				level: parsed.level ?? levelForBuildLine(line, chunk.stream),
				message: sanitize(parsed.message),
				ts: parsed.ts ?? now,
			};
		});
		const rows = this.guard(projectScope(build.orgId, build.projectId), parsedRows, logEventAccess());
		this.tracked('le', () =>
			this.ctx.db.transaction((tx) => {
				if (rows.length > 0) tx.insert(logEvents).values(rows).run();
				tx.update(builds)
					.set({ log, logTail: log.slice(-LOG_TAIL) })
					.where(eq(builds.id, buildId))
					.run();
			}),
		);
		return true;
	}

	/** Compatibility path for callers that already hold a plain text chunk (for example recovery). */
	appendBuildText(nodeId: string, buildId: string, text: string): boolean {
		const lines = text
			.replace(/\r\n/g, '\n')
			.split('\n')
			.filter((line, index, all) => line.length > 0 || index < all.length - 1);
		if (lines.length === 0) return true;
		return this.appendBuild(nodeId, buildId, { stream: 'stdout', lines });
	}

	/** Runtime journal output drained by an agent, one batch per workload. */
	appendRuntime(nodeId: string, batch: RuntimeLogBatch): number {
		// A job run's output (plan 09) is stored under its run, never mixed into the app's stream.
		if (batch.jobRunId) return this.appendJobRun(nodeId, batch.jobRunId, batch);
		// Replicas (plan 21) drain under `<id>-r<n>` and belong to the workload `<id>`.
		const { workloadId, replica } = parseWorkloadReplicaId(batch.workloadId);
		const workload = this.ctx.db
			.select()
			.from(workloads)
			.where(eq(workloads.id, workloadId))
			.get();
		// A workload may have moved or stopped between the helper read and this POST. Treat that as
		// an empty, successful drain instead of failing the agent's loop. Managed services are not
		// in `workloads`; their ids (`st_…`, `db_…`) resolve to their own table.
		if (!workload) return this.appendServiceRuntime(nodeId, batch);
		// A spread copy (C4) or a copy mid-move runs on a node other than `workloads.node_id`.
		if (!this.ctx.workloads.runsOnNode(workload, replica, nodeId))
			throw new CoreError(
				'forbidden',
				'This workload is placed on another node.',
				403,
			);
		const project = this.ctx.db
			.select()
			.from(projects)
			.where(eq(projects.id, workload.projectId))
			.get();
		if (!project || project.deletedAt) return 0;
		if (batch.lines.length === 0) return 0;
		const now = this.ctx.now();
		const parsedRows = batch.lines.map((line) => {
			const parsed = parseLogLine(line.message);
			return {
				orgId: workload.orgId,
				projectId: workload.projectId,
				deploymentId: workload.deploymentId,
				buildId: null,
				nodeId,
				source: 'runtime' as const,
				stream: line.stream,
				level: parsed.level ?? line.level,
				message: replica > 0
					? `[r${replica}] ${sanitize(parsed.message)}`
					: sanitize(parsed.message),
				ts: Number.isFinite(line.ts) ? Math.max(0, Number(line.ts)) : parsed.ts ?? now,
			};
		});
		const rows = this.guard(projectScope(workload.orgId, workload.projectId), parsedRows, logEventAccess());
		if (rows.length > 0) this.tracked('le', () => this.ctx.db.insert(logEvents).values(rows).run());
		return rows.length;
	}

	/**
	 * One job run's output. The node must hold the run under the same workload id; a run the node
	 * does not own is a 403, an unknown one an empty drain. Each run keeps its first
	 * `JOB_LOG_LINES_MAX` lines and one notice that the rest was dropped.
	 */
	private appendJobRun(nodeId: string, runId: string, batch: RuntimeLogBatch): number {
		const run = this.ctx.jobs.runForLogs(nodeId, runId, batch.workloadId);
		if (!run) {
			const known = this.ctx.sqlite.query<{ n: number }, [string]>('SELECT 1 AS n FROM job_runs WHERE id = ?').get(runId);
			if (known) throw new CoreError('forbidden', 'This job run belongs to another node.', 403);
			return 0;
		}
		if (batch.lines.length === 0) return 0;
		const stored =
			this.ctx.sqlite.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM log_events WHERE job_run_id = ?').get(runId)?.n ?? 0;
		if (stored > JOB_LOG_LINES_MAX) return 0;
		const now = this.ctx.now();
		const room = JOB_LOG_LINES_MAX - stored;
		const parsedRows: Array<typeof logEvents.$inferInsert> = batch.lines.slice(0, Math.max(0, room)).map((line) => {
			const parsed = parseLogLine(line.message);
			return {
				orgId: run.orgId,
				projectId: run.projectId,
				deploymentId: run.deploymentId,
				buildId: null,
				nodeId,
				jobRunId: runId,
				source: 'runtime' as const,
				stream: line.stream,
				level: parsed.level ?? line.level,
				message: sanitize(parsed.message),
				ts: Number.isFinite(line.ts) ? Math.max(0, Number(line.ts)) : parsed.ts ?? now,
			};
		});
		const rows = this.guard(projectScope(run.orgId, run.projectId), parsedRows, logEventAccess());
		if (batch.lines.length > room)
			rows.push({
				orgId: run.orgId,
				projectId: run.projectId,
				deploymentId: run.deploymentId,
				buildId: null,
				nodeId,
				jobRunId: runId,
				source: 'system',
				stream: 'system',
				level: 'warn',
				message: `Output truncated: a run keeps its first ${JOB_LOG_LINES_MAX} lines.`,
				ts: now,
			});
		if (rows.length > 0) this.tracked('le', () => this.ctx.db.insert(logEvents).values(rows).run());
		return rows.length;
	}

	/**
	 * Store a drained batch for a managed service. Returns 0 for an unknown id (the unit may have
	 * been removed between the read and the POST), and 403 if the node does not own it.
	 */
	private appendServiceRuntime(nodeId: string, batch: RuntimeLogBatch): number {
		const storage = this.ctx.db
			.select()
			.from(storageInstances)
			.where(eq(storageInstances.id, batch.workloadId))
			.get();
		const database = storage
			? undefined
			: this.ctx.db.select().from(databases).where(eq(databases.id, batch.workloadId)).get();
		const service = storage ?? database;
		if (!service) {
			// Kubernetes machines keep their own log table (0116); the service checks node ownership.
			const parse = (line: RuntimeLogBatch['lines'][number]) => {
				const parsed = parseLogLine(line.message);
				return {
					stream: line.stream,
					level: parsed.level ?? line.level,
					message: sanitize(parsed.message),
					ts: Number.isFinite(line.ts) ? Math.max(0, Number(line.ts)) : parsed.ts ?? this.ctx.now(),
				};
			};
			if (this.ctx.kubernetes.isMachineId(batch.workloadId)) {
				// The guard needs the cluster scope; the service still checks node ownership.
				const machine = this.ctx.db
					.select({ orgId: k8sMachines.orgId, clusterId: k8sMachines.clusterId, nodeId: k8sMachines.nodeId })
					.from(k8sMachines)
					.where(eq(k8sMachines.id, batch.workloadId))
					.get();
				const lines = batch.lines.map(parse);
				const kept = machine && machine.nodeId === nodeId
					? this.guard({ orgId: machine.orgId, scopeKind: 'k8s', scopeId: machine.clusterId, projectId: null }, lines, messageRowAccess('kle'))
					: lines;
				if (machine && machine.nodeId === nodeId && kept.length === 0) return 0;
				return this.tracked('kle', () => this.ctx.kubernetes.appendRuntimeLogs(nodeId, batch.workloadId, kept));
			}
			// Brokers keep their own log table (0048); the service checks node ownership.
			if (!this.ctx.brokers.isBrokerId(batch.workloadId)) return 0;
			const broker = this.ctx.db
				.select({ orgId: brokers.orgId, nodeId: brokers.nodeId })
				.from(brokers)
				.where(eq(brokers.id, batch.workloadId))
				.get();
			const lines = batch.lines.map(parse);
			const kept = broker && broker.nodeId === nodeId
				? this.guard({ orgId: broker.orgId, scopeKind: 'broker', scopeId: batch.workloadId, projectId: null }, lines, messageRowAccess('ble'))
				: lines;
			if (broker && broker.nodeId === nodeId && kept.length === 0) return 0;
			return this.tracked('ble', () => this.ctx.brokers.appendRuntimeLogs(nodeId, batch.workloadId, kept));
		}
		if (service.nodeId !== nodeId)
			throw new CoreError('forbidden', 'This service is placed on another node.', 403);
		if (batch.lines.length === 0) return 0;
		const kind: ServiceLogKind = storage ? 'storage' : 'database';
		const now = this.ctx.now();
		const parsedRows = batch.lines.map((line) => {
			const parsed = parseLogLine(line.message);
			return {
				orgId: service.orgId,
				kind,
				serviceId: service.id,
				nodeId,
				source: 'runtime' as const,
				stream: line.stream,
				level: parsed.level ?? line.level,
				message: sanitize(parsed.message),
				ts: Number.isFinite(line.ts) ? Math.max(0, Number(line.ts)) : parsed.ts ?? now,
			};
		});
		const rows = this.guard({ orgId: service.orgId, scopeKind: kind, scopeId: service.id, projectId: null }, parsedRows, serviceEventAccess());
		if (rows.length > 0) this.tracked('sle', () => this.ctx.db.insert(serviceLogEvents).values(rows).run());
		return rows.length;
	}

	/** A lifecycle breadcrumb in a managed service's own stream (restart, disk move, …). */
	appendServiceSystem(input: {
		kind: ServiceLogKind;
		serviceId: string;
		orgId: string;
		nodeId?: string | null;
		level?: LogLevel;
		message: string;
	}): void {
		// Lifecycle notices skip rules and quotas but are redacted (§10.4).
		const message = this.ctx.logGuard?.redact(input.orgId, null, sanitize(input.message)) ?? sanitize(input.message);
		if (input.kind === 'broker') {
			this.tracked('ble', () => this.ctx.db
				.insert(brokerLogEvents)
				.values({
					orgId: input.orgId,
					brokerId: input.serviceId,
					nodeId: input.nodeId ?? null,
					source: 'system',
					stream: 'system',
					level: input.level ?? 'info',
					message,
					ts: this.ctx.now(),
				})
				.run());
			return;
		}
		this.tracked('sle', () => this.ctx.db
			.insert(serviceLogEvents)
			.values({
				orgId: input.orgId,
				kind: input.kind as Exclude<ServiceLogKind, 'broker'>,
				serviceId: input.serviceId,
				nodeId: input.nodeId ?? null,
				source: 'system',
				stream: 'system',
				level: input.level ?? 'info',
				message,
				ts: this.ctx.now(),
			})
			.run());
	}

	/** Newest page or everything after a cursor, scoped to one managed service. */
	queryService(
		principal: Principal,
		kind: ServiceLogKind,
		serviceId: string,
		input: ServiceLogQuery = {},
	): ServiceLogQueryResult {
		if (kind === 'broker') {
			const owner = this.ctx.db.select({ orgId: brokers.orgId }).from(brokers).where(eq(brokers.id, serviceId)).get();
			if (!owner || owner.orgId !== principal.orgId)
				throw new CoreError('not_found', 'Service not found.', 404);
			this.ctx.iam.require(principal, 'logs:read', { type: 'broker', id: serviceId });
			return this.queryBroker(principal, serviceId, input);
		}
		const orgId =
			kind === 'storage'
				? this.ctx.db
						.select({ orgId: storageInstances.orgId })
						.from(storageInstances)
						.where(eq(storageInstances.id, serviceId))
						.get()?.orgId
				: this.ctx.db
						.select({ orgId: databases.orgId })
						.from(databases)
						.where(eq(databases.id, serviceId))
						.get()?.orgId;
		if (!orgId || orgId !== principal.orgId)
			throw new CoreError('not_found', 'Service not found.', 404);
		this.ctx.iam.require(principal, 'logs:read', {
			type: kind === 'storage' ? 'storage' : 'database',
			id: serviceId,
		});

		const requested = Number(input.limit ?? DEFAULT_LIMIT);
		const limit = Number.isFinite(requested)
			? Math.max(1, Math.min(Math.floor(requested), MAX_LIMIT))
			: DEFAULT_LIMIT;
		const conditions = [
			eq(serviceLogEvents.orgId, principal.orgId),
			eq(serviceLogEvents.kind, kind),
			eq(serviceLogEvents.serviceId, serviceId),
		];
		if (input.level) {
			const index = LEVEL_ORDER.indexOf(input.level);
			conditions.push(inArray(serviceLogEvents.level, LEVEL_ORDER.slice(Math.max(0, index))));
		}
		const q = input.q?.trim();
		if (q)
			conditions.push(sql`instr(lower(${serviceLogEvents.message}), lower(${q.slice(0, 200)})) > 0`);

		const after = input.after;
		let rows: Array<typeof serviceLogEvents.$inferSelect>;
		if (after !== undefined) {
			rows = this.ctx.db
				.select()
				.from(serviceLogEvents)
				.where(and(...conditions, gt(serviceLogEvents.seq, after)))
				.orderBy(asc(serviceLogEvents.seq))
				.limit(limit + 1)
				.all();
		} else {
			rows = this.ctx.db
				.select()
				.from(serviceLogEvents)
				.where(and(...conditions))
				.orderBy(desc(serviceLogEvents.seq))
				.limit(limit + 1)
				.all()
				.reverse();
		}
		const hasMore = rows.length > limit;
		if (hasMore) rows = after !== undefined ? rows.slice(0, limit) : rows.slice(1);
		return {
			events: rows.map(
				(row): ServiceLogEvent => ({
					seq: row.seq,
					ts: row.ts,
					kind: row.kind,
					serviceId: row.serviceId,
					source: row.source,
					stream: row.stream,
					...present(row.source, row.level, row.message),
				}),
			),
			cursor: rows.at(-1)?.seq ?? after ?? 0,
			hasMore,
		};
	}

	/** `queryService` for a broker: the same cursor and filters over `broker_log_events` (0048). */
	private queryBroker(principal: Principal, brokerId: string, input: ServiceLogQuery): ServiceLogQueryResult {
		const owner = this.ctx.db.select({ orgId: brokers.orgId }).from(brokers).where(eq(brokers.id, brokerId)).get();
		if (!owner || owner.orgId !== principal.orgId) throw new CoreError('not_found', 'Service not found.', 404);
		const requested = Number(input.limit ?? DEFAULT_LIMIT);
		const limit = Number.isFinite(requested)
			? Math.max(1, Math.min(Math.floor(requested), MAX_LIMIT))
			: DEFAULT_LIMIT;
		const conditions = [eq(brokerLogEvents.orgId, principal.orgId), eq(brokerLogEvents.brokerId, brokerId)];
		if (input.level) {
			const index = LEVEL_ORDER.indexOf(input.level);
			conditions.push(inArray(brokerLogEvents.level, LEVEL_ORDER.slice(Math.max(0, index))));
		}
		const q = input.q?.trim();
		if (q) conditions.push(sql`instr(lower(${brokerLogEvents.message}), lower(${q.slice(0, 200)})) > 0`);
		const after = input.after;
		let rows =
			after !== undefined
				? this.ctx.db
						.select()
						.from(brokerLogEvents)
						.where(and(...conditions, gt(brokerLogEvents.seq, after)))
						.orderBy(asc(brokerLogEvents.seq))
						.limit(limit + 1)
						.all()
				: this.ctx.db
						.select()
						.from(brokerLogEvents)
						.where(and(...conditions))
						.orderBy(desc(brokerLogEvents.seq))
						.limit(limit + 1)
						.all()
						.reverse();
		const hasMore = rows.length > limit;
		if (hasMore) rows = after !== undefined ? rows.slice(0, limit) : rows.slice(1);
		return {
			events: rows.map(
				(row): ServiceLogEvent => ({
					seq: row.seq,
					ts: row.ts,
					kind: 'broker',
					serviceId: row.brokerId,
					source: row.source,
					stream: row.stream,
					...present(row.source, row.level, row.message),
				}),
			),
			cursor: rows.at(-1)?.seq ?? after ?? 0,
			hasMore,
		};
	}

	/** Lifecycle breadcrumb (queue recovery, drain notices) that belongs in the same stream. */
	appendSystem(input: {
		orgId: string;
		projectId: string;
		deploymentId?: string | null;
		buildId?: string | null;
		nodeId?: string | null;
		level?: LogLevel;
		message: string;
	}): void {
		// Lifecycle notices skip rules and quotas but are redacted (§10.4).
		const message = this.ctx.logGuard?.redact(input.orgId, input.projectId, sanitize(input.message)) ?? sanitize(input.message);
		this.tracked('le', () => this.ctx.db
			.insert(logEvents)
			.values({
				orgId: input.orgId,
				projectId: input.projectId,
				deploymentId: input.deploymentId ?? null,
				buildId: input.buildId ?? null,
				nodeId: input.nodeId ?? null,
				source: 'system',
				stream: 'system',
				level: input.level ?? 'info',
				message,
				ts: this.ctx.now(),
			})
			.run());
	}

	/**
	 * Newest page (`after` omitted) or everything after a cursor (SSE reconnect). The extra row
	 * tells the caller whether to offer "load older".
	 */
	query(
		principal: Principal,
		project: ProjectRow,
		input: LogQuery = {},
	): LogQueryResult {
		this.ctx.iam.require(principal, 'logs:read', { type: 'project', id: project.id });
		const requested = Number(input.limit ?? DEFAULT_LIMIT);
		const limit = Number.isFinite(requested)
			? Math.max(1, Math.min(Math.floor(requested), MAX_LIMIT))
			: DEFAULT_LIMIT;
		const conditions = [
			eq(logEvents.orgId, principal.orgId),
			eq(logEvents.projectId, project.id),
			// Job output (plan 09) is read per run; the app's own stream leaves it out.
			input.jobRunId ? eq(logEvents.jobRunId, input.jobRunId) : isNull(logEvents.jobRunId),
		];
		// A build view includes lifecycle breadcrumbs (claim recovery, cancellation) alongside the
		// Builder's own stdout/stderr; the row is still scoped by buildId below.
		if (input.source === 'build' && input.buildId)
			conditions.push(inArray(logEvents.source, ['build', 'system']));
		else if (input.source) conditions.push(eq(logEvents.source, input.source));
		if (input.buildId) conditions.push(eq(logEvents.buildId, input.buildId));
		if (input.deploymentId)
			conditions.push(eq(logEvents.deploymentId, input.deploymentId));
		if (input.level) {
			const index = LEVEL_ORDER.indexOf(input.level);
			conditions.push(
				inArray(logEvents.level, LEVEL_ORDER.slice(Math.max(0, index))),
			);
		}
		const q = input.q?.trim();
		if (q)
			conditions.push(
				sql`instr(lower(${logEvents.message}), lower(${q.slice(0, 200)})) > 0`,
			);

		const after = input.after;
		let rows: Array<typeof logEvents.$inferSelect>;
		if (after !== undefined) {
			rows = this.ctx.db
				.select()
				.from(logEvents)
				.where(and(...conditions, gt(logEvents.seq, after)))
				.orderBy(asc(logEvents.seq))
				.limit(limit + 1)
				.all();
		} else {
			rows = this.ctx.db
				.select()
				.from(logEvents)
				.where(and(...conditions))
				.orderBy(desc(logEvents.seq))
				.limit(limit + 1)
				.all()
				.reverse();
		}
		const hasMore = rows.length > limit;
		if (hasMore)
			rows = after !== undefined ? rows.slice(0, limit) : rows.slice(1);
		return {
			events: rows.map(toView),
			cursor: rows.at(-1)?.seq ?? after ?? 0,
			hasMore,
		};
	}

	// --- Node-shipped records (docs/LOGS.md §5; Lane N1) -----------------------------------

	/**
	 * Store a `NodeLogBatch` from an authenticated node: platform unit journald, edge access
	 * lines and OTLP records (LP5–LP7). The target resolves server-side (`resolveNodeLogTarget`):
	 * a workload to its project with the runs-on-node check (403 otherwise), a site host to the
	 * project that serves it, and a platform unit to `platform:<nodeId>` under the sentinel org
	 * `PLATFORM_LOG_ORG_ID`. Rows go to `log_records`, the node's `dropped` count to
	 * `log_drop_counts`, and the inserted rows to the `onAppend` listeners. A target that no
	 * longer exists is an empty, successful drain; platform batches are discarded while
	 * `PLATFORM_LOGS` is off, and the answer says so the agent backs off.
	 */
	appendRecords(nodeId: string, batch: NodeLogBatch): { stored: number; disabled?: true } {
		if (batch.target.kind === 'platform' && !featureEnabled(this.ctx.config, 'PLATFORM_LOGS'))
			return { stored: 0, disabled: true };
		const resolved = resolveNodeLogTarget(this.ctx, nodeId, batch.target);
		if (!resolved || (batch.records.length === 0 && batch.dropped === 0)) return { stored: 0 };
		const { stored, rows } = insertNodeLogRecords(this.ctx, nodeId, resolved, batch);
		if (rows.length > 0) this.emitAppended(rows);
		return { stored };
	}

	// ------------------------------------------------------------------------------------------

	/**
	 * Delete hot-tail rows past retention, then keep at most `cap` newest rows per scope in each
	 * table (docs/LOGS.md §10.1–§10.2, LP9): a noisy project trims only its own history. Without
	 * `retentionMs` each org uses its effective hot-tail days (`log-retention.ts`). Kubernetes and
	 * pipeline lines keep their own retention.
	 */
	prune(now = this.ctx.now(), retentionMs?: number, cap = LOG_SCOPE_ROW_CAP): number {
		return this.ctx.logRetention.pruneHotTail(now, retentionMs, cap);
	}
}

function sanitize(message: string): string {
	return (
		message
			.replace(/\u0000/g, '')
			// Terminal colour is not useful in a shared log view; keep the text, drop the escapes.
			.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
			.slice(0, 16_384)
	);
}

/**
 * Parse again on the way out, so rows stored before ingestion parsed lines (or by an older
 * parser) still read as level + message. A parsed level only replaces the default `info`, never
 * a level the node or an earlier parse already chose.
 */
function present(
	source: string,
	level: LogLevel,
	message: string,
): { level: LogLevel; message: string } {
	if (source === 'system') return { level, message };
	const replica = /^\[r\d+\] /.exec(message)?.[0] ?? '';
	const parsed = parseLogLine(message.slice(replica.length));
	if (parsed.format === 'raw') return { level, message };
	return {
		level: level === 'info' && parsed.level ? parsed.level : level,
		message: parsed.message ? `${replica}${sanitize(parsed.message)}` : message,
	};
}

function toView(row: typeof logEvents.$inferSelect): LogEventView {
	return {
		seq: row.seq,
		ts: row.ts,
		source: row.source,
		stream: row.stream,
		...present(row.source, row.level, row.message),
		projectId: row.projectId,
		deploymentId: row.deploymentId,
		buildId: row.buildId,
	};
}
