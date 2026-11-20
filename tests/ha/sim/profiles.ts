/**
 * Fault profiles for the lease simulator. A profile is the set of assumptions a run makes about
 * the world; every bound here is one the lease's safety argument (CLUSTERING §6.3) depends on.
 *
 * - `default` stays inside what ha-lease.ts assumes: a response is acted on within 10 s of the store
 *   applying it (network legs ≤ 4 s, process freezes ≤ 5 s), monotonic clocks drift ≤ 100 ppm,
 *   every store frontend's `Date` stays within the policy's skew tolerance (5 s) of true time, so two
 *   frontends differ by up to twice that (the margin `takeoverAfterMs` = TTL + 2 × skew documents),
 *   the store is linearizable, requests time out, and an operator force-promotes only after
 *   stopping the old holder. The real ha-lease.ts must pass it; `ha-sim` CI runs it.
 * - `adversarial` breaks those assumptions on purpose (long freezes, slow legs, no request timeout,
 *   stale reads, 1000 ppm drift, store frontends up to 15 s off). Violations here are findings about what the lease does *not*
 *   guarantee, not regressions.
 */
export type FaultKind =
	| 'partition'
	| 'slow'
	| 'freeze'
	| 'crash'
	| 'store-5xx'
	| 'put-throttle'
	| 'lost-response'
	| 'store-501'
	| 'spurious-409'
	| 'clock-step'
	| 'store-clock-step'
	| 'gate'
	| 'release'
	| 'force-promote'
	| 'stale-reads'
	| 'no-date';

/**
 * The lease policy as documented (CLUSTERING §6.3, ha-lease.ts DEFAULT_CONTROL_LEASE_POLICY). The
 * simulator judges the module under test against these numbers, never against the module's own
 * policy, so a mutant that loosens its policy is still judged by the documented one.
 */
export interface LeaseSpec {
	ttlMs: number;
	fenceAfterMs: number;
	takeoverAfterMs: number;
	skewToleranceMs: number;
}

export const DOCUMENTED_POLICY: LeaseSpec = { ttlMs: 30_000, fenceAfterMs: 20_000, takeoverAfterMs: 40_000, skewToleranceMs: 5_000 };

export interface Profile {
	name: string;
	spec: LeaseSpec;
	/** Simulated length of one run. Every fault is over by faultWindowMs + 120 s; the operator heals at
	 * faultWindowMs + 150 s, and the rest of the run is for liveness. */
	durationMs: number;
	/** Faults start inside [0, faultWindowMs]; the rest of the run is quiet so liveness can be judged. */
	faultWindowMs: number;
	contenders: [number, number];
	faultsPerRun: [number, number];
	/** One network leg (client→store or store→client) outside a slow episode. */
	normalLegMs: [number, number];
	/** Upper bound of one leg during a `slow` episode. */
	maxSlowLegMs: number;
	maxFreezeMs: number;
	/** Monotonic clock rate error bound, parts per million. */
	driftPpm: number;
	/** Node wall clock offset bound (reported as skew only). */
	wallSkewMs: number;
	/** Per-request `Date` jitter on top of a frontend's offset, before truncation to whole seconds. */
	storeJitterMs: number;
	/** Store frontends (behind one endpoint); each request lands on one at random. */
	storeFrontends: number;
	/** Bound on |frontend clock + jitter − true time|. A frontend offset is redrawn by `store-clock-step`. */
	storeSkewMs: number;
	/** Node wall clock step bound (`clock-step`). The lease must not use the wall clock for decisions. */
	maxClockStepMs: number;
	/**
	 * How node-targeted faults pick their node: `holder` aims at whoever the store names when the
	 * fault starts, `previous` hits the node the fault before it hit, 0–`followGapMs` later (so faults
	 * compound on one node: a partition and a clock step, a slow link and a freeze), the rest are random.
	 */
	targeting: { holder: number; previous: number; followGapMs: number };
	/** The client gives up on a request after this long; Infinity models a transport with no timeout. */
	clientTimeoutMs: number;
	/** Fault kinds and their weights. */
	kinds: Partial<Record<FaultKind, number>>;
	tickIntervalMs: number;
	/** An operator re-seeds a fenced node after this long (§6.6). */
	reseedAfterMs: [number, number];
}

export const PROFILES: Record<string, Profile> = {
	default: {
		name: 'default',
		spec: DOCUMENTED_POLICY,
		durationMs: 780_000,
		faultWindowMs: 450_000,
		contenders: [2, 4],
		faultsPerRun: [4, 14],
		normalLegMs: [2, 150],
		maxSlowLegMs: 4_000,
		maxFreezeMs: 5_000,
		driftPpm: 100,
		wallSkewMs: 4_000,
		storeJitterMs: 400,
		storeFrontends: 3,
		storeSkewMs: DOCUMENTED_POLICY.skewToleranceMs,
		maxClockStepMs: 60_000,
		targeting: { holder: 0.5, previous: 0.25, followGapMs: 15_000 },
		clientTimeoutMs: 10_000,
		kinds: {
			partition: 5,
			slow: 4,
			freeze: 3,
			crash: 2,
			'store-5xx': 3,
			'put-throttle': 2,
			'lost-response': 3,
			'store-501': 0.5,
			'spurious-409': 1,
			'clock-step': 3,
			'store-clock-step': 2,
			gate: 1.5,
			release: 1.5,
			'force-promote': 1,
		},
		tickIntervalMs: 5_000,
		reseedAfterMs: [20_000, 180_000],
	},
	adversarial: {
		name: 'adversarial',
		spec: DOCUMENTED_POLICY,
		durationMs: 780_000,
		faultWindowMs: 450_000,
		contenders: [2, 4],
		faultsPerRun: [4, 14],
		normalLegMs: [2, 150],
		maxSlowLegMs: 20_000,
		maxFreezeMs: 90_000,
		driftPpm: 1_000,
		wallSkewMs: 4_000,
		storeJitterMs: 400,
		storeFrontends: 3,
		storeSkewMs: 15_000,
		maxClockStepMs: 60_000,
		targeting: { holder: 0.5, previous: 0.25, followGapMs: 15_000 },
		clientTimeoutMs: Number.POSITIVE_INFINITY,
		kinds: {
			partition: 5,
			slow: 4,
			freeze: 4,
			crash: 2,
			'store-5xx': 3,
			'put-throttle': 2,
			'lost-response': 3,
			'store-501': 0.5,
			'spurious-409': 1,
			'clock-step': 3,
			'store-clock-step': 2,
			gate: 1.5,
			release: 1.5,
			'force-promote': 1,
			'stale-reads': 2,
			'no-date': 0.5,
		},
		tickIntervalMs: 5_000,
		reseedAfterMs: [20_000, 180_000],
	},
};
