/**
 * Schedules for the W9 model: one generator per family in W9-SPEC §7, plus one fixed minimal
 * counterexample scenario.
 *
 * Everything is a pure function of (seed, family): a seed replays exactly. Faults are written as
 * data so a run can print the exact schedule it used.
 */
import { Rng } from '../rng.ts';
import { type Family, type Fault, type MemberId, type Scenario } from './spec.ts';

const DURATION = 150_000;

function fault(id: number, at: number, kind: Fault['kind'], extra: Partial<Fault> = {}): Fault {
	return { id, at, kind, ...extra };
}

function edge(
	id: number,
	at: number,
	from: string,
	to: string,
	durationMs: number,
	options: { symmetric?: boolean; mode?: 'refuse' | 'drop' } = {},
): Fault {
	return fault(id, at, 'edge-down', {
		from,
		to,
		durationMs,
		symmetric: options.symmetric ?? true,
		mode: options.mode ?? 'drop',
	});
}

function base(seed: number, family: Family): { rng: Rng; finish: (s: Partial<Scenario> & { faults: Fault[] }) => Scenario } {
	const rng = new Rng(seed, 21);
	return {
		rng,
		finish: (scenario) => ({
			name: scenario.name ?? family,
			family,
			durationMs: scenario.durationMs ?? DURATION,
			faults: scenario.faults,
			expect: scenario.expect ?? {},
			durability: scenario.durability ?? 'sync',
			sync: scenario.sync ?? ['b'],
			syncLoss: scenario.syncLoss ?? 'downgrade',
			writes: scenario.writes ?? true,
		}),
	};
}

/** `renew-loss`: the primary loses the arbiter, with and without a member also unreachable. */
function renewLoss(seed: number): Scenario {
	const { rng, finish } = base(seed, 'renew-loss');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(5_000, 12_000);
	const duration = rng.int(8_000, 24_000);
	const durability = rng.chance(0.5) ? 'sync' : 'async';
	const sync: MemberId[] = ['b'];
	faults.push(edge(id++, t, 'p', 'arb', duration));
	if (rng.chance(0.65)) {
		const peer: MemberId = durability === 'sync' ? (rng.chance(0.75) ? 'b' : 'a') : rng.pick(['a', 'b']);
		faults.push(edge(id++, t + rng.int(0, 600), 'p', peer, duration + rng.int(1_000, 8_000)));
	}
	return finish({ faults, durability, sync });
}

/** `cas-race`: two replicas acquire at once; two control standbys take over at once. */
function casRace(seed: number): Scenario {
	const { rng, finish } = base(seed, 'cas-race');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(5_000, 12_000);
	const duration = rng.int(20_000, 32_000);
	faults.push(edge(id++, t, 'p', 'arb', duration));
	faults.push(edge(id++, t, 'p', 'a', duration));
	faults.push(edge(id++, t, 'p', 'b', duration));
	faults.push(edge(id++, t, 'c0', 'arb', rng.int(45_000, 60_000)));
	return finish({ faults, durability: 'async', sync: ['b'] });
}

/** `arbiter-outage`: all members lose the arbiter, with and without a member unreachable. */
function arbiterOutage(seed: number): Scenario {
	const { rng, finish } = base(seed, 'arbiter-outage');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(6_000, 14_000);
	const duration = rng.int(15_000, 32_000);
	for (const member of ['p', 'a', 'b'] as MemberId[]) faults.push(edge(id++, t, member, 'arb', duration));
	const withPeerLoss = rng.chance(0.55);
	const peer: MemberId = rng.chance(0.7) ? 'b' : 'a';
	if (withPeerLoss) faults.push(edge(id++, t, 'p', peer, duration + rng.int(1_000, 10_000)));
	return finish({
		faults,
		durability: rng.chance(0.5) ? 'sync' : 'async',
		expect: { noPrimary: { from: t, to: t + duration } },
	});
}

/** `asymmetric`: reachability is directional; A can reach the arbiter, B can reach A, and so on. */
function asymmetric(seed: number): Scenario {
	const { rng, finish } = base(seed, 'asymmetric');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(5_000, 12_000);
	const duration = rng.int(20_000, 35_000);
	const pattern = rng.int(0, 2);
	if (pattern === 0) {
		// A reaches the arbiter and B; P reaches neither the arbiter nor A; B cannot reach the arbiter.
		faults.push(edge(id++, t, 'p', 'arb', duration));
		faults.push(edge(id++, t, 'p', 'a', duration));
		faults.push(edge(id++, t, 'b', 'arb', duration));
	} else if (pattern === 1) {
		// B reaches the arbiter and A; P reaches neither; A cannot reach the arbiter.
		faults.push(edge(id++, t, 'p', 'arb', duration));
		faults.push(edge(id++, t, 'p', 'b', duration));
		faults.push(edge(id++, t, 'a', 'arb', duration));
	} else {
		// The return path from the arbiter to P is broken: renewals apply but their answers are lost.
		faults.push(edge(id++, t, 'arb', 'p', duration, { symmetric: false }));
		faults.push(edge(id++, t, 'p', 'a', duration));
		faults.push(edge(id++, t, 'b', 'arb', duration));
	}
	const sync: MemberId[] = pattern === 0 ? ['a'] : ['b'];
	return finish({
		faults,
		durability: rng.chance(0.5) ? 'sync' : 'async',
		sync,
		// Pattern 2 keeps the only eligible replica away from the arbiter for the fault window, so
		// the failover clock starts when the arbiter is reachable again.
		expect: { failover: { after: t, withinMs: pattern === 2 ? duration + 35_000 : 35_000 } },
	});
}

/** `clock-step`: a wall-clock step during a lease, sometimes with the primary's renewals lost. */
function clockStep(seed: number): Scenario {
	const { rng, finish } = base(seed, 'clock-step');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(5_000, 12_000);
	const node = rng.pick(['p', 'b', 'c0', 'c1'] as const);
	const delta = (rng.chance(0.65) ? -1 : 1) * rng.int(30_000, 120_000);
	faults.push(fault(id++, t, 'clock-step', { node, value: delta }));
	if (rng.chance(0.5)) faults.push(edge(id++, t, 'p', 'arb', rng.int(10_000, 25_000)));
	return finish({ faults, durability: rng.chance(0.5) ? 'sync' : 'async' });
}

/** `stale-leader`: a process freezes past its lease, a successor promotes, then it resumes. */
function staleLeader(seed: number): Scenario {
	const { rng, finish } = base(seed, 'stale-leader');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(5_000, 12_000);
	const freeze = rng.int(20_000, 50_000);
	const databaseFreeze = rng.chance(0.75);
	if (databaseFreeze) {
		faults.push(fault(id++, t, 'freeze', { node: 'p', durationMs: freeze }));
	} else {
		faults.push(fault(id++, t, 'freeze', { node: 'c0', durationMs: 45_000 }));
	}
	return finish({
		faults,
		durability: rng.chance(0.4) ? 'async' : 'sync',
		expect: databaseFreeze ? { failover: { after: t, withinMs: 35_000 } } : {},
	});
}

/**
 * `sync-change`: the sync standby is lost and the primary runs the Revision 1 three-step
 * transition to the async replica. The primary is killed in one of five phases: before the open,
 * inside the open (before the switch), after the switch before the barrier, after the barrier
 * before the close, or after the close. Revision 1 forbids an automatic promotion in the first
 * four; only the last is a normal failover.
 */
function syncChange(seed: number): Scenario {
	const { rng, finish } = base(seed, 'sync-change');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(5_000, 10_000);
	const phase = rng.int(0, 6);
	const openAt = t + 50;
	if (phase !== 5) faults.push(edge(id++, t, 'p', 'b', 60_000));
	if (phase === 0) {
		faults.push(fault(id++, t + 10, 'kill-primary', { durationMs: 0 }));
	} else if (phase === 1 || phase === 2) {
		faults.push(fault(id++, 0, 'lag', { target: 'a', durationMs: openAt + 20_000 }));
		faults.push(fault(id++, openAt - 10, 'kill-after-open', { value: phase === 1 ? 100 : 600 }));
		faults.push(fault(id++, openAt, 'sync-change', { target: 'a' }));
	} else if (phase === 3) {
		faults.push(fault(id++, openAt - 10, 'kill-after-barrier'));
		faults.push(fault(id++, openAt, 'sync-change', { target: 'a' }));
	} else if (phase === 4) {
		faults.push(fault(id++, openAt, 'sync-change', { target: 'a' }));
		faults.push(fault(id++, openAt + 4_000, 'kill-primary', { durationMs: 0 }));
	} else if (phase === 5) {
		// The new member cannot acknowledge the barrier; the old sync standby is healthy. After
		// SYNC_CHANGE_TIMEOUT the primary must fall back to the old member, steady.
		faults.push(fault(id++, 0, 'lag', { target: 'a', durationMs: openAt + 40_000 }));
		faults.push(fault(id++, openAt, 'sync-change', { target: 'a' }));
	} else {
		// The new member cannot acknowledge the barrier and the old member is not healthy: the
		// on_sync_loss downgrade closes the transition steady with durability_effective async.
		faults.push(fault(id++, 0, 'lag', { target: 'a', durationMs: openAt + 40_000 }));
		faults.push(fault(id++, openAt, 'sync-change', { target: 'a' }));
	}
	return finish({ faults, durability: 'sync', sync: ['b'], durationMs: 45_000 });
}

/** `keepalive-acquire`: a member answers, is cut off from the primary, then tries to acquire. */
function keepAliveAcquire(seed: number): Scenario {
	const { rng, finish } = base(seed, 'keepalive-acquire');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(5_000, 12_000);
	const member: MemberId = rng.chance(0.6) ? 'b' : 'a';
	const durability = rng.chance(0.5) ? 'sync' : 'async';
	faults.push(edge(id++, t, 'p', 'arb', rng.int(30_000, 45_000)));
	faults.push(edge(id++, t, 'p', member, rng.int(30_000, 45_000)));
	return finish({
		faults,
		durability,
		sync: [member],
		expect: { failover: { after: t, withinMs: 35_000 } },
	});
}

/** `control-outage`: the control plane is away and the database primary is killed. I11. */
function controlOutage(seed: number): Scenario {
	const { rng, finish } = base(seed, 'control-outage');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(6_000, 12_000);
	const outageEnd = t + rng.int(60_000, 120_000);
	const viaCrash = rng.chance(0.35);
	if (viaCrash) {
		faults.push(fault(id++, t, 'control-crash', { durationMs: outageEnd - t }));
	} else {
		for (const node of ['c0', 'c1', 'c2']) faults.push(edge(id++, t, node, 'arb', outageEnd - t));
	}
	faults.push(fault(id++, t + 3_000, 'kill-primary', { durationMs: 0 }));
	return finish({
		faults,
		durability: rng.chance(0.6) ? 'sync' : 'async',
		expect: {
			controlOutage: { from: t, to: outageEnd },
			requireAcks: { from: t, to: t + 3_000, min: 1 },
			failover: { after: t + 3_000, withinMs: 35_000 },
		},
	});
}

/**
 * Revision 2: the control plane is unavailable while the synchronous standby is lost. The primary
 * applies the on_sync_loss setting locally at the last observed ETag so writes resume, reports it,
 * and the control plane reconciles on return. A stale ETag is never recorded as sync; the healthy
 * old member is re-opened with a fresh barrier, otherwise the policy outcome is recorded. Alerts.
 */
function controlSyncLoss(seed: number): Scenario {
	const { rng, finish } = base(seed, 'control-sync-loss');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(5_000, 12_000);
	const outage = rng.int(38_000, 55_000);
	faults.push(fault(id++, t, 'sync-control-outage', { durationMs: outage }));
	faults.push(edge(id++, t + 1_000, 'p', 'b', outage - 1_000 + rng.int(5_000, 15_000)));
	const killed = rng.chance(0.3);
	if (killed) faults.push(fault(id++, t + 36_000, 'kill-primary', { durationMs: 0 }));
	return finish({
		faults,
		durability: 'sync',
		sync: ['b'],
		durationMs: 100_000,
		expect: {
			requireAcks: { from: t + 33_000, to: t + outage, min: 1 },
			...(killed ? { failover: { after: t + 36_000, withinMs: 35_000 } } : {}),
		},
	});
}

/**
 * The loss heals after the primary applied the on_sync_loss setting locally. On return the report is
 * stale; if the lease names a healthy member the control plane re-opens a fresh barrier, otherwise
 * it records the policy outcome. Never `sync` from the stale report.
 */
function controlSyncStale(seed: number): Scenario {
	const { rng, finish } = base(seed, 'control-sync-stale');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(5_000, 12_000);
	const outage = rng.int(40_000, 55_000);
	const loss = rng.int(31_000, 45_000);
	faults.push(fault(id++, t, 'sync-control-outage', { durationMs: outage }));
	faults.push(edge(id++, t + 1_000, 'p', 'b', loss));
	return finish({
		faults,
		durability: 'sync',
		sync: ['b'],
		durationMs: 100_000,
		expect: { requireAcks: { from: t + 33_000, to: t + outage - 1_000, min: 1 } },
	});
}

/** A transient control-plane outage with no sync loss: traffic must not notice it. */
function controlTransient(seed: number): Scenario {
	const { rng, finish } = base(seed, 'control-transient');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(5_000, 12_000);
	const outage = rng.int(8_000, 20_000);
	faults.push(fault(id++, t, 'sync-control-outage', { durationMs: outage }));
	return finish({
		faults,
		durability: 'sync',
		sync: ['b'],
		durationMs: 60_000,
		expect: { requireAcks: { from: t, to: t + outage, min: 1 } },
	});
}

/** `mixed`: 2–4 faults from the families above, always healed by 100 s. */
function mixed(seed: number): Scenario {
	const { rng, finish } = base(seed, 'mixed');
	const faults: Fault[] = [];
	let id = 0;
	const count = rng.int(2, 4);
	const chosen = new Set<string>();
	for (let i = 0; i < count; i++) {
		const pick = rng.pick(['renew', 'peer', 'arb', 'freeze', 'clock', 'sync', 'control'] as const);
		if (chosen.has(pick)) continue;
		chosen.add(pick);
		const t = rng.int(5_000, 50_000);
		switch (pick) {
			case 'renew':
				faults.push(edge(id++, t, 'p', 'arb', rng.int(8_000, 25_000)));
				break;
			case 'peer': {
				const peer: MemberId = rng.pick(['a', 'b']);
				faults.push(edge(id++, t, 'p', peer, rng.int(8_000, 30_000)));
				break;
			}
			case 'arb':
				for (const member of ['p', 'a', 'b'] as MemberId[]) faults.push(edge(id++, t, member, 'arb', rng.int(10_000, 30_000)));
				break;
			case 'freeze': {
				const node = rng.pick(['p', 'a', 'b', 'c0'] as const);
				faults.push(fault(id++, t, 'freeze', { node, durationMs: rng.int(15_000, 40_000) }));
				break;
			}
			case 'clock':
				faults.push(
					fault(id++, t, 'clock-step', {
						node: rng.pick(['p', 'a', 'b', 'c1'] as const),
						value: (rng.chance(0.6) ? -1 : 1) * rng.int(30_000, 120_000),
					}),
				);
				break;
			case 'sync': {
				faults.push(edge(id++, t, 'p', 'b', 40_000));
				const mode = rng.int(0, 3);
				if (mode === 0) {
					faults.push(fault(id++, 0, 'lag', { target: 'a', durationMs: t + 20_000 }));
					faults.push(fault(id++, t + 40, 'kill-after-open', { value: 100 }));
				} else if (mode === 1) {
					faults.push(fault(id++, t + 40, 'kill-after-barrier'));
				}
				faults.push(fault(id++, t + 50, 'sync-change', { target: 'a' }));
				if (mode === 2) faults.push(fault(id++, t + 4_000, 'kill-primary', { durationMs: 0 }));
				break;
			}
			case 'control':
				for (const node of ['c0', 'c1', 'c2']) faults.push(edge(id++, t, node, 'arb', rng.int(20_000, 50_000)));
				break;
		}
	}
	return finish({ faults, durability: rng.chance(0.5) ? 'sync' : 'async' });
}

const GENERATORS: Record<Family, (seed: number) => Scenario> = {
	'renew-loss': renewLoss,
	'cas-race': casRace,
	'arbiter-outage': arbiterOutage,
	asymmetric,
	'clock-step': clockStep,
	'stale-leader': staleLeader,
	'sync-change': syncChange,
	'keepalive-acquire': keepAliveAcquire,
	'control-outage': controlOutage,
	'control-sync-loss': controlSyncLoss,
	'control-sync-stale': controlSyncStale,
	'control-transient': controlTransient,
	mixed,
};

export function generateScenario(seed: number, family: Family): Scenario {
	return GENERATORS[family](seed);
}

/**
 * The old counterexample, as a Revision 1 regression: the primary dies after open and before the
 * barrier, with the target lagging. `syncState: 'changing'` must make the fleet non-promotable.
 */
export function minimalSyncChange(): Scenario {
	const faults: Fault[] = [
		fault(0, 0, 'lag', { target: 'a', durationMs: 10_000 }),
		edge(1, 1_500, 'p', 'b', 60_000),
		fault(2, 1_540, 'kill-after-open', { value: 100 }),
		fault(3, 1_550, 'sync-change', { target: 'a' }),
	];
	return {
		name: 'sync-change-minimal',
		family: 'sync-change',
		durationMs: 30_000,
		faults,
		expect: {},
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** The primary dies after the barrier was acknowledged, before the close. Still `changing`. */
export function syncChangeAfterBarrier(): Scenario {
	const faults: Fault[] = [
		edge(0, 1_500, 'p', 'b', 60_000),
		fault(1, 1_540, 'kill-after-barrier'),
		fault(2, 1_550, 'sync-change', { target: 'a' }),
	];
	return {
		name: 'sync-change-after-barrier',
		family: 'sync-change',
		durationMs: 30_000,
		faults,
		expect: {},
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** The transition closed `steady {a}` and the primary died afterwards: a normal, safe failover. */
export function syncChangeAfterClose(): Scenario {
	const faults: Fault[] = [
		edge(0, 1_500, 'p', 'b', 60_000),
		fault(1, 1_550, 'sync-change', { target: 'a' }),
		fault(2, 5_500, 'kill-primary', { durationMs: 0 }),
	];
	return {
		name: 'sync-change-after-close',
		family: 'sync-change',
		durationMs: 30_000,
		faults,
		expect: {},
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** The barrier times out; the old standby is healthy, so step 3 falls back to it, steady. */
export function syncChangeFallback(): Scenario {
	const faults: Fault[] = [
		fault(0, 0, 'lag', { target: 'a', durationMs: 40_000 }),
		fault(1, 1_550, 'sync-change', { target: 'a' }),
	];
	return {
		name: 'sync-change-fallback',
		family: 'sync-change',
		durationMs: 45_000,
		faults,
		expect: {},
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** The barrier times out, the old standby is not healthy: on_sync_loss downgrade, steady. */
export function syncChangeDowngrade(): Scenario {
	const faults: Fault[] = [
		edge(0, 1_500, 'p', 'b', 60_000),
		fault(1, 0, 'lag', { target: 'a', durationMs: 40_000 }),
		fault(2, 1_550, 'sync-change', { target: 'a' }),
	];
	return {
		name: 'sync-change-downgrade',
		family: 'sync-change',
		durationMs: 45_000,
		faults,
		expect: {},
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** The close CAS applies but its response is lost: the primary must adopt the steady lease. */
export function syncChangeCloseRace(): Scenario {
	const faults: Fault[] = [
		edge(0, 1_500, 'p', 'b', 60_000),
		fault(1, 1_550, 'sync-change', { target: 'a' }),
		edge(2, 2_100, 'arb', 'p', 600, { symmetric: false }),
		fault(3, 6_000, 'kill-primary', { durationMs: 0 }),
	];
	return {
		name: 'sync-change-close-race',
		family: 'sync-change',
		durationMs: 35_000,
		faults,
		expect: {},
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** Rev 2: outage + lost sync standby; local async, stale report, record async + alert. */
export function syncControlLoss(): Scenario {
	const faults: Fault[] = [
		fault(0, 2_000, 'sync-control-outage', { durationMs: 43_000 }),
		edge(1, 3_000, 'p', 'b', 57_000),
	];
	return {
		name: 'sync-control-loss',
		family: 'control-sync-loss',
		durationMs: 60_000,
		faults,
		expect: { requireAcks: { from: 35_000, to: 44_000, min: 1 } },
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** Rev 2: the lost standby heals before the control plane returns; stale report, fresh barrier. */
export function syncControlStaleReopen(): Scenario {
	const faults: Fault[] = [
		fault(0, 2_000, 'sync-control-outage', { durationMs: 53_000 }),
		edge(1, 3_000, 'p', 'b', 33_000),
	];
	return {
		name: 'sync-control-stale-reopen',
		family: 'control-sync-stale',
		durationMs: 65_000,
		faults,
		expect: { requireAcks: { from: 35_000, to: 54_000, min: 1 } },
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** Rev 2: the report beats the next renewal, so the ETag is the same and the change is recorded. */
export function syncControlSameEtage(): Scenario {
	const faults: Fault[] = [
		fault(0, 2_000, 'sync-control-outage', { durationMs: 32_500 }),
		edge(1, 3_000, 'p', 'b', 57_000),
	];
	return {
		name: 'sync-control-same-etag',
		family: 'control-sync-loss',
		durationMs: 60_000,
		faults,
		expect: { requireAcks: { from: 35_000, to: 45_000, min: 1 } },
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** Rev 2: a transient control-plane outage with nothing else failing. */
export function syncControlTransient(): Scenario {
	const faults: Fault[] = [fault(0, 2_000, 'sync-control-outage', { durationMs: 15_000 })];
	return {
		name: 'sync-control-transient',
		family: 'control-transient',
		durationMs: 40_000,
		faults,
		expect: { requireAcks: { from: 3_000, to: 16_000, min: 1 } },
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/**
 * Rev 2's forbidden act: a node reports a new sync member from inside the outage, and the report is
 * stale on return. The normal reconciler must refuse it; `record-sync-on-stale` records it and a
 * lagging member promotes with missing acknowledged commits.
 */
export function syncControlStaleSync(): Scenario {
	const faults: Fault[] = [
		fault(0, 2_000, 'sync-control-outage', { durationMs: 53_000 }),
		edge(1, 3_000, 'p', 'b', 57_000),
		fault(2, 0, 'lag', { target: 'a', durationMs: 80_000 }),
		fault(3, 56_000, 'kill-primary', { durationMs: 0 }),
	];
	return {
		name: 'sync-control-stale-sync',
		family: 'control-sync-loss',
		durationMs: 90_000,
		faults,
		expect: {},
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** The control-plane outage with a database failover: I11's positive case. */
export function minimalControlOutage(): Scenario {
	const faults: Fault[] = [
		edge(0, 8_000, 'c0', 'arb', 100_000),
		edge(1, 8_000, 'c1', 'arb', 100_000),
		edge(2, 8_000, 'c2', 'arb', 100_000),
		fault(3, 11_000, 'kill-primary', { durationMs: 0 }),
	];
	return {
		name: 'control-outage-minimal',
		family: 'control-outage',
		durationMs: 60_000,
		faults,
		expect: {
			controlOutage: { from: 8_000, to: 60_000 },
			requireAcks: { from: 8_000, to: 11_000, min: 1 },
			failover: { after: 11_000, withinMs: 35_000 },
		},
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** The clock-step / renewal-loss pair that the `fence-wall-clock` mutant fails. */
export function wallClockFenceScenario(): Scenario {
	const faults: Fault[] = [
		edge(0, 6_000, 'p', 'arb', 40_000),
		edge(1, 6_000, 'p', 'b', 40_000),
		fault(2, 6_100, 'clock-step', { node: 'p', value: -90_000 }),
	];
	return {
		name: 'wall-clock-fence',
		family: 'clock-step',
		durationMs: 50_000,
		faults,
		expect: { failover: { after: 6_000, withinMs: 40_000 } },
		durability: 'sync',
		sync: ['b'],
		syncLoss: 'downgrade',
		writes: true,
	};
}

/** Name → scenario for the CLI's `--scenario`. */
export const FIXED_SCENARIOS: Record<string, () => Scenario> = {
	'sync-change-minimal': minimalSyncChange,
	'sync-change-after-barrier': syncChangeAfterBarrier,
	'sync-change-after-close': syncChangeAfterClose,
	'sync-change-fallback': syncChangeFallback,
	'sync-change-downgrade': syncChangeDowngrade,
	'sync-change-close-race': syncChangeCloseRace,
	'sync-control-loss': syncControlLoss,
	'sync-control-stale-reopen': syncControlStaleReopen,
	'sync-control-same-etag': syncControlSameEtage,
	'sync-control-transient': syncControlTransient,
	'sync-control-stale-sync': syncControlStaleSync,
	'control-outage-minimal': minimalControlOutage,
	'wall-clock-fence': wallClockFenceScenario,
};
