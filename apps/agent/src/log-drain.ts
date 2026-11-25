import {
	levelForPriority,
	parseLogLine,
	type DesiredState,
	type RuntimeLogBatch,
	type WorkloadDesired,
} from '@yoal/contracts';
import type { HelperApi, HelperLogEntry } from './helper-client.ts';

const DEFAULT_INTERVAL_MS = 2_000;
const LINES_PER_READ = 200;
const LINES_PER_POST = 400;

export interface LogDrainOptions {
	helper: HelperApi;
	controlUrl: string;
	nodeToken: string;
	intervalMs?: number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Test seam. */
	fetch?: typeof fetch;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Runtime log drain (DESIGN §8). The agent does not run as root and never talks to journald
 * directly: it asks the helper for new entries after a cursor and forwards ordered batches to the
 * control plane. Cursors are only advanced after a successful POST, so a flaky link retries
 * instead of losing lines. The cursor map is in memory; a restart re-reads the last page and may
 * duplicate a few lines, which is preferable to a gap.
 */
export class WorkloadLogDrain {
	private readonly cursors = new Map<string, string>();
	private readonly warned = new Set<string>();
	private readonly helper: HelperApi;
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly intervalMs: number;
	private readonly log: NonNullable<LogDrainOptions['log']>;
	private readonly doFetch: typeof fetch;
	private readonly doSleep: (ms: number, signal: AbortSignal) => Promise<void>;

	constructor(options: LogDrainOptions) {
		this.helper = options.helper;
		this.controlUrl = options.controlUrl.replace(/\/+$/, '');
		this.nodeToken = options.nodeToken;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.log = options.log ?? (() => undefined);
		this.doFetch = options.fetch ?? fetch;
		this.doSleep = options.sleep ?? sleep;
	}

	async run(
		getState: () => DesiredState | null,
		signal: AbortSignal,
	): Promise<void> {
		while (!signal.aborted) {
			await this.drain(getState()).catch((error: unknown) => {
				this.log('warn', `Log drain failed: ${errorText(error)}`);
			});
			await this.doSleep(this.intervalMs, signal);
		}
	}

	/** Drain every workload currently placed on this node. Returns the number of lines stored. */
	async drain(state: DesiredState | null): Promise<number> {
		if (!state) return 0;
		const desired = state.workloads.filter(
			(workload) => workload.status !== 'stopped',
		);
		const ids = new Set(desired.map((workload) => workload.id));
		for (const id of this.cursors.keys())
			if (!ids.has(id)) this.cursors.delete(id);

		let stored = 0;
		for (const workload of desired) stored += await this.drainOne(workload);
		return stored;
	}

	private async drainOne(workload: WorkloadDesired): Promise<number> {
		const cursor = this.cursors.get(workload.id);
		let result;
		try {
			result = await this.helper.logs(workload.id, {
				...(cursor ? { cursor } : {}),
				lines: LINES_PER_READ,
			});
		} catch (error) {
			// A missing unit or an old helper is expected in dev. Warn once per workload, not every 2 s.
			if (!this.warned.has(workload.id)) {
				this.warned.add(workload.id);
				this.log(
					'warn',
					`Could not read logs for ${workload.projectSlug}: ${errorText(error)}`,
				);
			}
			return 0;
		}
		this.warned.delete(workload.id);
		if (result.entries.length === 0) {
			if (result.nextCursor) this.cursors.set(workload.id, result.nextCursor);
			return 0;
		}

		// Stack traces and other multi-line output become one record (docs/LOGS.md §4.3 step 1).
		const lines = joinMultilineEntries(result.entries).map((entry) => {
			const parsed = parseJoinedLogMessage(entry.message);
			return {
				ts: parsed.ts ?? entry.ts,
				stream: (entry.priority <= 3 ? 'stderr' : 'stdout') as
					| 'stdout'
					| 'stderr',
				level: parsed.level ?? levelForPriority(entry.priority),
				message: parsed.message,
			};
		});

		let sent = 0;
		for (let index = 0; index < lines.length; index += LINES_PER_POST) {
			const batch: RuntimeLogBatch = {
				workloadId: workload.id,
				lines: lines.slice(index, index + LINES_PER_POST),
				...(index + LINES_PER_POST >= lines.length && result.nextCursor
					? { cursor: result.nextCursor }
					: {}),
			};
			await this.post(batch);
			sent += batch.lines.length;
		}
		if (result.nextCursor) this.cursors.set(workload.id, result.nextCursor);
		return sent;
	}

	private async post(batch: RuntimeLogBatch): Promise<void> {
		const response = await this.doFetch(`${this.controlUrl}/api/agent/logs`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${this.nodeToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(batch),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(
				`log drain -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
			);
		}
	}
}

/** A joined record never exceeds the 16 KiB line cap the control plane stores. */
export const MULTILINE_MAX_CHARS = 16_384;
export const MULTILINE_MAX_LINES = 200;
/** A continuation more than this long after the previous line starts a new record. */
export const MULTILINE_GAP_MS = 1_000;

export interface MultilineOptions {
	maxChars?: number;
	maxLines?: number;
	gapMs?: number;
}

/** Python's banners between chained tracebacks. */
const PYTHON_CHAIN =
	/^(During handling of the above exception, another exception occurred:|The above exception was the direct cause of the following exception:)$/;
/** The last line of a Python traceback: `ValueError: boom`, `KeyboardInterrupt`, `pkg.Error: …`. */
const PYTHON_EXCEPTION_LINE = /^[A-Za-z_][\w.]*(: .*)?$/;

type MultilineVerdict = 'new' | 'join' | 'join-traceback' | 'end-traceback';

/**
 * Whether `line` continues the record before it (docs/LOGS.md §4.3 step 1). Continuations are
 * indented lines (stack frames: `\tat …`, `    at …`, `  File "…"`, `\t... 12 more`, source
 * excerpts), `Caused by: …`, a `Traceback (most recent call last):` header that follows an error
 * message, and, inside a Python traceback, the chained-exception banners and the final exception
 * line.
 */
export function classifyLogContinuation(line: string, inTraceback: boolean): MultilineVerdict {
	if (/^Traceback \(most recent call last\):\s*$/.test(line)) return 'join-traceback';
	if (/^[ \t]+\S/.test(line)) return 'join';
	if (/^Caused by: /.test(line)) return 'join';
	if (inTraceback && PYTHON_CHAIN.test(line)) return 'join';
	if (inTraceback && PYTHON_EXCEPTION_LINE.test(line)) return 'end-traceback';
	return 'new';
}

interface PendingRecord {
	entry: HelperLogEntry;
	lines: string[];
	chars: number;
	lastTs: number;
	stderr: boolean;
	inTraceback: boolean;
}

/**
 * Join continuation lines to the previous line of the same unit and stream, in read order (only
 * the agent sees the exact journald order). A joined record keeps the first line's time, the most
 * severe priority and the last line's cursor. It is capped at `maxChars`/`maxLines` (16 KiB / 200
 * lines), and a line more than `gapMs` (1 s) after the previous one always starts a new record.
 * The batch end flushes: a trace split across two reads ships as two records. Pure.
 */
export function joinMultilineEntries(
	entries: readonly HelperLogEntry[],
	options: MultilineOptions = {},
): HelperLogEntry[] {
	const maxChars = options.maxChars ?? MULTILINE_MAX_CHARS;
	const maxLines = options.maxLines ?? MULTILINE_MAX_LINES;
	const gapMs = options.gapMs ?? MULTILINE_GAP_MS;
	const out: HelperLogEntry[] = [];
	let pending: PendingRecord | null = null;

	const flush = (): void => {
		if (!pending) return;
		out.push(
			pending.lines.length === 1
				? pending.entry
				: { ...pending.entry, message: pending.lines.join('\n') },
		);
		pending = null;
	};
	const start = (entry: HelperLogEntry, inTraceback: boolean): void => {
		pending = {
			entry: { ...entry },
			lines: [entry.message],
			chars: entry.message.length,
			lastTs: entry.ts,
			stderr: entry.priority <= 3,
			inTraceback,
		};
	};

	for (const entry of entries) {
		const current = pending as PendingRecord | null;
		const verdict = classifyLogContinuation(entry.message, current?.inTraceback ?? false);
		const joinable =
			current !== null &&
			verdict !== 'new' &&
			current.stderr === entry.priority <= 3 &&
			Math.abs(entry.ts - current.lastTs) <= gapMs &&
			current.lines.length < maxLines &&
			current.chars + 1 + entry.message.length <= maxChars;
		if (!joinable || !current) {
			flush();
			start(entry, verdict === 'join-traceback');
			continue;
		}
		current.lines.push(entry.message);
		current.chars += 1 + entry.message.length;
		current.lastTs = entry.ts;
		current.entry.cursor = entry.cursor;
		current.entry.priority = Math.min(current.entry.priority, entry.priority);
		if (verdict === 'join-traceback') current.inTraceback = true;
		else if (verdict === 'end-traceback') current.inTraceback = false;
	}
	flush();
	return out;
}

/**
 * `parseLogLine` for a possibly joined record: the first line carries the level, time and
 * envelope; the continuation lines are kept verbatim under the parsed message.
 */
export function parseJoinedLogMessage(message: string): ReturnType<typeof parseLogLine> {
	const newline = message.indexOf('\n');
	if (newline < 0) return parseLogLine(message);
	const parsed = parseLogLine(message.slice(0, newline));
	return { ...parsed, message: `${parsed.message}${message.slice(newline)}` };
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
