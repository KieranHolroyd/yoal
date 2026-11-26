/**
 * Time windows for the Logs Explorer (docs/LOGS.md §7.2). A window is either relative to now
 * (`15m`, `1h`, `24h`, `7d`), or absolute bounds where an open `to` means "until now" (so a build
 * or a pipeline job can be read from its start and still tail). Everything here is pure.
 */

export type LogTime =
	{ kind: 'relative'; value: string } | { kind: 'absolute'; from: number; to: number | null };

export type LogTimeZone = 'utc' | 'local';

export const DEFAULT_LOG_TIME: LogTime = { kind: 'relative', value: '1h' };

/** The quick picks, shortest first. */
export const RELATIVE_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: '5m', label: 'Last 5 minutes' },
	{ value: '15m', label: 'Last 15 minutes' },
	{ value: '1h', label: 'Last hour' },
	{ value: '4h', label: 'Last 4 hours' },
	{ value: '24h', label: 'Last 24 hours' },
	{ value: '3d', label: 'Last 3 days' },
	{ value: '7d', label: 'Last 7 days' },
	{ value: '14d', label: 'Last 14 days' }
];

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000
};

const RELATIVE = /^(\d{1,4})(s|m|h|d|w)$/;

/** `15m` → 900000; null for anything else. */
export function relativeMs(value: string): number | null {
	const match = RELATIVE.exec(value.trim());
	if (!match) return null;
	const n = Number(match[1]);
	return n > 0 ? n * UNIT_MS[match[2]!]! : null;
}

export function isRelativeValue(value: string): boolean {
	return relativeMs(value) !== null;
}

/** Absolute bounds at `now`. */
export function resolveLogTime(time: LogTime, now: number): { from: number; to: number } {
	if (time.kind === 'relative') {
		const span = relativeMs(time.value) ?? 3_600_000;
		return { from: now - span, to: now };
	}
	const to = time.to ?? now;
	return { from: Math.min(time.from, to), to: Math.max(time.from, to) };
}

/** Live tail only makes sense when the window reaches now. */
export function reachesNow(time: LogTime): boolean {
	return time.kind === 'relative' || time.to === null;
}

/** Shortest relative value for a span, when it is one of the presets (`3600000` → `1h`). */
function presetForSpan(span: number): string | null {
	return RELATIVE_PRESETS.find((preset) => relativeMs(preset.value) === span)?.value ?? null;
}

/**
 * `[` / `]`: move the window back or forward by its own length. Moving forward into the future
 * snaps back to the matching relative window, so `]` after `[` returns to "last hour".
 */
export function shiftLogTime(time: LogTime, direction: -1 | 1, now: number): LogTime {
	const { from, to } = resolveLogTime(time, now);
	const span = Math.max(1_000, to - from);
	const nextFrom = from + direction * span;
	const nextTo = to + direction * span;
	if (direction > 0 && nextTo >= now - 1_000) {
		const preset = presetForSpan(span);
		if (preset) return { kind: 'relative', value: preset };
		return { kind: 'absolute', from: now - span, to: null };
	}
	return { kind: 'absolute', from: nextFrom, to: nextTo };
}

/** A brushed or clicked region of the histogram. */
export function zoomLogTime(from: number, to: number): LogTime {
	const lo = Math.floor(Math.min(from, to));
	const hi = Math.ceil(Math.max(from, to));
	return { kind: 'absolute', from: lo, to: Math.max(hi, lo + 1_000) };
}

/** "Around this time ±5 m" from a record. */
export function aroundLogTime(ts: number, spanMs = 5 * 60_000): LogTime {
	return { kind: 'absolute', from: ts - spanMs, to: ts + spanMs };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `14:02:11.204` in UTC or local time. */
export function formatClock(ts: number, zone: LogTimeZone): string {
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return '--:--:--.---';
	if (zone === 'utc') return date.toISOString().slice(11, 23);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** `2026-11-25 14:02:11` in UTC or local time. */
export function formatDateTime(ts: number, zone: LogTimeZone, withMs = false): string {
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return '—';
	if (zone === 'utc') {
		const iso = date.toISOString();
		return `${iso.slice(0, 10)} ${iso.slice(11, withMs ? 23 : 19)}`;
	}
	const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	return withMs ? `${base}.${pad(date.getMilliseconds(), 3)}` : base;
}

/** Parse `YYYY-MM-DD HH:mm[:ss]` in the given zone (or any ISO string). Null when invalid. */
export function parseDateTimeInput(text: string, zone: LogTimeZone): number | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const plain = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
	if (plain) {
		const [, y, mo, d, h = '0', mi = '0', s = '0'] = plain;
		const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const;
		const ms =
			zone === 'utc'
				? Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5])
				: new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]).getTime();
		return Number.isNaN(ms) ? null : ms;
	}
	const ms = Date.parse(trimmed);
	return Number.isNaN(ms) ? null : ms;
}

function spanLabel(ms: number): string {
	if (ms % UNIT_MS.d! === 0) return `${ms / UNIT_MS.d!}d`;
	if (ms % UNIT_MS.h! === 0) return `${ms / UNIT_MS.h!}h`;
	if (ms % UNIT_MS.m! === 0) return `${ms / UNIT_MS.m!}m`;
	return `${Math.round(ms / 1_000)}s`;
}

/** Button text for the picker. */
export function logTimeLabel(time: LogTime, zone: LogTimeZone): string {
	if (time.kind === 'relative') {
		const preset = RELATIVE_PRESETS.find((item) => item.value === time.value);
		return preset?.label ?? `Last ${time.value}`;
	}
	const from = formatDateTime(time.from, zone);
	if (time.to === null) return `Since ${from}`;
	const to = formatDateTime(time.to, zone);
	// Same day: only repeat the time.
	const sameDay = from.slice(0, 10) === to.slice(0, 10);
	return `${from} → ${sameDay ? to.slice(11) : to} (${spanLabel(Math.max(0, time.to - time.from))})`;
}

/** Round interval near `span / buckets`, as a `bin()` argument (`5m`, `1h`). */
export function binFor(span: number, buckets = 60): string {
	const steps = [
		1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
		10_800_000, 21_600_000, 43_200_000, 86_400_000
	];
	const target = span / Math.max(1, buckets);
	const step = steps.find((candidate) => candidate >= target) ?? steps.at(-1)!;
	return spanLabel(step);
}
