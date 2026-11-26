import { formatLogScope, logSeverities, type LogRecord, type LogSeverity } from '@yoal/contracts';

/**
 * Presentation helpers for one `LogRecord`: severity tones, the field list the flyout and facets
 * share (as query field names, so "filter to this value" writes a valid clause), and pivots
 * (docs/LOGS.md §9.3). Pure; components only map these to markup.
 */

export interface SeverityTone {
	short: string;
	/** Row text. */
	text: string;
	/** Level chip. */
	chip: string;
	/** Histogram bar (SVG fill). */
	fill: string;
	/** Swatch in legends and facets. */
	swatch: string;
}

export const SEVERITY_TONES: Readonly<Record<LogSeverity, SeverityTone>> = {
	trace: {
		short: 'TRC',
		text: 'text-muted-foreground',
		chip: 'text-muted-foreground',
		fill: 'fill-muted-foreground/25',
		swatch: 'bg-muted-foreground/25'
	},
	debug: {
		short: 'DBG',
		text: 'text-muted-foreground',
		chip: 'text-muted-foreground',
		fill: 'fill-muted-foreground/45',
		swatch: 'bg-muted-foreground/45'
	},
	info: {
		short: 'INF',
		text: 'text-foreground',
		chip: 'text-info',
		fill: 'fill-info/70',
		swatch: 'bg-info/70'
	},
	warn: {
		short: 'WRN',
		text: 'text-warning',
		chip: 'bg-warning/10 text-warning',
		fill: 'fill-warning',
		swatch: 'bg-warning'
	},
	error: {
		short: 'ERR',
		text: 'text-destructive',
		chip: 'bg-destructive/10 text-destructive',
		fill: 'fill-destructive/80',
		swatch: 'bg-destructive/80'
	},
	fatal: {
		short: 'FTL',
		text: 'font-medium text-destructive',
		chip: 'bg-destructive text-white',
		fill: 'fill-destructive',
		swatch: 'bg-destructive'
	}
};

/** Most severe first, for legends and stacking (errors on top of the bar). */
export const SEVERITY_ORDER: readonly LogSeverity[] = [...logSeverities].reverse();

/** What the service column shows: the scope's name, else a short id. */
export function serviceLabel(record: LogRecord): string {
	if (record.scopeName) return record.scopeName;
	const id = record.scope.id;
	return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

export interface RecordField {
	/** Query field name: `level`, `deployment`, `@http.status`, `resource.host.name`. */
	field: string;
	value: string;
	group: 'record' | 'attribute' | 'resource';
	/** Can be turned into a `field:value` clause. */
	filterable: boolean;
}

/** Every field the record carries, in a stable order (built-ins, then attributes, then resource). */
export function recordFields(record: LogRecord): RecordField[] {
	const fields: RecordField[] = [];
	const add = (field: string, value: string | number | null | undefined, filterable = true) => {
		if (value === null || value === undefined || value === '') return;
		fields.push({ field, value: String(value), group: 'record', filterable });
	};
	add('level', record.severity);
	add('scope', formatLogScope(record.scope));
	add('service', record.scopeName);
	add('kind', record.scope.kind);
	add('source', record.source);
	add('stream', record.stream);
	add('channel', record.channel);
	add('deployment', record.deploymentId);
	add('build', record.buildId);
	add('job', record.jobRunId);
	add('node', record.nodeId);
	add('replica', record.replica);
	add('request', record.requestId);
	add('trace', record.traceId);
	add('span', record.spanId);
	add('pattern', record.patternId);
	for (const key of Object.keys(record.attributes).sort())
		fields.push({
			field: `@${key}`,
			value: record.attributes[key]!,
			group: 'attribute',
			filterable: true
		});
	for (const key of Object.keys(record.resource).sort())
		fields.push({
			field: `resource.${key}`,
			value: record.resource[key]!,
			group: 'resource',
			filterable: true
		});
	return fields;
}

/** The value `f`/`x` act on when nothing is hovered: the most specific stream-ish field. */
export function primaryField(record: LogRecord): { field: string; value: string } {
	if (record.stream) return { field: 'stream', value: record.stream };
	if (record.deploymentId) return { field: 'deployment', value: record.deploymentId };
	return { field: 'scope', value: formatLogScope(record.scope) };
}

/** A body that is a JSON object or array, parsed; null otherwise. */
export function jsonBody(body: string): unknown {
	const trimmed = body.trim();
	if (
		!(trimmed.startsWith('{') && trimmed.endsWith('}')) &&
		!(trimmed.startsWith('[') && trimmed.endsWith(']'))
	)
		return null;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return null;
	}
}

export interface RecordPivot {
	label: string;
	/** A clause to filter to (`deployment:dep_1`), or a dashboard link. */
	query?: string;
	href?: string;
	/** Group pivots in the flyout. */
	kind: 'filter' | 'link';
}

/** Pivots from a row (docs/LOGS.md §9.3): to its deploy, build, node, request, trace and stream. */
export function recordPivots(record: LogRecord): RecordPivot[] {
	const pivots: RecordPivot[] = [];
	const slug = record.scope.kind === 'project' ? record.scopeName : null;
	if (record.requestId)
		pivots.push({
			kind: 'filter',
			label: 'Every line of this request',
			query: `request:${record.requestId}`
		});
	if (record.traceId)
		pivots.push({
			kind: 'filter',
			label: 'Every line in this trace',
			query: `trace:${record.traceId}`
		});
	if (record.deploymentId) {
		pivots.push({
			kind: 'filter',
			label: 'This deployment',
			query: `deployment:${record.deploymentId}`
		});
		if (slug)
			pivots.push({
				kind: 'link',
				label: 'Open the deployment',
				href: `/projects/${encodeURIComponent(slug)}/deployments/${encodeURIComponent(record.deploymentId)}`
			});
	}
	if (record.buildId) {
		pivots.push({
			kind: 'filter',
			label: 'This build',
			query: `source:build build:${record.buildId}`
		});
		if (slug)
			pivots.push({
				kind: 'link',
				label: 'Open the build log',
				href: `/projects/${encodeURIComponent(slug)}?tab=logs&logSource=build&build=${encodeURIComponent(record.buildId)}`
			});
	}
	if (record.jobRunId) {
		pivots.push({ kind: 'filter', label: 'This job run', query: `job:${record.jobRunId}` });
		if (slug)
			pivots.push({
				kind: 'link',
				label: 'Open the project’s jobs',
				href: `/projects/${encodeURIComponent(slug)}?tab=jobs`
			});
	}
	if (record.nodeId) {
		pivots.push({ kind: 'filter', label: 'Lines from this node', query: `node:${record.nodeId}` });
		pivots.push({ kind: 'link', label: 'Open Nodes', href: '/nodes' });
	}
	if (record.stream)
		pivots.push({
			kind: 'filter',
			label: 'This stream',
			query: `stream:${quoteIfNeeded(record.stream)}`
		});
	return pivots;
}

function quoteIfNeeded(value: string): string {
	return /^[A-Za-z0-9_.\-/:@]+$/.test(value) ? value : `"${value.replace(/["\\]/g, '\\$&')}"`;
}
