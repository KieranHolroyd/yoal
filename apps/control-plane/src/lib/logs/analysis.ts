import {
	LOG_COMPARE_ORDER,
	type LogCompareBaseline,
	type LogCompareResult,
	type LogCompareRow,
	type LogHistogramMarker,
	type LogTableResult,
	type QueryResult
} from '@yoal/contracts';
import { formatDateTime, type LogTimeZone } from './time.js';

/**
 * Pure helpers for the Patterns, Analytics and Compare tabs and the Why? panel (docs/LOGS.md §8).
 * The components stay thin; everything here is unit-tested.
 */

const DAY = 86_400_000;

// ----------------------------------------------------------------------------------- patterns

export interface PatternRow {
	id: string;
	template: string;
	count: number;
	/** Share of all lines in the table. */
	share: number;
	firstSeen: number | null;
	lastSeen: number | null;
	/** First seen inside the window being read: a template that is new here. */
	isNew: boolean;
	sampleId: string | null;
	sparkline: number[];
}

function columnIndex(result: LogTableResult, ...names: string[]): number {
	return result.columns.findIndex((column) => names.includes(column.name));
}

function numberOf(value: string | number | null | undefined): number | null {
	if (value === null || value === undefined || value === '') return null;
	const number = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(number) ? number : null;
}

/** A `| patterns` table → rows the Patterns tab draws (columns found by name). */
export function patternRows(result: LogTableResult, windowFrom: number): PatternRow[] {
	const id = columnIndex(result, 'pattern', 'pattern_id', 'patternId');
	const template = columnIndex(result, 'template');
	const count = columnIndex(result, 'count');
	const first = columnIndex(result, 'first_seen');
	const last = columnIndex(result, 'last_seen');
	const total = result.rows.reduce(
		(sum, row) => sum + (count >= 0 ? (numberOf(row[count]) ?? 0) : 0),
		0
	);
	return result.rows.map((row, index) => {
		const n = count >= 0 ? (numberOf(row[count]) ?? 0) : 0;
		const firstSeen = first >= 0 ? numberOf(row[first]) : null;
		return {
			id: id >= 0 ? String(row[id] ?? '') : '',
			template: String((template >= 0 ? row[template] : id >= 0 ? row[id] : '') ?? ''),
			count: n,
			share: total > 0 ? n / total : 0,
			firstSeen,
			lastSeen: last >= 0 ? numberOf(row[last]) : null,
			isNew: firstSeen !== null && firstSeen >= windowFrom,
			sampleId: result.sampleIds?.[index] ?? null,
			sparkline: result.sparklines?.[index] ?? []
		};
	});
}

/** `<NUM>`-style placeholders split out so they can be highlighted. */
export function templateParts(template: string): Array<{ text: string; placeholder: boolean }> {
	const parts: Array<{ text: string; placeholder: boolean }> = [];
	const pattern = /<[A-Z*]{1,8}>/g;
	let last = 0;
	for (let match = pattern.exec(template); match; match = pattern.exec(template)) {
		if (match.index > last)
			parts.push({ text: template.slice(last, match.index), placeholder: false });
		parts.push({ text: match[0], placeholder: true });
		last = match.index + match[0].length;
	}
	if (last < template.length) parts.push({ text: template.slice(last), placeholder: false });
	return parts;
}

/** Points of a sparkline polyline in a `width × height` box (max at the top). */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
	if (values.length === 0) return '';
	const max = Math.max(1, ...values);
	const step = values.length > 1 ? width / (values.length - 1) : 0;
	return values
		.map(
			(value, index) =>
				`${(index * step).toFixed(1)},${(height - (value / max) * (height - 1) - 0.5).toFixed(1)}`
		)
		.join(' ');
}

// ---------------------------------------------------------------------------------- analytics

export type AnalyticsShape = 'time' | 'category' | 'table';

/** How a `| stats` answer is drawn (§8.4): a time series when grouped by `bin()`, else bars or a table. */
export function analyticsShape(result: LogTableResult): AnalyticsShape {
	if (result.rows.length === 0) return 'table';
	const hasNumber = result.columns.some((column) => column.type === 'number');
	if (!hasNumber) return 'table';
	if (result.columns.some((column) => column.type === 'time')) return 'time';
	return result.rows.length <= 50 ? 'category' : 'table';
}

/** A `/table` answer in the dashboards' `QueryResult` shape, so the D101 panel renderers draw it. */
export function toQueryResult(result: LogTableResult): QueryResult {
	const timeIndex = result.columns.findIndex((column) => column.type === 'time');
	let intervalSeconds = 0;
	if (timeIndex >= 0) {
		const times = [
			...new Set(
				result.rows
					.map((row) => numberOf(row[timeIndex]))
					.filter((value): value is number => value !== null)
			)
		].sort((a, b) => a - b);
		const steps = times
			.slice(1)
			.map((time, index) => time - times[index]!)
			.filter((step) => step > 0);
		intervalSeconds = steps.length > 0 ? Math.min(...steps) / 1_000 : 60;
	}
	return {
		columns: result.columns.map((column) => ({
			name: column.name,
			type:
				column.type === 'time'
					? "DateTime64(3, 'UTC')"
					: column.type === 'number'
						? 'Float64'
						: 'String',
			kind: column.type
		})),
		rows: result.rows.map((row) =>
			row.map((cell, index) =>
				result.columns[index]?.type === 'number' || result.columns[index]?.type === 'time'
					? numberOf(cell)
					: cell
			)
		),
		sql: '',
		intervalSeconds,
		resolution: null,
		stats: { elapsedMs: result.elapsedMs, rowsRead: 0, bytesRead: 0 },
		truncated: false
	};
}

// ------------------------------------------------------------------------------------ compare

export interface BaselinePreset {
	key: string;
	label: string;
	baseline: LogCompareBaseline;
}

export const BASELINE_PRESETS: readonly BaselinePreset[] = [
	{ key: 'previous', label: 'Previous window', baseline: { kind: 'previous' } },
	{ key: 'yesterday', label: 'Same time yesterday', baseline: { kind: 'offset', offsetMs: DAY } },
	{ key: 'week', label: 'Same time last week', baseline: { kind: 'offset', offsetMs: 7 * DAY } }
];

/** Which picker entry a baseline is: a preset key, `deploy`, `offset` or `range`. */
export function baselineKey(baseline: LogCompareBaseline): string {
	const preset = BASELINE_PRESETS.find(
		(item) =>
			item.baseline.kind === baseline.kind &&
			(baseline.kind !== 'offset' ||
				(item.baseline.kind === 'offset' && item.baseline.offsetMs === baseline.offsetMs))
	);
	return preset?.key ?? baseline.kind;
}

export function baselineLabel(
	baseline: LogCompareBaseline,
	zone: LogTimeZone,
	markers: readonly LogHistogramMarker[] = []
): string {
	const preset = BASELINE_PRESETS.find((item) => item.key === baselineKey(baseline));
	if (preset) return preset.label;
	switch (baseline.kind) {
		case 'offset': {
			const hours = baseline.offsetMs / 3_600_000;
			return hours >= 24 && hours % 24 === 0
				? `${hours / 24} days earlier`
				: `${Math.round(hours * 10) / 10} h earlier`;
		}
		case 'deploy': {
			const marker = markers.find(
				(item) => item.kind === 'deploy' && deployIdOf(item) === baseline.deploymentId
			);
			return marker ? `Before ${marker.label}` : `Before deploy ${baseline.deploymentId.slice(-8)}`;
		}
		case 'range':
			return `${formatDateTime(baseline.from, zone)} → ${formatDateTime(baseline.to, zone)}`;
		default:
			return 'Previous window';
	}
}

/** The deployment id of a deploy marker (its href ends with it). */
export function deployIdOf(marker: LogHistogramMarker): string | null {
	if (marker.kind !== 'deploy' || !marker.href) return null;
	const match = /\/deployments\/([^/?#]+)/.exec(marker.href);
	return match ? decodeURIComponent(match[1]!) : null;
}

export interface CompareGroup {
	change: LogCompareRow['change'];
	label: string;
	rows: LogCompareRow[];
}

const GROUP_LABELS: Record<LogCompareRow['change'], string> = {
	new: 'New',
	rising: 'Rising',
	falling: 'Falling',
	gone: 'Gone',
	steady: 'Steady'
};

/** Rows grouped in the order the tab shows them: new, rising, falling, gone, then steady. */
export function compareGroups(result: LogCompareResult): CompareGroup[] {
	const order: Array<LogCompareRow['change']> = ['new', 'rising', 'falling', 'gone', 'steady'];
	return order
		.map((change) => ({
			change,
			label: GROUP_LABELS[change],
			rows: result.rows.filter((row) => row.change === change)
		}))
		.filter((group) => group.rows.length > 0);
}

/** `×4.2`, `new`, `gone`: the ratio column. */
export function ratioLabel(row: LogCompareRow): string {
	if (row.ratio === null) return row.current > 0 ? 'new' : '—';
	if (row.current === 0) return 'gone';
	if (row.ratio >= 10) return `×${Math.round(row.ratio)}`;
	return `×${row.ratio.toFixed(row.ratio < 1 ? 2 : 1)}`;
}

/** Stable order for rows the server sent (defensive: older servers may not sort). */
export function sortCompareRows(rows: readonly LogCompareRow[]): LogCompareRow[] {
	return [...rows].sort((a, b) => LOG_COMPARE_ORDER[a.change] - LOG_COMPARE_ORDER[b.change]);
}

// ---------------------------------------------------------------------------------------- why

/** `0.92` → `92%`; small shares keep a decimal. */
export function percent(share: number): string {
	const value = share * 100;
	if (value > 0 && value < 1) return `${value.toFixed(1)}%`;
	return `${Math.round(value)}%`;
}

/** A Why? selection as a log-time window, ordered and at least one second wide. */
export function whySelection(from: number, to: number): { from: number; to: number } {
	const a = Math.floor(Math.min(from, to));
	const b = Math.ceil(Math.max(from, to));
	return { from: a, to: Math.max(b, a + 1_000) };
}
