/**
 * Schedules for the W11 model: one generator per family in W11-SPEC §10/§11, plus the fixed
 * scenarios the report names.
 *
 * Everything is a pure function of (seed, family): a seed replays exactly. Faults are written as
 * data so a run can print the exact schedule it used.
 */
import { Rng } from '../rng.ts';
import { defaultPolicy } from './policy.ts';
import {
	type Durability,
	type Family,
	type Fault,
	type MemberId,
	type PolicyConfig,
	type RefusalReason,
	type Scenario,
} from './spec.ts';

const DURATION = 90_000;

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

interface FinishOptions {
	name?: string;
	durationMs?: number;
	durability?: Durability;
	sync?: MemberId[];
	syncLoss?: 'downgrade' | 'block';
	writes?: boolean;
	policy?: Partial<PolicyConfig>;
}

function base(seed: number, family: Family): { rng: Rng; finish: (faults: Fault[], expect: Scenario['expect'], options?: FinishOptions) => Scenario } {
	const rng = new Rng(seed, 41);
	return {
		rng,
		finish: (faults, expect, options = {}) => {
			const durability = options.durability ?? 'sync';
			const policy = defaultPolicy(durability);
			return {
				name: options.name ?? family,
				family,
				durationMs: options.durationMs ?? DURATION,
				faults,
				expect,
				durability,
				sync: durability === 'sync' ? (options.sync ?? ['b']) : [],
				syncLoss: options.syncLoss ?? 'downgrade',
				writes: options.writes ?? true,
				policy: { ...policy, ...options.policy },
			};
		},
	};
}

function simple(seed: number, name: string, family: Family, faults: Fault[], expect: Scenario['expect'], options: FinishOptions = {}): Scenario {
	const { finish } = base(seed, family);
	return finish(faults, expect, { name, ...options });
}

/** W11 §10: the primary's node is powered off. The canonical M4 fault. */
function powerOff(seed: number): Scenario {
	const { rng, finish } = base(seed, 'power-off');
	const t = rng.int(4_000, 12_000);
	const durability: Durability = rng.chance(0.6) ? 'sync' : 'async';
	return finish([fault(0, t, 'kill-primary')], { failover: { after: t, withinMs: 30_000 } }, { durability });
}

/** W11 §10: the primary process freezes; the lease expires by the arbiter's clock. */
function freeze(seed: number): Scenario {
	const { rng, finish } = base(seed, 'freeze');
	const t = rng.int(4_000, 12_000);
	const duration = rng.int(22_000, 50_000);
	const durability: Durability = rng.chance(0.6) ? 'sync' : 'async';
	return finish(
		[fault(0, t, 'freeze', { node: 'p', durationMs: duration })],
		{ failover: { after: t, withinMs: 30_000 } },
		{ durability, durationMs: Math.max(80_000, t + duration + 20_000) },
	);
}

/** W11 §10: the primary can still reach the arbiter, so it keeps renewing; no failover. */
function partitionArbiterOk(seed: number): Scenario {
	const { rng, finish } = base(seed, 'partition-arbiter-ok');
	const t = rng.int(4_000, 12_000);
	const duration = rng.int(20_000, 38_000);
	const faults = [
		edge(0, t, 'p', 'a', duration),
		edge(1, t, 'p', 'b', duration),
	];
	return finish(
		faults,
		{
			noPrimary: { from: t, to: t + duration },
			primaryStays: { node: 'p', from: t, to: t + duration },
			requireAcks: { from: t, to: t + duration - 1_000, min: 1 },
		},
		// async so the isolated primary can still acknowledge without its two replicas.
		{ durability: 'async', durationMs: Math.max(70_000, t + duration + 10_000) },
	);
}

/** W11 §10: the primary cannot reach the arbiter or the members; it fences and a replica promotes. */
function partitionIsolated(seed: number): Scenario {
	const { rng, finish } = base(seed, 'partition-isolated');
	const t = rng.int(4_000, 12_000);
	const duration = rng.int(25_000, 45_000);
	const durability: Durability = rng.chance(0.6) ? 'sync' : 'async';
	const faults = [
		edge(0, t, 'p', 'arb', duration),
		edge(1, t, 'p', 'a', duration),
		edge(2, t, 'p', 'b', duration),
	];
	return finish(faults, { failover: { after: t, withinMs: 30_000 } }, { durability });
}

/**
 * W11 §10: the arbiter is unreachable for everyone. Variant A keeps the primary through the H21
 * failsafe (every member answers); variant B also loses a member, so the primary fences, but no
 * promotion is possible while the arbiter is away.
 */
function arbiterOutage(seed: number): Scenario {
	const { rng, finish } = base(seed, 'arbiter-outage');
	const t = rng.int(6_000, 14_000);
	const duration = rng.int(15_000, 32_000);
	const durability: Durability = rng.chance(0.5) ? 'sync' : 'async';
	const faults = (['p', 'a', 'b'] as MemberId[]).map((member, i) => edge(i, t, member, 'arb', duration));
	const variantB = rng.chance(0.5);
	if (variantB) faults.push(edge(3, t, 'p', 'b', duration + rng.int(1_000, 6_000)));
	const expect: Scenario['expect'] = {
		noPrimary: { from: t, to: t + duration },
		// The arbiter is unreachable for every member, so §9's working-arbiter budget does not
		// apply; a post-outage recovery is measured by the liveness expectation, not the bound.
		ttf: false,
		...(variantB
			? {}
			: {
					primaryStays: { node: 'p', from: t, to: t + duration },
					requireAcks: { from: t, to: t + duration - 1_000, min: 1 },
				}),
	};
	return finish(faults, expect, {
		durability,
		durationMs: Math.max(75_000, t + duration + 20_000),
	});
}

/** W11 §10: two candidates. The CAS picks one; the loser re-follows. Async + acceptDataLoss. */
function twoCandidates(seed: number): Scenario {
	const { rng, finish } = base(seed, 'two-candidates');
	const t = rng.int(4_000, 12_000);
	const duration = rng.int(25_000, 42_000);
	const faults = [
		edge(0, t, 'p', 'arb', duration),
		edge(1, t, 'p', 'a', duration),
		edge(2, t, 'p', 'b', duration),
	];
	return finish(
		faults,
		{ failover: { after: t, withinMs: 30_000 } },
		{ durability: 'async', durationMs: Math.max(75_000, t + duration + 15_000) },
	);
}

/** W11 §10: a stale leader resumes after a successor promoted; it fences before serving. */
function staleLeader(seed: number): Scenario {
	const { rng, finish } = base(seed, 'stale-leader');
	const t = rng.int(4_000, 12_000);
	const duration = rng.int(25_000, 50_000);
	const durability: Durability = rng.chance(0.5) ? 'sync' : 'async';
	return finish(
		[fault(0, t, 'freeze', { node: 'p', durationMs: duration })],
		{ failover: { after: t, withinMs: 30_000 } },
		{ durability, durationMs: Math.max(85_000, t + duration + 20_000) },
	);
}

/** W11 §10: a wall-clock step is inert; with renewal loss it must not delay the fence past the TTL. */
function clockStep(seed: number): Scenario {
	const { rng, finish } = base(seed, 'clock-step');
	const t = rng.int(4_000, 12_000);
	const node = rng.pick(['p', 'a', 'b'] as const);
	const delta = (rng.chance(0.65) ? -1 : 1) * rng.int(30_000, 120_000);
	const durability: Durability = rng.chance(0.5) ? 'sync' : 'async';
	const faults = [fault(0, t, 'clock-step', { node, value: delta })];
	const isolates = rng.chance(0.55);
	const duration = rng.int(20_000, 35_000);
	if (isolates) {
		faults.push(edge(1, t, 'p', 'arb', duration));
		if (node !== 'b') faults.push(edge(2, t, 'p', 'b', duration));
		if (node !== 'a') faults.push(edge(3, t, 'p', 'a', duration));
		// The replica the primary can still reach answers its keep-alive and is the one the notice
		// must reach. Drop it sometimes to exercise the safer-but-slower path.
		if (node !== 'p' && rng.chance(0.3))
			faults.push(fault(4, 0, 'notice', { target: node, notice: 'drop', durationMs: 70_000 }));
	}
	return finish(
		faults,
		isolates ? { failover: { after: t, withinMs: 60_000 } } : {},
		{ durability },
	);
}

/**
 * W11 §10 last row: the sync set names a dead member. The Rev-1 transition handles it; automatic
 * promotion always follows the lease, not the setting. Variants:
 *   0: b dies, the primary transitions to a and closes {a}, then the primary dies -> a promotes.
 *   1: b dies, the primary dies before the transition closes -> a is not named; no promotion.
 *   2: b and the primary die together -> the lease still names b; a must not promote.
 *   3: async + acceptDataLoss, b and the primary die -> a promotes (an async failover).
 */
function syncNamedDead(seed: number): Scenario {
	const { rng, finish } = base(seed, 'sync-named-dead');
	const t = rng.int(5_000, 12_000);
	const variant = rng.int(0, 3);
	if (variant === 3)
		return finish(
			[fault(0, t, 'crash', { node: 'b' }), fault(1, t + 200, 'kill-primary')],
			{ failover: { after: t + 200, withinMs: 30_000 } },
			{ durability: 'async' },
		);
	if (variant === 0)
		return finish(
			[fault(0, t, 'crash', { node: 'b' }), fault(1, t + 10_000, 'kill-primary')],
			{ failover: { after: t + 10_000, withinMs: 30_000 } },
			{ durability: 'sync', sync: ['b'] },
		);
	if (variant === 1)
		return finish(
			[fault(0, t, 'crash', { node: 'b' }), fault(1, t + 1_000, 'kill-primary')],
			{ noPrimary: { from: t, to: 90_000 } },
			{ durability: 'sync', sync: ['b'] },
		);
	return finish(
		[fault(0, t, 'crash', { node: 'b' }), fault(1, t + 100, 'kill-primary')],
		{ noPrimary: { from: t, to: 90_000 } },
		{ durability: 'sync', sync: ['b'] },
	);
}

/**
 * W11 §4.4 and the H21 failsafe. A member answers the primary's keep-alive while its own stream is
 * down and it can reach the arbiter. It must not acquire within one TTL of its answer. Variant A:
 * every member keeps answering, so the primary keeps serving through the arbiter outage and no
 * failover happens at all. Variant B is the mixed fault: one other member is unreachable, so the
 * primary fences; the answering member must wait out its TTL. The bound is measured there.
 */
function failsafeKeepalive(seed: number): Scenario {
	const { rng, finish } = base(seed, 'failsafe-keepalive');
	const t = rng.int(4_000, 10_000);
	const duration = rng.int(35_000, 55_000);
	const mixed = rng.chance(0.35);
	if (!mixed)
		return finish(
			[edge(0, t, 'p', 'arb', duration), fault(1, t, 'lag', { target: 'a', durationMs: duration })],
			{
				noPrimary: { from: t, to: t + duration },
				primaryStays: { node: 'p', from: t, to: t + duration },
				requireAcks: { from: t, to: t + duration - 1_000, min: 1 },
				// The primary keeps serving through the failsafe; a post-outage fence is a
				// recovery, not a failover, so §9's clock (last renew) is not applicable.
				ttf: false,
			},
			{ durability: 'async', durationMs: Math.max(70_000, t + duration + 10_000) },
		);
	// Mixed: sync {a}; a is the eligible member and keeps answering the primary. b is unreachable,
	// so the primary's failsafe fails and it fences at the proof/TTL deadline. Revision 3's fence
	// notice should let a acquire at the expiry; a dropped notice falls back to the one-TTL block.
	const faults: Fault[] = [
		edge(0, t, 'p', 'arb', duration + 20_000),
		edge(1, t, 'p', 'b', duration + 20_000),
	];
	if (rng.chance(0.35))
		faults.push(fault(2, 0, 'notice', { target: 'a', notice: 'drop', durationMs: 90_000 }));
	return finish(
		faults,
		{ failover: { after: t, withinMs: 60_000 } },
		{ durability: 'sync', sync: ['a'], durationMs: Math.max(90_000, t + duration + 30_000) },
	);
}

/**
 * Revision 3: the canonical two-fault case with best-effort fence-notice delivery. The primary
 * loses the arbiter and `b`, so it fences at ~t+15..21 s. The eligible sync member `a` is
 * reachable and answers the keep-alive. The notice is delivered, dropped, delayed, duplicated,
 * stale or bad-epoch: the model judges the bound only when `a` holds a valid one, and records the
 * one-TTL slower path (with an alert) otherwise.
 */
function fenceNotice(seed: number): Scenario {
	const { rng, finish } = base(seed, 'fence-notice');
	const t = rng.int(4_000, 10_000);
	const faults: Fault[] = [
		edge(0, t, 'p', 'arb', 80_000),
		edge(1, t, 'p', 'b', 80_000),
	];
	const pick = rng.int(0, 99);
	const mode: 'delivered' | 'drop' | 'delay' | 'duplicate' | 'stale' | 'bad-epoch' =
		pick < 50
			? 'delivered'
			: pick < 65
				? 'drop'
				: pick < 75
					? 'delay'
					: pick < 85
						? 'duplicate'
						: pick < 92
							? 'stale'
							: 'bad-epoch';
	if (mode !== 'delivered')
		faults.push(
			fault(2, 0, 'notice', {
				target: 'a',
				notice: mode,
				durationMs: 90_000,
				value: mode === 'delay' ? rng.int(500, 8_000) : 500,
			}),
		);
	return finish(
		faults,
		{ failover: { after: t, withinMs: 70_000 } },
		{ durability: 'sync', sync: ['a'], durationMs: 100_000 },
	);
}

/** W11 §1.5 and I11: the control plane is down through a failover; traffic and promotion continue. */
function controlDown(seed: number): Scenario {
	const { rng, finish } = base(seed, 'control-down');
	const t = rng.int(5_000, 12_000);
	const kill = t + 3_000;
	const duration = rng.int(50_000, 100_000);
	const durability: Durability = rng.chance(0.6) ? 'sync' : 'async';
	return finish(
		[fault(0, t, 'control-down', { durationMs: duration }), fault(1, kill, 'kill-primary')],
		{
			failover: { after: kill, withinMs: 30_000 },
			requireAcks: { from: t, to: kill, min: 1 },
			controlDown: { from: t, to: t + duration, minAcks: 1, requirePromotion: true },
		},
		{ durability, durationMs: Math.max(95_000, t + duration + 10_000) },
	);
}

interface RefusalCase {
	reason: RefusalReason | null;
	durability: Durability;
	policy: Partial<PolicyConfig>;
}

const REFUSALS: RefusalCase[] = [
	{ reason: 'global-flag-off', durability: 'sync', policy: { globalFlag: false } },
	{ reason: 'durability-async-without-accept-data-loss', durability: 'async', policy: { acceptDataLoss: false } },
	{ reason: 'fewer-than-three-data-nodes', durability: 'sync', policy: { dataNodes: 2 } },
	{ reason: 'fewer-than-two-zones', durability: 'sync', policy: { zones: 1 } },
	{ reason: 'no-failover-drill', durability: 'sync', policy: { drill: 'none' } },
	{ reason: 'failover-drill-failed', durability: 'sync', policy: { drill: 'failed' } },
	{ reason: 'failover-drill-stale', durability: 'sync', policy: { drill: 'stale' } },
	{ reason: 'no-replica-on-another-online-node', durability: 'sync', policy: { replicaOnAnotherOnlineNode: false } },
	{ reason: 'active-switchover', durability: 'sync', policy: { switchoverActive: true } },
	{ reason: 'sync-transition', durability: 'sync', policy: { syncStepping: true } },
	{ reason: 'node-not-db-member', durability: 'sync', policy: { allDbMember: false } },
	{ reason: null, durability: 'sync', policy: { requested: 'manual' } },
];

/**
 * W11 §3: `auto` is refused and the database is manual only. A primary loss must not promote.
 * One case per refusal rule plus the default `manual` mode.
 */
function refusal(seed: number): Scenario {
	const { rng, finish } = base(seed, 'refusal');
	const chosen = rng.pick(REFUSALS);
	const t = rng.int(4_000, 12_000);
	const expect: Scenario['expect'] = { noPrimary: { from: t, to: 80_000 } };
	if (chosen.reason) expect.autoRefused = chosen.reason;
	return finish([fault(0, t, 'kill-primary')], expect, {
		durability: chosen.durability,
		policy: chosen.policy,
		durationMs: 80_000,
	});
}

/** `mixed`: 2-4 faults from the families above. Invariants always run; expectations stay light. */
function mixed(seed: number): Scenario {
	const { rng, finish } = base(seed, 'mixed');
	const faults: Fault[] = [];
	let id = 0;
	const count = rng.int(2, 4);
	const chosen = new Set<string>();
	const name = rng.pick(['renew', 'peer', 'arb', 'freeze', 'clock', 'sync', 'control'] as const);
	for (let i = 0; i < count; i++) {
		const pick = rng.pick(['renew', 'peer', 'arb', 'freeze', 'clock', 'sync', 'control'] as const);
		if (chosen.has(pick)) continue;
		chosen.add(pick);
		const t = rng.int(5_000, 45_000);
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
				const node = rng.pick(['p', 'a', 'b'] as const);
				faults.push(fault(id++, t, 'freeze', { node, durationMs: rng.int(15_000, 40_000) }));
				break;
			}
			case 'clock':
				faults.push(
					fault(id++, t, 'clock-step', {
						node: rng.pick(['p', 'a', 'b'] as const),
						value: (rng.chance(0.6) ? -1 : 1) * rng.int(30_000, 120_000),
					}),
				);
				break;
			case 'sync':
				faults.push(edge(id++, t, 'p', 'b', 40_000));
				if (rng.chance(0.4)) faults.push(fault(id++, t + 100, 'kill-primary'));
				break;
			case 'control':
				faults.push(fault(id++, t, 'control-down', { durationMs: rng.int(20_000, 50_000) }));
				break;
		}
	}
	void name;
	return finish(faults, { ttf: false }, { durability: rng.chance(0.5) ? 'sync' : 'async', durationMs: 100_000 });
}

const GENERATORS: Record<Family, (seed: number) => Scenario> = {
	'power-off': powerOff,
	freeze,
	'partition-arbiter-ok': partitionArbiterOk,
	'partition-isolated': partitionIsolated,
	'arbiter-outage': arbiterOutage,
	'two-candidates': twoCandidates,
	'stale-leader': staleLeader,
	'clock-step': clockStep,
	'sync-named-dead': syncNamedDead,
	'failsafe-keepalive': failsafeKeepalive,
	'control-down': controlDown,
	refusal,
	'fence-notice': fenceNotice,
	mixed,
};

export function generateScenario(seed: number, family: Family): Scenario {
	return GENERATORS[family](seed);
}

// ── fixed scenarios named in W11-MODEL.md ───────────────────────────────────

/** The canonical M4 schedule: sync, armed, the primary's node is powered off. */
export function powerOffSync(): Scenario {
	return simple(1, 'w11-power-off-sync', 'power-off', [fault(0, 8_000, 'kill-primary')], {
		failover: { after: 8_000, withinMs: 30_000 },
	});
}

/** The same with `async` + acceptDataLoss: one candidate wins, loss is explicit. */
export function powerOffAsync(): Scenario {
	return simple(1, 'w11-power-off-async', 'power-off', [fault(0, 8_000, 'kill-primary')], {
		failover: { after: 8_000, withinMs: 30_000 },
	}, { durability: 'async' });
}

/** Primary process freeze; the lease expires by the arbiter clock and a successor promotes. */
export function freezePrimary(): Scenario {
	return simple(1, 'w11-freeze', 'freeze', [fault(0, 8_000, 'freeze', { node: 'p', durationMs: 30_000 })], {
		failover: { after: 8_000, withinMs: 30_000 },
	});
}

/** The primary can still renew: no failover and traffic continues. */
export function partitionArbiterOkFixed(): Scenario {
	return simple(
		1,
		'w11-partition-arbiter-ok',
		'partition-arbiter-ok',
		[edge(0, 8_000, 'p', 'a', 30_000), edge(1, 8_000, 'p', 'b', 30_000)],
		{
			noPrimary: { from: 8_000, to: 38_000 },
			primaryStays: { node: 'p', from: 8_000, to: 38_000 },
			requireAcks: { from: 8_000, to: 37_000, min: 1 },
		},
		{ durability: 'async' },
	);
}

/** The primary cannot renew or reach the members: it fences, a replica promotes. */
export function partitionIsolatedFixed(): Scenario {
	return simple(
		1,
		'w11-partition-isolated',
		'partition-isolated',
		[
			edge(0, 8_000, 'p', 'arb', 35_000),
			edge(1, 8_000, 'p', 'a', 35_000),
			edge(2, 8_000, 'p', 'b', 35_000),
		],
		{ failover: { after: 8_000, withinMs: 30_000 } },
	);
}

/** Arbiter outage alone: no failover and no stop. */
export function arbiterAlone(): Scenario {
	return simple(
		1,
		'w11-arbiter-alone',
		'arbiter-outage',
		[
			edge(0, 8_000, 'p', 'arb', 25_000),
			edge(1, 8_000, 'a', 'arb', 25_000),
			edge(2, 8_000, 'b', 'arb', 25_000),
		],
		{
			noPrimary: { from: 8_000, to: 33_000 },
			primaryStays: { node: 'p', from: 8_000, to: 33_000 },
			requireAcks: { from: 8_000, to: 32_000, min: 1 },
			ttf: false,
		},
	);
}

/** Arbiter outage plus one unreachable member: the primary fences and no promotion is possible. */
export function arbiterPlusMember(): Scenario {
	return simple(
		1,
		'w11-arbiter-plus-member',
		'arbiter-outage',
		[
			edge(0, 8_000, 'p', 'arb', 25_000),
			edge(1, 8_000, 'a', 'arb', 25_000),
			edge(2, 8_000, 'b', 'arb', 25_000),
			edge(3, 8_000, 'p', 'b', 25_000),
		],
		{ noPrimary: { from: 8_000, to: 33_000 }, ttf: false },
	);
}

/** Two candidates race the CAS at generation+1. Exactly one can win. */
export function twoCandidatesFixed(): Scenario {
	return simple(
		1,
		'w11-two-candidates',
		'two-candidates',
		[
			edge(0, 8_000, 'p', 'arb', 30_000),
			edge(1, 8_000, 'p', 'a', 30_000),
			edge(2, 8_000, 'p', 'b', 30_000),
		],
		{ failover: { after: 8_000, withinMs: 30_000 } },
		{ durability: 'async' },
	);
}

/** A stale leader resumes after a successor promoted; it must fence. */
export function staleLeaderFixed(): Scenario {
	return simple(1, 'w11-stale-leader', 'stale-leader', [fault(0, 8_000, 'freeze', { node: 'p', durationMs: 30_000 })], {
		failover: { after: 8_000, withinMs: 30_000 },
	});
}

/** Sync names b; b and the primary die together, so a (unnamed) must not promote. */
export function syncNamedDeadRefused(): Scenario {
	return simple(
		1,
		'w11-sync-named-dead',
		'sync-named-dead',
		[fault(0, 8_000, 'crash', { node: 'b' }), fault(1, 8_100, 'kill-primary')],
		{ noPrimary: { from: 8_000, to: 60_000 } },
		{ durability: 'sync', sync: ['b'], durationMs: 60_000 },
	);
}

/** Sync names b; b dies, the primary closes a fresh set {a}, then the primary dies: a promotes. */
export function syncNamedDeadClosed(): Scenario {
	return simple(
		1,
		'w11-sync-named-dead-then-close',
		'sync-named-dead',
		[fault(0, 8_000, 'crash', { node: 'b' }), fault(1, 18_000, 'kill-primary')],
		{ failover: { after: 18_000, withinMs: 30_000 } },
		{ durability: 'sync', sync: ['b'] },
	);
}

/** `auto` is refused: no drill. Manual only. */
export function noDrillRefused(): Scenario {
	return simple(1, 'w11-no-drill', 'refusal', [fault(0, 8_000, 'kill-primary')], {
		noPrimary: { from: 8_000, to: 60_000 },
		autoRefused: 'no-failover-drill',
	}, { policy: { drill: 'none' }, durationMs: 60_000 });
}

/** `auto` is refused: two data nodes. Manual only. */
export function twoDataNodesRefused(): Scenario {
	return simple(1, 'w11-two-data-nodes', 'refusal', [fault(0, 8_000, 'kill-primary')], {
		noPrimary: { from: 8_000, to: 60_000 },
		autoRefused: 'fewer-than-three-data-nodes',
	}, { policy: { dataNodes: 2 }, durationMs: 60_000 });
}

/** `auto` is refused: async without acceptDataLoss. Manual only. */
export function asyncWithoutAcceptRefused(): Scenario {
	return simple(
		1,
		'w11-async-no-accept',
		'refusal',
		[fault(0, 8_000, 'kill-primary')],
		{ noPrimary: { from: 8_000, to: 60_000 }, autoRefused: 'durability-async-without-accept-data-loss' },
		{ durability: 'async', policy: { acceptDataLoss: false }, durationMs: 60_000 },
	);
}

/** The control plane is down through the failover. I11's positive case. */
export function controlDownFixed(): Scenario {
	return simple(
		1,
		'w11-control-down',
		'control-down',
		[fault(0, 6_000, 'control-down', { durationMs: 80_000 }), fault(1, 9_000, 'kill-primary')],
		{
			failover: { after: 9_000, withinMs: 30_000 },
			requireAcks: { from: 6_000, to: 9_000, min: 1 },
			controlDown: { from: 6_000, to: 86_000, minAcks: 1, requirePromotion: true },
		},
		{ durationMs: 90_000 },
	);
}

/** The clean H21 failsafe + keep-alive gate: no member may acquire, and the primary keeps serving. */
export function failsafeKeepaliveFixed(): Scenario {
	return simple(
		1,
		'w11-failsafe-keepalive',
		'failsafe-keepalive',
		[edge(0, 6_000, 'p', 'arb', 40_000), fault(1, 6_000, 'lag', { target: 'a', durationMs: 40_000 })],
		{
			noPrimary: { from: 6_000, to: 46_000 },
			primaryStays: { node: 'p', from: 6_000, to: 46_000 },
			requireAcks: { from: 6_000, to: 45_000, min: 1 },
		},
		{ durability: 'async', durationMs: 55_000 },
	);
}

/**
 * Revision 3's canonical two-fault case **with the fence notice delivered**:
 *   1. the primary cannot reach the arbiter, so its renewals fail;
 *   2. one other member (`b`) is unreachable, so the H21 failsafe fails and the primary fences at
 *      its one-TTL proof deadline.
 * The eligible member `a` is reachable from the primary and answers its keep-alive until the
 * fence. The notice is the §1.8 exception; `a` may acquire at lease expiry without the one-TTL
 * block. The model still applies the §4.1 stream-down debounce, so this schedule measures the
 * Rev-3 claim that the worst case stays within 30 s.
 */
export function failsafeMinimalBound(): Scenario {
	return simple(
		1,
		'w11-failsafe-minimal',
		'failsafe-keepalive',
		[edge(0, 6_000, 'p', 'arb', 70_000), edge(1, 6_000, 'p', 'b', 70_000)],
		{ failover: { after: 6_000, withinMs: 60_000 } },
		{ durability: 'sync', sync: ['a'], durationMs: 40_000 },
	);
}

/** Rev 3: the same two-fault case with the notice dropped. The one-TTL block must hold; the
 * slower path is reported and alerted, not counted as a bound violation. */
export function failsafeNoticeLost(): Scenario {
	return simple(
		1,
		'w11-failsafe-notice-lost',
		'fence-notice',
		[
			edge(0, 6_000, 'p', 'arb', 70_000),
			edge(1, 6_000, 'p', 'b', 70_000),
			fault(2, 0, 'notice', { target: 'a', notice: 'drop', durationMs: 60_000 }),
		],
		{ failover: { after: 6_000, withinMs: 60_000 } },
		{ durability: 'sync', sync: ['a'], durationMs: 60_000 },
	);
}

/** Rev 3: the notice is delayed past the fence; the member uses it if it arrives first. */
export function failsafeNoticeDelayed(): Scenario {
	return simple(
		1,
		'w11-failsafe-notice-delayed',
		'fence-notice',
		[
			edge(0, 6_000, 'p', 'arb', 70_000),
			edge(1, 6_000, 'p', 'b', 70_000),
			fault(2, 0, 'notice', { target: 'a', notice: 'delay', value: 5_000, durationMs: 60_000 }),
		],
		{ failover: { after: 6_000, withinMs: 60_000 } },
		{ durability: 'sync', sync: ['a'], durationMs: 60_000 },
	);
}

/** Rev 3: the notice is duplicated; the receiver is idempotent. */
export function failsafeNoticeDuplicated(): Scenario {
	return simple(
		1,
		'w11-failsafe-notice-duplicated',
		'fence-notice',
		[
			edge(0, 6_000, 'p', 'arb', 70_000),
			edge(1, 6_000, 'p', 'b', 70_000),
			fault(2, 0, 'notice', { target: 'a', notice: 'duplicate', value: 500, durationMs: 60_000 }),
		],
		{ failover: { after: 6_000, withinMs: 60_000 } },
		{ durability: 'sync', sync: ['a'], durationMs: 60_000 },
	);
}

/** Rev 3: a stale notice (previous generation) must not bypass the one-TTL block. */
export function failsafeNoticeStale(): Scenario {
	return simple(
		1,
		'w11-failsafe-notice-stale',
		'fence-notice',
		[
			edge(0, 6_000, 'p', 'arb', 70_000),
			edge(1, 6_000, 'p', 'b', 70_000),
			fault(2, 0, 'notice', { target: 'a', notice: 'stale', durationMs: 60_000 }),
		],
		{ failover: { after: 6_000, withinMs: 60_000 } },
		{ durability: 'sync', sync: ['a'], durationMs: 60_000 },
	);
}

/** A wall-clock step back while the primary loses its renewals; the monotonic machine fences. */
export function wallClockFence(): Scenario {
	return simple(
		1,
		'w11-wall-clock-fence',
		'clock-step',
		[
			edge(0, 6_000, 'p', 'arb', 30_000),
			edge(1, 6_000, 'p', 'a', 30_000),
			edge(2, 6_000, 'p', 'b', 30_000),
			fault(3, 6_100, 'clock-step', { node: 'p', value: -90_000 }),
		],
		{ failover: { after: 6_000, withinMs: 30_000 } },
		{ durability: 'async', durationMs: 50_000 },
	);
}

export const FIXED_SCENARIOS: Record<string, () => Scenario> = {
	'w11-power-off-sync': powerOffSync,
	'w11-power-off-async': powerOffAsync,
	'w11-freeze': freezePrimary,
	'w11-partition-arbiter-ok': partitionArbiterOkFixed,
	'w11-partition-isolated': partitionIsolatedFixed,
	'w11-arbiter-alone': arbiterAlone,
	'w11-arbiter-plus-member': arbiterPlusMember,
	'w11-two-candidates': twoCandidatesFixed,
	'w11-stale-leader': staleLeaderFixed,
	'w11-sync-named-dead': syncNamedDeadRefused,
	'w11-sync-named-dead-then-close': syncNamedDeadClosed,
	'w11-no-drill': noDrillRefused,
	'w11-two-data-nodes': twoDataNodesRefused,
	'w11-async-no-accept': asyncWithoutAcceptRefused,
	'w11-control-down': controlDownFixed,
	'w11-failsafe-keepalive': failsafeKeepaliveFixed,
	'w11-failsafe-minimal': failsafeMinimalBound,
	'w11-failsafe-notice-lost': failsafeNoticeLost,
	'w11-failsafe-notice-delayed': failsafeNoticeDelayed,
	'w11-failsafe-notice-duplicated': failsafeNoticeDuplicated,
	'w11-failsafe-notice-stale': failsafeNoticeStale,
	'w11-wall-clock-fence': wallClockFence,
};
