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
 * `sync-change`: the sync standby is lost and the primary switches the recorded set to a lagging
 * async replica; the primary is killed in the window between the two steps. This is the schedule
 * the counterexample lives in (W9-SPEC §5.1, §5.5).
 */
function syncChange(seed: number): Scenario {
	const { rng, finish } = base(seed, 'sync-change');
	const faults: Fault[] = [];
	let id = 0;
	const t = rng.int(5_000, 10_000);
	const lagUntil = t + rng.int(2_000, 5_000);
	const crashAt = t + rng.int(150, 1_900);
	faults.push(fault(id++, 0, 'lag', { target: 'a', durationMs: lagUntil }));
	faults.push(edge(id++, t, 'p', 'b', rng.int(40_000, 80_000)));
	faults.push(fault(id++, t + rng.int(10, 120), 'sync-change', { target: 'a' }));
	if (rng.chance(0.8)) faults.push(fault(id++, crashAt, 'kill-primary', { durationMs: 0 }));
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
				faults.push(fault(id++, 0, 'lag', { target: 'a', durationMs: t + 3_000 }));
				faults.push(edge(id++, t, 'p', 'b', 40_000));
				faults.push(fault(id++, t + 30, 'sync-change', { target: 'a' }));
				if (rng.chance(0.6)) faults.push(fault(id++, t + rng.int(150, 1_200), 'kill-primary', { durationMs: 0 }));
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
	mixed,
};

export function generateScenario(seed: number, family: Family): Scenario {
	return GENERATORS[family](seed);
}

/**
 * The fixed minimal schedule for the counterexample. Short enough to read: four faults, one
 * promotion, one missing acknowledged commit.
 */
export function minimalSyncChange(): Scenario {
	const faults: Fault[] = [
		fault(0, 0, 'lag', { target: 'a', durationMs: 3_000 }),
		edge(1, 1_500, 'p', 'b', 60_000),
		fault(2, 1_550, 'sync-change', { target: 'a' }),
		fault(3, 1_800, 'kill-primary', { durationMs: 0 }),
	];
	return {
		name: 'sync-change-minimal',
		family: 'sync-change',
		durationMs: 25_000,
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
	'control-outage-minimal': minimalControlOutage,
	'wall-clock-fence': wallClockFenceScenario,
};
