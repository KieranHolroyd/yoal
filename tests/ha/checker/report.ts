/**
 * The checker report (Lab ↔ checker contract, HA-PLAN §4 W1). Lane A's lab reads this file's
 * schema; changes are additive only.
 */
import { z } from './zod.ts';

export const INVARIANT_IDS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I11', 'I12', 'I13', 'I14', 'I15', 'I16'] as const;
export type InvariantId = (typeof INVARIANT_IDS)[number];

/** `not-observed` means no relevant observation existed; it is never a pass. */
export const invariantStatusSchema = z.enum(['pass', 'fail', 'not-observed']);
export type InvariantStatus = z.infer<typeof invariantStatusSchema>;

export const invariantResultSchema = z.object({
	status: invariantStatusSchema,
	evidence: z.array(z.string()),
});
export type InvariantResult = z.infer<typeof invariantResultSchema>;

export const reportSchema = z.object({
	seed: z.number().int(),
	/** ISO-8601, the checker's clock. */
	startedAt: z.string(),
	endedAt: z.string(),
	/** Requests sent during the run (writes, reads), not counting the final verification sweep. */
	requests: z.number().int().nonnegative(),
	failedRequests: z.number().int().nonnegative(),
	/** By HTTP status, or `network` / `timeout` when no response came back. */
	failedByStatus: z.record(z.string(), z.number().int().nonnegative()),
	longestWriteGapMs: z.number().nonnegative(),
	acknowledgedWrites: z.number().int().nonnegative(),
	lostAcknowledgedWrites: z.number().int().nonnegative(),
	duplicateSingletonRuns: z.number().int().nonnegative(),
	invariants: z.object(
		Object.fromEntries(INVARIANT_IDS.map((id) => [id, invariantResultSchema])) as Record<InvariantId, typeof invariantResultSchema>,
	),
});
export type Report = z.infer<typeof reportSchema>;

export function failedInvariants(report: Report): InvariantId[] {
	return INVARIANT_IDS.filter((id) => report.invariants[id].status === 'fail');
}
