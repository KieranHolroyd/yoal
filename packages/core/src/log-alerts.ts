import {
	alertRuleProblem,
	builderLogsOf,
	compareAlert,
	formatLogQuery,
	formatLogQueryValue,
	logAlertExplorerHref,
	logAlertScopeKinds,
	logsBuilderOf,
	logsBuilderQuery,
	type AlertRuleSpec,
	type LogQueryNode,
	type LogScopeRef,
	type LogTableResult,
	type Permission,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, ValidationError } from './errors.ts';

/**
 * Log alert rules (docs/LOGS.md §9.1, extending D109). `AlertService` owns the rule rows, states and
 * notifications; this module turns a log rule into series by reading through the Logs Explorer as
 * the rule's org (`system:alerts`, which holds `logs:read` and `logs:query` org-wide), so the same
 * boundary, store choice (ClickHouse, or SQLite in lite mode) and query compilers apply as for a
 * person reading the Explorer.
 *
 * - `log_count` runs `<filter> | stats count() [by …]` over the trailing window. One series (the
 *   count, 0 when nothing matched), or one per group. Lite mode answers it.
 * - `log_pattern_new` runs `<filter> | patterns` over the current window, keeps the patterns whose
 *   count meets the condition, then asks whether each was seen in the scope during the lookback
 *   before the window (`pattern:a OR pattern:b | stats count() by pattern`). The unseen ones are
 *   the series. With `afterDeployMinutes`, the window starts at the latest deploy in scope that went
 *   live within that many minutes (no recent deploy: no series), so a pattern is "new since the
 *   deploy" for the whole period. Needs ClickHouse: lite mode reports `needs_clickhouse`, and the
 *   rule shows that as its health error.
 */

/** Rows a grouped count may return; more groups than this is a query to narrow. */
export const LOG_ALERT_MAX_GROUPS = 1_000;
/** New-pattern candidates checked against the lookback per evaluation. */
export const LOG_ALERT_MAX_PATTERNS = 50;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Template text kept on a pattern series' labels. */
const TEMPLATE_LABEL_CHARS = 200;

export interface LogAlertSeries {
	labels: Record<string, string>;
	value: number | null;
	/** Explorer link narrowed to this series (relative to the platform origin's root). */
	link: string | null;
}

export interface LogAlertObservation {
	series: LogAlertSeries[];
	/** The log query that ran (shown as the preview's `sql`). */
	query: string;
	window: { from: number; to: number };
	/** Explorer link for the whole rule over the window. */
	link: string | null;
	notice?: string;
}

interface LogTableReader {
	table(principal: Principal, input: { q: string; scopes: LogScopeRef[]; from: number; to: number }): Promise<LogTableResult>;
	resolveBoundary(principal: Principal, requested?: readonly LogScopeRef[], permissions?: readonly Permission[]): { boundary: { scopes: LogScopeRef[] } };
}

/** Permissions the author of a rule needs on its scopes (the evaluator itself runs as the org). */
export function logAlertPermissions(spec: Pick<AlertRuleSpec, 'kind' | 'query'>): Permission[] {
	const logs = logsBuilderOf(spec.query);
	const needsQuery =
		spec.kind === 'log_pattern_new' ||
		(logs !== null && (logs.groupBy.length > 0 || logs.metrics.some((metric) => metric.field !== 'count')));
	return needsQuery ? ['logs:read', 'logs:query'] : ['logs:read'];
}

/** Labels of a table row: every string column. The value: the last number column. */
function rowSeries(table: LogTableResult, row: Array<string | number | null>): { labels: Record<string, string>; value: number | null } {
	const labels: Record<string, string> = {};
	let value: number | null = null;
	table.columns.forEach((column, index) => {
		const cell = row[index];
		if (column.type === 'number') {
			const number = typeof cell === 'number' ? cell : cell === null || cell === undefined ? Number.NaN : Number(cell);
			value = Number.isFinite(number) ? number : null;
		} else if (column.type === 'string') labels[column.name] = cell === null || cell === undefined ? '' : String(cell);
	});
	return { labels, value };
}

/** `field:value` for each label, to narrow an Explorer link to one series. */
function labelFilter(labels: Record<string, string>): string {
	return Object.entries(labels)
		.filter(([, value]) => value !== '')
		.map(([field, value]) => `${field}:${formatLogQueryValue(value)}`)
		.join(' ');
}

export class LogAlertEvaluator {
	constructor(
		private readonly ctx: CoreContext,
		private readonly reader: LogTableReader = ctx.logExplorer,
	) {}

	/**
	 * The author must be able to read (and, for grouped counts and patterns, query) every scope the
	 * rule reads: notifications quote counts and templates. Empty scopes read the whole org, so they
	 * need `logs:read` at org level. Runs when a rule's query is created or changed.
	 */
	validate(principal: Principal, spec: AlertRuleSpec): void {
		const problem = alertRuleProblem(spec);
		if (problem) throw new ValidationError(problem.message, [{ path: problem.path.split('.'), message: problem.message }]);
		const logs = logsBuilderOf(spec.query)!;
		const compiled = logsBuilderQuery(logs, null);
		if (!compiled.ok) throw new ValidationError(compiled.error, [{ path: ['query'], message: compiled.error }]);
		const { scopes } = builderLogsOf(logs);
		const permissions = logAlertPermissions(spec);
		if (scopes.length === 0) {
			for (const permission of permissions)
				if (!this.ctx.iam.can(principal, permission, { type: 'org' }))
					throw new CoreError(
						'forbidden',
						`This rule reads every scope in the organisation, which needs ${permission} on the whole organisation. Pick the scopes it reads instead.`,
						403,
					);
			return;
		}
		const readable = new Set(this.reader.resolveBoundary(principal, scopes, permissions).boundary.scopes.map((scope) => `${scope.kind}:${scope.id}`));
		const missing = scopes.find((scope) => !readable.has(`${scope.kind}:${scope.id}`));
		if (missing)
			throw new CoreError('forbidden', `You cannot read logs in ${missing.kind} ${missing.id}, so a rule cannot read them for you.`, 403);
	}

	/** Evaluate a log rule at `now` as `principal` (the org's `system:alerts` principal). */
	async observe(principal: Principal, spec: AlertRuleSpec, now: number): Promise<LogAlertObservation> {
		const problem = alertRuleProblem(spec);
		if (problem) throw new ValidationError(problem.message);
		const logs = logsBuilderOf(spec.query)!;
		// Defence in depth: the schema check already refuses platform and edge scopes.
		const scopes = builderLogsOf(logs).scopes.filter((scope) => logAlertScopeKinds.includes(scope.kind));
		if (spec.kind === 'log_count') return this.#count(principal, spec, scopes, now);
		return this.#patterns(principal, spec, scopes, now);
	}

	async #count(principal: Principal, spec: AlertRuleSpec, scopes: LogScopeRef[], now: number): Promise<LogAlertObservation> {
		const logs = logsBuilderOf(spec.query)!;
		const window = { from: now - spec.windowSeconds * 1000, to: now };
		const compiled = logsBuilderQuery(logs.groupBy.length > 0 ? { ...logs, limit: logs.limit ?? LOG_ALERT_MAX_GROUPS } : logs, null);
		if (!compiled.ok) throw new ValidationError(compiled.error);
		const table = await this.reader.table(principal, { q: compiled.q, scopes, from: window.from, to: window.to });
		const link = (extra = '') => this.#link(spec, window, extra);
		let series: LogAlertSeries[] = table.rows.map((row) => {
			const { labels, value } = rowSeries(table, row);
			return { labels, value, link: link(labelFilter(labels)) };
		});
		// An ungrouped count is always one series: nothing matched is a count of 0, not "no data".
		if (logs.groupBy.length === 0) series = [{ labels: {}, value: series[0]?.value ?? 0, link: link() }];
		return { series, query: compiled.q, window, link: link(), ...notice(table) };
	}

	async #patterns(principal: Principal, spec: AlertRuleSpec, scopes: LogScopeRef[], now: number): Promise<LogAlertObservation> {
		const logs = logsBuilderOf(spec.query)!;
		const options = { afterDeployMinutes: spec.pattern?.afterDeployMinutes ?? null, lookbackDays: spec.pattern?.lookbackDays ?? 7 };
		let from = now - spec.windowSeconds * 1000;
		if (options.afterDeployMinutes !== null) {
			const liveAt = this.latestDeploy(principal.orgId, scopes, now - options.afterDeployMinutes * MINUTE_MS, now);
			if (liveAt === null)
				return {
					series: [],
					query: '',
					window: { from, to: now },
					link: this.#link(spec, { from, to: now }),
					notice: `No deploy in scope went live in the last ${options.afterDeployMinutes} min, so there is nothing new to look for.`,
				};
			from = liveAt;
		}
		const window = { from, to: now };
		const filter = builderLogsOf(logs).q;
		const current = [filter.trim(), `| patterns | sort count desc | limit ${LOG_ALERT_MAX_PATTERNS * 4}`].filter(Boolean).join(' ');
		const table = await this.reader.table(principal, { q: current, scopes, from: window.from, to: window.to });
		const columns = new Map(table.columns.map((column, index) => [column.name.toLowerCase(), index]));
		const at = { pattern: columns.get('pattern'), template: columns.get('template'), count: columns.get('count') };
		if (at.pattern === undefined || at.count === undefined) throw new CoreError('query_failed', 'The patterns table has no pattern or count column.', 502);
		const candidates = table.rows
			.map((row) => ({
				id: String(row[at.pattern!] ?? ''),
				template: at.template === undefined ? '' : String(row[at.template] ?? ''),
				count: Number(row[at.count!] ?? 0),
			}))
			.filter((row) => row.id !== '' && Number.isFinite(row.count) && compareAlert(row.count, spec.condition))
			.sort((a, b) => b.count - a.count)
			.slice(0, LOG_ALERT_MAX_PATTERNS);

		const seen = new Set<string>();
		if (candidates.length > 0) {
			// Any line of the pattern in scope before the window counts as seen, whatever its other fields.
			const ids: LogQueryNode[] = candidates.map((row) => ({ type: 'field', field: { kind: 'builtin', name: 'pattern' }, op: 'eq', value: row.id }));
			const before = formatLogQuery({
				filter: ids.length === 1 ? ids[0]! : { type: 'or', children: ids },
				pipes: [{ type: 'stats', aggregations: [{ fn: 'count', alias: 'count' }], by: [{ type: 'field', field: { kind: 'builtin', name: 'pattern' }, alias: 'pattern' }] }],
			});
			const lookback = await this.reader.table(principal, {
				q: before,
				scopes,
				from: Math.max(0, window.from - options.lookbackDays * DAY_MS),
				to: Math.max(0, window.from - 1),
			});
			const patternColumn = lookback.columns.findIndex((column) => column.name.toLowerCase() === 'pattern');
			const countColumn = lookback.columns.findIndex((column) => column.type === 'number');
			for (const row of lookback.rows)
				if (patternColumn >= 0 && Number(row[countColumn] ?? 0) > 0) seen.add(String(row[patternColumn] ?? ''));
		}

		const series = candidates
			.filter((row) => !seen.has(row.id))
			.map((row) => ({
				labels: { pattern: row.id, template: row.template.slice(0, TEMPLATE_LABEL_CHARS) },
				value: row.count,
				link: this.#link(spec, window, `pattern:${formatLogQueryValue(row.id)}`),
			}));
		return { series, query: current, window, link: this.#link(spec, window), ...notice(table) };
	}

	/** When the newest deploy of a project in scope went live inside `[from, to]`, or null. */
	latestDeploy(orgId: string, scopes: LogScopeRef[], from: number, to: number): number | null {
		const projectIds = [...new Set(scopes.filter((scope) => scope.kind === 'project' || scope.kind === 'function').map((scope) => scope.id))];
		// Scopes that name only databases, brokers… have no deploys; empty scopes mean the whole org.
		if (scopes.length > 0 && projectIds.length === 0) return null;
		const filter = projectIds.length > 0 ? `AND project_id IN (${projectIds.map(() => '?').join(', ')})` : '';
		const row = this.ctx.sqlite
			.query<{ at: number | null }, Array<string | number>>(
				`SELECT max(activated_at) AS at FROM deployments WHERE org_id = ? ${filter} AND activated_at IS NOT NULL AND activated_at BETWEEN ? AND ?`,
			)
			.get(orgId, ...projectIds, from, to);
		return row?.at ?? null;
	}

	#link(spec: AlertRuleSpec, window: { from: number; to: number }, extra = ''): string | null {
		return logAlertExplorerHref(spec, window, extra, this.ctx.config.platformOrigin);
	}
}

function notice(table: LogTableResult): { notice?: string } {
	const text = table.warnings.map((warning) => warning.message).join(' ');
	return text ? { notice: text } : {};
}
