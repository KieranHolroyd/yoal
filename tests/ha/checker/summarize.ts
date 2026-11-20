/** Turn the checker's request log and the observation stream into the report (pure). */
import { CHECKS, type InvariantOptions, duplicateSingletonRuns } from './invariants.ts';
import { type CheckerLog, failureKey, isFailed } from './log.ts';
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

export function summarize(log: CheckerLog, observations: Observation[], options: InvariantOptions = {}): Report {
	const run = log.requests.filter((r) => r.kind !== 'verify');
	const failed = run.filter(isFailed);
	const failedByStatus: Record<string, number> = {};
	for (const r of failed) failedByStatus[failureKey(r)] = (failedByStatus[failureKey(r)] ?? 0) + 1;
	const acked = run.filter((r) => r.kind === 'write' && r.status === 200);
	const verifies = new Map<number, number>();
	for (const r of log.requests) if (r.kind === 'verify') verifies.set(r.n, r.status);
	const lost = acked.filter((r) => verifies.get(r.n) === 404).length;
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
