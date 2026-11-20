import type { CanarySample, CanaryVerdict, RolloutSpec } from '@yoal/contracts';
import { isPromoteSpike } from './maintenance.ts';

/**
 * The canary judge (HA-PLAN H25 "Canary"). Owned by Wave 1 lane C. Pure: given the canary copies'
 * edge counters and the old copies' as a baseline over the same window, it says wait, pass or
 * fail. `rolloutTick` calls it only for a rollout whose spec sets `rollout.canary`, which is
 * refused while `RELEASE_PHASE` is off, so it is unreachable until then.
 *
 * The rules, in order:
 * 1. **Errors.** The 5xx-after-promote rule the platform already alerts on (`isPromoteSpike`): at
 *    least 20 canary requests, a 5xx ratio of 5% or more, and at least double the baseline's ratio
 *    (any ratio of 5% or more when the baseline had none). A hit fails at once, before the soak ends:
 *    there is no reason to keep sending users to a release that is failing them.
 * 2. **Latency.** With at least 20 requests on each side, a canary p95 above twice the baseline's
 *    and at least 250 ms slower fails. A slow canary with no baseline is not judged on latency:
 *    there is nothing to compare it with.
 * 3. **Soak.** Before `soakSeconds` have passed, wait. After, pass; with fewer than 20 canary
 *    requests the pass says it was judged on readiness alone, because a quiet app cannot be judged
 *    on traffic it does not get.
 */
export interface CanaryJudgeInput {
	rollout: RolloutSpec;
	/** Seconds since the canary copies became ready. */
	elapsedSeconds: number;
	canary: CanarySample;
	/** The old release's copies over the same window; null when none run (first deploy). */
	baseline: CanarySample | null;
}

/** Fewest requests a side needs before its ratio or p95 means anything (the promote-spike rule's). */
export const CANARY_MIN_REQUESTS = 20;
/** A canary p95 this many times the baseline's, and at least `CANARY_LATENCY_MIN_DELTA_MS` slower, fails. */
export const CANARY_LATENCY_FACTOR = 2;
export const CANARY_LATENCY_MIN_DELTA_MS = 250;

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

/** Owned by Wave 1 lane C. */
export function judgeCanary(input: CanaryJudgeInput): CanaryVerdict {
	const { canary, baseline } = input;
	const spike = isPromoteSpike(baseline ?? { requests: 0, status5xx: 0 }, canary);
	if (spike)
		return {
			verdict: 'fail',
			reason:
				`${percent(spike.afterRatio)} of ${canary.requests} canary requests returned 5xx` +
				(baseline && baseline.requests > 0 ? `, against ${percent(spike.beforeRatio)} on the previous release.` : '.'),
		};
	if (
		baseline &&
		canary.requests >= CANARY_MIN_REQUESTS &&
		baseline.requests >= CANARY_MIN_REQUESTS &&
		canary.durationP95Ms > baseline.durationP95Ms * CANARY_LATENCY_FACTOR &&
		canary.durationP95Ms - baseline.durationP95Ms >= CANARY_LATENCY_MIN_DELTA_MS
	)
		return {
			verdict: 'fail',
			reason: `The canary's p95 latency is ${Math.round(canary.durationP95Ms)} ms, against ${Math.round(baseline.durationP95Ms)} ms on the previous release.`,
		};
	const soak = input.rollout.soakSeconds;
	if (input.elapsedSeconds < soak)
		return {
			verdict: 'wait',
			reason: `Soaking: ${Math.floor(input.elapsedSeconds)} of ${soak} s, ${canary.requests} canary request${canary.requests === 1 ? '' : 's'} so far.`,
		};
	if (canary.requests < CANARY_MIN_REQUESTS)
		return {
			verdict: 'pass',
			reason: `Passed on readiness alone: ${canary.requests} request${canary.requests === 1 ? '' : 's'} in ${soak} s is too little traffic to judge.`,
		};
	const ratio = canary.status5xx / canary.requests;
	return {
		verdict: 'pass',
		reason: `${canary.requests} canary requests over ${soak} s, ${percent(ratio)} 5xx, p95 ${Math.round(canary.durationP95Ms)} ms.`,
	};
}
