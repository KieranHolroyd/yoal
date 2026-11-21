/**
 * The W9 model: the control-plane machine and the database member machine, written from
 * docs/build-plan/W9-SPEC.md alone (no implementation was read).
 *
 * Time is a virtual millisecond counter. Every RPC crosses a directed reachability graph with a
 * drawn round-trip latency; the arbiter is a linearizable single-object store with conditional
 * PUT. Members and control nodes run the state machines of W9-SPEC §4 and §5. The consumer is
 * W9-SPEC §5.6: it polls every member and forwards to the member answering `primary` at the
 * highest generation, with no control plane involved.
 *
 * The checker runs after every event:
 *   I3   no two members at `primary` at one generation, no two control nodes at one epoch;
 *        `strictOverlapMs` also measures two primaries at *different* generations, which the
 *        letter of I3 permits but the plan's intent does not.
 *   I12  a promotion on a `sync` database only ever names a member in the lease's sync set at
 *        the generation it acquired from.
 *   I13  at every promotion, and at the end of the run, the promoted member's history contains
 *        every commit acknowledged under `sync`; and an ack is never issued by an old primary
 *        when a higher-generation primary already exists and does not have it.
 *   I11  expectations attached to a schedule (control-plane outage, failover bound, traffic).
 *
 * Assumptions stated in docs/build-plan/W9-MODEL.md: the arbiter clock is monotonic and
 * authoritative; node timers are monotonic (wall-clock steps are inert); RPC legs are ≪ the
 * lease TTL (5–120 ms normal, ≤1.5 s under a fault); the arbiter's conditional write is atomic
 * and linearizable; a promotion is automatic only.
 */
import { Rng } from '../rng.ts';
import {
	type ControlId,
	type ControlLease,
	type DbLease,
	type Durability,
	type Fault,
	type MemberId,
	type Mutant,
	type Property,
	type RunResult,
	type RunStats,
	type Scenario,
	type TraceEvent,
	type Violation,
	type ViolationKind,
	SPEC,
} from './spec.ts';

export type DbState = 'streaming' | 'candidate' | 'promoting' | 'primary' | 'fencing' | 'fenced' | 'rewind';
export type ControlState = 'joining' | 'standby' | 'standby-behind' | 'promoting' | 'primary' | 'fenced' | 'unavailable';

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
	lastProof: number;
	lastProofWall: number;
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
	localAsync: boolean;
	changeTimeoutAt: number;
	barrierId: number;
	barrierSnapshot: Set<number>;
	killAfterOpen: number | null;
	killAfterBarrier: boolean;
	streamEpoch: number;
	replAt: Map<MemberId, number>;
	syncLostSince: number;
	syncDowngradeAt: number;
	nextSyncChangeAt: number;
	rewindAt: number;
	candidateBusy: boolean;
	acquire: { lease: DbLease; body: DbLease; gen: number; etag: string; date: number; sentAt: number; sentAtWall: number } | null;
	fenceTimer: number | null;
}

interface ControlNode {
	id: ControlId;
	state: ControlState;
	epoch: number;
	alive: boolean;
	frozenUntil: number;
	wallOffset: number;
	canPromote: boolean;
	masterKey: boolean;
	observedEtag: string | null;
	observedSince: number;
	lease: ControlLease | null;
	leaseEtag: string | null;
	lastServerDate: number;
	serverAt: number;
	lastConfirmed: number;
	lastRenewSent: number;
	fenceTimer: number | null;
	errSince: number;
	rejoinSince: number;
	tick: number;
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

interface SyncReport {
	etag: string;
	applied: 'async' | 'block' | { sync: MemberId };
	at: number;
}

interface Stored<T> {
	body: T;
	etag: string;
	appliedAt: number;
}

type ArbResult = { status: number; etag: string | null; date: number; body?: string };

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

export interface W9Options {
	seed: number;
	scenario: Scenario;
	mutant?: Mutant;
	/** Record every event, not just the ring kept for a violation. */
	trace?: boolean;
	/** Include per-commit/per-WAL lines in the trace (the fixed scenarios use this). */
	verbose?: boolean;
}

export class W9World {
	readonly seed: number;
	readonly scenario: Scenario;
	readonly mutant: Mutant;
	T = 0;
	events = 0;

	readonly db: DbMember[] = [];
	readonly control: ControlNode[] = [];
	readonly violations: Violation[] = [];
	readonly stats: RunStats = {
		promotions: 0,
		controlTakeovers: 0,
		acks: 0,
		writes: 0,
		rejectedWrites: 0,
		failClosedPolls: 0,
		strictOverlapMs: 0,
		controlStrictOverlapMs: 0,
		controlOutageAcks: 0,
		failoverLatencyMs: null,
		controlPromotions: 0,
		syncChangesOpened: 0,
		syncChangesClosed: 0,
		syncChangesFellBack: 0,
		syncChangesDowngraded: 0,
		primaryKilledChanging: 0,
		syncReports: 0,
		syncSameEtags: 0,
		syncStaleReconciled: 0,
		syncReopens: 0,
		syncAlerts: 0,
		localSyncLossApplied: 0,
	};

	#queue = new EventQueue();
	#rng: Rng;
	#cancelled = new Set<number>();
	#timerId = 0;
	#trace: TraceEvent[] | null;
	#ring: TraceEvent[] = [];
	#verbose: boolean;

	#controlStore: Stored<ControlLease> | null = null;
	#dbStore: Stored<DbLease>;
	#etag = 0;

	#edges = new Map<string, { mode: 'refuse' | 'drop' }[]>();
	#lagged = new Map<MemberId, number>();

	#syncLoss: 'downgrade' | 'block';

	#commits = new Map<number, Commit>();
	#reconciler = { available: true, reports: [] as SyncReport[], reconciling: false };
	#controlOutageUntil = 0;
	#acked = new Map<number, { gen: number; member: MemberId; t: number; durability: Durability }>();
	#missingAcksReported = new Set<number>();
	#writes: Write[] = [];
	#ackDeliveries: number[] = [];
	#nextCommit = 0;

	#target: MemberId | null = null;
	#polling = false;
	#lastObserve = 0;
	#prevDbPrimaries = 0;
	#prevControlPrimaries = 0;

	constructor(options: W9Options) {
		this.seed = options.seed;
		this.scenario = options.scenario;
		this.mutant = options.mutant ?? 'none';
		this.#rng = new Rng(options.seed, 11);
		this.#trace = options.trace ? [] : null;
		this.#verbose = options.verbose ?? false;
		this.#syncLoss = options.scenario.syncLoss ?? 'downgrade';

		const sync = options.scenario.sync ?? ['b'];
		const durability = options.scenario.durability ?? 'sync';
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
				lastProof: 0,
				lastProofWall: 0,
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
				localAsync: false,
				changeTimeoutAt: 0,
				barrierId: 0,
				barrierSnapshot: new Set<number>(),
				killAfterOpen: null,
				killAfterBarrier: false,
				streamEpoch: 0,
				replAt: new Map<MemberId, number>(),
				syncLostSince: 0,
				syncDowngradeAt: 0,
				nextSyncChangeAt: 0,
				rewindAt: 0,
				candidateBusy: false,
				acquire: null,
				fenceTimer: null,
			};
			this.db.push(member);
		}

		for (const id of ['c0', 'c1', 'c2'] as ControlId[]) {
			const node: ControlNode = {
				id,
				state: 'joining',
				epoch: 0,
				alive: true,
				frozenUntil: 0,
				wallOffset: 0,
				canPromote: true,
				masterKey: true,
				observedEtag: null,
				observedSince: 0,
				lease: null,
				leaseEtag: null,
				lastServerDate: 0,
				serverAt: 0,
				lastConfirmed: 0,
				lastRenewSent: 0,
				fenceTimer: null,
				errSince: 0,
				rejoinSince: 0,
				tick: 0,
			};
			this.control.push(node);
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

	#dbMember(id: string): DbMember {
		const member = this.db.find((m) => m.id === id);
		if (!member) throw new Error(`unknown member ${id}`);
		return member;
	}

	#isAlive(id: string): boolean {
		if (id === 'arb' || id === 'consumer' || id === 'reconciler') return true;
		const member = this.db.find((m) => m.id === id);
		if (member) return member.alive;
		const control = this.control.find((c) => c.id === id);
		if (control) return control.alive;
		return false;
	}

	#frozenUntil(id: string): number {
		const member = this.db.find((m) => m.id === id);
		if (member) return member.frozenUntil;
		const control = this.control.find((c) => c.id === id);
		if (control) return control.frozenUntil;
		return 0;
	}

	/** The node's best estimate of the arbiter's clock: last server Date plus elapsed monotonic. */
	#serverNow(id: string): number {
		const member = this.db.find((m) => m.id === id);
		if (member) return member.lastServerDate + (this.T - member.serverAt);
		const control = this.control.find((c) => c.id === id);
		if (control) return control.lastServerDate + (this.T - control.serverAt);
		return this.T;
	}

	#wall(id: string): number {
		const member = this.db.find((m) => m.id === id);
		if (member) return this.T + member.wallOffset;
		const control = this.control.find((c) => c.id === id);
		if (control) return this.T + control.wallOffset;
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
	 * One RPC. The request crosses `from→to`, `serve` runs at arrival (linearization point),
	 * the response crosses `to→from`. A lost response still applied the write.
	 */
	#call<T>(from: string, to: string, serve: () => T, cb: (err: string | null, result?: T) => void): void {
		const fail = (why: string, delay: number) => {
			this.#timer(this.T + delay, () => cb(why));
		};
		if (!this.#isAlive(from) || !this.#isAlive(to)) return fail('down', 5);
		if (this.T < this.#frozenUntil(from) || this.T < this.#frozenUntil(to)) return fail('frozen', RPC_TIMEOUT_MS);
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

	#arbRead(from: string, store: 'control' | 'db', cb: (err: string | null, result?: ArbResult) => void): void {
		this.#call(
			from,
			'arb',
			(): ArbResult => {
				const current = store === 'control' ? this.#controlStore : this.#dbStore;
				if (!current) return { status: 404, etag: null, date: this.T };
				return { status: 200, etag: current.etag, date: this.T, body: JSON.stringify(current.body) };
			},
			cb,
		);
	}

	#arbReadDb(from: string, cb: (err: string | null, lease?: DbLease, etag?: string, date?: number) => void): void {
		this.#arbRead(from, 'db', (err, result) => {
			if (err || !result) return cb(err ?? 'no result');
			if (result.status !== 200 || !result.body) return cb(`status ${result.status}`);
			cb(null, JSON.parse(result.body) as DbLease, result.etag ?? undefined, result.date);
		});
	}

	#arbReadControl(
		from: string,
		cb: (err: string | null, lease?: ControlLease, etag?: string, date?: number) => void,
	): void {
		this.#arbRead(from, 'control', (err, result) => {
			if (err || !result) return cb(err ?? 'no result');
			if (result.status === 404) return cb('absent');
			if (result.status !== 200 || !result.body) return cb(`status ${result.status}`);
			cb(null, JSON.parse(result.body) as ControlLease, result.etag ?? undefined, result.date);
		});
	}

	#arbWriteDb(
		from: string,
		condition: { ifMatch: string } | { ifNoneMatch: true },
		body: DbLease,
		cb: (err: string | null, result?: ArbResult) => void,
	): void {
		const prev = this.#dbStore;
		this.#call(
			from,
			'arb',
			(): ArbResult => {
				const current = this.#dbStore;
				const matches = 'ifNoneMatch' in condition ? current === null : current.etag === condition.ifMatch;
				if (!matches) return { status: 412, etag: current.etag, date: this.T };
				const stored = { body, etag: this.#nextEtag(), appliedAt: this.T };
				this.#dbStore = stored;
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
				return { status: 200, etag: stored.etag, date: this.T };
			},
			cb,
		);
		void prev;
	}

	#arbWriteControl(
		from: string,
		condition: { ifMatch: string } | { ifNoneMatch: true },
		body: ControlLease,
		cb: (err: string | null, result?: ArbResult) => void,
	): void {
		this.#call(
			from,
			'arb',
			(): ArbResult => {
				const current = this.#controlStore;
				const matches = 'ifNoneMatch' in condition ? current === null : current?.etag === condition.ifMatch;
				if (!matches) return { status: 412, etag: current?.etag ?? null, date: this.T };
				if (current) {
					if (body.epoch < current.body.epoch)
						this.#violate(
							'support',
							'lease-epoch-decreased',
							`epoch fell ${current.body.epoch}→${body.epoch}`,
						);
					else if (body.epoch === current.body.epoch && body.holderNodeId !== current.body.holderNodeId)
						this.#violate(
							'support',
							'lease-holder-change-not-plus-one',
							`holder changed ${current.body.holderNodeId}→${body.holderNodeId} at epoch ${body.epoch}`,
						);
					else if (body.epoch > current.body.epoch + 1)
						this.#violate(
							'support',
							'lease-holder-change-not-plus-one',
							`epoch jumped ${current.body.epoch}→${body.epoch}`,
						);
				}
				const stored = { body, etag: this.#nextEtag(), appliedAt: this.T };
				this.#controlStore = stored;
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
		for (const node of this.control) this.#timer(this.T + this.#rng.int(0, 500), () => this.#controlTick(node));
		if (this.scenario.writes !== false) {
			this.#timer(this.T + 1000, () => this.#consumerPoll());
			this.#timer(this.T + 1200, () => this.#consumerWriteTick());
		}
		this.#timer(this.T + 100, () => this.#bootstrapControl());

		while (this.#queue.size > 0) {
			const item = this.#queue.pop() as QueueItem;
			if (item.at > this.scenario.durationMs) break;
			this.T = item.at;
			this.events++;
			if (this.events > 2_000_000) throw new Error(`w9 model: event cap at T=${this.T}`);
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
			trace: this.#trace ?? [],
			events: this.events,
			durationMs: this.T,
		};
	}

	#observe(): void {
		const elapsed = this.T - this.#lastObserve;
		this.#lastObserve = this.T;

		const primaries = this.db.filter((m) => m.state === 'primary');
		const servingDb = primaries.filter((m) => m.alive && this.T >= m.frozenUntil);
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
		this.#prevDbPrimaries = servingDb.length;

		const controlPrimaries = this.control.filter((c) => c.state === 'primary');
		const servingControl = controlPrimaries.filter((c) => c.alive && this.T >= c.frozenUntil);
		const byEpoch = new Map<number, ControlNode[]>();
		for (const c of controlPrimaries) byEpoch.set(c.epoch, [...(byEpoch.get(c.epoch) ?? []), c]);
		for (const [epoch, nodes] of byEpoch) {
			if (nodes.length > 1)
				this.#violate(
					'I3',
					'two-control-primary-same-epoch',
					`${nodes.map((c) => c.id).join(' and ')} are primary at epoch ${epoch}`,
				);
		}
		if (this.#prevControlPrimaries >= 2) this.stats.controlStrictOverlapMs += elapsed;
		this.#prevControlPrimaries = servingControl.length;
	}

	#finalize(): void {
		const expect = this.scenario.expect;
		if (expect.failover) {
			const promotion = this.stats.promotions > 0 ? this.#firstPromotionAfter(expect.failover.after) : null;
			if (promotion === null) {
				this.#violate(
					'I11',
					'failover-too-slow',
					`no database promotion after ${(expect.failover.after / 1000).toFixed(1)} s (limit ${(expect.failover.withinMs / 1000).toFixed(0)} s)`,
				);
			} else {
				const latency = promotion - expect.failover.after;
				this.stats.failoverLatencyMs = latency;
				if (latency > expect.failover.withinMs)
					this.#violate(
						'I11',
						'failover-too-slow',
						`failover took ${(latency / 1000).toFixed(1)} s from the loss (limit ${(expect.failover.withinMs / 1000).toFixed(0)} s)`,
					);
			}
		}
		if (expect.noPrimary) {
			const inWindow = this.#promotionTimes().filter((t) => t >= expect.noPrimary!.from && t <= expect.noPrimary!.to);
			if (inWindow.length > 0)
				this.#violate(
					'I11',
					'primary-during-arbiter-outage',
					`a database promotion completed at ${(inWindow[0]! / 1000).toFixed(1)} s while the arbiter was away`,
				);
		}
		if (expect.requireAcks) {
			const count = this.#ackDeliveries.filter(
				(t) => t >= expect.requireAcks!.from && t <= expect.requireAcks!.to,
			).length;
			if (count < expect.requireAcks.min)
				this.#violate(
					'I11',
					'no-traffic-during-control-outage',
					`${count} acknowledged writes in the control-plane outage window (need ${expect.requireAcks.min})`,
				);
		}
		if (expect.controlOutage) {
			this.stats.controlOutageAcks = this.#ackDeliveries.filter(
				(t) => t >= expect.controlOutage!.from && t <= expect.controlOutage!.to,
			).length;
		}

		// I13 at rest: the primary the run ends with holds every acknowledged commit.
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
	}

	#promotionTimes(): number[] {
		return this.#promotions;
	}

	#promotions: number[] = [];
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
				const control = this.control.find((c) => c.id === fault.node);
				if (!member && !control) break;
				const node = (member ?? control) as DbMember | ControlNode;
				if (!node.alive) break;
				node.frozenUntil = Math.max(node.frozenUntil, until);
				this.#log(fault.node as string, `frozen for ${((fault.durationMs ?? 0) / 1000).toFixed(1)} s (fault #${fault.id})`);
				this.#timer(until, () => this.#onResume(fault.node as string));
				break;
			}
			case 'crash':
				this.#crash(fault.node as string, fault.durationMs ?? 0);
				this.#log(fault.node as string, `process stopped (fault #${fault.id})`);
				break;
			case 'clock-step': {
				const member = this.db.find((m) => m.id === fault.node);
				const control = this.control.find((c) => c.id === fault.node);
				const node = member ?? control;
				if (!node) break;
				node.wallOffset += fault.value ?? 0;
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
			case 'sync-control-outage': {
				const end = this.T + (fault.durationMs ?? 0);
				this.#controlOutageUntil = Math.max(this.#controlOutageUntil, end);
				this.#reconciler.available = false;
				this.#log('reconciler', `control plane unreachable for ${((fault.durationMs ?? 0) / 1000).toFixed(1)} s (fault #${fault.id})`);
				this.#timer(end, () => {
					if (this.T < this.#controlOutageUntil) return;
					this.#reconciler.available = true;
					this.#log('reconciler', 'control plane returned; reconciling reports');
					this.#reconcile();
				});
				break;
			}
			case 'kill-primary': {
				const primary = this.#highestPrimary();
				if (!primary) break;
				this.#crash(primary.id, fault.durationMs ?? 0);
				this.#log(primary.id, `primary killed (fault #${fault.id})`);
				break;
			}
			case 'control-crash':
				for (const node of this.control) this.#crash(node.id, fault.durationMs ?? 0);
				this.#log('control', `all control nodes stopped (fault #${fault.id})`);
				break;
			case 'master-key': {
				const node = this.control.find((c) => c.id === fault.node);
				if (!node) break;
				node.masterKey = false;
				node.canPromote = false;
				this.#log(node.id, `master key unverifiable: canPromote=false (fault #${fault.id})`);
				break;
			}
		}
	}

	#crash(id: string, durationMs: number): void {
		const member = this.db.find((m) => m.id === id);
		if (member) {
			if (member.state === 'primary' && member.changePhase !== null) this.stats.primaryKilledChanging++;
			member.alive = false;
			member.state = member.state === 'primary' ? 'fencing' : member.state;
			member.streamFrom = null;
			member.effectiveSync = null;
			member.localAsync = false;
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
			return;
		}
		const control = this.control.find((c) => c.id === id);
		if (control) {
			control.alive = false;
			control.state = 'joining';
			control.observedEtag = null;
			this.#cancel(control.fenceTimer);
			if (durationMs > 0)
				this.#timer(this.T + durationMs, () => {
					control.alive = true;
					control.frozenUntil = 0;
					control.state = 'joining';
					control.canPromote = control.masterKey;
					this.#log(control.id, 'process restarted; joining');
					this.#timer(this.T + 500, () => this.#controlTick(control));
				});
		}
	}

	#onResume(id: string): void {
		const member = this.db.find((m) => m.id === id);
		if (member) {
			if (this.T < member.frozenUntil) return;
			this.#log(member.id, `resumed (${member.state})`);
			if (member.state === 'primary' && !this.#primaryProvable(member)) {
				this.#log(member.id, 'resume found the lease unprovable; fencing before serving');
				this.#fence(member, 'resume after the lease expired');
			}
			return;
		}
		const control = this.control.find((c) => c.id === id);
		if (control) {
			if (this.T < control.frozenUntil) return;
			this.#log(control.id, `resumed (${control.state})`);
			if (control.state === 'primary' && this.T - control.lastConfirmed >= SPEC.control.fenceAfterMs)
				this.#fenceControl(control, 'resume after the control lease expired');
		}
	}

	// ── the control-plane machine (W9-SPEC §4) ──────────────────────────────

	#bootstrapControl(): void {
		const first = this.control[0] as ControlNode;
		this.#arbWriteControl(first.id, { ifNoneMatch: true }, { epoch: 1, holderNodeId: first.id, expiresAt: this.#serverNow(first.id) + SPEC.control.ttlMs }, (err, result) => {
			if (err) {
				this.#timer(this.T + 500, () => this.#bootstrapControl());
				return;
			}
			if (result?.status === 200) {
				first.lease = { epoch: 1, holderNodeId: first.id, expiresAt: this.#serverNow(first.id) + SPEC.control.ttlMs };
				first.leaseEtag = result.etag;
				first.lastServerDate = result.date;
				first.serverAt = this.T;
				first.epoch = 1;
				first.state = 'promoting';
				first.lastConfirmed = this.T;
				this.#log(first.id, 'created control lease at epoch 1');
				this.#timer(this.T + 300, () => {
					if (!first.alive) return;
					first.state = 'primary';
					this.stats.controlPromotions++;
					this.#log(first.id, 'control primary at epoch 1');
					this.#scheduleControlFence(first);
				});
			}
		});
	}

	#controlTick(node: ControlNode): void {
		if (!node.alive) return;
		if (this.T < node.frozenUntil) {
			this.#timer(node.frozenUntil, () => this.#controlTick(node));
			return;
		}
		switch (node.state) {
			case 'joining':
				node.state = 'standby';
				this.#log(node.id, 'joined as standby');
				break;
			case 'promoting':
				break;
			case 'primary': {
				if (this.T - node.lastConfirmed >= SPEC.control.fenceAfterMs) this.#fenceControl(node, 'no confirmation');
				else if (this.T - node.lastRenewSent >= SPEC.control.renewMs) this.#renewControl(node);
				break;
			}
			case 'fenced': {
				if (this.T >= node.rejoinSince + SPEC.successorQuietMs) {
					node.state = 'standby';
					node.rejoinSince = 0;
					this.#log(node.id, 'rejoined as standby');
				}
				break;
			}
			case 'standby':
			case 'standby-behind':
			case 'unavailable':
				this.#pollControl(node);
				break;
		}
		this.#timer(this.T + 1000 + this.#rng.int(0, 200), () => this.#controlTick(node));
	}

	#pollControl(node: ControlNode): void {
		this.#arbReadControl(node.id, (err, lease, etag, date) => {
			if (!node.alive || this.T < node.frozenUntil) return;
			if (err || !lease) {
				if (node.errSince === 0) node.errSince = this.T;
				if (node.state !== 'unavailable' && this.T - node.errSince >= SPEC.control.ttlMs) {
					node.state = 'unavailable';
					this.#log(node.id, 'unavailable: the arbiter is not answering');
				}
				return;
			}
			node.errSince = 0;
			if (node.state === 'unavailable') {
				node.state = 'standby';
				this.#log(node.id, 'the arbiter answered; standby');
			}
			if (lease.epoch > node.epoch) {
				node.epoch = lease.epoch;
				this.#log(node.id, `observed epoch ${lease.epoch}`);
			}
			node.lease = lease;
			node.leaseEtag = etag ?? null;
			node.lastServerDate = date ?? this.T;
			node.serverAt = this.T;
			if (node.observedEtag !== etag) {
				node.observedEtag = etag ?? null;
				node.observedSince = this.T;
			}
			if (node.state === 'fenced') {
				const holder = lease.holderNodeId;
				if (node.rejoinSince === 0) {
					node.rejoinSince = this.T;
					this.#log(node.id, `holder stable at ${holder} epoch ${lease.epoch}; rejoin in ${(SPEC.successorQuietMs / 1000).toFixed(0)} s`);
				}
				return;
			}
			if (!node.canPromote || node.state === 'standby-behind') return;
			if (this.T - node.observedSince < SPEC.control.takeoverQuietMs) return;
			if (lease.expiresAt > (date ?? this.T)) return;
			this.#takeOverControl(node, lease, etag ?? null);
		});
	}

	#takeOverControl(node: ControlNode, lease: ControlLease, etag: string | null): void {
		if (!etag) return;
		this.#log(node.id, `attempting takeover at epoch ${lease.epoch + 1}`);
		this.#arbWriteControl(
			node.id,
			{ ifMatch: etag },
			{ epoch: lease.epoch + 1, holderNodeId: node.id, expiresAt: this.#serverNow(node.id) + SPEC.control.ttlMs },
			(err, result) => {
				if (!node.alive) return;
				if (err || !result) {
					this.#log(node.id, `takeover failed: ${err ?? 'no answer'}`);
					return;
				}
				if (result.status !== 200) {
					this.#log(node.id, `takeover lost the CAS (${result.status})`);
					node.observedEtag = null;
					return;
				}
				node.epoch = lease.epoch + 1;
				node.leaseEtag = result.etag;
				node.lastServerDate = result.date;
				node.serverAt = this.T;
				node.state = 'promoting';
				node.lastConfirmed = this.T;
				this.stats.controlTakeovers++;
				this.#log(node.id, `won the CAS; promoting at epoch ${node.epoch}`);
				this.#timer(this.T + this.#rng.int(200, 800), () => {
					if (!node.alive || node.state !== 'promoting') return;
					node.state = 'primary';
					this.stats.controlPromotions++;
					this.#log(node.id, `control primary at epoch ${node.epoch}`);
					this.#scheduleControlFence(node);
				});
			},
		);
	}

	#renewControl(node: ControlNode): void {
		node.lastRenewSent = this.T;
		const etag = node.leaseEtag;
		if (!etag) return;
		this.#arbWriteControl(
			node.id,
			{ ifMatch: etag },
			{ epoch: node.epoch, holderNodeId: node.id, expiresAt: this.#serverNow(node.id) + SPEC.control.ttlMs },
			(err, result) => {
				if (!node.alive || node.state !== 'primary') return;
				if (err || !result) {
					this.#log(node.id, `renew failed: ${err ?? 'no answer'}`);
					return;
				}
				if (result.status !== 200) {
					this.#log(node.id, `renew answered ${result.status}`);
					this.#rereadControl(node, 'renew');
					return;
				}
				node.leaseEtag = result.etag;
				node.lastServerDate = result.date;
				node.serverAt = this.T;
				node.lastConfirmed = this.T;
				this.#scheduleControlFence(node);
			},
		);
	}

	#rereadControl(node: ControlNode, why: string): void {
		this.#arbReadControl(node.id, (err, lease, etag) => {
			if (!node.alive) return;
			if (err || !lease || !etag) {
				this.#log(node.id, `${why}: re-read failed (${err ?? 'no lease'}); waiting for the fence timer`);
				return;
			}
			if (lease.holderNodeId === node.id && lease.epoch === node.epoch) {
				node.leaseEtag = etag;
				node.lease = lease;
				this.#log(node.id, `${why}: re-read shows we still hold epoch ${node.epoch}; retrying`);
				return;
			}
			this.#fenceControl(node, `${why}: a higher epoch is held by ${lease.holderNodeId}`);
		});
	}

	#scheduleControlFence(node: ControlNode): void {
		this.#cancel(node.fenceTimer);
		node.fenceTimer = this.#timer(this.T + SPEC.control.fenceAfterMs, () => {
			if (node.state === 'primary' && this.T - node.lastConfirmed >= SPEC.control.fenceAfterMs)
				this.#fenceControl(node, 'no confirmation for 20 s');
		});
	}

	#fenceControl(node: ControlNode, reason: string): void {
		if (node.state !== 'primary') return;
		node.state = 'fenced';
		node.rejoinSince = this.T;
		this.#cancel(node.fenceTimer);
		this.#log(node.id, `fenced at epoch ${node.epoch}: ${reason}`);
	}

	// ── the database member machine (W9-SPEC §5) ────────────────────────────

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
	 * W9-SPEC §5.3. A primary may serve while it can prove the lease, OR while the arbiter is
	 * unreachable AND every member answered a keep-alive within one TTL (the H21 failsafe). This
	 * is the one place the failsafe changes the "stop within one TTL" rule; the control plane has
	 * no such exception (decision 1).
	 */
	#primaryProvable(member: DbMember): boolean {
		if (member.state !== 'primary') return false;
		const ttl = this.mutant === 'fence-25s' ? 25_000 : SPEC.db.ttlMs;
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
					this.#log(member.id, 'barrier acknowledged; schedule kills the primary before the close');
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

	/**
	 * W9-SPEC §5.5. A change is only started from a steady lease, and while it is open the lease is
	 * `changing` with an empty sync set, so no member may acquire automatically.
	 */
	#maybeStartSyncChange(member: DbMember): void {
		if (member.localAsync) return;
		if (member.durability !== 'sync') return;
		if ((member.lease?.syncState ?? 'steady') !== 'steady') return;
		const lost = member.effectiveSync !== null && this.#streamDown(member, member.effectiveSync);
		if (!this.#reconciler.available) {
			// Revision 2: the control plane is away. The node may apply the on_sync_loss setting
			// locally and report it, but it must not touch the lease.
			if (member.effectiveSync !== null && !lost) return;
			if (member.syncLostSince === 0) member.syncLostSince = this.T;
			if (this.T - member.syncLostSince >= SPEC.syncDowngradeAfterMs) this.#applyLocalSyncLoss(member);
			return;
		}
		if (lost) {
			if (member.syncLostSince === 0) {
				member.syncLostSince = this.T;
				if (member.syncDowngradeAt === 0 && this.#syncLoss === 'downgrade')
					member.syncDowngradeAt = this.T + SPEC.syncDowngradeAfterMs;
			}
			if (this.T - member.syncLostSince < 2000) return;
		} else if (member.effectiveSync !== null) {
			member.syncLostSince = 0;
			return;
		}
		if (member.effectiveSync === null && member.syncDowngradeAt === 0 && this.#syncLoss === 'downgrade')
			member.syncDowngradeAt = this.T + SPEC.syncDowngradeAfterMs;
		const target = this.#pickSyncTarget(member);
		if (target) {
			this.#openSyncChange(member, target.id);
		}
	}

	/**
	 * Revision 2: while the control plane is unreachable the primary may apply the on_sync_loss
	 * setting locally, before any lease CAS, and report the applied value with the ETag it last
	 * observed. The lease stays as it was until the control plane reconciles.
	 */
	#applyLocalSyncLoss(member: DbMember): void {
		if (member.localAsync || member.state !== 'primary') return;
		member.localAsync = true;
		member.syncLostSince = 0;
		member.syncDowngradeAt = 0;
		const reportEtag = member.leaseEtag ?? '';
		const buggy = this.mutant === 'node-applies-sync' || this.mutant === 'record-sync-on-stale';
		if (buggy) {
			const target =
				(['a', 'b'] as MemberId[]).find((id) => id !== member.id && id !== member.effectiveSync) ?? 'a';
			member.effectiveSync = target;
			member.durabilityEffective = 'sync';
			this.#reconciler.reports.push({ etag: reportEtag, applied: { sync: target }, at: this.T });
			this.#log(
				member.id,
				`control plane away; applied synchronous_standby_names = ${target} locally (mutant); report ${reportEtag}`,
			);
		} else {
			member.effectiveSync = null;
			member.durabilityEffective = 'async';
			this.#reconciler.reports.push({ etag: reportEtag, applied: 'async', at: this.T });
			this.#log(member.id, `control plane away; applied on_sync_loss async locally at ${reportEtag}; report queued`);
		}
		this.stats.localSyncLossApplied++;
		this.stats.syncReports++;
		this.#checkPendingAcks();
		if (this.#reconciler.available) this.#timer(this.T + 100, () => this.#reconcile());
	}

	#reconcile(): void {
		if (!this.#reconciler.available || this.#reconciler.reconciling) return;
		const reports = this.#reconciler.reports.splice(0);
		if (reports.length === 0) return;
		this.#reconciler.reconciling = true;
		let remaining = reports.length;
		const done = () => {
			remaining--;
			if (remaining > 0) return;
			this.#reconciler.reconciling = false;
			if (this.#reconciler.reports.length > 0) this.#timer(this.T + 1000, () => this.#reconcile());
		};
		for (const report of reports) {
			this.#arbReadDb('reconciler', (err, lease, etag) => {
				if (err || !lease || !etag) {
					this.#reconciler.reports.push(report);
					done();
					return;
				}
				this.#reconcileReport(report, lease, etag);
				done();
			});
		}
	}

	#reconcileReport(report: SyncReport, lease: DbLease, etag: string): void {
		const holder = this.db.find((m) => m.id === lease.holderNodeId);
		const holderServing = holder !== undefined && holder.state === 'primary' && holder.alive && this.T >= holder.frozenUntil;
		if (report.etag === etag) {
			this.stats.syncSameEtags++;
			this.stats.syncAlerts++;
			this.#log('reconciler', `report at ${report.etag}: same ETag; recording the applied value and alerting`);
			const applied = report.applied;
			if (typeof applied === 'object') this.#recordSync(holder, lease, etag, applied.sync, false);
			else this.#recordAsync(holder, lease, etag, applied);
			return;
		}
		this.stats.syncStaleReconciled++;
		this.stats.syncAlerts++;
		this.#log(
			'reconciler',
			`stale report ${report.etag} (current ${etag}): never recording sync; alert`,
		);
		if (this.mutant === 'record-sync-on-stale' && typeof report.applied === 'object') {
			this.#recordSync(holder, lease, etag, report.applied.sync, true);
			return;
		}
		const first = lease.sync[0];
		const named = lease.syncState === 'steady' && lease.sync.length === 1 && first !== undefined ? this.#dbMember(first) : null;
		if (holderServing && named && this.#healthyForSync(holder, named)) {
			this.stats.syncReopens++;
			this.#log('reconciler', `re-opening a fresh barrier to the healthy named member ${named.id}`);
			this.#openSyncChange(holder, named.id);
			return;
		}
		if (holderServing) {
			this.#recordAsync(holder, lease, etag, this.#syncLoss === 'downgrade' ? 'async' : 'block');
			return;
		}
		this.#log('reconciler', 'no serving holder; leaving the lease for the next primary');
	}

	#healthyForSync(holder: DbMember, peer: DbMember): boolean {
		return (
			peer.alive &&
			this.T >= peer.frozenUntil &&
			peer.streamFrom === holder.id &&
			(peer.state === 'streaming' || peer.state === 'rewind') &&
			this.#edge(holder.id, peer.id) === 'up'
		);
	}

	/** Revision 2's forbidden act: record `sync` from a report whose ETag is stale. */
	#recordSync(
		holder: DbMember | undefined,
		lease: DbLease,
		etag: string,
		member: MemberId,
		stale: boolean,
	): void {
		if (stale)
			this.#violate(
				'support',
				'stale-sync-recorded',
				`reconciler recorded sync {${member}} from a stale report at ${etag}`,
			);
		const body: DbLease = {
			generation: lease.generation,
			holderNodeId: lease.holderNodeId,
			expiresAt: Math.max(lease.expiresAt, this.T + SPEC.db.ttlMs),
			sync: [member],
			syncState: 'steady',
			durability: 'sync',
			durabilityEffective: 'sync',
			syncSetAt: this.T,
		};
		this.#arbWriteDb('reconciler', { ifMatch: etag }, body, (err, result) => {
			if (err || !result || result.status !== 200) {
				this.#log('reconciler', `recording sync {${member}} failed (${err ?? result?.status ?? 'no answer'}); retrying`);
				this.#reconciler.reports.push({ etag: '', applied: { sync: member }, at: this.T });
				if (this.#reconciler.available) this.#timer(this.T + 1000, () => this.#reconcile());
				return;
			}
			if (holder) {
				holder.lease = body;
				holder.leaseEtag = result.etag;
				holder.lastServerDate = result.date;
				holder.serverAt = this.T;
				holder.effectiveSync = member;
				holder.durability = 'sync';
				holder.durabilityEffective = 'sync';
				holder.localAsync = false;
				holder.changePhase = null;
				holder.changeTarget = null;
				holder.changeOld = null;
				holder.barrierSnapshot.clear();
				holder.syncDowngradeAt = 0;
				this.#checkPendingAcks();
			}
			this.#log('reconciler', `recorded sync {${member}}${stale ? ' (MUTANT, from a stale report)' : ''}`);
		});
	}

	#recordAsync(holder: DbMember | undefined, lease: DbLease, etag: string, outcome: 'async' | 'block'): void {
		const body: DbLease = {
			generation: lease.generation,
			holderNodeId: lease.holderNodeId,
			expiresAt: Math.max(lease.expiresAt, this.T + SPEC.db.ttlMs),
			sync: [],
			syncState: 'steady',
			durability: outcome === 'async' ? 'async' : 'sync',
			durabilityEffective: outcome === 'async' ? 'async' : 'sync',
			syncSetAt: this.T,
		};
		this.#arbWriteDb('reconciler', { ifMatch: etag }, body, (err, result) => {
			if (err || !result || result.status !== 200) {
				this.#log('reconciler', `recording ${outcome} failed (${err ?? result?.status ?? 'no answer'}); retrying`);
				this.#reconciler.reports.push({ etag: '', applied: outcome, at: this.T });
				if (this.#reconciler.available) this.#timer(this.T + 1000, () => this.#reconcile());
				return;
			}
			if (holder) {
				holder.lease = body;
				holder.leaseEtag = result.etag;
				holder.lastServerDate = result.date;
				holder.serverAt = this.T;
				holder.effectiveSync = null;
				holder.durability = body.durability;
				holder.durabilityEffective = body.durabilityEffective;
				holder.localAsync = false;
				holder.changePhase = null;
				holder.changeTarget = null;
				holder.changeOld = null;
				holder.barrierSnapshot.clear();
				holder.syncDowngradeAt = 0;
				this.#checkPendingAcks();
			}
			this.#log('reconciler', `recorded ${outcome}: sync [], steady`);
		});
	}

	#streamDown(primary: DbMember, peerId: MemberId): boolean {
		const peer = this.#dbMember(peerId);
		if (!peer.alive || this.T < peer.frozenUntil) return true;
		if (peer.streamFrom !== primary.id) return true;
		if (peer.state !== 'streaming' && peer.state !== 'rewind') return true;
		return this.#edge(primary.id, peer.id) !== 'up';
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

	/** Step 1 of §5.5: open the transition (sync [], changing) before touching the setting. */
	#openSyncChange(member: DbMember, target: MemberId): void {
		if (member.state !== 'primary' || !member.leaseEtag) return;
		if (!this.#reconciler.available) return;
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
		this.#arbWriteDb(member.id, { ifMatch: member.leaseEtag }, body, (err, result) => {
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
			member.changeTimeoutAt = this.T + 30_000;
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
		});
	}

	/** Step 2 of §5.5: switch the setting, then issue the barrier the primary watches. */
	#startSwitching(member: DbMember): void {
		if (member.state !== 'primary' || member.changePhase !== 'opening') return;
		const target = member.changeTarget;
		if (!target) {
			this.#timeoutSyncChange(member);
			return;
		}
		member.changePhase = 'switching';
		member.effectiveSync = target;
		member.localAsync = false;
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
		const peer = this.#dbMember(target);
		if (!peer.alive || this.T < peer.frozenUntil) return false;
		for (const id of member.barrierSnapshot) if (!peer.history.has(id)) return false;
		return true;
	}

	/** Step 3 of §5.5: only now is the new member eligible. */
	#closeSyncChange(member: DbMember, target: MemberId | null): void {
		if (member.state !== 'primary' || !member.leaseEtag || !target) return;
		if (!this.#reconciler.available) return;
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
		this.#arbWriteDb(member.id, { ifMatch: member.leaseEtag }, body, (err, result) => {
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
		});
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
			const peer = this.#dbMember(old);
			const healthy =
				peer.alive && this.T >= peer.frozenUntil && peer.streamFrom === member.id && this.#edge(member.id, old) === 'up';
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
		if (!this.#reconciler.available) return;
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
		this.#arbWriteDb(member.id, { ifMatch: member.leaseEtag }, body, (err, result) => {
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
			member.localAsync = false;
			member.changePhase = null;
			member.changeTarget = null;
			member.changeOld = null;
			member.barrierSnapshot.clear();
			member.syncDowngradeAt = 0;
			this.stats.syncChangesFellBack++;
			this.#log(member.id, `fallback: sync {${old}}, syncState steady`);
			this.#checkPendingAcks();
		});
	}

	/** `on_sync_loss: block`: close the transition steady with no eligible member and no downgrade. */
	#blockSyncChange(member: DbMember): void {
		if (member.state !== 'primary' || !member.leaseEtag) return;
		if (!this.#reconciler.available) return;
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
		this.#arbWriteDb(member.id, { ifMatch: member.leaseEtag }, body, (err, result) => {
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
			member.localAsync = false;
			member.changePhase = null;
			member.changeTarget = null;
			member.changeOld = null;
			member.barrierSnapshot.clear();
			member.syncDowngradeAt = 0;
			this.#log(member.id, 'block: sync [], syncState steady; no eligible member');
		});
	}

	#downgrade(member: DbMember): void {
		if (member.state !== 'primary' || !member.leaseEtag) return;
		if (!this.#reconciler.available) return;
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
		this.#arbWriteDb(member.id, { ifMatch: member.leaseEtag }, body, (err, result) => {
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
		});
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
		this.#arbWriteDb(member.id, { ifMatch: member.leaseEtag }, body, (err, result) => {
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
			if (this.#verbose) this.#log(member.id, `renewed at ${member.generation}; lease expires ${(body.expiresAt / 1000).toFixed(1)} s`);
			this.#scheduleDbFence(member);
		});
	}

	#rereadDb(member: DbMember, why: string): void {
		this.#arbReadDb(member.id, (err, lease, etag, date) => {
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
				member.lastRenewOk = true;
				this.#adoptStoredLease(member, lease);
				this.#log(member.id, `${why}: still the holder at generation ${member.generation}; retrying`);
				return;
			}
			this.#fence(member, `${why}: generation ${lease.generation} is held by ${lease.holderNodeId}`);
		});
	}

	/**
	 * After a lost CAS response the store may already be in a different transition state than the
	 * primary's local view. Adopt it: a `changing` lease with no local transition resumes one (the
	 * target is not recorded, so pick again); a `steady` lease ends a local transition whose close
	 * was applied but whose answer was lost.
	 */
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
		member.changeTimeoutAt = this.T + 30_000;
		if (member.changeTarget) this.#startSwitching(member);
		else if (this.#syncLoss === 'downgrade') this.#downgrade(member);
		else this.#blockSyncChange(member);
	}

	#scheduleDbFence(member: DbMember): void {
		this.#cancel(member.fenceTimer);
		if (this.mutant === 'fence-wall-clock' || this.mutant === 'fence-25s') {
			// The mutant reads the wall clock or a loose TTL on the 1 s tick; no exact deadline.
			return;
		}
		member.fenceTimer = this.#timer(Math.max(this.T, member.lastProof + SPEC.db.ttlMs), () => {
			if (member.state === 'primary' && !this.#primaryProvable(member))
				this.#fence(member, 'no confirmation for one TTL and the failsafe does not hold');
		});
	}

	#fence(member: DbMember, reason: string): void {
		if (member.state !== 'primary') return;
		member.state = 'fencing';
		this.#cancel(member.fenceTimer);
		this.#log(member.id, `fencing at generation ${member.generation}: ${reason}`);
		this.#timer(this.T + this.#rng.int(50, 300), () => {
			if (member.state !== 'fencing') return;
			member.state = 'fenced';
			member.rewindAt = 0;
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
			this.T >= primary.frozenUntil;
		if (streamUp && primary) {
			if (member.generation < primary.generation) {
				member.generation = primary.generation;
				this.#log(member.id, `following generation ${primary.generation}`);
			}
			return;
		}
		const serving = primary !== null && primary.alive && this.T >= primary.frozenUntil;
		const lagged = this.T < (this.#lagged.get(member.id) ?? 0);
		if (member.streamFrom !== null) {
			member.streamFrom = null;
			member.streamEpoch++;
			this.#log(member.id, 'WAL receiver down');
			if (!lagged && serving && primary && this.#edge(primary.id, member.id) === 'up') {
				member.streamFrom = primary.id;
				member.streamEpoch++;
				member.generation = primary.generation;
				member.history = new Set(primary.history);
				this.#log(member.id, `re-attached to ${primary.id} at generation ${primary.generation}`);
				return;
			}
		} else if (!lagged && serving && primary && this.#edge(primary.id, member.id) === 'up') {
			member.streamFrom = primary.id;
			member.streamEpoch++;
			member.generation = primary.generation;
			member.history = new Set(primary.history);
			this.#log(member.id, `attached to ${primary.id} at generation ${primary.generation}`);
			return;
		}
		this.#arbReadDb(member.id, (err, lease, etag, date) => {
			if (!member.alive || member.state !== 'streaming') return;
			if (err || !lease || !etag) return;
			member.lease = lease;
			member.leaseEtag = etag;
			member.lastServerDate = date ?? this.T;
			member.serverAt = this.T;
			if (lease.generation < member.generation) return;
			if (this.mutant !== 'promote-while-changing' && lease.syncState !== 'steady') return;
			if ((date ?? this.T) < lease.expiresAt) return;
			if (this.mutant === 'promote-while-changing' && lease.syncState === 'changing') {
				// The buggy member ignores §5.5's non-promotable window.
			} else if (this.mutant !== 'ignore-eligibility') {
				const eligible = lease.durabilityEffective === 'async' || lease.sync.includes(member.id);
				if (!eligible) return;
			}
			if (this.mutant !== 'ignore-keepalive' && this.T - member.lastAnsweredToPrimary < SPEC.db.ttlMs) return;
			if (member.candidateBusy) return;
			member.candidateBusy = true;
			member.state = 'candidate';
			const sentAt = this.T;
			const sentAtWall = this.#wall(member.id);
			const gen = this.mutant === 'cas-same-generation' ? lease.generation : lease.generation + 1;
			const body: DbLease = {
				generation: gen,
				holderNodeId: member.id,
				expiresAt: this.#serverNow(member.id) + SPEC.db.ttlMs,
				sync: lease.sync.filter((id) => id !== member.id),
				syncState: 'steady',
				durability: lease.durability,
				durabilityEffective: lease.durabilityEffective,
				syncSetAt: this.T,
			};
			this.#log(member.id, `candidate at generation ${gen} (lease ${lease.generation}, sync {${lease.sync.join(',')}})`);
			this.#arbWriteDb(member.id, { ifMatch: etag }, body, (writeErr, result) => {
				member.candidateBusy = false;
				if (!member.alive) return;
				if (writeErr || !result) {
					member.state = 'streaming';
					this.#log(member.id, `acquire failed: ${writeErr ?? 'no answer'}`);
					return;
				}
				if (result.status !== 200) {
					member.state = 'streaming';
					this.#log(member.id, 'lost the CAS; re-following');
					return;
				}
				if (this.#acquiredTooEarly(member, gen)) return;
				member.state = 'promoting';
				member.acquire = { lease, body, gen, etag: result.etag ?? '', date: result.date, sentAt, sentAtWall };
				member.lastServerDate = result.date;
			member.serverAt = this.T;
				member.leaseEtag = result.etag;
				const promoteDelay = this.#rng.int(300, Math.max(400, SPEC.db.promoteBudgetMs));
				this.#log(member.id, `won the CAS at generation ${gen}; pg_ctl promote (${promoteDelay} ms)`);
				this.#timer(this.T + promoteDelay, () => this.#promote(member));
			});
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
		member.lastRenewOk = true;
		member.durability = acquired.body.durability;
		member.durabilityEffective = acquired.body.durabilityEffective;
		const inherited = acquired.body.sync;
		member.effectiveSync = inherited[0] ?? null;
		member.syncDowngradeAt = 0;
		member.syncLostSince = 0;
		member.localAsync = false;
		member.changePhase = null;
		member.changeTarget = null;
		member.changeOld = null;
		member.barrierSnapshot.clear();
		member.killAfterOpen = null;
		member.killAfterBarrier = false;
		this.stats.promotions++;
		this.#promotions.push(this.T);
		this.#log(
			member.id,
			`PRIMARY at generation ${member.generation}; effective sync ${member.effectiveSync ?? 'none'}`,
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

		if (acquired.lease.syncState !== 'steady')
			this.#violate(
				'I12',
				'promotion-during-sync-change',
				`${member.id} promoted at generation ${acquired.gen} while the lease was syncState ${acquired.lease.syncState}`,
			);
		else if (acquired.lease.durability === 'sync' && !acquired.lease.sync.includes(member.id))
			this.#violate(
				'I12',
				'promotion-not-in-sync-set',
				`${member.id} promoted at generation ${acquired.gen} from a lease whose sync set is {${acquired.lease.sync.join(',')}}`,
			);
		for (const [id, ack] of this.#acked) {
			if (ack.durability !== 'sync') continue;
			if (acquired.body.durabilityEffective !== 'sync') continue;
			if (!member.history.has(id))
				this.#violate(
					'I13',
					'missing-ack-at-promotion',
					`${member.id} promoted at generation ${member.generation} without acknowledged commit #${id}; it was acked by ${ack.member} at generation ${ack.gen} while ${ack.member === 'p' ? 'synchronous_standby_names was b' : `the sync standby was ${ack.member}`}`,
				);
			if (!member.history.has(id)) this.#missingAcksReported.add(id);
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
			if (commit.waitFor && this.#dbMember(commit.waitFor).history.has(commit.id)) this.#ack(commit);
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
			const primary = this.#dbMember(commit.acceptedBy);
			const highest = this.#highestPrimary();
			// A fenced node must not hand out authority. A commit whose sync flush lands after
			// its primary fenced is only acknowledged if the member now serving as primary has it;
			// otherwise the client must not be told it committed.
			const acceptedServing = primary.state === 'primary' && this.#primaryProvable(primary);
			if (!acceptedServing && !(highest && highest.history.has(commit.id))) continue;
			if (primary.durabilityEffective !== 'sync') {
				// The downgrade completed: commits that were blocked on the lost sync standby are
				// now acknowledged under the recorded async durability.
				this.#ack(commit);
				continue;
			}
			const waitFor = commit.waitFor;
			if (!waitFor) continue;
			if (this.#dbMember(waitFor).history.has(commit.id)) this.#ack(commit);
		}
	}

	/**
	 * W9-SPEC §5.3: a member that answered a keep-alive within one TTL must not acquire. The normal
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
		return this.mutant !== 'ignore-keepalive';
	}

	#ack(commit: Commit): void {
		if (commit.acked) return;
		commit.acked = true;
		commit.ackAt = this.T;
		const member = commit.acceptedBy;
		if (!member) return;
		// The obligation is the durability in force when the client is told it committed: a commit
		// accepted under sync but first acknowledged after the recorded downgrade is async.
		const durability = this.#dbMember(member).durabilityEffective;
		this.#acked.set(commit.id, { gen: commit.gen, member, t: this.T, durability });
		this.stats.acks++;
		if (this.#verbose) this.#log(commit.waitFor ? commit.waitFor : member, `commit #${commit.id} acknowledged (generation ${commit.gen})`);
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

	// ── the consumer (W9-SPEC §5.6) ─────────────────────────────────────────

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
			for (const [id, answer] of answers) {
				if (answer.role !== 'primary') continue;
				if (!best || answer.gen > best.gen) best = { id, gen: answer.gen };
			}
			this.#target = best?.id ?? null;
			if (!best) this.stats.failClosedPolls++;
			this.#polling = false;
			this.#timer(this.T + this.#rng.int(SPEC.discoveryMinMs, SPEC.discoveryMaxMs), () => this.#consumerPoll());
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
		const member = this.#dbMember(target);
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

	// ── test seams (used only by the checker self-tests) ────────────────────

	/** Force the observed state, to prove the I3 checker is not vacuous. */
	forcePrimaryForTest(id: MemberId, generation: number): void {
		const member = this.#dbMember(id);
		member.state = 'primary';
		member.generation = generation;
	}

	/** Run the invariant pass once, for the checker self-tests. */
	checkNowForTest(): Violation[] {
		this.#observe();
		return this.violations;
	}
}
