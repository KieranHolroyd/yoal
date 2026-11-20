import { describe, expect, test } from 'bun:test';
import type { RolloutSpec } from '@yoal/contracts';
import { CANARY_MIN_REQUESTS, judgeCanary } from './canary-judge.ts';

/**
 * HA-PLAN H25 "Canary": errors fail at once, latency fails on a real multiple over a real delta,
 * and a quiet app passes on readiness rather than on traffic it never got.
 */

const rollout = (soakSeconds: number): RolloutSpec => ({ canary: 1, soakSeconds, maxUnavailable: 1 });

describe('judgeCanary', () => {
	test('fails at once on a 5xx spike, even before the soak ends', () => {
		const verdict = judgeCanary({
			rollout: rollout(60),
			elapsedSeconds: 5,
			canary: { requests: 100, status5xx: 10, durationP95Ms: 100 },
			baseline: { requests: 100, status5xx: 1, durationP95Ms: 100 },
		});
		expect(verdict.verdict).toBe('fail');
		expect(verdict.reason).toContain('10.0%');
	});

	test('fails on 5% 5xx when the previous release had none', () => {
		const verdict = judgeCanary({
			rollout: rollout(60),
			elapsedSeconds: 60,
			canary: { requests: 40, status5xx: 2, durationP95Ms: 100 },
			baseline: null,
		});
		expect(verdict.verdict).toBe('fail');
	});

	test('does not call a 5xx spike on fewer than 20 requests', () => {
		const verdict = judgeCanary({
			rollout: rollout(60),
			elapsedSeconds: 60,
			canary: { requests: 10, status5xx: 5, durationP95Ms: 100 },
			baseline: null,
		});
		expect(verdict.verdict).toBe('pass');
		expect(verdict.reason).toContain('readiness alone');
	});

	test('waits until the soak has run', () => {
		const verdict = judgeCanary({
			rollout: rollout(30),
			elapsedSeconds: 12,
			canary: { requests: 500, status5xx: 0, durationP95Ms: 40 },
			baseline: { requests: 500, status5xx: 0, durationP95Ms: 40 },
		});
		expect(verdict.verdict).toBe('wait');
		expect(verdict.reason).toContain('of 30 s');
	});

	test('passes after the soak on a healthy canary', () => {
		const verdict = judgeCanary({
			rollout: rollout(30),
			elapsedSeconds: 30,
			canary: { requests: 500, status5xx: 0, durationP95Ms: 40 },
			baseline: { requests: 500, status5xx: 0, durationP95Ms: 40 },
		});
		expect(verdict.verdict).toBe('pass');
		expect(verdict.reason).toContain('0.0% 5xx');
	});

	test('fails on latency when the canary is twice as slow and at least 250 ms slower', () => {
		const verdict = judgeCanary({
			rollout: rollout(30),
			elapsedSeconds: 30,
			canary: { requests: 100, status5xx: 0, durationP95Ms: 600 },
			baseline: { requests: 100, status5xx: 0, durationP95Ms: 100 },
		});
		expect(verdict.verdict).toBe('fail');
		expect(verdict.reason).toContain('p95 latency');
	});

	test('does not fail latency on the multiple alone when the delta is small', () => {
		const verdict = judgeCanary({
			rollout: rollout(30),
			elapsedSeconds: 30,
			canary: { requests: 100, status5xx: 0, durationP95Ms: 320 },
			baseline: { requests: 100, status5xx: 0, durationP95Ms: 100 },
		});
		expect(verdict.verdict).toBe('pass');
	});

	test('does not judge latency without a baseline', () => {
		const verdict = judgeCanary({
			rollout: rollout(30),
			elapsedSeconds: 30,
			canary: { requests: 100, status5xx: 0, durationP95Ms: 5_000 },
			baseline: null,
		});
		expect(verdict.verdict).toBe('pass');
	});

	test('needs CANARY_MIN_REQUESTS on both sides before latency means anything', () => {
		expect(CANARY_MIN_REQUESTS).toBe(20);
		const verdict = judgeCanary({
			rollout: rollout(30),
			elapsedSeconds: 30,
			canary: { requests: 10, status5xx: 0, durationP95Ms: 5_000 },
			baseline: { requests: 100, status5xx: 0, durationP95Ms: 10 },
		});
		expect(verdict.verdict).toBe('pass');
	});
});
