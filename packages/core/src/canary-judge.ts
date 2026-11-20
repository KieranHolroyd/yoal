import type { CanarySample, CanaryVerdict, RolloutSpec } from '@yoal/contracts';

/**
 * The canary judge (HA-PLAN H25 "Canary"). Owned by Wave 1 lane C. Pure: given the canary copies'
 * edge counters and the old copies' as a baseline over the same window, it says wait, pass or
 * fail. `rolloutTick` calls it only for a rollout whose spec sets `rollout.canary`, which is
 * refused while `RELEASE_PHASE` is off, so it is unreachable until then.
 */
export interface CanaryJudgeInput {
	rollout: RolloutSpec;
	/** Seconds since the canary copies became ready. */
	elapsedSeconds: number;
	canary: CanarySample;
	/** The old release's copies over the same window; null when none run (first deploy). */
	baseline: CanarySample | null;
}

/** Owned by Wave 1 lane C. */
export function judgeCanary(_input: CanaryJudgeInput): CanaryVerdict {
	throw new Error('not implemented (HA Wave 1 lane C): canary judge');
}
