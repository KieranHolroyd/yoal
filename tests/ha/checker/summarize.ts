/** Turn the checker's request log and the observation stream into the report (pure). */
import { CHECKS, type InvariantOptions, duplicateSingletonRuns } from './invariants.ts';
import { type CheckerLog, type RequestRecord, failureKey, isFailed } from './log.ts';
import type { Observation } from './observations.ts';
import { INVARIANT_IDS, type InvariantId, type InvariantResult, type Report, reportSchema } from './report.ts';

export function longestWriteGapMs(log: CheckerLog): number {
	const acks = log.requests
		.filter((r) => r.kind === 'write' && r.status === 200)
		.map((r) => r.endedAt)
		.sort((a, b) => a - b);
	let gap = 0;
	let previous = log.startedAt;
	for (const t of acks) {
		gap = Math.max(gap, t - previous);
		previous = t;
	}
	return Math.max(gap, log.endedAt - previous);
}

/**
 * Acknowledged rows the final verification did not read back intact: gone (404), different content,
 * or still failing (or never read) when the retry budget ran out. The same rows I6 judges; I6 only
 * forgives losses inside the stated RPO before a promotion.
 */
export function lostAcknowledgedWrites(log: CheckerLog): number {
	const verifies = new Map<number, RequestRecord>();
	for (const r of log.requests) if (r.kind === 'verify') verifies.set(r.n, r); // the last attempt wins
	return log.requests.filter((r) => {
		if (r.kind !== 'write' || r.status !== 200) return false;
		const check = verifies.get(r.n);
		return !check || check.status !== 200 || check.match === false;
	}).length;
}

export function summarize(log: CheckerLog, observations: Observation[], options: InvariantOptions = {}): Report {
	const run = log.requests.filter((r) => r.kind !== 'verify');
	const failed = run.filter(isFailed);
	const failedByStatus: Record<string, number> = {};
	for (const r of failed) failedByStatus[failureKey(r)] = (failedByStatus[failureKey(r)] ?? 0) + 1;
	const acked = run.filter((r) => r.kind === 'write' && r.status === 200);
	const lost = lostAcknowledgedWrites(log);
	const invariants = Object.fromEntries(
		INVARIANT_IDS.map((id) => [id, CHECKS[id]({ log, observations, options })]),
	) as Record<InvariantId, InvariantResult>;
	return reportSchema.parse({
		seed: log.seed,
		startedAt: new Date(log.startedAt).toISOString(),
		endedAt: new Date(log.endedAt).toISOString(),
		requests: run.length,
		failedRequests: failed.length,
		failedByStatus,
		longestWriteGapMs: longestWriteGapMs(log),
		acknowledgedWrites: acked.length,
		lostAcknowledgedWrites: lost,
		duplicateSingletonRuns: duplicateSingletonRuns(log, observations),
		invariants,
	});
}
