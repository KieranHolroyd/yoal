import {
	LOG_COMPARE_ORDER,
	classifyLogCompare,
	logCompareInputSchema,
	logWhyInputSchema,
	type LogCompareInput,
	type LogCompareResult,
	type LogCompareRow,
	type LogScopeRef,
	type LogWarning,
	type LogWhyResult,
	type LogWhyRow,
	type Principal,
} from '@yoal/contracts';
import type * as z from 'zod';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError, ValidationError } from './errors.ts';
import {
	COMPARE_PATTERN_CAP,
	WHY_ATTRIBUTE_KEYS,
	WHY_BUILTINS,
	compileCompare,
	compileCompareTotals,
	compileWhy,
	compileWhyTotals,
	type LogWindow,
} from './log-store/clickhouse-analysis.ts';
import { compileMapKeys, type ClickHouseCompileOptions, type CompiledLogQuery } from './log-store/clickhouse-compiler.ts';
import type { LogStoreRead } from './log-store/types.ts';

/**
 * Compare and Why? (docs/LOGS.md §8.2–§8.3, L4). `LogExplorerService.compare()` / `why()` are thin
 * hooks into this module; the SQL lives in `log-store/clickhouse-analysis.ts`.
 *
 * - **Compare** runs the query's filter over two windows and classifies every pattern by its
 *   per-minute rate: new, rising, falling, gone or steady (`classifyLogCompare`). A deploy
 *   baseline reads the deployment's live time from SQLite and compares the same length either
 *   side of it.
 * - **Why?** compares a brushed selection with the rest of the window across the built-ins and
 *   the top attribute keys, and ranks field values by lift (selection share − baseline share).
 *
 * Both need ClickHouse (lite mode is a 422 `needs_clickhouse`) and `logs:query` as well as
 * `logs:read`, like every pipe-stage read (§10.5). Tenancy comes from the service's boundary.
 */

/** What a prepared read looks like to this module (the service's `PreparedRead`). */
export interface AnalysisPrepared {
	read: LogStoreRead;
	q: string;
	platform: LogScopeRef[];
}

/** The ClickHouse store's analysis surface (`ClickHouseLogStore.analysis`). */
export interface LogAnalysisStore {
	analysis(compile: (options: ClickHouseCompileOptions) => CompiledLogQuery): Promise<unknown[][]>;
	analysisWarnings?(read: LogStoreRead): LogWarning[];
	healthy?: () => boolean | Promise<boolean>;
}

/** What `LogExplorerService` lends this module. */
export interface LogAnalysisHost {
	ctx: Pick<CoreContext, 'sqlite' | 'now'>;
	/** Parse, resolve the boundary (with `logs:read` + `logs:query`) and default the window. */
	prepare(principal: Principal, input: { q: string; scopes: LogScopeRef[]; from?: number; to?: number }): AnalysisPrepared;
	audit(principal: Principal, prepared: AnalysisPrepared, op: string): void;
	/** The healthy ClickHouse store, or null in lite mode. */
	clickhouse(): unknown;
}

type Input<S extends z.ZodType> = z.input<S> | Record<string, unknown>;

/** A deployment's live time and project, for a deploy baseline. */
export interface DeployMoment {
	id: string;
	projectId: string;
	at: number;
}

// ------------------------------------------------------------------------------------ pure

/**
 * The two windows a compare reads (§8.2). `current` is the request's window except for a deploy
 * baseline, where it starts at the deploy and runs for the window's length (cut at `now`), and the
 * baseline is the same length right before the deploy.
 */
export function compareWindows(
	window: LogWindow,
	baseline: LogCompareInput['baseline'],
	now: number,
	deploy: DeployMoment | null = null,
): { current: LogWindow; baseline: LogWindow } {
	const span = window.to - window.from;
	if (span <= 0) throw new ValidationError('The compare window is empty; widen the time range.', [{ path: ['from'], message: 'from must be before to' }]);
	switch (baseline.kind) {
		case 'previous':
			return { current: window, baseline: { from: window.from - span, to: window.from } };
		case 'offset':
			return { current: window, baseline: { from: window.from - baseline.offsetMs, to: window.to - baseline.offsetMs } };
		case 'range': {
			const from = Math.min(baseline.from, baseline.to);
			const to = Math.max(baseline.from, baseline.to);
			if (to <= from) throw new ValidationError('The baseline range is empty.', [{ path: ['baseline'], message: 'from must be before to' }]);
			return { current: window, baseline: { from, to } };
		}
		case 'deploy': {
			if (!deploy) throw new NotFoundError('Deployment');
			const end = Math.max(deploy.at + 1, Math.min(deploy.at + span, now));
			const length = end - deploy.at;
			return { current: { from: deploy.at, to: end }, baseline: { from: deploy.at - length, to: deploy.at } };
		}
	}
}

/** Raw compare rows `[pattern, template, current, baseline, sample]` → classified, ordered, cut. */
export function classifyCompareRows(
	data: readonly unknown[][],
	windows: { current: LogWindow; baseline: LogWindow },
	limit: number,
): LogCompareRow[] {
	const currentMs = windows.current.to - windows.current.from;
	const baselineMs = windows.baseline.to - windows.baseline.from;
	const minutes = (ms: number) => Math.max(1, ms / 60_000);
	const rows = data
		.map(([pattern, template, current, baseline, sample]) => {
			const now = Number(current) || 0;
			const before = Number(baseline) || 0;
			const { change, ratio } = classifyLogCompare(now, before, currentMs, baselineMs);
			return {
				patternId: String(pattern ?? ''),
				template: String(template ?? ''),
				current: now,
				baseline: before,
				change,
				ratio: ratio === null ? null : Math.round(ratio * 1_000) / 1_000,
				sampleId: typeof sample === 'string' && sample ? sample : null,
			} satisfies LogCompareRow;
		})
		.filter((row) => row.patternId && (row.current > 0 || row.baseline > 0));
	// Biggest per-minute movement first inside each group.
	const delta = (row: LogCompareRow) => Math.abs(row.current / minutes(currentMs) - row.baseline / minutes(baselineMs));
	rows.sort((a, b) => LOG_COMPARE_ORDER[a.change] - LOG_COMPARE_ORDER[b.change] || delta(b) - delta(a) || a.patternId.localeCompare(b.patternId));
	return rows.slice(0, limit);
}

/** Raw Why? rows `[field, value, selection, rest]` → shares and lift, ranked, positive lift only. */
export function rankWhyRows(
	data: readonly unknown[][],
	totals: { selection: number; baseline: number },
	limit: number,
): LogWhyRow[] {
	const share = (count: number, total: number) => (total > 0 ? count / total : 0);
	const rows: LogWhyRow[] = [];
	for (const [field, value, selection, rest] of data) {
		const selectionCount = Number(selection) || 0;
		const baselineCount = Number(rest) || 0;
		if (selectionCount <= 0) continue;
		const selectionShare = share(selectionCount, totals.selection);
		const baselineShare = share(baselineCount, totals.baseline);
		const lift = selectionShare - baselineShare;
		if (lift <= 0) continue;
		rows.push({
			field: String(field ?? ''),
			value: String(value ?? ''),
			selectionCount,
			baselineCount,
			selectionShare: round(selectionShare),
			baselineShare: round(baselineShare),
			lift: round(lift),
		});
	}
	rows.sort((a, b) => b.lift - a.lift || b.selectionCount - a.selectionCount || a.field.localeCompare(b.field) || a.value.localeCompare(b.value));
	return rows.slice(0, limit);
}

function round(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

// --------------------------------------------------------------------------------- service

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
	const parsed = schema.safeParse(input ?? {});
	if (!parsed.success) throw new ValidationError('Invalid log read.', parsed.error.issues);
	return parsed.data;
}

function needsClickhouse(feature: 'compare' | 'why'): CoreError {
	const message =
		feature === 'compare'
			? 'Compare needs the search index (ClickHouse). Lite mode searches the SQLite hot tail only.'
			: 'Why? needs the search index (ClickHouse). Lite mode searches the SQLite hot tail only.';
	const failure = new CoreError('needs_clickhouse', message, 422);
	(failure as CoreError & { feature?: string }).feature = feature;
	return failure;
}

async function analysisStore(host: LogAnalysisHost, feature: 'compare' | 'why'): Promise<LogAnalysisStore> {
	const store = host.clickhouse() as Partial<LogAnalysisStore> | null;
	if (!store || typeof store.analysis !== 'function') throw needsClickhouse(feature);
	try {
		if (typeof store.healthy === 'function' && !(await store.healthy())) throw needsClickhouse(feature);
	} catch (error) {
		if (error instanceof CoreError) throw error;
		throw needsClickhouse(feature);
	}
	return store as LogAnalysisStore;
}

/** A deployment in the caller's org by id or short id, or null. */
export function findDeployMoment(sqlite: CoreContext['sqlite'], orgId: string, id: string): DeployMoment | null {
	const row = sqlite
		.query<{ id: string; project_id: string; at: number }, [string, string, string]>(
			`SELECT id, project_id, COALESCE(activated_at, created_at) AS at FROM deployments
			 WHERE org_id = ? AND (id = ? OR short_id = ?) ORDER BY created_at DESC LIMIT 1`,
		)
		.get(orgId, id, id);
	return row ? { id: row.id, projectId: row.project_id, at: Number(row.at) } : null;
}

/** Strip pipe stages: compare and Why? read the filter only. */
function filterOnly(prepared: AnalysisPrepared): LogStoreRead {
	return { ...prepared.read, ast: { filter: prepared.read.ast.filter, pipes: [] } };
}

export async function compareLogs(host: LogAnalysisHost, principal: Principal, input: Input<typeof logCompareInputSchema>): Promise<LogCompareResult> {
	const value = parse(logCompareInputSchema, input);
	let scopes = value.scopes;
	let deploy: DeployMoment | null = null;
	if (value.baseline.kind === 'deploy') {
		deploy = findDeployMoment(host.ctx.sqlite, principal.orgId, value.baseline.deploymentId);
		// "What did this deploy change?" reads the deploy's project unless the caller chose scopes.
		if (deploy && scopes.length === 0)
			scopes = [
				{ kind: 'project', id: deploy.projectId },
				{ kind: 'function', id: deploy.projectId },
			];
	}
	const prepared = host.prepare(principal, { q: value.q, scopes, from: value.from, to: value.to });
	if (deploy) {
		const projectId = deploy.projectId;
		const readable = prepared.read.boundary.scopes.some((scope) => (scope.kind === 'project' || scope.kind === 'function') && scope.id === projectId);
		// Another org's deployment, or one the caller cannot read, is "not found" like a missing one.
		if (!readable) deploy = null;
	}
	const store = await analysisStore(host, 'compare');
	const windows = compareWindows({ from: prepared.read.from, to: prepared.read.to }, value.baseline, host.ctx.now(), deploy);
	host.audit(principal, prepared, 'compare');
	const read = filterOnly(prepared);
	if (read.boundary.scopes.length === 0)
		return { current: { ...windows.current, total: 0 }, baseline: { ...windows.baseline, total: 0 }, rows: [], engine: 'clickhouse', warnings: [] };
	const [totals, data] = await Promise.all([
		store.analysis((options) => compileCompareTotals(read, windows.current, windows.baseline, options)),
		store.analysis((options) => compileCompare(read, windows.current, windows.baseline, options)),
	]);
	const currentTotal = Number(totals[0]?.[0] ?? 0) || 0;
	const baselineTotal = Number(totals[0]?.[1] ?? 0) || 0;
	const rows = classifyCompareRows(data, windows, value.limit);
	const warnings: LogWarning[] = [...(store.analysisWarnings?.({ ...read, from: windows.current.from, to: windows.current.to }) ?? [])];
	const mined = data.reduce<number>((sum, row) => sum + (Number(row[2]) || 0) + (Number(row[3]) || 0), 0);
	const unmined = currentTotal + baselineTotal - mined;
	if (unmined > 0 && data.length < COMPARE_PATTERN_CAP)
		warnings.push({
			code: 'partial',
			message: `${unmined.toLocaleString('en-GB')} line${unmined === 1 ? ' has' : 's have'} no pattern yet and ${unmined === 1 ? 'is' : 'are'} only counted in the totals.`,
		});
	return {
		current: { ...windows.current, total: currentTotal },
		baseline: { ...windows.baseline, total: baselineTotal },
		rows,
		engine: 'clickhouse',
		warnings,
	};
}

export async function whyLogs(host: LogAnalysisHost, principal: Principal, input: Input<typeof logWhyInputSchema>): Promise<LogWhyResult> {
	const value = parse(logWhyInputSchema, input);
	const prepared = host.prepare(principal, { q: value.q, scopes: value.scopes, from: value.from, to: value.to });
	const read = filterOnly(prepared);
	const selection: LogWindow = {
		from: Math.max(read.from, Math.min(value.selection.from, value.selection.to)),
		to: Math.min(read.to, Math.max(value.selection.from, value.selection.to)),
	};
	if (selection.to <= selection.from)
		throw new ValidationError('The selection must lie inside the time window.', [{ path: ['selection'], message: 'outside from..to' }]);
	const store = await analysisStore(host, 'why');
	host.audit(principal, prepared, 'why');
	if (read.boundary.scopes.length === 0)
		return { selection: { ...selection, total: 0 }, baseline: { from: read.from, to: read.to, total: 0 }, rows: [], engine: 'clickhouse', warnings: [] };
	const [totalsData, keysData] = await Promise.all([
		store.analysis((options) => compileWhyTotals(read, selection, options)),
		value.fields?.length ? Promise.resolve([]) : store.analysis((options) => compileMapKeys(read, 'attributes', WHY_ATTRIBUTE_KEYS, options)),
	]);
	const totals = { selection: Number(totalsData[0]?.[0] ?? 0) || 0, baseline: Number(totalsData[0]?.[1] ?? 0) || 0 };
	const fields = value.fields?.length ? value.fields : [...WHY_BUILTINS, ...keysData.map(([key]) => `@${String(key)}`)];
	const warnings: LogWarning[] = [...(store.analysisWarnings?.(read) ?? [])];
	if (totals.baseline === 0 && totals.selection > 0)
		warnings.push({ code: 'partial', message: 'Nothing outside the selection to compare with; widen the time range.' });
	if (totals.selection === 0)
		return { selection: { ...selection, total: 0 }, baseline: { from: read.from, to: read.to, total: totals.baseline }, rows: [], engine: 'clickhouse', warnings };
	const data = await store.analysis((options) => compileWhy(read, selection, fields, totals, options));
	return {
		selection: { ...selection, total: totals.selection },
		baseline: { from: read.from, to: read.to, total: totals.baseline },
		rows: rankWhyRows(data, totals, value.limit),
		engine: 'clickhouse',
		warnings,
	};
}
