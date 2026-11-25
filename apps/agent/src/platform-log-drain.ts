import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
	PLATFORM_LOG_UNIT_NAMES,
	SEVERITY_NUMBER,
	severityNumberForLevel,
	type NodeLogBatch,
	type NodeLogRecord,
	type PlatformLogUnit,
} from '@yoal/contracts';
import type { HelperLogEntry, HelperLogResult, LogReadOptions } from './helper-client.ts';
import { joinMultilineEntries, parseJoinedLogMessage } from './log-drain.ts';

const DEFAULT_INTERVAL_MS = 5_000;
/** While the control plane's `PLATFORM_LOGS` flag is off, probe this often instead of reading. */
const DISABLED_INTERVAL_MS = 60_000;
/** Same read size as the workload drain; a busy unit gets a few pages per tick. */
const LINES_PER_READ = 200;
const MAX_PAGES_PER_TICK = 5;
const STATE_VERSION = 1;

/** The helper's platform log verb (`GET /v1/platform-logs/<unit>`); `HelperClient` implements it. */
export interface PlatformLogReader {
	platformLogs(unit: PlatformLogUnit, options?: LogReadOptions): Promise<HelperLogResult>;
}

export interface PlatformLogDrainOptions {
	helper: PlatformLogReader;
	controlUrl: string;
	nodeToken: string;
	/** JSON file holding the journald cursor per unit, in the agent's data dir. */
	statePath: string;
	intervalMs?: number;
	disabledIntervalMs?: number;
	/** Defaults to the whole allow-list; units not installed on this node simply read empty. */
	units?: readonly PlatformLogUnit[];
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Test seams. */
	fetch?: typeof fetch;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface CursorState {
	version: number;
	cursors: Partial<Record<PlatformLogUnit, string>>;
}

/** journald PRIORITY (syslog) → OTel severity number: emerg/alert/crit are fatal. */
export function severityNumberForPriority(priority: number): number {
	if (priority <= 2) return SEVERITY_NUMBER.fatal;
	if (priority === 3) return SEVERITY_NUMBER.error;
	if (priority === 4) return SEVERITY_NUMBER.warn;
	if (priority === 7) return SEVERITY_NUMBER.debug;
	return SEVERITY_NUMBER.info;
}

/**
 * Journal entries of one platform unit → `NodeLogRecord`s (docs/LOGS.md §5, LP5). Multi-line
 * output is joined first (§4.3 step 1). A level or time the line declares wins over journald's
 * priority and receive time. Tenancy is not in the record: the control plane scopes the batch to
 * `platform:<node>` from the authenticated node, and stamps `host.*` itself.
 */
export function platformLogRecords(unit: PlatformLogUnit, entries: readonly HelperLogEntry[]): NodeLogRecord[] {
	return joinMultilineEntries(entries).map((entry) => {
		const parsed = parseJoinedLogMessage(entry.message);
		return {
			ts: Math.max(0, Math.floor(parsed.ts ?? entry.ts)),
			source: 'platform',
			severityNumber: parsed.level ? severityNumberForLevel(parsed.level) : severityNumberForPriority(entry.priority),
			body: parsed.message,
			attributes: {},
			resource: { 'service.name': unit },
			channel: entry.priority <= 3 ? 'stderr' : 'stdout',
		};
	});
}

/**
 * Platform log drain (docs/LOGS.md §5, LP5). Every 5 s the agent asks the helper for new journald
 * entries of each allow-listed Yoal unit and posts them to `/api/agent/log-records` as
 * `target: { kind: 'platform', unit }`. Like the workload drain, a cursor moves only after the
 * control plane accepted the batch, but here the cursors are persisted per unit in the agent's
 * data dir, so a restart neither re-ships nor skips lines.
 *
 * Kill switch: `PLATFORM_LOGS`. When the control plane answers `disabled`, the drain stops reading
 * (cursors stay where they were) and only probes once a minute with an empty batch.
 */
export class PlatformLogDrain {
	private state: CursorState | null = null;
	/** Units whose last read failed, and the distinct errors already logged for them. */
	private readonly failing = new Set<PlatformLogUnit>();
	private readonly warned = new Set<string>();
	private disabled = false;
	private readonly helper: PlatformLogReader;
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly statePath: string;
	private readonly intervalMs: number;
	private readonly disabledIntervalMs: number;
	private readonly units: readonly PlatformLogUnit[];
	private readonly log: NonNullable<PlatformLogDrainOptions['log']>;
	private readonly doFetch: typeof fetch;
	private readonly doSleep: (ms: number, signal: AbortSignal) => Promise<void>;

	constructor(options: PlatformLogDrainOptions) {
		this.helper = options.helper;
		this.controlUrl = options.controlUrl.replace(/\/+$/, '');
		this.nodeToken = options.nodeToken;
		this.statePath = options.statePath;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.disabledIntervalMs = options.disabledIntervalMs ?? DISABLED_INTERVAL_MS;
		this.units = options.units ?? PLATFORM_LOG_UNIT_NAMES;
		this.log = options.log ?? (() => undefined);
		this.doFetch = options.fetch ?? fetch;
		this.doSleep = options.sleep ?? sleep;
	}

	get isDisabled(): boolean {
		return this.disabled;
	}

	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			await this.drain().catch((error: unknown) => {
				this.log('warn', `Platform log drain failed: ${errorText(error)}`);
			});
			await this.doSleep(this.disabled ? this.disabledIntervalMs : this.intervalMs, signal);
		}
	}

	/** One pass over every unit. Returns the number of records the control plane stored. */
	async drain(): Promise<number> {
		const state = await this.load();
		if (this.disabled) {
			const first = this.units[0];
			if (!first) return 0;
			await this.post({ target: { kind: 'platform', unit: first }, records: [], dropped: 0 });
			if (this.disabled) return 0;
			this.log('info', 'Platform log drain re-enabled by the control plane');
		}
		let stored = 0;
		for (const unit of this.units) {
			stored += await this.drainUnit(state, unit);
			if (this.disabled) break;
		}
		return stored;
	}

	/** The persisted cursor for a unit (tests and diagnostics). */
	cursorFor(unit: PlatformLogUnit): string | null {
		return this.state?.cursors[unit] ?? null;
	}

	private async drainUnit(state: CursorState, unit: PlatformLogUnit): Promise<number> {
		let stored = 0;
		for (let page = 0; page < MAX_PAGES_PER_TICK; page += 1) {
			const cursor = state.cursors[unit];
			let result: HelperLogResult;
			try {
				result = await this.helper.platformLogs(unit, { ...(cursor ? { cursor } : {}), lines: LINES_PER_READ });
			} catch (error) {
				// An older helper (404), no helper in dev or a journal hiccup: warn once per distinct
				// error, not once per unit every 5 s.
				this.failing.add(unit);
				const text = errorText(error);
				if (!this.warned.has(text)) {
					this.warned.add(text);
					this.log('warn', `Could not read platform logs (${unit}): ${text}`);
				}
				return stored;
			}
			if (this.failing.delete(unit) && this.failing.size === 0) this.warned.clear();
			if (result.entries.length === 0) {
				if (result.nextCursor && result.nextCursor !== cursor) await this.saveCursor(state, unit, result.nextCursor);
				return stored;
			}
			const response = await this.post({
				target: { kind: 'platform', unit },
				records: platformLogRecords(unit, result.entries),
				dropped: 0,
			});
			if (this.disabled) return stored;
			stored += response.stored;
			const next = result.nextCursor ?? result.entries.at(-1)?.cursor;
			if (next) await this.saveCursor(state, unit, next);
			if (result.entries.length < LINES_PER_READ) return stored;
		}
		return stored;
	}

	private async post(batch: NodeLogBatch): Promise<{ stored: number }> {
		const response = await this.doFetch(`${this.controlUrl}/api/agent/log-records`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${this.nodeToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(batch),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`platform log drain -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
		}
		const body = (await response.json().catch(() => ({}))) as { stored?: unknown; disabled?: unknown };
		const disabled = body.disabled === true;
		if (disabled && !this.disabled) this.log('info', 'Platform logs are switched off (PLATFORM_LOGS); probing once a minute');
		this.disabled = disabled;
		return { stored: typeof body.stored === 'number' ? body.stored : 0 };
	}

	private async load(): Promise<CursorState> {
		if (this.state) return this.state;
		let state: CursorState = { version: STATE_VERSION, cursors: {} };
		try {
			const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as Partial<CursorState>;
			if (parsed && parsed.version === STATE_VERSION && parsed.cursors && typeof parsed.cursors === 'object') {
				const cursors: CursorState['cursors'] = {};
				for (const unit of PLATFORM_LOG_UNIT_NAMES) {
					const value = (parsed.cursors as Record<string, unknown>)[unit];
					if (typeof value === 'string' && value.length > 0 && value.length <= 512) cursors[unit] = value;
				}
				state = { version: STATE_VERSION, cursors };
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				this.log('warn', `Platform log cursors unreadable, starting from the journal tail: ${errorText(error)}`);
		}
		this.state = state;
		return state;
	}

	/** Write-then-rename, so a crash mid-write never leaves a torn cursor file. */
	private async saveCursor(state: CursorState, unit: PlatformLogUnit, cursor: string): Promise<void> {
		state.cursors[unit] = cursor;
		await fs.mkdir(dirname(this.statePath), { recursive: true });
		const temp = `${this.statePath}.${process.pid}.tmp`;
		await fs.writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		await fs.rename(temp, this.statePath);
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener('abort', finish, { once: true });
	});
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
