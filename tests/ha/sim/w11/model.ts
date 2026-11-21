/**
 * The W11 model: automatic database promotion and the W11 policy, written from
 * docs/build-plan/W11-SPEC.md alone (the production implementation of automatic failover was not
 * read). It extends the W9 member machine (W9-SPEC §5) with:
 *
 *   - the per-database arming policy (§3), evaluated as data by policy.ts and re-evaluated live;
 *   - the W11 candidate rule (§4): its own stream down for 5 s, the lease expired by the arbiter's
 *     clock, eligibility (I12), and no keep-alive answered within one TTL (the H21 failsafe);
 *   - the W11 promotion body (§5.1): the CAS is at generation+1 with `sync: []`,
 *     `syncState: 'changing'`, then `pg_ctl promote`, then the new primary re-arms a fresh sync set
 *     through the W9 Revision 1 transition;
 *   - the time-to-writable budget (§9) measured from the lost primary's last applied lease write.
 *
 * Time is a virtual millisecond counter. Every RPC crosses a directed reachability graph with a
 * drawn round-trip latency; the arbiter is a linearizable single-object store with conditional PUT.
 * The consumer is W11 §6: poll every 1-2 s, forward only to a primary at the highest generation,
 * fail closed. The control plane (§7) is a read-only reader with an availability flag; it never
 * decides and never writes a lease.
 *
 * The checker runs after every event:
 *   I3   no two members at `primary` at one generation; `strictOverlapMs` also measures two
 *        primaries at different generations.
 *   I12  a promotion happens only for a member named in the lease's sync set at the generation it
 *        acquired from, and only from a steady lease.
 *   I13  at every promotion from a lease whose effective durability is `sync`, and at the end of
 *        the run, the promoted member holds every acknowledged `sync` commit.
 *   I11  control-plane outages must not stop traffic or failover; the reader never lowers a
 *        generation; an arbiter outage alone must not fail over or stop a healthy primary.
 *   bound time-to-writable ≤ 30 s per loss from the last successful lease renew (median ≤ 25 s is
 *        reported by run.ts and asserted by the tests).
 */
import { Rng } from '../rng.ts';
import { evaluateArming, autoEnabledFor } from './policy.ts';
import {
	type ArmDecision,
	type DbLease,
	type Durability,
	type Fault,
	type MemberId,
	type Mutant,
	type Property,
	type RefusalReason,
	type RunResult,
	type RunStats,
	type Scenario,
	type TraceEvent,
	type Violation,
	type ViolationKind,
	SPEC,
} from './spec.ts';

export type DbState = 'streaming' | 'candidate' | 'promoting' | 'primary' | 'fencing' | 'fenced' | 'rewind';

interface Acquire {
	/** The lease read at the CAS. I12 and I13 are judged against this generation. */
	fromLease: DbLease;
	body: DbLease;
	gen: number;
	etag: string;
	sentAt: number;
	sentAtWall: number;
	appliedAt: number;
}

interface DbMember {
	id: MemberId;
	state: DbState;
	generation: number;
	history: Set<number>;
	alive: boolean;
	frozenUntil: number;
	wallOffset: number;
	lease: DbLease | null;
	leaseEtag: string | null;
	lastServerDate: number;
	serverAt: number;
	durability: Durability;
	durabilityEffective: Durability;
	streamFrom: MemberId | null;
	streamEpoch: number;
	replAt: Map<MemberId, number>;
	streamDownSince: number | null;
	/** Monotonic send time of the last confirmed renewal. */
	lastProof: number;
	lastProofWall: number;
	/** Arbiter apply time of the last successful lease write (renew or acquire). W11 §9's clock. */
	lastLeaseApply: number;
	lastRenewOk: boolean;
	lastRenewSent: number;
	lastKeepAlive: number;
	peerLastAnswer: Map<MemberId, number>;
	lastAnsweredToPrimary: number;
	effectiveSync: MemberId | null;
	changePhase: 'opening' | 'switching' | null;
	changeTarget: MemberId | null;
	changeOld: MemberId | null;
	changeOpenedAt: number;
	changeTimeoutAt: number;
	barrierId: number;
	barrierSnapshot: Set<number>;
	killAfterOpen: number | null;
	killAfterBarrier: boolean;
	syncLostSince: number;
	syncDowngradeAt: number;
	rewindAt: number;
	candidateBusy: boolean;
	acquire: Acquire | null;
	fenceTimer: number | null;
	/** The lost primary's baseline, set when it stops serving; consumed by the next promotion. */
	lostBaseline: number | null;
	promotedAt: number | null;
}

interface Commit {
	id: number;
	gen: number;
	acceptedBy: MemberId | null;
	durability: Durability;
	acked: boolean;
	ackAt: number | null;
	waitFor: MemberId | null;
	timedOut: boolean;
}

interface Write {
	id: number;
	commit: number;
	target: MemberId;
	sentAt: number;
	ackedAt: number | null;
	deliveredAt: number | null;
	timedOut: boolean;
}

interface Stored<T> {
	body: T;
	etag: string;
	appliedAt: number;
}

type ArbResult = { status: number; etag: string | null; date: number; body?: string; appliedAt?: number };

interface QueueItem {
	at: number;
	seq: number;
	fn: () => void;
}

const RPC_TIMEOUT_MS = 700;
const TRACE_RING = 400;

/** A binary min-heap on (at, seq); equal times run in insertion order. */
class EventQueue {
	#items: QueueItem[] = [];
	#seq = 0;

	push(at: number, fn: () => void): void {
		const item = { at, seq: this.#seq++, fn };
		const a = this.#items;
		a.push(item);
		let i = a.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (less(a[p] as QueueItem, item)) break;
			a[i] = a[p] as QueueItem;
			i = p;
		}
		a[i] = item;
	}

	pop(): QueueItem | undefined {
		const a = this.#items;
		const top = a[0];
		const last = a.pop();
		if (a.length > 0 && last) {
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				let best = last;
				if (l < a.length && less(a[l] as QueueItem, best)) {
					m = l;
					best = a[l] as QueueItem;
				}
				if (r < a.length && less(a[r] as QueueItem, best)) m = r;
				if (m === i) break;
				a[i] = a[m] as QueueItem;
				i = m;
			}
			a[i] = last;
		}
		return top;
	}

	get size(): number {
		return this.#items.length;
	}
}

function less(x: QueueItem, y: QueueItem): boolean {
	return x.at < y.at || (x.at === y.at && x.seq < y.seq);
}

export interface W11Options {
	seed: number;
	scenario: Scenario;
	mutant?: Mutant;
	trace?: boolean;
	verbose?: boolean;
}

export class W11World {
	readonly seed: number;
	readonly scenario: Scenario;
	readonly mutant: Mutant;
	readonly armDecision: ArmDecision;
	T = 0;
	events = 0;

	readonly db: DbMember[] = [];
	readonly violations: Violation[] = [];
	readonly stats: RunStats = {
		promotions: 0,
		acks: 0,
		writes: 0,
		rejectedWrites: 0,
		failClosedPolls: 0,
		strictOverlapMs: 0,
		primaryLosses: 0,
		fences: 0,
		syncChangesOpened: 0,
		syncChangesClosed: 0,
		syncChangesFellBack: 0,
		syncChangesDowngraded: 0,
		primaryKilledChanging: 0,
		candidateAttempts: 0,
		candidateLostCas: 0,
		controlDownPromotions: 0,
		controlDownAcks: 0,
		controlRowGeneration: 1,
		staleResumes: 0,
		asyncLostAcks: 0,
		ttfExempt: 0,
	};
	readonly failoverLatenciesMs: number[] = [];

	#queue = new EventQueue();
	#rng: Rng;
	#cancelled = new Set<number>();
	#timerId = 0;
	#trace: TraceEvent[] | null;
	#ring: TraceEvent[] = [];
	#verbose: boolean;

	#dbStore: Stored<DbLease>;
	#etag = 0;

	#edges = new Map<string, { mode: 'refuse' | 'drop' }[]>();
	#lagged = new Map<MemberId, number>();

	#syncLoss: 'downgrade' | 'block';

	#commits = new Map<number, Commit>();
	#acked = new Map<number, { gen: number; member: MemberId; t: number; durability: Durability }>();
	#missingAcksReported = new Set<number>();
	#writes: Write[] = [];
	#ackDeliveries: number[] = [];
	#nextCommit = 0;

	#control = { available: true, rowGeneration: 1 };
	#maxGenerationSeen = 1;
	#fenceEvents: { id: MemberId; t: number }[] = [];
	#failoverBaseline: { id: MemberId; baseline: number; at: number; cause: string } | null = null;

	#target: MemberId | null = null;
	#polling = false;
	#lastObserve = 0;
	#prevDbPrimaries = 0;

	#promotions: number[] = [];

	constructor(options: W11Options) {
		this.seed = options.seed;
		this.scenario = options.scenario;
		this.mutant = options.mutant ?? 'none';
		this.#rng = new Rng(options.seed, 31);
		this.#trace = options.trace ? [] : null;
		this.#verbose = options.verbose ?? false;
		this.#syncLoss = options.scenario.syncLoss;

		this.armDecision = evaluateArming({
			...options.scenario.policy,
			durability: options.scenario.durability,
		});

		const durability = options.scenario.durability;
		const sync = durability === 'sync' ? options.scenario.sync : [];
		const initial: DbLease = {
			generation: 1,
			holderNodeId: 'p',
			expiresAt: SPEC.db.ttlMs,
			sync,
			syncState: 'steady',
			durability,
			durabilityEffective: durability,
			syncSetAt: 0,
		};
		this.#dbStore = { body: initial, etag: this.#nextEtag(), appliedAt: 0 };

		for (const id of ['p', 'a', 'b'] as MemberId[]) {
			const member: DbMember = {
				id,
				state: id === 'p' ? 'primary' : 'streaming',
				generation: 1,
				history: new Set(),
				alive: true,
				frozenUntil: 0,
				wallOffset: 0,
				lease: initial,
				leaseEtag: this.#dbStore.etag,
				lastServerDate: 0,
				serverAt: 0,
				durability,
				durabilityEffective: durability,
				streamFrom: id === 'p' ? null : 'p',
				streamEpoch: 0,
				replAt: new Map<MemberId, number>(),
				streamDownSince: null,
				lastProof: 0,
				lastProofWall: 0,
				lastLeaseApply: 0,
				lastRenewOk: true,
				lastRenewSent: 0,
				lastKeepAlive: 0,
				peerLastAnswer: new Map<MemberId, number>([
					['p', 0],
					['a', 0],
					['b', 0],
				]),
				lastAnsweredToPrimary: 0,
				effectiveSync: id === 'p' ? (sync[0] ?? null) : null,
				changePhase: null,
				changeTarget: null,
				changeOld: null,
				changeOpenedAt: 0,
				changeTimeoutAt: 0,
				barrierId: 0,
				barrierSnapshot: new Set<number>(),
				killAfterOpen: null,
				killAfterBarrier: false,
				syncLostSince: 0,
				syncDowngradeAt: 0,
				rewindAt: 0,
				candidateBusy: false,
				acquire: null,
				fenceTimer: null,
				lostBaseline: null,
				promotedAt: null,
			};
			this.db.push(member);
		}
	}

	// ── plumbing ────────────────────────────────────────────────────────────

	#nextEtag(): string {
		return `"e${++this.#etag}"`;
	}

	#timer(at: number, fn: () => void): number {
		const id = ++this.#timerId;
		this.#queue.push(at, () => {
			if (!this.#cancelled.has(id)) fn();
		});
		return id;
	}

	#cancel(id: number | null): void {
		if (id !== null) this.#cancelled.add(id);
	}

	#log(actor: string, text: string): void {
		const line = { t: this.T, actor, text };
		this.#ring.push(line);
		if (this.#ring.length > TRACE_RING) this.#ring.shift();
		this.#trace?.push(line);
	}

	#violate(property: Property, kind: ViolationKind, message: string): void {
		if (this.violations.length >= 100) return;
		this.violations.push({ property, kind, t: this.T, message });
		if (this.#trace === null) this.#trace = [...this.#ring];
		this.#log('!', `VIOLATION ${property}/${kind}: ${message}`);
	}

	#member(id: string): DbMember {
		const member = this.db.find((m) => m.id === id);
		if (!member) throw new Error(`unknown member ${id}`);
		return member;
	}

	#isAlive(id: string): boolean {
		if (id === 'arb' || id === 'consumer') return true;
		return this.db.find((m) => m.id === id)?.alive ?? false;
	}

	#frozenUntil(id: string): number {
		return this.db.find((m) => m.id === id)?.frozenUntil ?? 0;
	}

	/** The node's best estimate of the arbiter's clock: last server Date plus elapsed monotonic. */
	#serverNow(id: string): number {
		const member = this.db.find((m) => m.id === id);
		if (member) return member.lastServerDate + (this.T - member.serverAt);
		return this.T;
	}

	#wall(id: string): number {
		const member = this.db.find((m) => m.id === id);
		if (member) return this.T + member.wallOffset;
		return this.T;
	}

	#edge(from: string, to: string): 'up' | 'refuse' | 'drop' {
		const faults = this.#edges.get(`${from}|${to}`);
		if (!faults || faults.length === 0) return 'up';
		if (faults.some((f) => f.mode === 'drop')) return 'drop';
		return 'refuse';
	}

	#leg(from: string, to: string): number {
		const slow = this.#edges.get(`${from}|${to}`)?.some((f) => f.mode === 'refuse');
		if (slow) return this.#rng.int(200, 1500);
		return this.#rng.int(5, 120);
	}

	/**
	 * One RPC. The request crosses `from→to`, `serve` runs at arrival (linearization point), the
	 * response crosses `to→from`. A lost response still applied the write.
	 */
	#call<T>(from: string, to: string, serve: () => T, cb: (err: string | null, result?: T) => void): void {
		const fail = (why: string, delay: number) => {
			this.#timer(this.T + delay, () => cb(why));
		};
		if (!this.#isAlive(from) || !this.#isAlive(to)) return fail('down', 5);
		if (this.T < this.#frozenUntil(from) || this.T < this.#frozenUntil(to))
			return fail('frozen', RPC_TIMEOUT_MS);
		const request = this.#edge(from, to);
		if (request === 'refuse') return fail('refused', this.#rng.int(2, 15));
		if (request === 'drop') return fail('timeout', RPC_TIMEOUT_MS);
		const out = this.#leg(from, to);
		this.#timer(this.T + out, () => {
			if (!this.#isAlive(from) || !this.#isAlive(to)) return cb('down');
			if (this.T < this.#frozenUntil(from) || this.T < this.#frozenUntil(to)) return cb('frozen');
			if (this.#edge(from, to) !== 'up') return cb('partitioned');
			let result: T;
			try {
				result = serve();
			} catch (error) {
				cb(`serve failed: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			const back = this.#leg(to, from);
			this.#timer(this.T + back, () => {
				if (this.T < this.#frozenUntil(from) || !this.#isAlive(from)) return cb('frozen');
				if (this.#edge(to, from) !== 'up') return cb('response lost');
				cb(null, result);
			});
		});
	}

	// ── the arbiter ─────────────────────────────────────────────────────────

	#arbReadDb(
		from: string,
		cb: (err: string | null, lease?: DbLease, etag?: string, date?: number, appliedAt?: number) => void,
	): void {
		this.#call(
			from,
			'arb',
			(): ArbResult => {
				const current = this.#dbStore;
				return {
					status: 200,
					etag: current.etag,
					date: this.T,
					body: JSON.stringify(current.body),
					appliedAt: current.appliedAt,
				};
			},
			(err, result) => {
				if (err || !result) return cb(err ?? 'no result');
				if (result.status !== 200 || !result.body) return cb(`status ${result.status}`);
				cb(null, JSON.parse(result.body) as DbLease, result.etag ?? undefined, result.date, result.appliedAt);
			},
		);
	}

	#arbWriteDb(
		from: string,
		condition: { ifMatch: string } | { ifNoneMatch: true },
		body: DbLease,
		cb: (err: string | null, result?: ArbResult) => void,
		onApplied?: (appliedAt: number) => void,
	): void {
		this.#call(
			from,
			'arb',
			(): ArbResult => {
				const current = this.#dbStore;
				const matches = 'ifNoneMatch' in condition ? false : current.etag === condition.ifMatch;
				if (!matches) return { status: 412, etag: current.etag, date: this.T };
				if (this.mutant === 'cas-second-holder' && body.generation === current.body.generation) {
					// The deliberately broken arbiter accepts a second holder at one generation.
					current.body = body;
					current.etag = this.#nextEtag();
					current.appliedAt = this.T;
					onApplied?.(this.T);
					return { status: 200, etag: current.etag, date: this.T };
				}
				if (body.generation < current.body.generation)
					this.#violate(
						'support',
						'lease-generation-decreased',
						`generation fell ${current.body.generation}→${body.generation}`,
					);
				else if (body.generation === current.body.generation && body.holderNodeId !== current.body.holderNodeId)
					this.#violate(
						'support',
						'lease-holder-change-not-plus-one',
						`holder changed ${current.body.holderNodeId}→${body.holderNodeId} at generation ${body.generation}`,
					);
				else if (body.generation > current.body.generation + 1)
					this.#violate(
						'support',
						'lease-holder-change-not-plus-one',
						`generation jumped ${current.body.generation}→${body.generation}`,
					);
				const stored = { body, etag: this.#nextEtag(), appliedAt: this.T };
				this.#dbStore = stored;
				onApplied?.(this.T);
				return { status: 200, etag: stored.etag, date: this.T };
			},
			cb,
		);
	}

	// ── run ─────────────────────────────────────────────────────────────────

	run(): RunResult {
		for (const fault of [...this.scenario.faults].sort((a, b) => a.at - b.at || a.id - b.id))
			this.#timer(fault.at, () => this.#applyFault(fault));
		for (const member of this.db) this.#timer(this.T + this.#rng.int(0, 400), () => this.#dbTick(member));
		if (this.scenario.writes !== false) {
			this.#timer(this.T + 1000, () => this.#consumerPoll());
			this.#timer(this.T + 1200, () => this.#consumerWriteTick());
		}

		while (this.#queue.size > 0) {
			const item = this.#queue.pop() as QueueItem;
			if (item.at > this.scenario.durationMs) break;
			this.T = item.at;
			this.events++;
			if (this.events > 2_000_000) throw new Error(`w11 model: event cap at T=${this.T}`);
			item.fn();
			this.#observe();
			if (this.violations.length >= 100) break;
		}
		this.T = Math.min(this.T, this.scenario.durationMs);
		this.#finalize();

		return {
			seed: this.seed,
			family: this.scenario.family,
			scenario: this.scenario.name,
			violations: this.violations,
			stats: this.stats,
			failoverLatenciesMs: this.failoverLatenciesMs,
			trace: this.#trace ?? [],
			events: this.events,
			durationMs: this.T,
		};
	}

	#observe(): void {
		const elapsed = this.T - this.#lastObserve;
		this.#lastObserve = this.T;

		const primaries = this.db.filter((m) => m.state === 'primary');
		const serving = primaries.filter((m) => m.alive && this.T >= m.frozenUntil);
		const byGen = new Map<number, DbMember[]>();
		for (const m of primaries) byGen.set(m.generation, [...(byGen.get(m.generation) ?? []), m]);
		for (const [gen, members] of byGen) {
			if (members.length > 1)
				this.#violate(
					'I3',
					'two-primary-same-generation',
					`${members.map((m) => m.id).join(' and ')} are primary at generation ${gen}`,
				);
		}
		if (this.#prevDbPrimaries >= 2) this.stats.strictOverlapMs += elapsed;
		this.#prevDbPrimaries = serving.length;
	}

	#finalize(): void {
		// I13 at rest: the primary the run ends with holds every acknowledged `sync` commit.
		const finalPrimary = this.#highestPrimary();
		if (finalPrimary && (finalPrimary.lease?.durabilityEffective ?? 'sync') === 'sync') {
			for (const [id, ack] of this.#acked) {
				if (ack.durability !== 'sync') continue;
				if (this.#missingAcksReported.has(id)) continue;
				if (!finalPrimary.history.has(id))
					this.#violate(
						'I13',
						'end-primary-missing-ack',
						`${finalPrimary.id} is primary at generation ${finalPrimary.generation} but is missing acknowledged commit #${id} (acked by ${ack.member} at generation ${ack.gen})`,
					);
			}
		}

		// W11's async promise is weaker: report (do not fail) acknowledged async commits the final
		// primary does not have. The spec accepts this RPO when `acceptDataLoss` is set.
		if (finalPrimary) {
			for (const [id, ack] of this.#acked) {
				if (ack.durability !== 'async') continue;
				if (!finalPrimary.history.has(id)) this.stats.asyncLostAcks++;
			}
		}

		const expect = this.scenario.expect;
		if (expect.failover) {
			const promotion = this.#firstPromotionAfter(expect.failover.after);
			if (promotion === null) {
				this.#violate(
					'I11',
					'no-promotion-when-expected',
					`no database promotion after ${(expect.failover.after / 1000).toFixed(1)} s (limit ${(expect.failover.withinMs / 1000).toFixed(0)} s)`,
				);
			} else {
				const latency = promotion - expect.failover.after;
				if (latency > expect.failover.withinMs)
					this.#violate(
						'I11',
						'no-promotion-when-expected',
						`failover took ${(latency / 1000).toFixed(1)} s from the loss (limit ${(expect.failover.withinMs / 1000).toFixed(0)} s)`,
					);
			}
		}
		if (expect.noPrimary) {
			const inWindow = this.#promotions.filter((t) => t >= expect.noPrimary!.from && t <= expect.noPrimary!.to);
			if (inWindow.length > 0)
				this.#violate(
					'I11',
					'promotion-when-forbidden',
					`a database promotion completed at ${(inWindow[0]! / 1000).toFixed(1)} s inside a forbidden window`,
				);
		}
		if (expect.primaryStays) {
			const fenced = this.#fenceEvents.filter(
				(f) =>
					f.id === expect.primaryStays!.node &&
					f.t >= expect.primaryStays!.from &&
					f.t <= expect.primaryStays!.to,
			);
			if (fenced.length > 0)
				this.#violate(
					'I11',
					'primary-fenced-unexpectedly',
					`${expect.primaryStays.node} fenced at ${(fenced[0]!.t / 1000).toFixed(1)} s inside a window where it must keep serving`,
				);
		}
		if (expect.requireAcks) {
			const count = this.#ackDeliveries.filter(
				(t) => t >= expect.requireAcks!.from && t <= expect.requireAcks!.to,
			).length;
			if (count < expect.requireAcks.min)
				this.#violate(
					'I11',
					'no-traffic-during-outage',
					`${count} acknowledged writes in the outage window (need ${expect.requireAcks.min})`,
				);
		}
		if (expect.controlDown) {
			const window = expect.controlDown;
			const acks = this.#ackDeliveries.filter((t) => t >= window.from && t <= window.to).length;
			if (window.minAcks !== undefined && acks < window.minAcks)
				this.#violate(
					'I11',
					'no-traffic-during-outage',
					`${acks} acknowledged writes inside the control-plane outage (need ${window.minAcks})`,
				);
			if (window.requirePromotion) {
				const promoted = this.#promotions.filter((t) => t >= window.from && t <= window.to);
				if (promoted.length === 0)
					this.#violate(
						'I11',
						'no-promotion-when-expected',
						'no database promotion completed while the control plane was down',
					);
			}
		}
		if (expect.autoRefused) {
			if (this.armDecision.refusals.includes(expect.autoRefused) === false)
				this.#violate(
					'policy',
					'promotion-not-armed',
					`the policy did not refuse auto for ${expect.autoRefused}; it refused [${this.armDecision.refusals.join(', ')}]`,
				);
			if (this.#promotions.length > 0)
				this.#violate(
					'policy',
					'promotion-when-forbidden',
					`${this.#promotions.length} automatic promotion(s) although auto was refused for ${expect.autoRefused}`,
				);
		}

		this.stats.controlRowGeneration = this.#control.rowGeneration;
	}

	#firstPromotionAfter(t: number): number | null {
		return this.#promotions.find((p) => p > t) ?? null;
	}

	#highestPrimary(): DbMember | null {
		let best: DbMember | null = null;
		for (const m of this.db) if (m.state === 'primary' && (!best || m.generation > best.generation)) best = m;
		return best;
	}

	// ── faults ──────────────────────────────────────────────────────────────

	#applyFault(fault: Fault): void {
		const until = fault.at + (fault.durationMs ?? 0);
		switch (fault.kind) {
			case 'edge-down': {
				const entry = { mode: fault.mode ?? 'drop' } as const;
				const add = (from: string, to: string) => {
					const key = `${from}|${to}`;
					const list = this.#edges.get(key) ?? [];
					list.push(entry);
					this.#edges.set(key, list);
					this.#log('net', `${from}↛${to} (${entry.mode}, fault #${fault.id})`);
				};
				add(fault.from as string, fault.to as string);
				if (fault.symmetric) add(fault.to as string, fault.from as string);
				if (fault.durationMs)
					this.#timer(until, () => {
						for (const [key, list] of this.#edges) {
							const i = list.indexOf(entry);
							if (i >= 0) list.splice(i, 1);
							if (list.length === 0) this.#edges.delete(key);
						}
						this.#log('net', `${fault.from}↔${fault.to} restored (fault #${fault.id})`);
					});
				break;
			}
			case 'freeze': {
				const member = this.db.find((m) => m.id === fault.node);
				if (!member || !member.alive) break;
				if (member.state === 'primary') this.#markLost(member, 'freeze');
				member.frozenUntil = Math.max(member.frozenUntil, until);
				this.#log(fault.node as string, `frozen for ${((fault.durationMs ?? 0) / 1000).toFixed(1)} s (fault #${fault.id})`);
				this.#timer(until, () => this.#onResume(fault.node as string));
				break;
			}
			case 'crash':
				this.#crash(fault.node as string, fault.durationMs ?? 0);
				this.#log(fault.node as string, `process stopped (fault #${fault.id})`);
				break;
			case 'kill-primary': {
				const primary = this.#highestPrimary();
				if (!primary) break;
				this.#crash(primary.id, fault.durationMs ?? 0);
				this.#log(primary.id, `primary killed (fault #${fault.id})`);
				break;
			}
			case 'clock-step': {
				const member = this.db.find((m) => m.id === fault.node);
				if (!member) break;
				member.wallOffset += fault.value ?? 0;
				this.#log(
					fault.node as string,
					`wall clock stepped ${(fault.value ?? 0) > 0 ? '+' : ''}${((fault.value ?? 0) / 1000).toFixed(1)} s (fault #${fault.id})`,
				);
				break;
			}
			case 'sync-change': {
				const primary = this.#highestPrimary();
				if (primary) this.#openSyncChange(primary, fault.target as MemberId);
				break;
			}
			case 'kill-after-open': {
				const primary = this.#highestPrimary();
				if (primary) primary.killAfterOpen = fault.value ?? 0;
				break;
			}
			case 'kill-after-barrier': {
				const primary = this.#highestPrimary();
				if (primary) primary.killAfterBarrier = true;
				break;
			}
			case 'lag':
				this.#lagged.set(fault.target as MemberId, until);
				this.#log('wal', `replication to ${fault.target} dropped until ${(until / 1000).toFixed(1)} s (fault #${fault.id})`);
				break;
			case 'control-down': {
				const end = this.T + (fault.durationMs ?? 0);
				this.#control.available = false;
				this.#log('control', `control plane unreachable for ${((fault.durationMs ?? 0) / 1000).toFixed(1)} s (fault #${fault.id})`);
				this.#timer(end, () => {
					this.#control.available = true;
					this.#log('control', 'control plane returned; reconciling from reports and the lease');
					this.#controlReconcile();
				});
				break;
			}
		}
	}

	#markLost(member: DbMember, cause: string): void {
		if (member.state !== 'primary') return;
		if (member.lostBaseline !== null) return;
		member.lostBaseline = member.lastLeaseApply;
		this.#failoverBaseline = { id: member.id, baseline: member.lastLeaseApply, at: this.T, cause };
		this.stats.primaryLosses++;
		this.#log(member.id, `stopped serving (${cause}); time-to-writable clock starts at ${(member.lastLeaseApply / 1000).toFixed(3)} s`);
	}

	#crash(id: string, durationMs: number): void {
		const member = this.db.find((m) => m.id === id);
		if (!member) return;
		if (member.state === 'primary') {
			this.#markLost(member, 'crash');
			if (member.changePhase !== null) this.stats.primaryKilledChanging++;
		}
		member.alive = false;
		if (member.state === 'primary') member.state = 'fencing';
		member.streamFrom = null;
		member.effectiveSync = null;
		member.changePhase = null;
		member.changeTarget = null;
		member.changeOld = null;
		member.barrierSnapshot.clear();
		member.killAfterOpen = null;
		member.killAfterBarrier = false;
		member.acquire = null;
		this.#cancel(member.fenceTimer);
		if (durationMs > 0)
			this.#timer(this.T + durationMs, () => {
				member.alive = true;
				member.state = 'fenced';
				member.frozenUntil = 0;
				member.lastKeepAlive = this.T;
				member.rewindAt = 0;
				for (const peer of ['p', 'a', 'b'] as MemberId[]) member.peerLastAnswer.set(peer, this.T);
				this.#log(member.id, 'process restarted; role fenced');
				this.#timer(this.T + 200, () => this.#dbTick(member));
			});
	}

	#onResume(id: string): void {
		const member = this.db.find((m) => m.id === id);
		if (!member) return;
		if (this.T < member.frozenUntil) return;
		this.#log(member.id, `resumed (${member.state})`);
		if (member.state === 'primary' && !this.#primaryProvable(member)) {
			this.stats.staleResumes++;
			this.#log(member.id, 'resume found the lease unprovable; fencing before serving');
			this.#markLost(member, 'resume after the lease expired');
			this.#fence(member, 'resume after the lease expired');
		}
	}

	// ── the control-plane reader (W11-SPEC §7) ──────────────────────────────

	#controlReconcile(): void {
		const observed = Math.max(this.#maxGenerationSeen, ...this.db.map((m) => m.generation));
		if (observed < this.#control.rowGeneration)
			this.#violate(
				'I11',
				'control-reader-lowered-generation',
				`reader would lower the database row's generation ${this.#control.rowGeneration}→${observed}`,
			);
		const next = Math.max(this.#control.rowGeneration, observed);
		this.#control.rowGeneration = next;
		this.#log('control', `reconciled the database row to generation ${next}; it is never lowered`);
	}

	// ── the database member machine (W9-SPEC §5, W11-SPEC §4-§5) ────────────

	#dbTick(member: DbMember): void {
		if (!member.alive) return;
		if (this.T < member.frozenUntil) {
			this.#timer(member.frozenUntil, () => this.#dbTick(member));
			return;
		}
		if (this.T - member.lastKeepAlive >= SPEC.keepAliveMs) {
			member.lastKeepAlive = this.T;
			for (const peer of this.db) if (peer.id !== member.id) this.#sendKeepAlive(member, peer);
		}
		switch (member.state) {
			case 'primary':
				this.#primaryTick(member);
				break;
			case 'streaming':
				this.#replicaTick(member);
				break;
			case 'fenced':
				this.#fencedTick(member);
				break;
			case 'promoting':
			case 'candidate':
			case 'fencing':
			case 'rewind':
				break;
		}
		this.#timer(this.T + 1000 + this.#rng.int(0, 300), () => this.#dbTick(member));
	}

	#sendKeepAlive(from: DbMember, to: DbMember): void {
		this.#call(
			from.id,
			to.id,
			() => {
				if (from.state === 'primary') to.lastAnsweredToPrimary = this.T;
				return true;
			},
			(err) => {
				if (!err) from.peerLastAnswer.set(to.id, this.T);
			},
		);
	}

	/**
	 * W9-SPEC §5.3 / W11-SPEC §4.4. A primary may serve while it can prove the lease, OR while the
	 * arbiter is unreachable AND every member answered a keep-alive within one TTL (the H21
	 * failsafe). This is the one place the failsafe changes "stop within one TTL".
	 */
	#primaryProvable(member: DbMember): boolean {
		if (member.state !== 'primary') return false;
		const ttl = SPEC.db.ttlMs;
		if (this.mutant === 'fence-wall-clock') {
			if (this.#wall(member.id) - member.lastProofWall < ttl) return true;
		} else if (this.T - member.lastProof < ttl) return true;
		return this.#failsafeHolds(member, ttl);
	}

	#failsafeHolds(member: DbMember, ttl: number): boolean {
		if (member.lastRenewOk) return false;
		for (const peer of this.db) {
			if (peer.id === member.id) continue;
			const answered = member.peerLastAnswer.get(peer.id) ?? Number.NEGATIVE_INFINITY;
			if (this.T - answered >= ttl) return false;
		}
		return true;
	}

	#primaryTick(member: DbMember): void {
		if (!this.#primaryProvable(member)) {
			this.#fence(member, 'cannot prove the lease');
			return;
		}
		if (member.changePhase === null) {
			this.#maybeStartSyncChange(member);
		} else if (member.changePhase === 'switching') {
			if (this.#barrierHolds(member)) {
				if (member.killAfterBarrier) {
					member.killAfterBarrier = false;
					this.#log(member.id, 'barrier acknowledged; schedule kills the new primary before the close');
					this.#crash(member.id, 0);
					return;
				}
				this.#closeSyncChange(member, member.changeTarget);
			} else if (this.T >= member.changeTimeoutAt) {
				this.#timeoutSyncChange(member);
			}
		}
		if (member.changePhase === null && member.syncDowngradeAt !== 0 && this.T >= member.syncDowngradeAt)
			this.#downgrade(member);
		if (this.T - member.lastRenewSent >= SPEC.db.renewMs) this.#renewDb(member);
	}

	#streamDown(primary: DbMember, peerId: MemberId): boolean {
		const peer = this.#member(peerId);
		if (!peer.alive || this.T < peer.frozenUntil) return true;
		if (peer.streamFrom !== primary.id) return true;
		if (peer.state !== 'streaming' && peer.state !== 'rewind') return true;
		if (this.#edge(primary.id, peer.id) !== 'up') return true;
		if (this.T < (this.#lagged.get(peer.id) ?? 0)) return true;
		return false;
	}

	#pickSyncTarget(primary: DbMember): DbMember | null {
		for (const peer of this.db) {
			if (peer.id === primary.id) continue;
			if (!peer.alive || this.T < peer.frozenUntil) continue;
			if (peer.state !== 'streaming' || peer.streamFrom !== primary.id) continue;
			if (this.#edge(primary.id, peer.id) !== 'up') continue;
			return peer;
		}
		return null;
	}

	/** W9-SPEC §5.5: open the transition (`sync: []`, `changing`) before touching the setting. */
	#openSyncChange(member: DbMember, target: MemberId): void {
		if (member.state !== 'primary' || !member.leaseEtag) return;
		if (member.changePhase !== null) return;
		if ((member.lease?.syncState ?? 'steady') !== 'steady') return;
		const old = member.effectiveSync;
		const body: DbLease = {
			generation: member.generation,
			holderNodeId: member.id,
			expiresAt: this.#serverNow(member.id) + SPEC.db.ttlMs,
			sync: [],
			syncState: 'changing',
			durability: member.lease?.durability ?? 'sync',
			durabilityEffective: member.lease?.durabilityEffective ?? 'sync',
			syncSetAt: this.T,
		};
		this.#arbWriteDb(
			member.id,
			{ ifMatch: member.leaseEtag },
			body,
			(err, result) => {
				if (!member.alive || member.state !== 'primary') return;
				if (err || !result || result.status !== 200) {
					this.#log(member.id, `open sync change failed (${err ?? result?.status ?? 'no answer'}); re-reading`);
					this.#rereadDb(member, 'open sync change');
					return;
				}
				member.lease = body;
				member.leaseEtag = result.etag;
				member.lastServerDate = result.date;
				member.serverAt = this.T;
				member.changePhase = 'opening';
				member.changeTarget = target;
				member.changeOld = old;
				member.changeOpenedAt = this.T;
				member.changeTimeoutAt = this.T + SPEC.syncChangeTimeoutMs;
				member.barrierId = 0;
				member.barrierSnapshot = new Set<number>();
				member.syncDowngradeAt = 0;
				member.syncLostSince = 0;
				this.stats.syncChangesOpened++;
				this.#log(member.id, `open: sync [], syncState changing (target ${target})`);
				if (member.killAfterOpen !== null) {
					const delay = Math.max(1, member.killAfterOpen);
					member.killAfterOpen = null;
					this.#timer(this.T + delay, () => {
						if (!member.alive || member.state !== 'primary') return;
						this.#log(member.id, 'schedule kills the primary inside the open transition');
						this.#crash(member.id, 0);
					});
				}
				this.#startSwitching(member);
			},
			(appliedAt) => {
				if (member.state === 'primary') member.lastLeaseApply = appliedAt;
			},
		);
	}

	#startSwitching(member: DbMember): void {
		if (member.state !== 'primary' || member.changePhase !== 'opening') return;
		const target = member.changeTarget;
		if (!target) {
			this.#timeoutSyncChange(member);
			return;
		}
		member.changePhase = 'switching';
		member.effectiveSync = target;
		const id = ++this.#nextCommit;
		const barrier: Commit = {
			id,
			gen: member.generation,
			acceptedBy: member.id,
			durability: 'sync',
			acked: true,
			ackAt: this.T,
			waitFor: null,
			timedOut: false,
		};
		member.history.add(id);
		this.#commits.set(id, barrier);
		member.barrierId = id;
		member.barrierSnapshot = new Set(member.history);
		this.#replicate(member, barrier);
		this.#log(member.id, `switch: synchronous_standby_names = ${target}; barrier #${id}`);
	}

	#barrierHolds(member: DbMember): boolean {
		const target = member.changeTarget;
		if (!target) return false;
		const peer = this.#member(target);
		if (!peer.alive || this.T < peer.frozenUntil) return false;
		for (const id of member.barrierSnapshot) if (!peer.history.has(id)) return false;
		return true;
	}

	/** W9-SPEC §5.5 step 3: only now is the new member eligible. */
	#closeSyncChange(member: DbMember, target: MemberId | null): void {
		if (member.state !== 'primary' || !member.leaseEtag || !target) return;
		const body: DbLease = {
			generation: member.generation,
			holderNodeId: member.id,
			expiresAt: this.#serverNow(member.id) + SPEC.db.ttlMs,
			sync: [target],
			syncState: 'steady',
			durability: member.durability,
			durabilityEffective: member.durabilityEffective,
			syncSetAt: this.T,
		};
		this.#arbWriteDb(
			member.id,
			{ ifMatch: member.leaseEtag },
			body,
			(err, result) => {
				if (!member.alive || member.state !== 'primary') return;
				if (err || !result || result.status !== 200) {
					this.#log(member.id, `close sync change failed (${err ?? result?.status ?? 'no answer'}); re-reading`);
					this.#rereadDb(member, 'close sync change');
					return;
				}
				member.lease = body;
				member.leaseEtag = result.etag;
				member.lastServerDate = result.date;
				member.serverAt = this.T;
				member.changePhase = null;
				member.changeTarget = null;
				member.changeOld = null;
				member.barrierSnapshot.clear();
				member.syncDowngradeAt = 0;
				this.stats.syncChangesClosed++;
				this.#log(member.id, `close: sync {${target}}, syncState steady`);
				this.#checkPendingAcks();
			},
			(appliedAt) => {
				if (member.state === 'primary') member.lastLeaseApply = appliedAt;
			},
		);
	}

	#timeoutSyncChange(member: DbMember): void {
		if (member.changePhase !== 'switching') return;
		const target = member.changeTarget;
		if (target && this.#barrierHolds(member)) {
			this.#closeSyncChange(member, target);
			return;
		}
		const old = member.changeOld;
		if (old && old !== member.id) {
			const peer = this.#member(old);
			const healthy =
				peer.alive &&
				this.T >= peer.frozenUntil &&
				peer.streamFrom === member.id &&
				this.#edge(member.id, old) === 'up';
			if (healthy) {
				this.#fallbackSyncChange(member, old);
				return;
			}
		}
		if (this.#syncLoss === 'downgrade') this.#downgrade(member);
		else this.#blockSyncChange(member);
	}

	#fallbackSyncChange(member: DbMember, old: MemberId): void {
		if (member.state !== 'primary' || !member.leaseEtag) return;
		const body: DbLease = {
			generation: member.generation,
			holderNodeId: member.id,
			expiresAt: this.#serverNow(member.id) + SPEC.db.ttlMs,
			sync: [old],
			syncState: 'steady',
			durability: member.durability,
			durabilityEffective: member.durabilityEffective,
			syncSetAt: this.T,
		};
		this.#arbWriteDb(
			member.id,
			{ ifMatch: member.leaseEtag },
			body,
			(err, result) => {
				if (!member.alive || member.state !== 'primary') return;
				if (err || !result || result.status !== 200) {
					this.#log(member.id, `fallback failed (${err ?? result?.status ?? 'no answer'}); re-reading`);
					this.#rereadDb(member, 'fallback sync change');
					return;
				}
				member.lease = body;
				member.leaseEtag = result.etag;
				member.lastServerDate = result.date;
				member.serverAt = this.T;
				member.effectiveSync = old;
				member.changePhase = null;
				member.changeTarget = null;
				member.changeOld = null;
				member.barrierSnapshot.clear();
				member.syncDowngradeAt = 0;
				this.stats.syncChangesFellBack++;
				this.#log(member.id, `fallback: sync {${old}}, syncState steady`);
				this.#checkPendingAcks();
			},
			(appliedAt) => {
				if (member.state === 'primary') member.lastLeaseApply = appliedAt;
			},
		);
	}

	#blockSyncChange(member: DbMember): void {
		if (member.state !== 'primary' || !member.leaseEtag) return;
		const body: DbLease = {
			generation: member.generation,
			holderNodeId: member.id,
			expiresAt: this.#serverNow(member.id) + SPEC.db.ttlMs,
			sync: [],
			syncState: 'steady',
			durability: 'sync',
			durabilityEffective: 'sync',
			syncSetAt: this.T,
		};
		this.#arbWriteDb(
			member.id,
			{ ifMatch: member.leaseEtag },
			body,
			(err, result) => {
				if (!member.alive || member.state !== 'primary') return;
				if (err || !result || result.status !== 200) {
					this.#log(member.id, `block close failed (${err ?? result?.status ?? 'no answer'}); re-reading`);
					this.#rereadDb(member, 'block sync change');
					return;
				}
				member.lease = body;
				member.leaseEtag = result.etag;
				member.lastServerDate = result.date;
				member.serverAt = this.T;
				member.effectiveSync = null;
				member.changePhase = null;
				member.changeTarget = null;
				member.changeOld = null;
				member.barrierSnapshot.clear();
				member.syncDowngradeAt = 0;
				this.#log(member.id, 'block: sync [], syncState steady; no eligible member');
			},
			(appliedAt) => {
				if (member.state === 'primary') member.lastLeaseApply = appliedAt;
			},
		);
	}

	#downgrade(member: DbMember): void {
		if (member.state !== 'primary' || !member.leaseEtag) return;
		const body: DbLease = {
			generation: member.generation,
			holderNodeId: member.id,
			expiresAt: this.#serverNow(member.id) + SPEC.db.ttlMs,
			sync: [],
			syncState: 'steady',
			durability: 'async',
			durabilityEffective: 'async',
			syncSetAt: this.T,
		};
		this.#arbWriteDb(
			member.id,
			{ ifMatch: member.leaseEtag },
			body,
			(err, result) => {
				if (!member.alive || member.state !== 'primary') return;
				if (err || !result || result.status !== 200) {
					this.#log(member.id, `downgrade failed (${err ?? result?.status ?? 'no answer'}); re-reading`);
					this.#rereadDb(member, 'downgrade');
					return;
				}
				member.lease = body;
				member.leaseEtag = result.etag;
				member.lastServerDate = result.date;
				member.serverAt = this.T;
				member.durability = 'async';
				member.durabilityEffective = 'async';
				member.effectiveSync = null;
				member.changePhase = null;
				member.changeTarget = null;
				member.changeOld = null;
				member.barrierSnapshot.clear();
				member.syncDowngradeAt = 0;
				this.stats.syncChangesDowngraded++;
				this.#log(member.id, 'downgraded: durability_effective = async recorded in the lease');
				this.#checkPendingAcks();
			},
			(appliedAt) => {
				if (member.state === 'primary') member.lastLeaseApply = appliedAt;
			},
		);
	}

	#maybeStartSyncChange(member: DbMember): void {
		if (member.durability !== 'sync') return;
		if ((member.lease?.syncState ?? 'steady') !== 'steady') return;
		const lost = member.effectiveSync !== null && this.#streamDown(member, member.effectiveSync);
		if (!lost) {
			if (member.effectiveSync !== null) {
				member.syncLostSince = 0;
				member.syncDowngradeAt = 0;
			}
			return;
		}
		if (member.syncLostSince === 0) {
			member.syncLostSince = this.T;
			if (member.syncDowngradeAt === 0 && this.#syncLoss === 'downgrade')
				member.syncDowngradeAt = this.T + SPEC.syncDowngradeAfterMs;
		}
		if (this.T - member.syncLostSince < 2000) return;
		const target = this.#pickSyncTarget(member);
		if (target) this.#openSyncChange(member, target.id);
	}

	#renewDb(member: DbMember): void {
		if (member.state !== 'primary' || !member.leaseEtag) return;
		const sentAt = this.T;
		const sentAtWall = this.#wall(member.id);
		member.lastRenewSent = sentAt;
		const body: DbLease = {
			generation: member.generation,
			holderNodeId: member.id,
			expiresAt: this.#serverNow(member.id) + SPEC.db.ttlMs,
			sync: member.lease?.sync ?? [],
			syncState: member.lease?.syncState ?? 'steady',
			durability: member.lease?.durability ?? 'sync',
			durabilityEffective: member.lease?.durabilityEffective ?? 'sync',
			syncSetAt: member.lease?.syncSetAt ?? this.T,
		};
		this.#arbWriteDb(
			member.id,
			{ ifMatch: member.leaseEtag },
			body,
			(err, result) => {
				if (!member.alive || member.state !== 'primary') return;
				if (err || !result) {
					member.lastRenewOk = false;
					this.#log(member.id, `renew failed: ${err ?? 'no answer'}; failsafe is active`);
					return;
				}
				if (result.status !== 200) {
					this.#log(member.id, `renew answered ${result.status}; re-reading`);
					this.#rereadDb(member, 'renew');
					return;
				}
				member.lastRenewOk = true;
				member.lease = body;
				member.leaseEtag = result.etag;
				member.lastServerDate = result.date;
				member.serverAt = this.T;
				member.lastProof = sentAt;
				member.lastProofWall = sentAtWall;
				member.lostBaseline = null;
				if (this.#failoverBaseline?.id === member.id) this.#failoverBaseline = null;
				if (this.#verbose)
					this.#log(member.id, `renewed at ${member.generation}; lease expires ${(body.expiresAt / 1000).toFixed(1)} s`);
				this.#scheduleDbFence(member);
			},
			(appliedAt) => {
				member.lastLeaseApply = appliedAt;
			},
		);
	}

	#rereadDb(member: DbMember, why: string): void {
		this.#arbReadDb(member.id, (err, lease, etag, date, appliedAt) => {
			if (!member.alive) return;
			if (err || !lease || !etag) {
				this.#log(member.id, `${why}: re-read failed (${err ?? 'no lease'})`);
				return;
			}
			if (lease.holderNodeId === member.id && lease.generation === member.generation) {
				member.lease = lease;
				member.leaseEtag = etag;
				member.lastServerDate = date ?? this.T;
				member.serverAt = this.T;
				if (appliedAt !== undefined) member.lastLeaseApply = appliedAt;
				member.lastRenewOk = true;
				member.lostBaseline = null;
				if (this.#failoverBaseline?.id === member.id) this.#failoverBaseline = null;
				this.#adoptStoredLease(member, lease);
				this.#log(member.id, `${why}: still the holder at generation ${member.generation}; retrying`);
				return;
			}
			this.#fence(member, `${why}: generation ${lease.generation} is held by ${lease.holderNodeId}`, true);
		});
	}

	#adoptStoredLease(member: DbMember, lease: DbLease): void {
		member.durability = lease.durability;
		member.durabilityEffective = lease.durabilityEffective;
		if (lease.syncState === 'steady') {
			if (member.changePhase !== null) {
				this.#log(member.id, 're-read shows the transition closed; adopting steady');
				member.effectiveSync = lease.sync[0] ?? null;
				member.changePhase = null;
				member.changeTarget = null;
				member.changeOld = null;
				member.barrierSnapshot.clear();
				member.syncDowngradeAt = 0;
			}
			return;
		}
		if (member.changePhase !== null) return;
		this.#log(member.id, 're-read shows a changing lease with no local transition; resuming');
		member.changePhase = 'opening';
		member.changeOld = null;
		member.changeTarget = this.#pickSyncTarget(member)?.id ?? null;
		member.changeTimeoutAt = this.T + SPEC.syncChangeTimeoutMs;
		if (member.changeTarget) this.#startSwitching(member);
		else if (this.#syncLoss === 'downgrade') member.syncDowngradeAt = this.T + SPEC.syncDowngradeAfterMs;
	}

	#scheduleDbFence(member: DbMember): void {
		this.#cancel(member.fenceTimer);
		if (this.mutant === 'fence-wall-clock') return;
		member.fenceTimer = this.#timer(Math.max(this.T, member.lastProof + SPEC.db.ttlMs), () => {
			if (member.state !== 'primary') return;
			if (this.T < member.frozenUntil) {
				// A frozen process runs no timers; check again when it thaws.
				member.fenceTimer = this.#timer(member.frozenUntil, () => {
					if (member.state === 'primary' && !this.#primaryProvable(member))
						this.#fence(member, 'no confirmation for one TTL and the failsafe does not hold');
				});
				return;
			}
			if (!this.#primaryProvable(member))
				this.#fence(member, 'no confirmation for one TTL and the failsafe does not hold');
		});
	}

	#fence(member: DbMember, reason: string, superseded = false): void {
		if (member.state !== 'primary') return;
		if (!superseded) this.#markLost(member, reason);
		member.state = 'fencing';
		this.#cancel(member.fenceTimer);
		this.#fenceEvents.push({ id: member.id, t: this.T });
		this.stats.fences++;
		this.#log(member.id, `fencing at generation ${member.generation}: ${reason}`);
		this.#timer(this.T + this.#rng.int(50, 300), () => {
			if (member.state !== 'fencing') return;
			member.state = 'fenced';
			member.rewindAt = 0;
			member.effectiveSync = null;
			this.#log(member.id, 'fenced; writes rejected');
		});
	}

	#replicaTick(member: DbMember): void {
		const primary = this.#highestPrimary();
		const streamUp =
			primary !== null &&
			primary.id !== member.id &&
			primary.state === 'primary' &&
			member.streamFrom === primary.id &&
			this.#edge(primary.id, member.id) === 'up' &&
			primary.alive &&
			this.T >= primary.frozenUntil &&
			this.T >= (this.#lagged.get(member.id) ?? 0);
		if (streamUp && primary) {
			if (member.generation < primary.generation) {
				member.generation = primary.generation;
				this.#maxGenerationSeen = Math.max(this.#maxGenerationSeen, primary.generation);
				this.#log(member.id, `following generation ${primary.generation}`);
			}
			member.streamDownSince = null;
			return;
		}
		if (member.streamDownSince === null) {
			member.streamDownSince = this.T;
			this.#log(member.id, 'WAL receiver down');
		}

		const serving = primary !== null && primary.alive && this.T >= primary.frozenUntil;
		const lagged = this.T < (this.#lagged.get(member.id) ?? 0);
		if (serving && primary && !lagged && this.#edge(primary.id, member.id) === 'up') {
			if (member.streamFrom !== primary.id) {
				member.streamFrom = primary.id;
				member.streamEpoch++;
				member.generation = primary.generation;
				member.history = new Set(primary.history);
				member.streamDownSince = null;
				this.#log(member.id, `attached to ${primary.id} at generation ${primary.generation}`);
				return;
			}
		}

		this.#arbReadDb(member.id, (err, lease, etag, date) => {
			if (!member.alive || member.state !== 'streaming') return;
			if (err || !lease || !etag) return;
			member.lease = lease;
			member.leaseEtag = etag;
			member.lastServerDate = date ?? this.T;
			member.serverAt = this.T;
			if (lease.generation < member.generation) return;
			if (lease.generation > this.#maxGenerationSeen) this.#maxGenerationSeen = lease.generation;
			if (this.mutant !== 'ignore-eligibility' && lease.syncState !== 'steady') return;
			if ((date ?? this.T) < lease.expiresAt) return;
			if (member.streamDownSince === null || this.T - member.streamDownSince < SPEC.db.streamDownMs) return;
			if (!this.#autoAllows(member, lease)) return;
			if (this.mutant !== 'ignore-eligibility' && !this.#eligible(member, lease)) return;
			if (
				this.mutant !== 'ignore-keepalive' &&
				this.mutant !== 'cas-same-generation' &&
				this.T - member.lastAnsweredToPrimary < SPEC.db.ttlMs
			)
				return;
			if (member.candidateBusy) return;
			member.candidateBusy = true;
			member.state = 'candidate';
			this.stats.candidateAttempts++;
			const sentAt = this.T;
			const sentAtWall = this.#wall(member.id);
			const gen = this.mutant === 'cas-same-generation' ? lease.generation : lease.generation + 1;
			const body: DbLease = {
				generation: gen,
				holderNodeId: member.id,
				expiresAt: this.#serverNow(member.id) + SPEC.db.ttlMs,
				sync: [],
				syncState: 'changing',
				durability: lease.durability,
				durabilityEffective: lease.durabilityEffective,
				syncSetAt: this.T,
			};
			this.#log(
				member.id,
				`candidate at generation ${gen} (lease ${lease.generation}, sync {${lease.sync.join(',')}}, ${lease.durabilityEffective})`,
			);
			this.#arbWriteDb(
				member.id,
				{ ifMatch: etag },
				body,
				(writeErr, result) => {
					member.candidateBusy = false;
					if (!member.alive) return;
					if (writeErr || !result || result.status !== 200) {
						this.stats.candidateLostCas++;
						this.#log(member.id, `acquire failed or lost the CAS (${writeErr ?? result?.status ?? 'no answer'}); re-reading`);
						this.#resolveAcquire(member, lease, gen, sentAt, sentAtWall);
						return;
					}
					this.#winAcquire(member, lease, body, gen, result, sentAt, sentAtWall);
				},
				(appliedAt) => {
					member.lastLeaseApply = appliedAt;
				},
			);
		});
	}

	#autoAllows(member: DbMember, lease: DbLease): boolean {
		if (this.mutant === 'arm-anyway' || this.mutant === 'async-without-accept') return true;
		return autoEnabledFor(this.armDecision.armed, lease.durabilityEffective, this.scenario.policy.acceptDataLoss);
	}

	#eligible(member: DbMember, lease: DbLease): boolean {
		if (lease.durabilityEffective === 'async') {
			if (this.mutant === 'async-without-accept') return true;
			return this.scenario.policy.acceptDataLoss;
		}
		return lease.sync.includes(member.id);
	}

	#winAcquire(
		member: DbMember,
		fromLease: DbLease,
		body: DbLease,
		gen: number,
		result: ArbResult,
		sentAt: number,
		sentAtWall: number,
	): void {
		if (this.#acquiredTooEarly(member, gen)) return;
		member.state = 'promoting';
		member.acquire = {
			fromLease,
			body,
			gen,
			etag: result.etag ?? '',
			sentAt,
			sentAtWall,
			appliedAt: result.date,
		};
		member.lastServerDate = result.date;
		member.serverAt = this.T;
		member.leaseEtag = result.etag;
		const promoteDelay = this.#rng.int(300, Math.max(400, SPEC.db.promoteBudgetMs));
		this.#log(member.id, `won the CAS at generation ${gen}; pg_ctl promote (${promoteDelay} ms)`);
		this.#timer(this.T + promoteDelay, () => this.#promote(member));
	}

	#resolveAcquire(
		member: DbMember,
		fromLease: DbLease,
		gen: number,
		sentAt: number,
		sentAtWall: number,
	): void {
		this.#arbReadDb(member.id, (err, lease, etag, date) => {
			if (!member.alive) return;
			if (!err && lease && etag && lease.holderNodeId === member.id && lease.generation === gen) {
				member.lease = lease;
				member.leaseEtag = etag;
				member.lastServerDate = date ?? this.T;
				member.serverAt = this.T;
				this.#log(member.id, `the lost CAS response is proved: the lease names us at generation ${gen}`);
				this.#winAcquire(member, fromLease, lease, gen, { status: 200, etag, date: date ?? this.T }, sentAt, sentAtWall);
				return;
			}
			member.state = 'streaming';
			this.#log(member.id, 'lost the CAS; re-following');
		});
	}

	#promote(member: DbMember): void {
		const acquired = member.acquire;
		if (!member.alive || member.state !== 'promoting' || !acquired) return;
		member.state = 'primary';
		member.generation = acquired.gen;
		member.lease = acquired.body;
		member.lastProof = acquired.sentAt;
		member.lastProofWall = acquired.sentAtWall;
		member.lastLeaseApply = acquired.appliedAt;
		member.lastRenewOk = true;
		member.durability = acquired.body.durability;
		member.durabilityEffective = acquired.body.durabilityEffective;
		member.effectiveSync = null;
		member.syncDowngradeAt = 0;
		member.syncLostSince = 0;
		member.changePhase = null;
		member.changeTarget = null;
		member.changeOld = null;
		member.barrierSnapshot.clear();
		member.killAfterOpen = null;
		member.killAfterBarrier = false;
		member.promotedAt = this.T;
		member.streamFrom = null;
		this.stats.promotions++;
		this.#promotions.push(this.T);
		this.#maxGenerationSeen = Math.max(this.#maxGenerationSeen, member.generation);
		if (!this.#control.available) this.stats.controlDownPromotions++;
		this.#log(
			member.id,
			`PRIMARY at generation ${member.generation}; effective sync ${member.effectiveSync ?? 'none'} (lease was ${acquired.fromLease.durabilityEffective})`,
		);
		this.#scheduleDbFence(member);

		// Every replica that can reach the new primary follows it from now on.
		for (const peer of this.db) {
			if (peer.id === member.id || !peer.alive) continue;
			if (peer.state !== 'streaming') continue;
			if (this.#edge(member.id, peer.id) !== 'up') continue;
			peer.streamFrom = member.id;
			peer.streamEpoch++;
			peer.generation = member.generation;
			for (const id of member.history) peer.history.add(id);
			this.#log(peer.id, `now streaming from ${member.id} at generation ${member.generation}`);
		}

		this.#checkI12(member, acquired);
		this.#checkI13(member, acquired);
		this.#consumeFailoverBaseline(member);
		this.#rearm(member);
	}

	#checkI12(member: DbMember, acquired: Acquire): void {
		const lease = acquired.fromLease;
		if (lease.syncState !== 'steady') {
			this.#violate(
				'I12',
				'promotion-during-sync-change',
				`${member.id} promoted at generation ${acquired.gen} from a lease whose syncState was ${lease.syncState}`,
			);
			return;
		}
		if (lease.durabilityEffective === 'sync' && !lease.sync.includes(member.id))
			this.#violate(
				'I12',
				'promotion-not-in-sync-set',
				`${member.id} promoted at generation ${acquired.gen} from a lease whose sync set is {${lease.sync.join(',')}}`,
			);
		if (lease.durabilityEffective === 'async' && !this.scenario.policy.acceptDataLoss)
			this.#violate(
				'I12',
				'promotion-without-accept-data-loss',
				`${member.id} promoted from an async lease without acceptDataLoss`,
			);
		if (this.mutant === 'arm-anyway' && !this.armDecision.armed)
			this.#violate(
				'policy',
				'promotion-not-armed',
				`${member.id} promoted at generation ${acquired.gen} although auto was refused (${this.armDecision.refusals.join(', ') || 'manual'})`,
			);
	}

	#checkI13(member: DbMember, acquired: Acquire): void {
		if (acquired.fromLease.durabilityEffective !== 'sync') return;
		for (const [id, ack] of this.#acked) {
			if (ack.durability !== 'sync') continue;
			if (!member.history.has(id)) {
				this.#violate(
					'I13',
					'missing-ack-at-promotion',
					`${member.id} promoted at generation ${member.generation} without acknowledged commit #${id}; it was acked by ${ack.member} at generation ${ack.gen}`,
				);
				this.#missingAcksReported.add(id);
			}
		}
	}

	#consumeFailoverBaseline(member: DbMember): void {
		const baseline = this.#failoverBaseline;
		if (!baseline || baseline.id === member.id) return;
		const latency = this.T - baseline.baseline;
		this.#failoverBaseline = null;
		if (this.scenario.expect.ttf === false) {
			this.stats.ttfExempt++;
			this.#log(
				member.id,
				`time to writable ${(latency / 1000).toFixed(2)} s, not judged: the arbiter was unreachable for the candidate`,
			);
			return;
		}
		this.failoverLatenciesMs.push(latency);
		this.#log(
			member.id,
			`time to writable ${(latency / 1000).toFixed(2)} s from ${baseline.id}'s last lease renew at ${(baseline.baseline / 1000).toFixed(3)} s`,
		);
		if (latency > SPEC.timeToWritable.worstMs)
			this.#violate(
				'bound',
				'time-to-writable-exceeded',
				`time to writable ${(latency / 1000).toFixed(1)} s from ${baseline.id}'s last successful renew (worst ${(SPEC.timeToWritable.worstMs / 1000).toFixed(0)} s)`,
			);
	}

	/**
	 * W11-SPEC §5.3: after `pg_ctl promote`, the winner clears the sync setting and re-arms the
	 * Revision 1 transition. The acquire CAS already wrote `sync: []`, `changing`; an async
	 * database closes it `steady`; a sync database selects a healthy replica and runs the barrier.
	 */
	#rearm(member: DbMember): void {
		if (!member.alive || member.state !== 'primary') return;
		if (member.durabilityEffective === 'async') {
			if (!member.leaseEtag) return;
			const body: DbLease = {
				generation: member.generation,
				holderNodeId: member.id,
				expiresAt: this.#serverNow(member.id) + SPEC.db.ttlMs,
				sync: [],
				syncState: 'steady',
				durability: 'async',
				durabilityEffective: 'async',
				syncSetAt: this.T,
			};
			this.#arbWriteDb(
				member.id,
				{ ifMatch: member.leaseEtag },
				body,
				(err, result) => {
					if (!member.alive || member.state !== 'primary') return;
					if (err || !result || result.status !== 200) {
						this.#log(member.id, `re-arm (async) failed (${err ?? result?.status ?? 'no answer'}); re-reading`);
						this.#rereadDb(member, 're-arm');
						return;
					}
					member.lease = body;
					member.leaseEtag = result.etag;
					member.lastServerDate = result.date;
					member.serverAt = this.T;
					this.#log(member.id, 're-armed: sync [], steady (async)');
					this.#checkPendingAcks();
				},
				(appliedAt) => {
					if (member.state === 'primary') member.lastLeaseApply = appliedAt;
				},
			);
			return;
		}

		const target = this.#pickSyncTarget(member);
		if (target) {
			member.changePhase = 'switching';
			member.changeTarget = target.id;
			member.changeOld = null;
			member.changeOpenedAt = this.T;
			member.changeTimeoutAt = this.T + SPEC.syncChangeTimeoutMs;
			member.effectiveSync = target.id;
			const id = ++this.#nextCommit;
			const barrier: Commit = {
				id,
				gen: member.generation,
				acceptedBy: member.id,
				durability: 'sync',
				acked: true,
				ackAt: this.T,
				waitFor: null,
				timedOut: false,
			};
			member.history.add(id);
			this.#commits.set(id, barrier);
			member.barrierId = id;
			member.barrierSnapshot = new Set(member.history);
			this.#replicate(member, barrier);
			this.#log(member.id, `re-armed: barrier #${id} to ${target.id}`);
			return;
		}
		if (this.#syncLoss === 'downgrade') {
			member.syncDowngradeAt = this.T + SPEC.syncDowngradeAfterMs;
			this.#log(member.id, 'no healthy replica for sync; on_sync_loss downgrade in 30 s');
		} else {
			this.#log(member.id, 'no healthy replica for sync; on_sync_loss block');
		}
	}

	#fencedTick(member: DbMember): void {
		const primary = this.#highestPrimary();
		if (!primary || primary.id === member.id) return;
		if (!primary.alive || this.T < primary.frozenUntil) return;
		if (this.#edge(primary.id, member.id) !== 'up') return;
		if (member.rewindAt === 0) {
			member.rewindAt = this.T + this.#rng.int(1000, 4000);
			this.#log(member.id, `will rewind against ${primary.id}`);
			return;
		}
		if (this.T < member.rewindAt) return;
		member.state = 'rewind';
		member.history = new Set(primary.history);
		member.generation = primary.generation;
		member.streamFrom = primary.id;
		member.streamEpoch++;
		member.rewindAt = 0;
		member.state = 'streaming';
		this.#log(member.id, `rewound to ${primary.id} at generation ${primary.generation}; streaming`);
	}

	// ── commits, replication, acks ──────────────────────────────────────────

	#acceptWrite(member: DbMember, commit: Commit): boolean {
		if (member.state !== 'primary' || !this.#primaryProvable(member)) return false;
		if (commit.acceptedBy !== null) return false;
		commit.gen = member.generation;
		commit.acceptedBy = member.id;
		commit.durability = member.durabilityEffective;
		member.history.add(commit.id);
		this.#replicate(member, commit);
		if (member.durabilityEffective === 'async') {
			this.#ack(commit);
		} else {
			commit.waitFor = member.effectiveSync;
			if (commit.waitFor && this.#member(commit.waitFor).history.has(commit.id)) this.#ack(commit);
		}
		return true;
	}

	/**
	 * WAL is an ordered stream. A delivery that cannot be made detaches the receiver (`streamEpoch`
	 * invalidates everything already in flight); it re-attaches only after copying the primary's
	 * whole history. This is what makes "the barrier is in the receiver's history" imply "every
	 * earlier acknowledged commit is too".
	 */
	#replicate(member: DbMember, commit: Commit): void {
		for (const peer of this.db) {
			if (peer.id === member.id) continue;
			if (!peer.alive || this.T < peer.frozenUntil) continue;
			if (peer.streamFrom !== member.id) continue;
			if (this.#edge(member.id, peer.id) !== 'up' || this.T < (this.#lagged.get(peer.id) ?? 0)) {
				this.#detachStream(member, peer, `commit #${commit.id} could not be shipped`);
				continue;
			}
			const at = Math.max(this.T + this.#rng.int(10, 180), member.replAt.get(peer.id) ?? 0);
			member.replAt.set(peer.id, at);
			const epoch = peer.streamEpoch;
			this.#timer(at, () => {
				if (!peer.alive || this.T < peer.frozenUntil) return;
				if (peer.streamEpoch !== epoch || peer.streamFrom !== member.id) return;
				if (this.#edge(member.id, peer.id) !== 'up' || this.T < (this.#lagged.get(peer.id) ?? 0)) {
					this.#detachStream(member, peer, `commit #${commit.id} lost in flight`);
					return;
				}
				if (peer.history.has(commit.id)) return;
				peer.history.add(commit.id);
				this.#checkPendingAcks();
			});
		}
	}

	#detachStream(sender: DbMember, peer: DbMember, why: string): void {
		if (peer.streamFrom === null) return;
		peer.streamFrom = null;
		peer.streamEpoch++;
		sender.replAt.delete(peer.id);
		this.#log(peer.id, `WAL stream gap (${why}); re-attach and catch up`);
	}

	#checkPendingAcks(): void {
		for (const commit of this.#commits.values()) {
			if (commit.acked || commit.acceptedBy === null) continue;
			const primary = this.#member(commit.acceptedBy);
			const highest = this.#highestPrimary();
			const acceptedServing = primary.state === 'primary' && this.#primaryProvable(primary);
			if (!acceptedServing && !(highest && highest.history.has(commit.id))) continue;
			if (primary.durabilityEffective !== 'sync') {
				this.#ack(commit);
				continue;
			}
			const waitFor = commit.waitFor;
			if (!waitFor) continue;
			if (this.#member(waitFor).history.has(commit.id)) this.#ack(commit);
		}
	}

	/**
	 * W11-SPEC §4.4: a member that answered a keep-alive within one TTL must not acquire. The normal
	 * machine never reaches the CAS in that state; the `ignore-keepalive` mutant does, and the
	 * breach is reported so the rule is visible rather than silently assumed.
	 */
	#acquiredTooEarly(member: DbMember, gen: number): boolean {
		const answeredFor = this.T - member.lastAnsweredToPrimary;
		if (answeredFor >= SPEC.db.ttlMs) return false;
		this.#violate(
			'support',
			'acquired-too-early-after-keepalive',
			`${member.id} acquired generation ${gen} ${(answeredFor / 1000).toFixed(1)} s after answering a keep-alive (need ${SPEC.db.ttlMs / 1000} s)`,
		);
		return this.mutant !== 'ignore-keepalive' && this.mutant !== 'cas-same-generation';
	}

	#ack(commit: Commit): void {
		if (commit.acked) return;
		commit.acked = true;
		commit.ackAt = this.T;
		const member = commit.acceptedBy;
		if (!member) return;
		const durability = this.#member(member).durabilityEffective;
		this.#acked.set(commit.id, { gen: commit.gen, member, t: this.T, durability });
		this.stats.acks++;
		if (!this.#control.available) this.stats.controlDownAcks++;
		if (this.#verbose)
			this.#log(commit.waitFor ? commit.waitFor : member, `commit #${commit.id} acknowledged (generation ${commit.gen})`);
		const higher = this.#highestPrimary();
		if (
			durability === 'sync' &&
			higher &&
			higher.generation > commit.gen &&
			(higher.lease?.durabilityEffective ?? 'sync') === 'sync' &&
			!higher.history.has(commit.id)
		)
			this.#violate(
				'I13',
				'ack-lost-to-higher-primary',
				`commit #${commit.id} was acknowledged by ${member} at generation ${commit.gen} while ${higher.id} was primary at generation ${higher.generation} without it`,
			);
		const write = this.#writes.find((w) => w.commit === commit.id);
		if (write) {
			write.ackedAt = this.T;
			this.#timer(this.T + this.#rng.int(5, 80), () => {
				write.deliveredAt = this.T;
				this.#ackDeliveries.push(this.T);
			});
		}
	}

	// ── the consumer (W11-SPEC §6) ───────────────────────────────────────────

	#consumerPoll(): void {
		if (this.#polling) {
			this.#timer(this.T + 500, () => this.#consumerPoll());
			return;
		}
		this.#polling = true;
		const answers = new Map<MemberId, { role: DbState; gen: number }>();
		let outstanding = this.db.length;
		const done = () => {
			if (outstanding > 0) return;
			let best: { id: MemberId; gen: number } | null = null;
			let tie = false;
			for (const [id, answer] of answers) {
				if (answer.role !== 'primary') continue;
				if (!best || answer.gen > best.gen) {
					best = { id, gen: answer.gen };
					tie = false;
				} else if (answer.gen === best.gen) {
					tie = true;
				}
			}
			this.#target = tie ? null : (best?.id ?? null);
			if (!best || tie) this.stats.failClosedPolls++;
			this.#polling = false;
			this.#timer(this.T + this.#rng.int(SPEC.discoveryMinMs, SPEC.discoveryMaxMs), () =>
				this.#consumerPoll(),
			);
		};
		for (const member of this.db) {
			this.#call(
				'consumer',
				member.id,
				() => {
					const role = this.#roleOf(member);
					return { role, gen: member.generation };
				},
				(err, answer) => {
					outstanding--;
					if (!err && answer) answers.set(member.id, answer);
					done();
				},
			);
		}
	}

	#roleOf(member: DbMember): DbState {
		if (member.state === 'primary' && !this.#primaryProvable(member)) {
			this.#fence(member, 'a consumer asked for its role after the lease expired');
			return 'fenced';
		}
		return member.state;
	}

	#consumerWriteTick(): void {
		if (this.#target) this.#consumerWrite(this.#target);
		this.#timer(this.T + this.#rng.int(500, 900), () => this.#consumerWriteTick());
	}

	#consumerWrite(target: MemberId): void {
		const member = this.#member(target);
		const commit: Commit = {
			id: ++this.#nextCommit,
			gen: member.generation,
			acceptedBy: null,
			durability: member.durabilityEffective,
			acked: false,
			ackAt: null,
			waitFor: null,
			timedOut: false,
		};
		this.#commits.set(commit.id, commit);
		const write: Write = { id: commit.id, commit: commit.id, target, sentAt: this.T, ackedAt: null, deliveredAt: null, timedOut: false };
		this.#writes.push(write);
		this.stats.writes++;
		this.#timer(this.T + 30_000, () => {
			if (!write.ackedAt) write.timedOut = true;
		});
		this.#call(
			'consumer',
			target,
			() => this.#acceptWrite(member, commit),
			(err, ok) => {
				if (err || !ok) {
					this.stats.rejectedWrites++;
					write.timedOut = true;
					this.#log('consumer', `write #${commit.id} to ${target} rejected (${err ?? 'not primary'})`);
				}
			},
		);
	}

	// ── test seams ───────────────────────────────────────────────────────────

	/** Force the observed state, to prove the I3 checker is not vacuous. */
	forcePrimaryForTest(id: MemberId, generation: number): void {
		const member = this.#member(id);
		member.state = 'primary';
		member.generation = generation;
	}

	/** Run the invariant pass once, for the checker self-tests. */
	checkNowForTest(): Violation[] {
		this.#observe();
		return this.violations;
	}

	/** The policy decision, for the arming tests and the fixed refusal scenarios. */
	armDecisionForTest(): ArmDecision {
		return this.armDecision;
	}
}
