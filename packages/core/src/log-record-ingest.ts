import { and, eq, sql } from 'drizzle-orm';
import { databases, domains, logRecords, nodes, projects, storageInstances, workloads } from '@yoal/db';
import {
	isPlatformLogUnit,
	parseWorkloadReplicaId,
	SEVERITY_NUMBER,
	type LogRecordSource,
	type LogScopeKind,
	type NodeLogBatch,
	type NodeLogRecord,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';
import type { UnifiedLogRow } from './log-store/sqlite-sources.ts';
import type { ProjectRow } from './projects.ts';

/**
 * Record ingest for the node-shipped sources (docs/LOGS.md §5: platform units, edge access lines,
 * OTLP; LP5–LP7). A node posts a `NodeLogBatch`; tenancy never comes from the payload. The control
 * plane resolves the batch target to an org and scope here, and `LogService.appendRecords` writes
 * the rows to `log_records`.
 *
 * Org rule for records no tenant owns (`platform` and unattributed `edge` scopes): `org_id` is the
 * sentinel `PLATFORM_LOG_ORG_ID` ('platform'), never a real org. The install has no "owning org"
 * row, and a sentinel means a tenant boundary (`org_id = <org>`) can never include Yoal's own
 * logs, even for an org whose workloads are the only ones on the node (decided 2026-11-25, §15.2).
 * Readers grant these scopes to platform admins only (§10.5) and match this org id explicitly.
 */
export const PLATFORM_LOG_ORG_ID = 'platform';

/** Bounds per record, server-side, on top of the contract's per-value limits. */
const MAX_ATTRIBUTE_KEYS = 64;
const MAX_RESOURCE_KEYS = 32;
/** Rows per INSERT, well inside SQLite's bound-parameter limit (18 columns each). */
const INSERT_CHUNK = 500;

/** Sources only the control plane writes; a node cannot claim them for a workload or site. */
const SERVER_ONLY_SOURCES: ReadonlySet<LogRecordSource> = new Set(['build', 'job', 'pipeline', 'audit', 'email', 'platform']);

export interface ResolvedLogTarget {
	orgId: string;
	scopeKind: LogScopeKind;
	scopeId: string;
	stream: string | null;
	projectId: string | null;
	deploymentId: string | null;
	/** The `source` every record of the batch is stored with, when the target fixes it. */
	source: LogRecordSource | null;
	/** Server-stamped resource keys; they override whatever the node sent. */
	resource: Record<string, string>;
}

/** `Example.COM.:443` → `example.com`. */
export function normalizeLogHost(host: string): string {
	let value = host.trim().toLowerCase();
	if (value.startsWith('[')) value = value.slice(0, value.indexOf(']') + 1 || undefined);
	else if (value.split(':').length === 2) value = value.split(':')[0]!;
	return value.replace(/\.+$/, '');
}

/**
 * Resolve a batch target to the scope its records belong to (docs/LOGS.md §3). Returns null when
 * the target no longer exists (a workload removed between the read and the POST): the caller
 * answers an empty, successful drain, like `appendRuntime`. Throws 403 when the node does not run
 * the workload or service, and 400 for a platform unit outside the allow-list.
 *
 * - `workload`: the project (and deployment) of the workload, with the same replica / runs-on-node
 *   check as `appendRuntime`; managed storage and databases resolve to their own scope.
 * - `site`: the project that serves the host (verified custom domain or its `www.` redirect
 *   sibling, preview host, environment host or `<slug>.<contentDomain>`, through
 *   `AccessService.resolveContentHost`). A host no project serves (the control plane's own host,
 *   a stray Host header) goes to the node's `edge` scope under `PLATFORM_LOG_ORG_ID`.
 * - `platform`: `platform:<nodeId>` under `PLATFORM_LOG_ORG_ID`, stream `unit:<unit>`.
 */
export function resolveNodeLogTarget(ctx: CoreContext, nodeId: string, target: NodeLogBatch['target']): ResolvedLogTarget | null {
	if (target.kind === 'platform') {
		if (!isPlatformLogUnit(target.unit)) throw new CoreError('invalid_unit', 'Unknown platform log unit.', 400);
		return {
			orgId: PLATFORM_LOG_ORG_ID,
			scopeKind: 'platform',
			scopeId: nodeId,
			stream: `unit:${target.unit}`,
			projectId: null,
			deploymentId: null,
			source: 'platform',
			resource: { 'service.name': target.unit },
		};
	}
	if (target.kind === 'site') return resolveSite(ctx, nodeId, normalizeLogHost(target.host));
	return resolveWorkload(ctx, nodeId, target.workloadId);
}

function resolveWorkload(ctx: CoreContext, nodeId: string, id: string): ResolvedLogTarget | null {
	// Replicas (plan 21) post under `<id>-r<n>` and belong to the workload `<id>`.
	const { workloadId, replica } = parseWorkloadReplicaId(id);
	const workload = ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
	if (workload) {
		// A spread copy (C4) or a copy mid-move runs on a node other than `workloads.node_id`.
		if (!ctx.workloads.runsOnNode(workload, replica, nodeId))
			throw new CoreError('forbidden', 'This workload is placed on another node.', 403);
		const project = ctx.db.select().from(projects).where(eq(projects.id, workload.projectId)).get();
		if (!project || project.deletedAt) return null;
		return {
			orgId: workload.orgId,
			scopeKind: 'project',
			scopeId: workload.projectId,
			stream: `deployment:${workload.deploymentId}`,
			projectId: workload.projectId,
			deploymentId: workload.deploymentId,
			source: null,
			resource: {
				'service.name': project.slug,
				'deployment.id': workload.deploymentId,
				replica: String(replica),
			},
		};
	}
	// Managed services are not in `workloads`; their ids resolve to their own table.
	const storage = ctx.db.select().from(storageInstances).where(eq(storageInstances.id, workloadId)).get();
	const database = storage ? undefined : ctx.db.select().from(databases).where(eq(databases.id, workloadId)).get();
	const service = storage ?? database;
	if (!service) return null;
	if (service.nodeId !== nodeId) throw new CoreError('forbidden', 'This service is placed on another node.', 403);
	return {
		orgId: service.orgId,
		scopeKind: storage ? 'storage' : 'database',
		scopeId: service.id,
		stream: null,
		projectId: null,
		deploymentId: null,
		source: null,
		resource: { 'service.name': service.name },
	};
}

function resolveSite(ctx: CoreContext, nodeId: string, host: string): ResolvedLogTarget {
	const route = ctx.access.resolveContentHost(host);
	const project = route?.project ?? wwwSiblingProject(ctx, host);
	const deploymentId = route?.deploymentId ?? project?.productionDeploymentId ?? null;
	if (project)
		return {
			orgId: project.orgId,
			scopeKind: 'project',
			scopeId: project.id,
			stream: `site:${host}`,
			projectId: project.id,
			deploymentId,
			source: null,
			resource: {
				'service.name': project.slug,
				'http.host': host,
				...(deploymentId ? { 'deployment.id': deploymentId } : {}),
			},
		};
	return {
		orgId: PLATFORM_LOG_ORG_ID,
		scopeKind: 'edge',
		scopeId: nodeId,
		stream: `site:${host}`,
		projectId: null,
		deploymentId: null,
		source: null,
		resource: { 'http.host': host },
	};
}

/** `www.example.com` when `example.com` is a verified custom domain that redirects www. */
function wwwSiblingProject(ctx: CoreContext, host: string): ProjectRow | null {
	if (!host.startsWith('www.')) return null;
	const parent = ctx.db
		.select()
		.from(domains)
		.where(and(eq(domains.hostname, host.slice(4)), sql`${domains.status} IN ('verified','active')`))
		.get();
	if (!parent?.redirectWww) return null;
	const project = ctx.db.select().from(projects).where(eq(projects.id, parent.projectId)).get() as ProjectRow | undefined;
	return project && !project.deletedAt ? project : null;
}

/** Same cleaning as `LogService`'s `sanitize`: no NULs, no ANSI escapes, 16 KiB. */
export function sanitizeLogBody(message: string): string {
	return message
		.replace(/\u0000/g, '')
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
		.slice(0, 16_384);
}

function boundedMap(input: Record<string, string> | undefined, maxKeys: number): Record<string, string> {
	const out: Record<string, string> = {};
	let count = 0;
	for (const [key, value] of Object.entries(input ?? {})) {
		if (count >= maxKeys) break;
		if (typeof value !== 'string') continue;
		out[key] = value.replace(/\u0000/g, '');
		count += 1;
	}
	return out;
}

function sourceFor(resolved: ResolvedLogTarget, record: NodeLogRecord): LogRecordSource {
	if (resolved.source) return resolved.source;
	return SERVER_ONLY_SOURCES.has(record.source) ? 'runtime' : record.source;
}

function optionalId(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/** Map a validated batch onto `log_records` rows (without `seq`). Pure apart from its inputs. */
export function buildLogRecordRows(
	resolved: ResolvedLogTarget,
	node: { id: string; name: string | null },
	records: readonly NodeLogRecord[],
	now: number,
): Array<Omit<UnifiedLogRow, 'seq'>> {
	const stamped: Record<string, string> = {
		...resolved.resource,
		'host.id': node.id,
		...(node.name ? { 'host.name': node.name } : {}),
	};
	return records.map((record) => {
		const severity = Math.max(0, Math.min(24, Math.floor(record.severityNumber)));
		const resource = { ...boundedMap(record.resource, MAX_RESOURCE_KEYS), ...stamped };
		return {
			tag: 'lr',
			ts: Number.isFinite(record.ts) && record.ts > 0 ? Math.floor(record.ts) : now,
			observed_ts: now,
			org_id: resolved.orgId,
			scope_kind: resolved.scopeKind,
			scope_id: resolved.scopeId,
			stream: resolved.stream,
			source: sourceFor(resolved, record),
			channel: record.channel ?? null,
			// 0 is OTel's "unspecified"; stored as info like every other reader treats it.
			severity_number: severity === 0 ? SEVERITY_NUMBER.info : severity,
			body: sanitizeLogBody(record.body),
			attributes: JSON.stringify(boundedMap(record.attributes, MAX_ATTRIBUTE_KEYS)),
			resource: JSON.stringify(resource),
			trace_id: optionalId(record.traceId),
			span_id: optionalId(record.spanId),
			request_id: optionalId(record.requestId),
			project_id: resolved.projectId,
			deployment_id: resolved.deploymentId,
			build_id: null,
			job_run_id: null,
			node_id: node.id,
		};
	});
}

export interface AppendRecordsResult {
	stored: number;
	/** Set when the batch was discarded because its source is switched off (`PLATFORM_LOGS`). */
	disabled?: boolean;
	/** The rows as inserted, with their `seq`, for the tail bus (`LogService.onAppend`). */
	rows: UnifiedLogRow[];
}

/**
 * Write a resolved batch: rows into `log_records` (in chunks, one transaction) and the node's
 * `dropped` count into `log_drop_counts` (reason `node`, per scope per minute; `minute` is the
 * epoch-ms start of the minute).
 */
export function insertNodeLogRecords(
	ctx: CoreContext,
	nodeId: string,
	resolved: ResolvedLogTarget,
	batch: NodeLogBatch,
): AppendRecordsResult {
	const now = ctx.now();
	const node = ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get();
	const rows = buildLogRecordRows(resolved, { id: nodeId, name: node?.name ?? null }, batch.records, now);
	const inserted: UnifiedLogRow[] = [];
	ctx.db.transaction((tx) => {
		for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
			const chunk = rows.slice(index, index + INSERT_CHUNK);
			const seqs = tx
				.insert(logRecords)
				.values(
					chunk.map((row) => ({
						orgId: row.org_id,
						scopeKind: row.scope_kind,
						scopeId: row.scope_id,
						stream: row.stream,
						source: row.source,
						channel: row.channel,
						severityNumber: row.severity_number,
						body: row.body,
						attributes: row.attributes ?? '{}',
						resource: row.resource ?? '{}',
						traceId: row.trace_id,
						spanId: row.span_id,
						requestId: row.request_id,
						projectId: row.project_id,
						deploymentId: row.deployment_id,
						nodeId: row.node_id,
						ts: row.ts,
						observedTs: row.observed_ts ?? now,
					})),
				)
				.returning({ seq: logRecords.seq })
				.all()
				.map((row) => row.seq)
				// One multi-row INSERT assigns increasing rowids in VALUES order; RETURNING order is not
				// guaranteed, so pair by sorted seq.
				.sort((a, b) => a - b);
			chunk.forEach((row, offset) => inserted.push({ ...row, seq: seqs[offset]! }));
		}
		if (batch.dropped > 0)
			tx.run(sql`INSERT INTO log_drop_counts (org_id, scope_kind, scope_id, minute, reason, lines, bytes)
				VALUES (${resolved.orgId}, ${resolved.scopeKind}, ${resolved.scopeId}, ${Math.floor(now / 60_000) * 60_000}, 'node', ${batch.dropped}, 0)
				ON CONFLICT (scope_kind, scope_id, minute, reason) DO UPDATE SET lines = lines + excluded.lines`);
	});
	return { stored: inserted.length, rows: inserted };
}
