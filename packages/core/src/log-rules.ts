import {
	compileLogPredicate,
	formatLogScope,
	logRuleInputSchema,
	logRulePreviewInputSchema,
	logRuleUpdateSchema,
	parseLogQuery,
	type LogRecord,
	type LogRuleKind,
	type LogRulePreviewResult,
	type LogRuleView,
	type LogScopeRef,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError, ValidationError } from './errors.ts';
import { DrainMiner } from './log-patterns.ts';
import { BUILTIN_REDACTION_KINDS, createRedactor, MAX_REDACTION_RULES, redactionRuleError, type RedactionRule } from './log-redaction.ts';
import { SQLITE_LOG_SOURCES, unifiedRowToLogRecord, type UnifiedLogRow } from './log-store/sqlite-sources.ts';
import { newId } from './util.ts';

/**
 * Ingest and index rules (docs/LOGS.md §10.3–§10.4). An org or project rule is a log query plus an
 * action, or a regex for redaction. Each kind applies at its own stage:
 *
 * | kind         | stage                         | effect                                                        |
 * |--------------|-------------------------------|---------------------------------------------------------------|
 * | `exclude`    | ingest (`LogIngestGuard`)     | the line is dropped before SQLite, so drains honour it too    |
 * | `sample`     | ingest                        | a matching line is kept with probability `sampleRate`         |
 * | `index_only` | indexer (`LogIndexer`)        | kept in the hot tail and drains, never inserted in ClickHouse |
 * | `redact`     | ingest, inside the redactor   | an extra org regex for `createRedactor` (`[REDACTED:rule:x]`)  |
 *
 * Org rules (no project) apply to every scope of the org; project rules to that project's records.
 * Compiled rules are cached per org and rebuilt after a write, never per line. Drops are counted
 * in `log_drop_counts` (reasons `exclude`, `sample`).
 *
 * Note on naming: §10.3 says "keep the line in the hot tail and drains but not in ClickHouse" for
 * the action the schema calls `index_only`; that is what it does here (it skips the index).
 */

type RulesContext = Pick<CoreContext, 'sqlite' | 'now' | 'iam' | 'audit'> & Partial<Pick<CoreContext, 'logExplorer'>>;

interface RuleRow {
	id: string;
	org_id: string;
	project_id: string | null;
	name: string;
	kind: string;
	query: string;
	pattern: string | null;
	replacement: string | null;
	sample_rate: number | null;
	enabled: number;
	created_by: string;
	created_at: number;
	updated_at: number;
}

interface CompiledMatch {
	id: string;
	projectId: string | null;
	predicate: (record: LogRecord) => boolean;
	rate: number;
}

export interface CompiledLogRules {
	exclude: CompiledMatch[];
	sample: CompiledMatch[];
	indexOnly: CompiledMatch[];
	redact: Array<{ projectId: string | null; rule: RedactionRule }>;
}

export type IngestRuleDecision = 'keep' | 'exclude' | 'sample';

/** Rules per org (all kinds). */
export const MAX_LOG_RULES = 200;
/** Lines a preview replays at most. */
export const LOG_RULE_PREVIEW_LINES = 20_000;

const EMPTY: CompiledLogRules = { exclude: [], sample: [], indexOnly: [], redact: [] };

/** `(?i)foo` → `{ pattern: 'foo', flags: 'i' }`: the only flag syntax the stored row needs. */
export function splitRedactPattern(pattern: string): { pattern: string; flags: string } {
	return pattern.startsWith('(?i)') ? { pattern: pattern.slice(4), flags: 'i' } : { pattern, flags: '' };
}

/** A redaction rule name (`[a-z0-9][a-z0-9_-]{0,39}`) from a display name. */
export function redactRuleName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^[-_]+|[-_]+$/g, '')
		.slice(0, 40);
	return /^[a-z0-9]/.test(slug) ? slug : `rule${slug ? `-${slug}` : ''}`.slice(0, 40);
}

function toRedactionRule(row: Pick<RuleRow, 'name' | 'pattern'>): RedactionRule {
	const { pattern, flags } = splitRedactPattern(row.pattern ?? '');
	return { name: redactRuleName(row.name), pattern, ...(flags ? { flags } : {}) };
}

function appliesTo(projectId: string | null, record: Pick<LogRecord, 'projectId' | 'scope'>): boolean {
	if (projectId === null) return true;
	return record.projectId === projectId || ((record.scope.kind === 'project' || record.scope.kind === 'function') && record.scope.id === projectId);
}

export class LogRuleService {
	readonly #compiled = new Map<string, CompiledLogRules>();
	/** Called after every write so dependent caches (the redactors) rebuild. */
	readonly onChange: Array<(orgId: string) => void> = [];

	constructor(private readonly ctx: RulesContext) {}

	// ------------------------------------------------------------------------------- CRUD

	list(principal: Principal, options: { projectId?: string | null } = {}): LogRuleView[] {
		this.requireRead(principal, options.projectId ?? null);
		const rows = this.ctx.sqlite
			.query<RuleRow, [string]>('SELECT * FROM log_rules WHERE org_id = ? ORDER BY created_at, id')
			.all(principal.orgId)
			.filter((row) => (options.projectId === undefined ? true : row.project_id === options.projectId));
		const slugs = this.projectSlugs(principal.orgId);
		return rows
			.filter((row) => row.project_id === null || this.ctx.iam.can(principal, 'logs:read', { type: 'project', id: row.project_id }))
			.map((row) => toView(row, slugs));
	}

	get(principal: Principal, id: string): LogRuleView {
		const row = this.row(principal.orgId, id);
		this.requireRead(principal, row.project_id);
		return toView(row, this.projectSlugs(principal.orgId));
	}

	create(principal: Principal, input: unknown): LogRuleView {
		const parsed = logRuleInputSchema.safeParse(input ?? {});
		if (!parsed.success) throw new ValidationError('Invalid log rule.', parsed.error.issues);
		const value = parsed.data;
		const projectId = value.project ? this.resolveProject(principal.orgId, value.project) : null;
		this.requireConfigure(principal, projectId);
		const count = this.ctx.sqlite.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM log_rules WHERE org_id = ?').get(principal.orgId)?.n ?? 0;
		if (count >= MAX_LOG_RULES) throw new CoreError('limit_reached', `An organisation has at most ${MAX_LOG_RULES} log rules.`, 409);
		const normalized = validateRule(value.kind, { query: value.query, pattern: value.pattern ?? null, sampleRate: value.sampleRate ?? null, name: value.name });
		if (value.kind === 'redact') {
			const redacts = this.ctx.sqlite
				.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM log_rules WHERE org_id = ? AND kind = 'redact'")
				.get(principal.orgId)?.n ?? 0;
			if (redacts >= MAX_REDACTION_RULES) throw new CoreError('limit_reached', `An organisation has at most ${MAX_REDACTION_RULES} redaction rules.`, 409);
		}
		const id = newId('lrl_');
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO log_rules (id, org_id, project_id, name, kind, query, pattern, replacement, sample_rate, enabled, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
			[id, principal.orgId, projectId, value.name, value.kind, normalized.query, normalized.pattern, normalized.sampleRate, value.enabled ? 1 : 0, principal.userId, now, now],
		);
		this.changed(principal.orgId);
		this.ctx.audit.record({ principal, action: 'logs.rule_create', resource: 'logs', resourceId: id, args: { name: value.name, kind: value.kind, projectId }, result: 'ok' });
		return this.get(principal, id);
	}

	update(principal: Principal, id: string, input: unknown): LogRuleView {
		const parsed = logRuleUpdateSchema.safeParse(input ?? {});
		if (!parsed.success) throw new ValidationError('Invalid log rule.', parsed.error.issues);
		const row = this.row(principal.orgId, id);
		this.requireConfigure(principal, row.project_id);
		const patch = parsed.data;
		const name = patch.name ?? row.name;
		const normalized = validateRule(row.kind as LogRuleKind, {
			name,
			query: patch.query ?? row.query,
			pattern: patch.pattern === undefined ? row.pattern : patch.pattern,
			sampleRate: patch.sampleRate === undefined ? row.sample_rate : patch.sampleRate,
		});
		const enabled = patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0;
		this.ctx.sqlite.run(
			'UPDATE log_rules SET name = ?, query = ?, pattern = ?, sample_rate = ?, enabled = ?, updated_at = ? WHERE id = ? AND org_id = ?',
			[name, normalized.query, normalized.pattern, normalized.sampleRate, enabled, this.ctx.now(), id, principal.orgId],
		);
		this.changed(principal.orgId);
		this.ctx.audit.record({ principal, action: 'logs.rule_update', resource: 'logs', resourceId: id, args: patch, result: 'ok' });
		return this.get(principal, id);
	}

	delete(principal: Principal, id: string): void {
		const row = this.row(principal.orgId, id);
		this.requireConfigure(principal, row.project_id);
		this.ctx.sqlite.run('DELETE FROM log_rules WHERE id = ? AND org_id = ?', [id, principal.orgId]);
		this.changed(principal.orgId);
		this.ctx.audit.record({ principal, action: 'logs.rule_delete', resource: 'logs', resourceId: id, args: { name: row.name, kind: row.kind }, result: 'ok' });
	}

	// ------------------------------------------------------------------------- application

	/** Enabled rules of an org, compiled once and cached until the next write. */
	compiled(orgId: string): CompiledLogRules {
		const cached = this.#compiled.get(orgId);
		if (cached) return cached;
		let rows: RuleRow[] = [];
		try {
			rows = this.ctx.sqlite.query<RuleRow, [string]>('SELECT * FROM log_rules WHERE org_id = ? AND enabled = 1 ORDER BY created_at, id').all(orgId);
		} catch {
			rows = [];
		}
		const compiled: CompiledLogRules = rows.length === 0 ? EMPTY : { exclude: [], sample: [], indexOnly: [], redact: [] };
		for (const row of rows) {
			if (row.kind === 'redact') {
				const rule = toRedactionRule(row);
				// A rule that no longer validates (hand-edited row) is skipped rather than failing ingest.
				if (!redactionRuleError(rule)) compiled.redact.push({ projectId: row.project_id, rule });
				continue;
			}
			const parsed = parseLogQuery(row.query);
			if (!parsed.ok || parsed.ast.pipes.length > 0) continue;
			const entry: CompiledMatch = {
				id: row.id,
				projectId: row.project_id,
				predicate: compileLogPredicate(parsed.ast.filter),
				rate: Math.max(0, Math.min(1, row.sample_rate ?? 1)),
			};
			if (row.kind === 'exclude') compiled.exclude.push(entry);
			else if (row.kind === 'sample') compiled.sample.push(entry);
			else if (row.kind === 'index_only') compiled.indexOnly.push(entry);
		}
		if (this.#compiled.size > 5_000) this.#compiled.clear();
		this.#compiled.set(orgId, compiled);
		return compiled;
	}

	/** Whether any ingest rule (exclude or sample) could apply to a scope, so callers skip records. */
	hasIngestRules(orgId: string, projectId: string | null): boolean {
		const rules = this.compiled(orgId);
		const relevant = (entry: CompiledMatch) => entry.projectId === null || entry.projectId === projectId;
		return rules.exclude.some(relevant) || rules.sample.some(relevant);
	}

	/** The ingest decision for one record: the first exclude that matches, then the first sample. */
	ingestDecision(record: LogRecord, random: () => number = Math.random): IngestRuleDecision {
		const rules = this.compiled(record.orgId);
		for (const rule of rules.exclude) if (appliesTo(rule.projectId, record) && safeMatch(rule.predicate, record)) return 'exclude';
		for (const rule of rules.sample)
			if (appliesTo(rule.projectId, record) && safeMatch(rule.predicate, record)) return random() < rule.rate ? 'keep' : 'sample';
		return 'keep';
	}

	/** The indexer's filter: false keeps a record out of ClickHouse (`index_only`, §10.3). */
	keepInIndex(record: LogRecord): boolean {
		const rules = this.compiled(record.orgId);
		if (rules.indexOnly.length === 0) return true;
		for (const rule of rules.indexOnly) if (appliesTo(rule.projectId, record) && safeMatch(rule.predicate, record)) return false;
		return true;
	}

	/** Org redaction rules for a scope: the org's, plus the project's own. */
	redactionRules(orgId: string, projectId: string | null): RedactionRule[] {
		return this.compiled(orgId)
			.redact.filter((entry) => entry.projectId === null || entry.projectId === projectId)
			.map((entry) => entry.rule)
			.slice(0, MAX_REDACTION_RULES);
	}

	/** Forget compiled rules (after a write here, or a test that wrote SQL directly). */
	invalidate(orgId?: string): void {
		if (orgId) this.#compiled.delete(orgId);
		else this.#compiled.clear();
	}

	// ------------------------------------------------------------------------------ preview

	/**
	 * Replay the last minutes of the hot tail through a draft rule (§10.3): the share it would drop
	 * (or keep out of the index), and the top templates among what it matches. Redact rules return
	 * up to five matched lines, masked. Reads only scopes the caller can read.
	 */
	preview(principal: Principal, input: unknown): LogRulePreviewResult {
		const parsed = logRulePreviewInputSchema.safeParse(input ?? {});
		if (!parsed.success) throw new ValidationError('Invalid rule preview.', parsed.error.issues);
		const value = parsed.data;
		const projectId = value.project ? this.resolveProject(principal.orgId, value.project) : null;
		const normalized = validateRule(value.kind, { name: 'preview', query: value.query, pattern: value.pattern ?? null, sampleRate: value.sampleRate ?? null });
		const explorer = this.ctx.logExplorer;
		if (!explorer) throw new CoreError('unavailable', 'Log reads are not available.', 503);
		const requested: LogScopeRef[] = projectId ? [{ kind: 'project', id: projectId }] : [];
		const { boundary } = explorer.resolveBoundary(principal, requested);
		const allowed = new Set(boundary.scopes.map(formatLogScope));
		const now = this.ctx.now();
		const since = now - value.minutes * 60_000;
		const records: LogRecord[] = [];
		let capped = false;
		const kinds = new Set(boundary.scopes.map((scope) => scope.kind));
		for (const source of SQLITE_LOG_SOURCES) {
			if (!source.scopeKinds.some((kind) => kinds.has(kind))) continue;
			const room = LOG_RULE_PREVIEW_LINES - records.length;
			if (room <= 0) {
				capped = true;
				break;
			}
			let rows: UnifiedLogRow[] = [];
			try {
				rows = this.ctx.sqlite
					.query<UnifiedLogRow, [string, number, number]>(
						`SELECT * FROM (${source.select} WHERE ${source.tsColumn} >= ${Math.floor(since)}) u WHERE u.org_id = ? AND u.ts >= ? ORDER BY u.seq DESC LIMIT ?`,
					)
					.all(boundary.orgId, since, room + 1);
			} catch {
				rows = [];
			}
			if (rows.length > room) {
				capped = true;
				rows = rows.slice(0, room);
			}
			for (const row of rows) {
				if (!allowed.has(`${row.scope_kind}:${row.scope_id}`)) continue;
				records.push(unifiedRowToLogRecord(row));
			}
		}
		const miner = new DrainMiner({ maxTemplatesPerScope: 500 });
		let matched = 0;
		const examples: string[] = [];
		if (value.kind === 'redact') {
			const rule = toRedactionRule({ name: 'preview', pattern: normalized.pattern });
			const redactor = createRedactor({ rules: [rule], disable: BUILTIN_REDACTION_KINDS });
			for (const record of records) {
				const result = redactor.redact(record.body);
				if (result.hits.length === 0) continue;
				matched += 1;
				miner.patternFor('preview', record.body);
				if (examples.length < 5) examples.push(result.text.slice(0, 500));
			}
		} else {
			const ast = parseLogQuery(normalized.query);
			const predicate = ast.ok ? compileLogPredicate(ast.ast.filter) : () => false;
			for (const record of records) {
				if (!safeMatch(predicate, record)) continue;
				matched += 1;
				miner.patternFor('preview', record.body);
			}
		}
		const scanned = records.length;
		const share = (count: number) => (scanned === 0 ? 0 : Math.round((count / scanned) * 10_000) / 100);
		const rate = normalized.sampleRate ?? 1;
		return {
			scanned,
			matched,
			droppedPercent: value.kind === 'exclude' ? share(matched) : value.kind === 'sample' ? share(matched * (1 - rate)) : 0,
			indexSkippedPercent: value.kind === 'index_only' ? share(matched) : 0,
			topPatterns: miner
				.templates('preview')
				.sort((a, b) => b.count - a.count)
				.slice(0, 5)
				.map((template) => ({ template: template.template, count: template.count })),
			examples,
			capped,
			minutes: value.minutes,
		};
	}

	// ------------------------------------------------------------------------------ helpers

	private changed(orgId: string): void {
		this.invalidate(orgId);
		for (const listener of this.onChange) {
			try {
				listener(orgId);
			} catch (error) {
				console.error('[logs] rule listener failed', error);
			}
		}
	}

	private row(orgId: string, id: string): RuleRow {
		const row = this.ctx.sqlite.query<RuleRow, [string, string]>('SELECT * FROM log_rules WHERE id = ? AND org_id = ?').get(id, orgId);
		if (!row) throw new NotFoundError('Log rule');
		return row;
	}

	private requireRead(principal: Principal, projectId: string | null): void {
		const resource = projectId ? { type: 'project' as const, id: projectId } : { type: 'org' as const };
		if (this.ctx.iam.can(principal, 'logs:configure', resource)) return;
		this.ctx.iam.require(principal, 'logs:read', resource);
	}

	private requireConfigure(principal: Principal, projectId: string | null): void {
		this.ctx.iam.require(principal, 'logs:configure', projectId ? { type: 'project', id: projectId } : { type: 'org' });
	}

	private resolveProject(orgId: string, ref: string): string {
		const row = this.ctx.sqlite
			.query<{ id: string }, [string, string, string]>('SELECT id FROM projects WHERE org_id = ? AND (id = ? OR slug = ?) AND deleted_at IS NULL')
			.get(orgId, ref, ref);
		if (!row) throw new NotFoundError('Project');
		return row.id;
	}

	private projectSlugs(orgId: string): Map<string, string> {
		return new Map(
			this.ctx.sqlite.query<{ id: string; slug: string }, [string]>('SELECT id, slug FROM projects WHERE org_id = ?').all(orgId).map((row) => [row.id, row.slug]),
		);
	}
}


/** A predicate that throws (a pathological regex) never decides anything. */
function safeMatch(predicate: (record: LogRecord) => boolean, record: LogRecord): boolean {
	try {
		return predicate(record);
	} catch {
		return false;
	}
}

/** Kind-specific checks; returns the values to store. */
function validateRule(
	kind: LogRuleKind,
	input: { name: string; query: string; pattern: string | null; sampleRate: number | null },
): { query: string; pattern: string | null; sampleRate: number | null } {
	if (kind === 'redact') {
		const pattern = input.pattern?.trim() ?? '';
		if (!pattern) throw new ValidationError('A redaction rule needs a pattern.', [{ path: ['pattern'], message: 'required' }]);
		const error = redactionRuleError(toRedactionRule({ name: input.name, pattern }));
		if (error) throw new ValidationError(error, [{ path: ['pattern'], message: error }]);
		return { query: '', pattern, sampleRate: null };
	}
	const query = input.query.trim();
	if (kind === 'exclude' && !query)
		throw new ValidationError('An exclusion rule needs a query; an empty one would drop every line.', [{ path: ['query'], message: 'required' }]);
	const parsed = parseLogQuery(query);
	if (!parsed.ok)
		throw new ValidationError(`Query error at ${parsed.error.start}–${parsed.error.end}: ${parsed.error.message}`, [
			{ path: ['query'], message: parsed.error.message },
		]);
	if (parsed.ast.pipes.length > 0) throw new ValidationError('A rule query cannot have pipe stages.', [{ path: ['query'], message: 'no pipes' }]);
	if (kind === 'sample') {
		if (input.sampleRate === null || input.sampleRate === undefined)
			throw new ValidationError('A sample rule needs a sample rate (the share of matching lines kept, 0–1).', [{ path: ['sampleRate'], message: 'required' }]);
		return { query, pattern: null, sampleRate: input.sampleRate };
	}
	return { query, pattern: null, sampleRate: null };
}

function toView(row: RuleRow, slugs: Map<string, string>): LogRuleView {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind as LogRuleKind,
		query: row.query,
		pattern: row.pattern,
		sampleRate: row.sample_rate,
		enabled: row.enabled === 1,
		projectId: row.project_id,
		projectSlug: row.project_id ? (slugs.get(row.project_id) ?? null) : null,
		createdBy: row.created_by,
		createdAt: new Date(row.created_at).toISOString(),
		updatedAt: new Date(row.updated_at).toISOString(),
	};
}
