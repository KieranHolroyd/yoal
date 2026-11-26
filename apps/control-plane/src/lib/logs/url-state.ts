import { formatLogScope, parseLogScope, type LogScopeRef } from '@yoal/contracts';
import { DEFAULT_LOG_TIME, isRelativeValue, type LogTime, type LogTimeZone } from './time.js';

/**
 * The Explorer's state lives in the URL (docs/LOGS.md §7.2, LP11), so a link is a shareable
 * investigation: query, scopes, time, mode, the selected row, the time zone and live tail.
 *
 * `/logs` uses bare keys (`?q=…&scope=project:prj_1&range=1h`). An explorer embedded in a
 * resource page passes a prefix (`log_q`, `log_range`…) so it never collides with the page's own
 * parameters (`?tab=`, a traffic `range=`). Defaults are left out so links stay short.
 */

export const explorerModes = ['stream', 'patterns', 'analytics', 'compare'] as const;
export type ExplorerMode = (typeof explorerModes)[number];

export interface ExplorerUrlState {
	q: string;
	scopes: LogScopeRef[];
	time: LogTime;
	mode: ExplorerMode;
	/** Selected record id (opens the flyout). */
	row: string | null;
	tz: LogTimeZone;
	live: boolean;
}

export interface ExplorerUrlOptions {
	/** `''` for `/logs`; e.g. `log_` when embedded. */
	prefix?: string;
	/** What an absent key means; also what is left out when encoding. */
	defaults?: Partial<ExplorerUrlState>;
}

export const EXPLORER_URL_KEYS = [
	'q',
	'scope',
	'range',
	'from',
	'to',
	'mode',
	'row',
	'tz',
	'live'
] as const;

type ParamsLike = { get(name: string): string | null; getAll(name: string): string[] };

function baseDefaults(defaults: Partial<ExplorerUrlState> = {}): ExplorerUrlState {
	return {
		q: '',
		scopes: [],
		time: DEFAULT_LOG_TIME,
		mode: 'stream',
		row: null,
		tz: 'utc',
		live: false,
		...defaults
	};
}

/** Epoch ms or an ISO-8601 string. */
function parseInstant(value: string | null): number | null {
	if (value === null || value === '') return null;
	if (/^\d{1,15}$/.test(value)) return Number(value);
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}

function formatInstant(ms: number): string {
	return new Date(ms).toISOString();
}

export function decodeExplorerState(
	params: ParamsLike,
	options: ExplorerUrlOptions = {}
): ExplorerUrlState {
	const prefix = options.prefix ?? '';
	const key = (name: string) => `${prefix}${name}`;
	const state = baseDefaults(options.defaults);

	const q = params.get(key('q'));
	if (q !== null) state.q = q.slice(0, 4_000);

	const scopes = params
		.getAll(key('scope'))
		.map((value) => parseLogScope(value))
		.filter((scope): scope is LogScopeRef => scope !== null);
	if (scopes.length > 0) {
		const seen = new Set<string>();
		state.scopes = scopes.filter((scope) => {
			const id = formatLogScope(scope);
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		});
	}

	const range = params.get(key('range'));
	const from = parseInstant(params.get(key('from')));
	const toRaw = params.get(key('to'));
	const to = toRaw === 'now' ? null : parseInstant(toRaw);
	if (from !== null && (to !== null || toRaw === null || toRaw === 'now')) {
		state.time = { kind: 'absolute', from, to: toRaw === null ? null : to };
		if (state.time.kind === 'absolute' && state.time.to !== null && state.time.to < state.time.from)
			state.time = { kind: 'absolute', from: state.time.to, to: state.time.from };
	} else if (range && isRelativeValue(range)) {
		state.time = { kind: 'relative', value: range };
	}

	const mode = params.get(key('mode'));
	if (mode && (explorerModes as readonly string[]).includes(mode))
		state.mode = mode as ExplorerMode;

	const row = params.get(key('row'));
	if (row !== null) state.row = row ? row.slice(0, 200) : null;

	const tz = params.get(key('tz'));
	if (tz === 'utc' || tz === 'local') state.tz = tz;

	const live = params.get(key('live'));
	if (live === '1' || live === 'true') state.live = true;
	else if (live === '0' || live === 'false') state.live = false;

	return state;
}

function sameTime(a: LogTime, b: LogTime): boolean {
	if (a.kind === 'relative' && b.kind === 'relative') return a.value === b.value;
	if (a.kind === 'absolute' && b.kind === 'absolute') return a.from === b.from && a.to === b.to;
	return false;
}

function sameScopes(a: LogScopeRef[], b: LogScopeRef[]): boolean {
	return (
		a.length === b.length &&
		a.every((scope, index) => formatLogScope(scope) === formatLogScope(b[index]!))
	);
}

/**
 * Write `state` into a copy of `base` (the page's other parameters survive), dropping every key
 * this codec owns first so stale ones never linger.
 */
export function encodeExplorerState(
	state: ExplorerUrlState,
	options: ExplorerUrlOptions & { base?: URLSearchParams } = {}
): URLSearchParams {
	const prefix = options.prefix ?? '';
	const key = (name: string) => `${prefix}${name}`;
	const defaults = baseDefaults(options.defaults);
	const params = new URLSearchParams(options.base);
	for (const name of EXPLORER_URL_KEYS) params.delete(key(name));

	if (state.q !== defaults.q) params.set(key('q'), state.q);
	if (!sameScopes(state.scopes, defaults.scopes))
		for (const scope of state.scopes) params.append(key('scope'), formatLogScope(scope));
	if (!sameTime(state.time, defaults.time)) {
		if (state.time.kind === 'relative') params.set(key('range'), state.time.value);
		else {
			params.set(key('from'), formatInstant(state.time.from));
			params.set(key('to'), state.time.to === null ? 'now' : formatInstant(state.time.to));
		}
	}
	if (state.mode !== defaults.mode) params.set(key('mode'), state.mode);
	if (state.row !== defaults.row) params.set(key('row'), state.row ?? '');
	if (state.tz !== defaults.tz) params.set(key('tz'), state.tz);
	if (state.live !== defaults.live) params.set(key('live'), state.live ? '1' : '0');
	return params;
}
