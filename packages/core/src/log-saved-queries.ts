import * as z from 'zod';
import {
	logSavedQueryInputSchema,
	logScopeRefSchema,
	logTimeRangeSchema,
	parseLogQuery,
	type LogSavedQuery,
	type LogSavedQueryInput,
	type LogScopeRef,
	type LogTimeRange,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import { newId, parseJson } from './util.ts';

/**
 * Saved log queries (docs/LOGS.md §7.2): name, query, scopes, time range and columns, personal or
 * shared with the org. A personal query is visible to its owner only; an org query to everyone
 * who can list saved queries. The owner edits and deletes their own with `logQuery:update` /
 * `logQuery:delete`; anyone else's org query needs `logQuery:manage` (org admins).
 *
 * A saved query's scopes are only a bookmark: running it still goes through the caller's own
 * read boundary, so sharing a query never shares access.
 */

/** PATCH body: every field optional and no defaults, so an omitted field is left as it is. */
export const logSavedQueryPatchSchema = z.object({
	name: z.string().min(1).max(120).optional(),
	q: z.string().max(4_000).optional(),
	scopes: z.array(logScopeRefSchema).max(200).optional(),
	range: logTimeRangeSchema.optional(),
	columns: z.array(z.string().max(200)).max(30).optional(),
	visibility: z.enum(['personal', 'org']).optional(),
});
export type LogSavedQueryPatch = z.infer<typeof logSavedQueryPatchSchema>;

interface SavedQueryRow {
	id: string;
	org_id: string;
	owner_id: string;
	name: string;
	query: string;
	scopes: string;
	range: string;
	columns: string;
	visibility: string;
	created_at: number;
	updated_at: number;
}

/** How many saved queries one org may hold, so the palette list stays cheap. */
const MAX_PER_ORG = 2_000;

export class LogSavedQueryService {
	constructor(private readonly ctx: CoreContext) {}

	list(principal: Principal): LogSavedQuery[] {
		this.ctx.iam.require(principal, 'logQuery:read', { type: 'org' });
		return this.ctx.sqlite
			.query<SavedQueryRow, [string, string]>(
				`SELECT * FROM log_saved_queries
				 WHERE org_id = ? AND (visibility = 'org' OR owner_id = ?)
				 ORDER BY lower(name), created_at`,
			)
			.all(principal.orgId, principal.userId)
			.map(toView);
	}

	get(principal: Principal, id: string): LogSavedQuery {
		this.ctx.iam.require(principal, 'logQuery:read', { type: 'org' });
		return toView(this.visibleRow(principal, id));
	}

	create(principal: Principal, input: LogSavedQueryInput | unknown): LogSavedQuery {
		this.ctx.iam.require(principal, 'logQuery:create', { type: 'org' });
		const parsed = logSavedQueryInputSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid saved query.', parsed.error.issues);
		const value = parsed.data;
		assertQueryParses(value.q);
		const count =
			this.ctx.sqlite
				.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM log_saved_queries WHERE org_id = ?')
				.get(principal.orgId)?.n ?? 0;
		if (count >= MAX_PER_ORG)
			throw new ValidationError(`An organization can keep up to ${MAX_PER_ORG} saved queries. Delete some first.`);
		const id = newId('lsq_');
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO log_saved_queries (id, org_id, owner_id, name, query, scopes, range, columns, visibility, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				principal.orgId,
				principal.userId,
				value.name.trim(),
				value.q,
				JSON.stringify(value.scopes),
				JSON.stringify(value.range),
				JSON.stringify(value.columns),
				value.visibility,
				now,
				now,
			],
		);
		this.ctx.audit.record({
			principal,
			action: 'log_query.create',
			resource: 'log_query',
			resourceId: id,
			args: { name: value.name, visibility: value.visibility },
			result: 'ok',
		});
		return this.get(principal, id);
	}

	update(principal: Principal, id: string, patch: LogSavedQueryPatch | unknown): LogSavedQuery {
		const parsed = logSavedQueryPatchSchema.safeParse(patch);
		if (!parsed.success) throw new ValidationError('Invalid saved query.', parsed.error.issues);
		const row = this.visibleRow(principal, id);
		this.requireWrite(principal, row, 'logQuery:update');
		const value = parsed.data;
		if (value.q !== undefined) assertQueryParses(value.q);
		const next = {
			name: value.name?.trim() ?? row.name,
			query: value.q ?? row.query,
			scopes: value.scopes ? JSON.stringify(value.scopes) : row.scopes,
			range: value.range ? JSON.stringify(value.range) : row.range,
			columns: value.columns ? JSON.stringify(value.columns) : row.columns,
			visibility: value.visibility ?? row.visibility,
		};
		this.ctx.sqlite.run(
			`UPDATE log_saved_queries SET name = ?, query = ?, scopes = ?, range = ?, columns = ?, visibility = ?, updated_at = ?
			 WHERE id = ? AND org_id = ?`,
			[next.name, next.query, next.scopes, next.range, next.columns, next.visibility, this.ctx.now(), id, principal.orgId],
		);
		this.ctx.audit.record({
			principal,
			action: 'log_query.update',
			resource: 'log_query',
			resourceId: id,
			args: { fields: Object.keys(value) },
			result: 'ok',
		});
		return toView(this.visibleRow(principal, id));
	}

	delete(principal: Principal, id: string): void {
		const row = this.visibleRow(principal, id);
		this.requireWrite(principal, row, 'logQuery:delete');
		this.ctx.sqlite.run('DELETE FROM log_saved_queries WHERE id = ? AND org_id = ?', [id, principal.orgId]);
		this.ctx.audit.record({
			principal,
			action: 'log_query.delete',
			resource: 'log_query',
			resourceId: id,
			args: { name: row.name },
			result: 'ok',
		});
	}

	/** A row the principal may see; anything else (another org, someone's personal query) is 404. */
	private visibleRow(principal: Principal, id: string): SavedQueryRow {
		const row = this.ctx.sqlite
			.query<SavedQueryRow, [string, string]>('SELECT * FROM log_saved_queries WHERE id = ? AND org_id = ?')
			.get(id, principal.orgId);
		if (!row || (row.visibility !== 'org' && row.owner_id !== principal.userId))
			throw new NotFoundError('Saved query');
		return row;
	}

	/** The owner needs the plain write permission; editing someone else's org query needs `manage`. */
	private requireWrite(
		principal: Principal,
		row: SavedQueryRow,
		permission: 'logQuery:update' | 'logQuery:delete',
	): void {
		this.ctx.iam.require(principal, row.owner_id === principal.userId ? permission : 'logQuery:manage', {
			type: 'org',
		});
	}
}

function assertQueryParses(q: string): void {
	const parsed = parseLogQuery(q);
	if (!parsed.ok)
		throw new ValidationError(`The query does not parse: ${parsed.error.message}`, [
			{ path: ['q'], message: parsed.error.message },
		]);
}

function toView(row: SavedQueryRow): LogSavedQuery {
	return {
		id: row.id,
		ownerId: row.owner_id,
		name: row.name,
		q: row.query,
		scopes: parseJson<LogScopeRef[]>(row.scopes, []),
		range: parseJson<LogTimeRange>(row.range, { relative: '1h' }),
		columns: parseJson<string[]>(row.columns, []),
		visibility: row.visibility === 'org' ? 'org' : 'personal',
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
