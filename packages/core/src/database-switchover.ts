import { parseLsn } from './database-sync.ts';

/**
 * Planned database switchover (docs/HA-PLAN.md W10, docs/CLUSTERING.md §9.3).
 *
 * The order is not negotiable: checkpoint the primary, stop new writes, **wait for in-flight
 * transactions to finish**, sample the final LSN, wait until the replica has replayed it, promote,
 * re-point. Sampling before the in-flight transactions commit would let an acknowledged commit sit
 * beyond the barrier and be lost by the promotion (W10 review blocker 4).
 *
 * A non-zero gap is a refusal, not a slow switchover: promoting a replica that has not replayed
 * every commit loses acknowledged writes. Writes are resumed on every refusal *before* promotion;
 * once `pg_ctl promote` has succeeded the old primary is never resumed, because that would produce
 * two primaries (blocker 5). A failure after that point returns `promoted: true` and is retried.
 *
 * The transport is the helper's fixed verbs (`checkpoint`, `writes/stop`, `writes/quiesce`,
 * `writes/resume`, `promote`) and the control plane's own re-point. Nothing here runs SQL.
 */

/** `SWITCHOVER_BUDGET_MS`: the plan's ≤ 5 s exit bound. */
export const SWITCHOVER_BUDGET_MS = 5_000;
/** How long the replica gets to replay the primary's final LSN after writes stop. */
export const SWITCHOVER_WAIT_MS = 3_000;
const POLL_MS = 50;

export type SwitchoverStep = 'checkpoint' | 'stop-writes' | 'quiesce' | 'wait-lsn' | 'promote' | 'repoint' | 'done';

export interface SwitchoverTransport {
	checkpoint(): Promise<void>;
	/** Make the primary refuse new transactions (read-only) without stopping it. */
	stopWrites(): Promise<void>;
	/** Wait until no client backend is mid-transaction; the helper blocks on in-flight commits. */
	quiesceWrites(): Promise<void>;
	/** Undo `stopWrites` after a refusal, and only before a promotion succeeded. */
	resumeWrites(): Promise<void>;
	/** `pg_current_wal_lsn()` on the primary, sampled after quiescence. */
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
	/** `pg_ctl promote` returned; the old primary must never take writes again. */
	promoted: boolean;
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
 * whether to surface it as a 409. `ok: false, promoted: false` means writes were resumed and
 * nothing was promoted. `ok: false, promoted: true` means the new primary is live but the re-point
 * (or a post-promotion check) failed: writes stay stopped on the old primary and the caller retries.
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
	let promoted = false;

	const result = (ok: boolean, message: string, extra: Partial<SwitchoverResult> = {}): SwitchoverResult => {
		const durationMs = now() - startedAt;
		return {
			step,
			ok,
			promoted,
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

		step = 'quiesce';
		onStep(step);
		// The helper's stop-writes waits for no non-idle backend; this explicit step is the seam,
		// so a transport that returns before in-flight commits drain is caught here.
		await options.transport.quiesceWrites();

		step = 'wait-lsn';
		onStep(step);
		// Only now is the sample final: every transaction that began before read-only was applied has
		// committed and is in the WAL.
		primaryLsn = await options.transport.primaryLsn();
		const waitStarted = now();
		for (;;) {
			replayLsn = await options.transport.replicaReplayLsn();
			const missing = gap(primaryLsn, replayLsn);
			if (missing === 0) break;
			if (missing === null)
				return refuse(options.transport, writeStopped, promoted, result, 'The primary or replica did not report a WAL position; refusing the switchover.');
			const timedOut = now() - waitStarted >= waitMs;
			if (timedOut) {
				return refuse(
					options.transport,
					writeStopped,
					promoted,
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
		// Latched before any later check: once `pg_ctl promote` returns, the old primary must not
		// resume writes, even if everything after this point fails.
		promoted = true;
		// `pg_ctl promote` returns the position the new primary starts from; it must not be behind
		// the old primary's last LSN (that would mean the equality check was a stale read). There is
		// no safe resume now, so this is reported as promoted-but-not-repointed for a manual repair.
		if (promotedLsn !== null && gap(primaryLsn, promotedLsn) !== 0)
			return result(
				false,
				`The promoted replica reported ${promotedLsn}, behind the primary's ${primaryLsn ?? 'unknown'} LSN. The new primary is live; do not resume the old one. Re-point or restore from a verified backup.`,
				{ gapBytes: gap(primaryLsn, promotedLsn), step: 'repoint' },
			);

		step = 'repoint';
		onStep(step);
		await options.transport.repoint(promotedLsn ?? primaryLsn);
		step = 'done';
		onStep(step);
		return result(true, 'Switchover complete; every acknowledged commit is on the new primary.', { gapBytes: 0 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return refuse(options.transport, writeStopped, promoted, result, `Switchover stopped at ${step}: ${message}`);
	}
}

async function refuse(
	transport: SwitchoverTransport,
	writeStopped: boolean,
	promoted: boolean,
	result: (ok: boolean, message: string, extra?: Partial<SwitchoverResult>) => SwitchoverResult,
	message: string,
	extra: Partial<SwitchoverResult> = {},
): Promise<SwitchoverResult> {
	// Never resume the old primary after a successful promotion: two primaries is worse than a
	// failed re-point. The caller retries the re-point (the new primary is authoritative).
	if (writeStopped && !promoted) {
		try {
			await transport.resumeWrites();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return result(false, `${message} Resuming writes also failed (${reason}); the primary may still be read-only.`, extra);
		}
	}
	return result(false, message, extra);
}
