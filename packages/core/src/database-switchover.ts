import { parseLsn } from './database-sync.ts';

/**
 * Planned database switchover (docs/HA-PLAN.md W10, docs/CLUSTERING.md §9.3).
 *
 * The order is not negotiable: checkpoint the primary, stop writes, wait until the replica's replay
 * LSN equals the primary's last LSN, promote, re-point. A non-zero gap is a refusal, not a slow
 * switchover: promoting a replica that has not replayed every commit loses acknowledged writes.
 * Writes are resumed on every refusal, before the error is returned.
 *
 * The transport is the helper's fixed verbs (`checkpoint`, `writes/stop`, `writes/resume`,
 * `promote`, `status`) and the control plane's own re-point. Nothing here runs SQL: the helper
 * renders the statements, so the control plane never supplies a command.
 */

/** `SWITCHOVER_BUDGET_MS`: the plan's ≤ 5 s exit bound. */
export const SWITCHOVER_BUDGET_MS = 5_000;
/** How long the replica gets to replay the primary's final LSN after writes stop. */
export const SWITCHOVER_WAIT_MS = 3_000;
const POLL_MS = 50;

export type SwitchoverStep = 'checkpoint' | 'stop-writes' | 'wait-lsn' | 'promote' | 'repoint' | 'done';

export interface SwitchoverTransport {
	checkpoint(): Promise<void>;
	/** Make the primary refuse writes (read-only) without stopping it; its LSN is still readable. */
	stopWrites(): Promise<void>;
	/** Undo `stopWrites` after a refusal. */
	resumeWrites(): Promise<void>;
	/** `pg_current_wal_lsn()` on the primary. */
	primaryLsn(): Promise<string | null>;
	/** `pg_last_wal_replay_lsn()` on the replica. */
	replicaReplayLsn(): Promise<string | null>;
	/** `pg_ctl promote`, returning the new primary's LSN. */
	promote(): Promise<string | null>;
	/** Move the database row, re-point consumers, and queue the old primary's rewind. */
	repoint(lsn: string | null): Promise<void>;
}

export interface SwitchoverResult {
	step: SwitchoverStep;
	ok: boolean;
	primaryLsn: string | null;
	replayLsn: string | null;
	/** Bytes the replica was short when the switchover was refused; null when it completed. */
	gapBytes: number | null;
	budgetMs: number;
	durationMs: number;
	withinBudget: boolean;
	message: string;
}

export interface SwitchoverOptions {
	transport: SwitchoverTransport;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	budgetMs?: number;
	waitMs?: number;
	onStep?: (step: SwitchoverStep) => void;
}

function gap(primary: string | null, replay: string | null): number | null {
	const from = parseLsn(primary);
	const to = parseLsn(replay);
	if (from === null || to === null) return null;
	const difference = from - to;
	return difference <= 0n ? 0 : difference > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(difference);
}

/**
 * Run one switchover. The returned result is always a value, never a throw: the caller decides
 * whether to surface it as a 409. `ok: false` means writes were resumed and nothing was promoted.
 */
export async function runSwitchover(options: SwitchoverOptions): Promise<SwitchoverResult> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const budgetMs = options.budgetMs ?? SWITCHOVER_BUDGET_MS;
	const waitMs = options.waitMs ?? SWITCHOVER_WAIT_MS;
	const onStep = options.onStep ?? (() => undefined);
	const startedAt = now();
	let step: SwitchoverStep = 'checkpoint';
	let primaryLsn: string | null = null;
	let replayLsn: string | null = null;
	let writeStopped = false;

	const result = (ok: boolean, message: string, extra: Partial<SwitchoverResult> = {}): SwitchoverResult => {
		const durationMs = now() - startedAt;
		return {
			step,
			ok,
			primaryLsn,
			replayLsn,
			gapBytes: null,
			budgetMs,
			durationMs,
			withinBudget: ok && durationMs <= budgetMs,
			message,
			...extra,
		};
	};

	try {
		onStep(step);
		await options.transport.checkpoint();

		step = 'stop-writes';
		onStep(step);
		await options.transport.stopWrites();
		writeStopped = true;

		step = 'wait-lsn';
		onStep(step);
		primaryLsn = await options.transport.primaryLsn();
		const waitStarted = now();
		for (;;) {
			replayLsn = await options.transport.replicaReplayLsn();
			const missing = gap(primaryLsn, replayLsn);
			if (missing === 0) break;
			if (missing === null)
				return await refuse(options.transport, writeStopped, result, 'The primary or replica did not report a WAL position; refusing the switchover.');
			const timedOut = now() - waitStarted >= waitMs;
			if (timedOut) {
				return await refuse(
					options.transport,
					writeStopped,
					result,
					`The replica is ${missing} byte(s) behind the primary and did not catch up within ${waitMs} ms; refusing the switchover.`,
					{ gapBytes: missing },
				);
			}
			await sleep(POLL_MS);
		}

		step = 'promote';
		onStep(step);
		const promotedLsn = await options.transport.promote();
		// `pg_ctl promote` returns the position the new primary starts from; it must not be behind
		// the old primary's last LSN (that would mean the equality check was a stale read).
		if (gap(primaryLsn, promotedLsn) !== 0 && promotedLsn !== null)
			return await refuse(
				options.transport,
				writeStopped,
				result,
				`The promoted replica reported ${promotedLsn}, behind the primary's ${primaryLsn ?? 'unknown'} LSN; refusing the switchover.`,
				{ gapBytes: gap(primaryLsn, promotedLsn) },
			);

		step = 'repoint';
		onStep(step);
		await options.transport.repoint(promotedLsn ?? primaryLsn);
		step = 'done';
		onStep(step);
		return result(true, 'Switchover complete; every acknowledged commit is on the new primary.', { gapBytes: 0 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return refuse(options.transport, writeStopped, result, `Switchover stopped at ${step}: ${message}`);
	}
}

async function refuse(
	transport: SwitchoverTransport,
	writeStopped: boolean,
	result: (ok: boolean, message: string, extra?: Partial<SwitchoverResult>) => SwitchoverResult,
	message: string,
	extra: Partial<SwitchoverResult> = {},
): Promise<SwitchoverResult> {
	if (writeStopped) await transport.resumeWrites().catch(() => undefined);
	return result(false, message, extra);
}
