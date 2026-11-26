import type { LogCompareInput, LogCompareRow } from './log-record.ts';

/**
 * Shared helpers for Compare and Why? (docs/LOGS.md §8.2–§8.3): the URL form of a compare
 * baseline, and the per-minute classification every surface (service, UI, CLI) agrees on.
 */

export type LogCompareBaseline = LogCompareInput['baseline'];

const DURATION_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * The URL contract (`mode=compare&baseline=…`; Lane R links to it):
 * `previous`, `offset:<ms>` (also `offset:1d`, `offset:7d`…), `deploy:<id>`, `range:<from>-<to>`
 * (epoch ms). Anything else is null, so a bad link falls back to the default baseline.
 */
export function parseLogCompareBaseline(value: string | null | undefined): LogCompareBaseline | null {
	const text = value?.trim();
	if (!text) return null;
	if (text === 'previous') return { kind: 'previous' };
	const index = text.indexOf(':');
	if (index <= 0) return null;
	const kind = text.slice(0, index);
	const rest = text.slice(index + 1);
	if (kind === 'offset') {
		const match = /^(\d{1,15})(ms|s|m|h|d|w)?$/.exec(rest);
		if (!match) return null;
		const offsetMs = Number(match[1]) * DURATION_MS[match[2] ?? 'ms']!;
		return Number.isSafeInteger(offsetMs) && offsetMs > 0 ? { kind: 'offset', offsetMs } : null;
	}
	if (kind === 'deploy') return /^[\w.-]{1,64}$/.test(rest) ? { kind: 'deploy', deploymentId: rest } : null;
	if (kind === 'range') {
		const match = /^(\d{1,15})-(\d{1,15})$/.exec(rest);
		if (!match) return null;
		const a = Number(match[1]);
		const b = Number(match[2]);
		return a === b ? null : { kind: 'range', from: Math.min(a, b), to: Math.max(a, b) };
	}
	return null;
}

export function formatLogCompareBaseline(baseline: LogCompareBaseline): string {
	switch (baseline.kind) {
		case 'previous':
			return 'previous';
		case 'offset':
			return `offset:${baseline.offsetMs}`;
		case 'deploy':
			return `deploy:${baseline.deploymentId}`;
		case 'range':
			return `range:${baseline.from}-${baseline.to}`;
	}
}

/** "Rising" needs at least this many lines in the current window, so 1 → 2 is not news. */
export const LOG_COMPARE_RISING_MIN_LINES = 5;

/**
 * Classify one pattern from its counts in two windows (§8.2). Counts are turned into per-minute
 * rates first, so windows of different lengths compare fairly:
 * new (baseline 0), gone (current 0), rising (≥2× and ≥5 lines now), falling (≤0.5×), steady.
 * `ratio` is current rate / baseline rate, null when the baseline is zero.
 */
export function classifyLogCompare(
	current: number,
	baseline: number,
	currentMs: number,
	baselineMs: number,
): { change: LogCompareRow['change']; ratio: number | null } {
	const now = current / Math.max(1, currentMs / 60_000);
	const before = baseline / Math.max(1, baselineMs / 60_000);
	if (baseline <= 0) return { change: current > 0 ? 'new' : 'steady', ratio: null };
	const ratio = now / before;
	if (current <= 0) return { change: 'gone', ratio };
	if (ratio >= 2 && current >= LOG_COMPARE_RISING_MIN_LINES) return { change: 'rising', ratio };
	if (ratio <= 0.5) return { change: 'falling', ratio };
	return { change: 'steady', ratio };
}

/** Display order of the compare groups: what changed first, steady last. */
export const LOG_COMPARE_ORDER: Readonly<Record<LogCompareRow['change'], number>> = {
	new: 0,
	rising: 1,
	gone: 2,
	falling: 3,
	steady: 4,
};
