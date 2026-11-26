import type { LogTableResult } from '@yoal/contracts';
import type { HistogramBucket, HistogramSeries } from './histogram.js';

/**
 * Shapes `/table` answers for the Patterns, Analytics and Compare tabs (docs/LOGS.md §8). Wave 1
 * keeps these minimal and generic over the column list, so they work with whatever the stores
 * name their columns; Wave 2 (lane A) finishes the tabs.
 */

const PALETTE: ReadonlyArray<{ fill: string; swatch: string }> = [
	{ fill: 'fill-chart-1', swatch: 'bg-chart-1' },
	{ fill: 'fill-chart-2', swatch: 'bg-chart-2' },
	{ fill: 'fill-chart-3', swatch: 'bg-chart-3' },
	{ fill: 'fill-chart-4', swatch: 'bg-chart-4' },
	{ fill: 'fill-chart-5', swatch: 'bg-chart-5' },
	{ fill: 'fill-muted-foreground/50', swatch: 'bg-muted-foreground/50' }
];

/** `| stats … by bin()` → stacked buckets, one series per value of the first string column. */
export function tableToSeries(result: LogTableResult): {
	buckets: HistogramBucket[];
	series: HistogramSeries[];
	intervalMs: number;
	from: number;
	to: number;
} | null {
	const timeIndex = result.columns.findIndex((column) => column.type === 'time');
	const valueIndex = result.columns.findIndex((column) => column.type === 'number');
	if (timeIndex < 0 || valueIndex < 0 || result.rows.length === 0) return null;
	const groupIndex = result.columns.findIndex(
		(column, index) => column.type === 'string' && index !== timeIndex
	);
	const byTs = new Map<number, HistogramBucket>();
	const totals = new Map<string, number>();
	for (const row of result.rows) {
		const raw = row[timeIndex];
		const ts = typeof raw === 'number' ? raw : Date.parse(String(raw));
		if (!Number.isFinite(ts)) continue;
		const group =
			groupIndex >= 0 ? String(row[groupIndex] ?? '') : result.columns[valueIndex]!.name;
		const value = Number(row[valueIndex] ?? 0) || 0;
		const bucket = byTs.get(ts) ?? { ts, values: {}, total: 0 };
		bucket.values[group] = (bucket.values[group] ?? 0) + value;
		bucket.total += value;
		byTs.set(ts, bucket);
		totals.set(group, (totals.get(group) ?? 0) + value);
	}
	const buckets = [...byTs.values()].sort((a, b) => a.ts - b.ts);
	if (buckets.length === 0) return null;
	const steps = buckets
		.slice(1)
		.map((bucket, index) => bucket.ts - buckets[index]!.ts)
		.filter((step) => step > 0);
	const intervalMs = steps.length > 0 ? Math.min(...steps) : 60_000;
	// Biggest series at the bottom of the stack; the long tail shares the last colour.
	const groups = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
	const series = groups.map((key, index) => ({
		key,
		label: key || '(empty)',
		...PALETTE[Math.min(index, PALETTE.length - 1)]!
	}));
	return { buckets, series, intervalMs, from: buckets[0]!.ts, to: buckets.at(-1)!.ts + intervalMs };
}

export interface CompareRow {
	key: string;
	current: number;
	previous: number;
	delta: number;
	change: 'new' | 'gone' | 'rising' | 'falling' | 'steady';
}

/** The key column (first string) and the count column (first number) of a patterns table. */
function keyed(result: LogTableResult): Map<string, number> {
	const keyIndex = result.columns.findIndex((column) => column.type === 'string');
	const countIndex = result.columns.findIndex((column) => column.type === 'number');
	const out = new Map<string, number>();
	if (keyIndex < 0 || countIndex < 0) return out;
	for (const row of result.rows) {
		const key = String(row[keyIndex] ?? '');
		out.set(key, (out.get(key) ?? 0) + (Number(row[countIndex] ?? 0) || 0));
	}
	return out;
}

/**
 * Compare two windows' patterns (docs/LOGS.md §8.2): new, gone, rising and falling templates,
 * biggest movement first. "Rising"/"falling" need at least a 50% change.
 */
export function comparePatterns(current: LogTableResult, previous: LogTableResult): CompareRow[] {
	const now = keyed(current);
	const before = keyed(previous);
	const keys = new Set([...now.keys(), ...before.keys()]);
	const rows: CompareRow[] = [];
	for (const key of keys) {
		const a = now.get(key) ?? 0;
		const b = before.get(key) ?? 0;
		let change: CompareRow['change'] = 'steady';
		if (b === 0 && a > 0) change = 'new';
		else if (a === 0 && b > 0) change = 'gone';
		else if (a >= b * 1.5) change = 'rising';
		else if (a <= b / 1.5) change = 'falling';
		rows.push({ key, current: a, previous: b, delta: a - b, change });
	}
	const rank: Record<CompareRow['change'], number> = {
		new: 0,
		rising: 1,
		gone: 2,
		falling: 3,
		steady: 4
	};
	return rows.sort(
		(x, y) => rank[x.change] - rank[y.change] || Math.abs(y.delta) - Math.abs(x.delta)
	);
}

/** Split a pattern template so `<NUM>`, `<*>`… placeholders can be highlighted. */
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
