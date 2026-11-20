/**
 * A deterministic discrete-event world for `ControlLease` (packages/core/src/ha-lease.ts).
 *
 * Real time is a virtual millisecond counter. Each contender gets its own monotonic clock (bounded
 * rate drift) and wall clock (offset plus steps); the store stamps responses with its own clock
 * (jitter, truncated to whole seconds like an HTTP `Date` header). The store is a linearizable
 * single-object map with conditional PUT; every request crosses a fake network with per-leg
 * delays, partitions, lost responses and timeouts. The lease code runs unmodified: its awaits
 * resolve only when the event loop delivers a response, so one seed gives one schedule.
 *
 * Properties are checked after every event and at every proof deadline:
 *   I1   at most one contender acts as primary at any instant;
 *   I1s  a contender acts only while the store names it, unreleased, at its epoch;
 *   I2   the stored epoch never decreases, rises by exactly 1 per new holder, and no contender's
 *        view of it goes down within one process lifetime;
 *   I13  a contender acts at most `i13BoundMs(profile)` after the store applied its last proof
 *        (renewal, takeover or bootstrap): fenceAfterMs on its own clock plus the longest the
 *        profile lets a response lag behind the store (one return leg and one freeze), capped at
 *        the TTL. A primary that cannot prove its lease stops within that window.
 * "Acting" is `holds()` on a live, unfrozen process that is not mid-release (release() requires
 * the caller to have stopped writes first, so the sim stops acting before calling it).
 */
import type { ConditionalStore, ConditionalWrite, VersionedRead, WriteCondition } from '../../../packages/core/src/object-store.ts';
import type { FaultKind, Profile } from './profiles.ts';
import { Rng } from './rng.ts';

export interface LeaseStatusLike {
	role: string;
	epoch: number;
	holderNodeId: string | null;
	reason: string;
}

export interface LeaseLike {
	readonly policy: { ttlMs: number; fenceAfterMs: number; takeoverAfterMs: number };
	tick(options?: { mayTakeOver?: boolean }): Promise<LeaseStatusLike>;
	bootstrap(epoch?: number): Promise<LeaseStatusLike>;
	release(): Promise<LeaseStatusLike>;
	forcePromote(): Promise<LeaseStatusLike>;
	resetAfterReseed(): void;
	holds(): boolean;
	status(): LeaseStatusLike;
}

export interface LeaseModule {
	ControlLease: new (options: {
		store: ConditionalStore;
		nodeId: string;
		monotonic?: () => number;
		wallClock?: () => number;
	}) => LeaseLike;
}

/** How a node-targeted fault picks its node (see `Profile.targeting`). */
export type FaultTarget = 'random' | 'holder' | 'previous';

export interface Fault {
	id: number;
	at: number;
	kind: FaultKind;
	/** The random node; `holder` and `previous` faults fall back to it when they have no better one. */
	node: number;
	target: FaultTarget;
	durationMs: number;
	/** Kind-specific number: max leg, status, delta, probability ×1000, frontend offset. */
	value: number;
	flag: boolean;
}

export interface Violation {
	property: 'I1' | 'I1s' | 'I2' | 'I13' | 'harness';
	t: number;
	message: string;
}

export interface TraceEvent {
	t: number;
	node: string;
	text: string;
	/** Verbose-only lines (every request) are hidden from the default trace. */
	verbose?: boolean;
	/** A renewal by the current holder, collapsed in the printed trace. */
	renewal?: boolean;
}

export interface RunResult {
	seed: number;
	profile: string;
	contenders: number;
	faults: Fault[];
	violation: Violation | null;
	/** End-of-run liveness: who acts after every fault healed. Reported, never a failure. */
	liveness: { primary: string | null; stalled: boolean; roles: string[] };
	events: number;
	trace: TraceEvent[];
	takeovers: number;
}

const KEY = 'yoal/ha/control-lease.json';

interface StoredVersion {
	body: string;
	etag: string;
	appliedAt: number;
}

interface Contender {
	index: number;
	id: string;
	lease: LeaseLike;
	incarnation: number;
	alive: boolean;
	frozenUntil: number;
	releasing: boolean;
	defaultGate: boolean;
	mayTakeOver: boolean;
	gateUntil: number;
	running: boolean;
	waiting: boolean;
	monoBase: number;
	rate: number;
	wallOffset: number;
	lastRole: string;
	lastActing: boolean;
	maxEpochSeen: number;
	reseedPending: boolean;
}

interface PathState {
	partitionUntil: number;
	partitionBlackhole: boolean;
	slowUntil: number;
	slowMaxLeg: number;
	staleUntil: number;
	fiveXXUntil: number;
	fiveXXStatus: number;
	fiveXXAfterApply: boolean;
	throttleUntil: number;
	lostUntil: number;
	lostP: number;
}

interface QueueItem {
	at: number;
	seq: number;
	fn: () => void;
}

/** A binary min-heap on (at, seq): equal times run in scheduling order, so runs are deterministic. */
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

function parse(body: string): { epoch: number; holderNodeId: string; released: boolean } | null {
	try {
		const v = JSON.parse(body) as { epoch?: unknown; holderNodeId?: unknown; released?: unknown };
		if (typeof v.epoch !== 'number' || typeof v.holderNodeId !== 'string') return null;
		return { epoch: v.epoch, holderNodeId: v.holderNodeId, released: v.released === true };
	} catch {
		return null;
	}
}

/** Fault kinds that act on one node (and so can be aimed at the holder). */
const NODE_FAULTS: ReadonlySet<FaultKind> = new Set<FaultKind>([
	'partition',
	'slow',
	'freeze',
	'crash',
	'store-5xx',
	'put-throttle',
	'lost-response',
	'clock-step',
	'stale-reads',
]);

/**
 * The I13 bound for a profile: the documented fenceAfterMs on the slowest allowed monotonic clock,
 * plus the longest a response can reach the process after the store applied it (one return leg
 * and one freeze), capped at the TTL (the bound the lease promises whatever the world does).
 */
export function i13BoundMs(profile: Profile): number {
	const fence = Math.ceil(profile.spec.fenceAfterMs / (1 - profile.driftPpm * 1e-6));
	const lag = Math.max(profile.maxSlowLegMs, profile.normalLegMs[1]) + profile.maxFreezeMs;
	return Math.min(profile.spec.ttlMs, fence + lag + 1);
}

/** Fault kinds that act on one node pick it; the others ignore `node`. */
export function generateFaults(seed: number, profile: Profile, contenders: number): Fault[] {
	const rng = new Rng(seed, 1);
	const count = rng.int(profile.faultsPerRun[0], profile.faultsPerRun[1]);
	const kinds = Object.entries(profile.kinds) as [FaultKind, number][];
	const total = kinds.reduce((s, [, w]) => s + w, 0);
	const faults: Fault[] = [];
	for (let id = 0; id < count; id++) {
		let roll = rng.float() * total;
		let kind: FaultKind = kinds[0]?.[0] ?? 'partition';
		for (const [k, w] of kinds) {
			roll -= w;
			if (roll < 0) {
				kind = k;
				break;
			}
		}
		let at = rng.int(10_000, profile.faultWindowMs);
		const node = rng.int(0, contenders - 1);
		const targetRoll = rng.float();
		const followGap = rng.int(0, profile.targeting.followGapMs);
		let target: FaultTarget = 'random';
		if (NODE_FAULTS.has(kind)) {
			if (targetRoll < profile.targeting.holder) target = 'holder';
			else if (targetRoll < profile.targeting.holder + profile.targeting.previous && faults.length > 0) {
				target = 'previous';
				at = Math.min(profile.faultWindowMs, (faults.at(-1) as Fault).at + followGap);
			}
		}
		let durationMs = rng.logInt(1_000, 90_000);
		let value = 0;
		let flag = rng.chance(0.5);
		switch (kind) {
			case 'slow':
				value = rng.int(500, profile.maxSlowLegMs);
				break;
			case 'freeze':
				durationMs = rng.logInt(200, profile.maxFreezeMs);
				break;
			case 'crash':
				durationMs = rng.logInt(2_000, 120_000);
				break;
			case 'store-5xx':
				value = rng.pick([500, 502, 503]);
				flag = rng.chance(0.3); // applied before the error
				break;
			case 'lost-response':
				value = rng.int(200, 1000); // probability ×1000
				break;
			case 'store-501':
				durationMs = rng.logInt(1_000, 30_000);
				break;
			case 'spurious-409':
				value = rng.int(100, 600);
				break;
			case 'clock-step':
				value = (rng.chance(0.6) ? -1 : 1) * rng.logInt(500, profile.maxClockStepMs);
				durationMs = 0;
				break;
			case 'store-clock-step':
				// flag: the whole store steps to a new offset; otherwise one frontend (node = its index).
				value = frontendOffset(rng, profile);
				durationMs = 0;
				break;
			case 'gate':
				flag = !rng.chance(0.7); // usually closes the promotion gate
				break;
			case 'release':
				durationMs = 0;
				break;
			case 'force-promote':
				durationMs = rng.logInt(10_000, 120_000); // how long the stopped holder stays down
				value = rng.int(1_000, 10_000); // operator delay before promoting
				break;
			case 'stale-reads':
				value = rng.int(200, 800);
				break;
			case 'no-date':
				durationMs = rng.logInt(1_000, 20_000);
				break;
			default:
				break;
		}
		faults.push({ id, at, kind, node, target, durationMs, value, flag });
	}
	return faults.sort((a, b) => a.at - b.at || a.id - b.id);
}

/** A frontend clock offset within the profile's skew bound, favouring its extremes. */
function frontendOffset(rng: Rng, profile: Profile): number {
	const max = Math.max(0, profile.storeSkewMs - profile.storeJitterMs);
	const roll = rng.float();
	if (roll < 0.3) return -max;
	if (roll < 0.6) return max;
	return rng.int(-max, max);
}

export function contenderCount(seed: number, profile: Profile): number {
	return new Rng(seed, 0).int(profile.contenders[0], profile.contenders[1]);
}

export interface RunOptions {
	seed: number;
	profile: Profile;
	module: LeaseModule;
	/** Fault ids to keep; all when absent (used to shrink a failing schedule). */
	keep?: ReadonlySet<number>;
	contenders?: number;
	/** Record verbose (per-request) trace lines. */
	verbose?: boolean;
}

export class World {
	readonly profile: Profile;
	readonly seed: number;
	readonly trace: TraceEvent[] = [];
	readonly contenders: Contender[] = [];
	readonly faults: Fault[];
	T = 0;
	violation: Violation | null = null;
	events = 0;
	takeovers = 0;

	#queue = new EventQueue();
	#rng: Rng;
	#module: LeaseModule;
	#verbose: boolean;
	#versions: StoredVersion[] = [];
	#etagCounter = 0;
	#paths: PathState[] = [];
	#store501Until = 0;
	#store409Until = 0;
	#store409P = 0;
	#noDateUntil = 0;
	/** Each store frontend's clock offset from true time. */
	#frontends: number[] = [];
	#frontendRng: Rng;
	/** Store-apply time of the last write naming each node id as an unreleased holder. */
	#lastProof = new Map<string, number>();
	readonly i13BoundMs: number;
	/** The node each injected fault hit, for `previous`-targeted faults. */
	#hit = new Map<number, number>();
	#healAt: number;

	constructor(options: RunOptions) {
		this.profile = options.profile;
		this.seed = options.seed;
		this.#module = options.module;
		this.#verbose = options.verbose ?? false;
		const n = options.contenders ?? contenderCount(options.seed, options.profile);
		const all = generateFaults(options.seed, options.profile, n);
		this.faults = options.keep ? all.filter((f) => options.keep?.has(f.id)) : all;
		const clocks = new Rng(options.seed, 2);
		this.#rng = new Rng(options.seed, 3);
		for (let i = 0; i < Math.max(1, options.profile.storeFrontends); i++) this.#frontends.push(frontendOffset(clocks, options.profile));
		this.#frontendRng = new Rng(options.seed, 4);
		this.i13BoundMs = i13BoundMs(options.profile);
		this.#healAt = options.profile.faultWindowMs + 150_000;
		for (let i = 0; i < n; i++) {
			const drift = (clocks.float() * 2 - 1) * options.profile.driftPpm * 1e-6;
			const gate = i === 0 || clocks.chance(0.85);
			const c: Contender = {
				index: i,
				id: `n${i}`,
				lease: null as unknown as LeaseLike,
				incarnation: 0,
				alive: true,
				frozenUntil: 0,
				releasing: false,
				defaultGate: gate,
				mayTakeOver: gate,
				gateUntil: 0,
				running: false,
				waiting: false,
				monoBase: clocks.int(1_000, 10_000_000),
				rate: 1 + drift,
				wallOffset: clocks.int(-options.profile.wallSkewMs, options.profile.wallSkewMs),
				lastRole: 'unknown',
				lastActing: false,
				maxEpochSeen: 0,
				reseedPending: false,
			};
			this.contenders.push(c);
			this.#paths.push({
				partitionUntil: 0,
				partitionBlackhole: false,
				slowUntil: 0,
				slowMaxLeg: 0,
				staleUntil: 0,
				fiveXXUntil: 0,
				fiveXXStatus: 500,
				fiveXXAfterApply: false,
				throttleUntil: 0,
				lostUntil: 0,
				lostP: 0,
			});
			this.#spawn(c);
		}
	}

	// ── clocks ─────────────────────────────────────────────────────────────

	#mono(c: Contender): number {
		return c.monoBase + this.T * c.rate;
	}

	#wall(c: Contender): number {
		return 1_700_000_000_000 + this.T + c.wallOffset;
	}

	/** The `Date` of one response: a random frontend's clock, jittered, truncated to the second. */
	#storeDate(): number | null {
		if (this.T < this.#noDateUntil) return null;
		const offset = this.#frontends[this.#frontendRng.int(0, this.#frontends.length - 1)] ?? 0;
		const jitter = this.#frontendRng.int(-this.profile.storeJitterMs, this.profile.storeJitterMs);
		return Math.floor((1_700_000_000_000 + this.T + offset + jitter) / 1000) * 1000;
	}

	// ── logging ────────────────────────────────────────────────────────────

	#log(node: string, text: string, extra: { verbose?: boolean; renewal?: boolean } = {}): void {
		if (extra.verbose && !this.#verbose) return;
		this.trace.push({ t: this.T, node, text, ...extra });
	}

	#fail(property: Violation['property'], message: string): void {
		if (this.violation) return;
		this.violation = { property, t: this.T, message };
		this.#log('!', `VIOLATION ${property}: ${message}`);
	}

	// ── contenders ─────────────────────────────────────────────────────────

	#spawn(c: Contender): void {
		c.incarnation++;
		const inc = c.incarnation;
		c.lease = new this.#module.ControlLease({
			store: this.#storeFor(c, inc),
			nodeId: c.id,
			monotonic: () => this.#mono(c),
			wallClock: () => this.#wall(c),
		});
		c.alive = true;
		c.running = false;
		c.waiting = false;
		c.releasing = false;
		c.lastRole = 'unknown';
		c.lastActing = false;
		c.maxEpochSeen = 0;
		c.reseedPending = false;
	}

	#storeFor(c: Contender, inc: number): ConditionalStore {
		return {
			readVersioned: (key: string) => this.#request(c, inc, { op: 'read', key }) as Promise<VersionedRead>,
			writeConditional: (key: string, body: string, condition: WriteCondition) =>
				this.#request(c, inc, { op: 'write', key, body, condition }) as Promise<ConditionalWrite>,
		};
	}

	#acting(c: Contender): boolean {
		return c.alive && this.T >= c.frozenUntil && !c.releasing && c.lease.holds();
	}

	/** Start one async lease action; continuations run inside `#settle`. */
	#start(c: Contender, label: string, action: (lease: LeaseLike) => Promise<LeaseStatusLike>, after?: () => void): boolean {
		if (!c.alive || this.T < c.frozenUntil || c.running) return false;
		const inc = c.incarnation;
		c.running = true;
		c.waiting = false;
		this.#log(c.id, label, { verbose: label === 'tick' });
		action(c.lease).then(
			() => {
				if (inc !== c.incarnation) return;
				c.running = false;
				after?.();
			},
			(error: unknown) => {
				if (inc !== c.incarnation) return;
				c.running = false;
				this.#log(c.id, `${label} threw: ${error instanceof Error ? error.message : String(error)}`);
				after?.();
			},
		);
		return true;
	}

	// ── the store and the network ──────────────────────────────────────────

	#leg(c: Contender): number {
		const path = this.#paths[c.index] as PathState;
		if (this.T < path.slowUntil) return this.#rng.int(200, path.slowMaxLeg);
		return this.#rng.logInt(this.profile.normalLegMs[0], this.profile.normalLegMs[1]);
	}

	#request(
		c: Contender,
		inc: number,
		req: { op: 'read'; key: string } | { op: 'write'; key: string; body: string; condition: WriteCondition },
	): Promise<VersionedRead | ConditionalWrite> {
		return new Promise((resolve, reject) => {
			c.waiting = true;
			const sentAt = this.T;
			const path = this.#paths[c.index] as PathState;
			let settled = false;
			const describe = req.op === 'read' ? 'GET' : `PUT ${'ifMatch' in req.condition ? `If-Match ${req.condition.ifMatch}` : 'If-None-Match *'}`;
			this.#log(c.id, `→ ${describe}`, { verbose: true });

			const deliver = (fn: () => void, what: string) => {
				const attempt = () => {
					if (settled) return;
					if (inc !== c.incarnation || !c.alive) {
						settled = true;
						return;
					}
					if (this.T < c.frozenUntil) {
						this.#queue.push(c.frozenUntil, attempt);
						return;
					}
					settled = true;
					c.waiting = false;
					this.#log(c.id, `← ${describe}: ${what}`, { verbose: true });
					fn();
				};
				attempt();
			};
			const timeout = (why: string) => () => deliver(() => reject(new Error(why)), why);
			if (Number.isFinite(this.profile.clientTimeoutMs))
				this.#queue.push(sentAt + this.profile.clientTimeoutMs, timeout('request timed out'));

			if (this.T < path.partitionUntil) {
				// Refused fast, or black-holed until the client timeout (never, without one).
				if (!path.partitionBlackhole) this.#queue.push(this.T + this.#rng.int(1, 30), timeout('connection refused (partition)'));
				return;
			}
			const arrival = this.T + this.#leg(c);
			this.#queue.push(arrival, () => {
				const answer = this.#serve(c, req);
				// A partition that began mid-flight, or a lost-response episode, drops the answer.
				const lost =
					this.T < path.partitionUntil ||
					(this.T < path.lostUntil && this.#rng.float() < path.lostP);
				if (lost) {
					if (!Number.isFinite(this.profile.clientTimeoutMs) && path.partitionBlackhole) return;
					if (!Number.isFinite(this.profile.clientTimeoutMs))
						this.#queue.push(this.T + this.#rng.int(1_000, 30_000), timeout('connection reset'));
					return;
				}
				const back = this.T + this.#leg(c);
				this.#queue.push(back, () => {
					if (this.T < path.partitionUntil) {
						if (!Number.isFinite(this.profile.clientTimeoutMs))
							this.#queue.push(this.T + this.#rng.int(1_000, 30_000), timeout('connection reset'));
						return;
					}
					deliver(() => resolve(answer), String(answer.status));
				});
			});
		});
	}

	/** The store applies or answers one request at the current instant (linearization point). */
	#serve(
		c: Contender,
		req: { op: 'read'; key: string } | { op: 'write'; key: string; body: string; condition: WriteCondition },
	): VersionedRead | ConditionalWrite {
		const path = this.#paths[c.index] as PathState;
		const current = this.#versions.at(-1);
		if (req.key !== KEY) throw new Error(`unexpected key ${req.key}`);
		if (this.T < path.fiveXXUntil && !(req.op === 'write' && path.fiveXXAfterApply)) {
			return req.op === 'read'
				? { status: path.fiveXXStatus, body: null, etag: null, serverDate: this.#storeDate() }
				: { status: path.fiveXXStatus, etag: null, serverDate: this.#storeDate() };
		}
		if (req.op === 'read') {
			let version = current;
			if (this.T < path.staleUntil && this.#versions.length > 1 && this.#rng.chance(0.6)) {
				version = this.#versions[Math.max(0, this.#versions.length - 1 - this.#rng.int(1, 3))];
			}
			if (!version) return { status: 404, body: null, etag: null, serverDate: this.#storeDate() };
			return { status: 200, body: version.body, etag: version.etag, serverDate: this.#storeDate() };
		}
		if (this.T < path.throttleUntil) return { status: 503, etag: null, serverDate: this.#storeDate() };
		if (this.T < this.#store501Until) return { status: 501, etag: null, serverDate: this.#storeDate() };
		if (this.T < this.#store409Until && this.#rng.float() < this.#store409P)
			return { status: 409, etag: null, serverDate: this.#storeDate() };
		const matches = 'ifNoneMatch' in req.condition ? current === undefined : current?.etag === req.condition.ifMatch;
		if (!matches) return { status: 412, etag: null, serverDate: this.#storeDate() };
		const etag = `"e${++this.#etagCounter}"`;
		this.#apply(c, req.body, etag, current);
		if (this.T < path.fiveXXUntil) return { status: path.fiveXXStatus, etag: null, serverDate: this.#storeDate() };
		return { status: 200, etag, serverDate: this.#storeDate() };
	}

	#apply(c: Contender, body: string, etag: string, previous: StoredVersion | undefined): void {
		const next = parse(body);
		const prev = previous ? parse(previous.body) : null;
		this.#versions.push({ body, etag, appliedAt: this.T });
		if (this.#versions.length > 8) this.#versions.shift();
		if (!next) {
			this.#fail('harness', `${c.id} wrote an unparseable lease: ${body}`);
			return;
		}
		const renewal = prev !== null && prev.holderNodeId === next.holderNodeId && prev.epoch === next.epoch && !next.released;
		this.#log(
			c.id,
			`store applied ${etag}: epoch ${next.epoch} holder ${next.holderNodeId}${next.released ? ' released' : ''}${prev ? ` (was epoch ${prev.epoch} ${prev.holderNodeId}${prev.released ? ' released' : ''})` : ' (created)'}`,
			{ renewal },
		);
		if (!next.released) {
			this.#lastProof.set(next.holderNodeId, this.T);
			this.#queue.push(this.T + this.i13BoundMs, () => undefined); // I13 deadline probe
		}
		if (prev) {
			if (next.epoch < prev.epoch) this.#fail('I2', `the stored epoch went down from ${prev.epoch} to ${next.epoch}`);
			else if (next.holderNodeId !== prev.holderNodeId && next.epoch !== prev.epoch + 1)
				this.#fail('I2', `holder changed ${prev.holderNodeId}→${next.holderNodeId} with epoch ${prev.epoch}→${next.epoch}, not +1`);
			else if (next.holderNodeId === prev.holderNodeId && next.epoch !== prev.epoch && next.epoch !== prev.epoch + 1)
				this.#fail('I2', `epoch jumped ${prev.epoch}→${next.epoch}`);
			if (next.holderNodeId !== prev.holderNodeId || next.epoch !== prev.epoch) this.takeovers++;
		}
	}

	// ── properties ─────────────────────────────────────────────────────────

	#observe(): void {
		const acting: Contender[] = [];
		const current = this.#versions.at(-1);
		const stored = current ? parse(current.body) : null;
		for (const c of this.contenders) {
			if (!c.alive) continue;
			const status = c.lease.status();
			if (status.role !== c.lastRole) {
				this.#log(c.id, `role ${c.lastRole} → ${status.role} at epoch ${status.epoch} (${status.reason})`);
				c.lastRole = status.role;
				if (status.role === 'fenced' && !c.reseedPending) {
					c.reseedPending = true;
					const inc = c.incarnation;
					this.#queue.push(this.T + this.#rng.int(this.profile.reseedAfterMs[0], this.profile.reseedAfterMs[1]), () => {
						if (inc !== c.incarnation || !c.alive || c.lease.status().role !== 'fenced') return;
						c.lease.resetAfterReseed();
						c.reseedPending = false;
						this.#log(c.id, 'operator re-seeded the fenced node');
					});
				}
			}
			if (status.epoch < c.maxEpochSeen)
				this.#fail('I2', `${c.id} saw epoch ${status.epoch} after ${c.maxEpochSeen} in one process lifetime`);
			c.maxEpochSeen = Math.max(c.maxEpochSeen, status.epoch);
			const isActing = this.#acting(c);
			if (isActing !== c.lastActing) {
				this.#log(c.id, isActing ? `starts acting as primary (epoch ${status.epoch})` : 'stops acting as primary');
				c.lastActing = isActing;
			}
			if (!isActing) continue;
			acting.push(c);
			if (!stored || stored.holderNodeId !== c.id || stored.epoch !== status.epoch || stored.released)
				this.#fail(
					'I1s',
					`${c.id} acts as primary at epoch ${status.epoch} while the store names ${stored ? `${stored.holderNodeId} at epoch ${stored.epoch}${stored.released ? ' (released)' : ''}` : 'nobody'}`,
				);
			const proof = this.#lastProof.get(c.id);
			if (proof === undefined || this.T - proof >= this.i13BoundMs)
				this.#fail(
					'I13',
					`${c.id} acts as primary ${proof === undefined ? 'with no applied proof' : `${((this.T - proof) / 1000).toFixed(3)} s after its last applied proof`} (bound ${this.i13BoundMs / 1000} s)`,
				);
		}
		if (acting.length > 1)
			this.#fail(
				'I1',
				`${acting.map((c) => `${c.id}@${c.lease.status().epoch}`).join(' and ')} act as primary at the same instant`,
			);
	}

	/** Run every lease continuation the last event released, until each one waits on the store again. */
	async #settle(): Promise<void> {
		for (let i = 0; i < 10_000; i++) {
			let busy = false;
			for (const c of this.contenders) if (c.running && !c.waiting) busy = true;
			if (!busy) return;
			await Promise.resolve();
		}
		this.#fail('harness', 'a lease action awaited something other than the simulated store');
	}

	// ── faults and the operator ────────────────────────────────────────────

	#scheduleTicks(c: Contender, from: number): void {
		const inc = c.incarnation;
		const loop = () => {
			if (inc !== c.incarnation) return;
			if (c.alive && this.T >= c.frozenUntil && !c.running && !c.releasing)
				this.#start(c, 'tick', (lease) => lease.tick({ mayTakeOver: c.mayTakeOver }));
			const jitter = this.#rng.int(0, 250);
			this.#queue.push(this.T + Math.round(this.profile.tickIntervalMs / c.rate) + jitter, loop);
		};
		this.#queue.push(from, loop);
	}

	#crash(c: Contender, why: string): void {
		c.alive = false;
		c.running = false;
		c.waiting = false;
		c.releasing = false;
		c.lastActing = false;
		this.#log(c.id, `process stopped (${why})`);
	}

	#restart(c: Contender): void {
		this.#spawn(c);
		this.#log(c.id, 'process restarted (role unknown)');
		this.#scheduleTicks(c, this.T + this.#rng.int(0, 2_000));
	}

	/** The node a fault hits: the store's holder, the previous fault's node, or its random node. */
	#targetOf(f: Fault): number {
		if (f.target === 'holder') {
			const current = this.#versions.at(-1);
			const holder = current ? parse(current.body)?.holderNodeId : undefined;
			const index = this.contenders.findIndex((c) => c.id === holder);
			if (index >= 0) return index;
		}
		if (f.target === 'previous') {
			const previous = this.#hit.get(f.id - 1);
			if (previous !== undefined) return previous;
		}
		return f.node;
	}

	#inject(f: Fault): void {
		const node = this.#targetOf(f);
		this.#hit.set(f.id, node);
		const c = this.contenders[node] as Contender;
		const path = this.#paths[node] as PathState;
		const until = this.T + f.durationMs;
		const secs = `${(f.durationMs / 1000).toFixed(1)} s`;
		switch (f.kind) {
			case 'partition':
				path.partitionUntil = Math.max(path.partitionUntil, until);
				path.partitionBlackhole = f.flag;
				this.#log(c.id, `fault #${f.id}: ${f.flag ? 'black-hole' : 'reject'} partition from the store for ${secs}`);
				break;
			case 'slow':
				path.slowUntil = Math.max(path.slowUntil, until);
				path.slowMaxLeg = f.value;
				this.#log(c.id, `fault #${f.id}: slow link, legs up to ${f.value} ms for ${secs}`);
				break;
			case 'freeze':
				// Freezes on one node never chain: the profile's bound is the longest single stall.
				if (!c.alive || this.T < c.frozenUntil + this.profile.maxFreezeMs) break;
				c.frozenUntil = Math.max(c.frozenUntil, until);
				this.#log(c.id, `fault #${f.id}: process frozen (SIGSTOP) for ${secs}`);
				this.#queue.push(c.frozenUntil, () => this.#log(c.id, 'process resumed', { verbose: true }));
				break;
			case 'crash':
				if (!c.alive) break;
				this.#crash(c, `fault #${f.id}, down ${secs}`);
				this.#queue.push(until, () => {
					if (!c.alive) this.#restart(c);
				});
				break;
			case 'store-5xx':
				path.fiveXXUntil = Math.max(path.fiveXXUntil, until);
				path.fiveXXStatus = f.value;
				path.fiveXXAfterApply = f.flag;
				this.#log(c.id, `fault #${f.id}: store answers ${f.value}${f.flag ? ' after applying writes' : ''} for ${secs}`);
				break;
			case 'put-throttle':
				path.throttleUntil = Math.max(path.throttleUntil, until);
				this.#log(c.id, `fault #${f.id}: store throttles this node's PUTs (503 SlowDown, not applied) for ${secs}; GETs work`);
				break;
			case 'lost-response':
				path.lostUntil = Math.max(path.lostUntil, until);
				path.lostP = f.value / 1000;
				this.#log(c.id, `fault #${f.id}: ${f.value / 10}% of responses lost after the store acted, for ${secs}`);
				break;
			case 'store-501':
				this.#store501Until = Math.max(this.#store501Until, until);
				this.#log('store', `fault #${f.id}: conditional PUT answers 501 for ${secs}`);
				break;
			case 'spurious-409':
				this.#store409Until = Math.max(this.#store409Until, until);
				this.#store409P = f.value / 1000;
				this.#log('store', `fault #${f.id}: ${f.value / 10}% of conditional PUTs answer 409 for ${secs}`);
				break;
			case 'clock-step':
				c.wallOffset += f.value;
				this.#log(c.id, `fault #${f.id}: wall clock stepped ${f.value > 0 ? '+' : ''}${(f.value / 1000).toFixed(3)} s`);
				break;
			case 'store-clock-step': {
				// Every frontend stays within the profile's skew bound of true time.
				const max = Math.max(0, this.profile.storeSkewMs - this.profile.storeJitterMs);
				if (f.flag) {
					const delta = f.value - (this.#frontends[0] ?? 0);
					this.#frontends = this.#frontends.map((o) => Math.max(-max, Math.min(max, o + delta)));
				} else this.#frontends[f.node % this.#frontends.length] = f.value;
				this.#log(
					'store',
					`fault #${f.id}: ${f.flag ? 'store clock' : `frontend ${f.node % this.#frontends.length} clock`} stepped; frontend offsets now ${this.#frontends.map((o) => `${o > 0 ? '+' : ''}${(o / 1000).toFixed(3)}`).join(' ')} s`,
				);
				break;
			}
			case 'gate':
				c.mayTakeOver = f.flag;
				c.gateUntil = Math.max(c.gateUntil, until);
				this.#log(c.id, `fault #${f.id}: promotion gate ${f.flag ? 'open' : 'closed'} for ${secs}`);
				this.#queue.push(until, () => {
					if (this.T >= c.gateUntil) c.mayTakeOver = c.defaultGate;
				});
				break;
			case 'stale-reads':
				path.staleUntil = Math.max(path.staleUntil, until);
				this.#log(c.id, `fault #${f.id}: reads may return an older version for ${secs}`);
				break;
			case 'no-date':
				this.#noDateUntil = Math.max(this.#noDateUntil, until);
				this.#log('store', `fault #${f.id}: responses carry no Date header for ${secs}`);
				break;
			case 'release': {
				const holder = this.contenders.find((x) => this.#acting(x));
				if (!holder) {
					this.#log('op', `fault #${f.id}: switchover requested, but nobody is primary`);
					break;
				}
				if (holder.running) {
					this.#log('op', `fault #${f.id}: switchover skipped (${holder.id} busy)`);
					break;
				}
				// The caller stops writes first (ha-lease.ts release()), then releases.
				holder.releasing = true;
				this.#log(holder.id, `fault #${f.id}: planned switchover: stop writes, then release`);
				const started = this.#start(holder, 'release()', (lease) => lease.release(), () => {
					holder.releasing = false;
				});
				if (!started) holder.releasing = false;
				break;
			}
			case 'force-promote': {
				const target = c;
				this.#queue.push(this.T + f.value, () => {
					if (!target.alive || target.lease.status().role === 'fenced' || target.lease.status().role === 'primary') {
						this.#log('op', `fault #${f.id}: forced promotion of ${target.id} skipped`);
						return;
					}
					// The break-glass precondition (§18.5): stop every node that thinks it is primary first.
					for (const x of this.contenders) {
						if (x === target || !x.alive || x.lease.status().role !== 'primary') continue;
						this.#crash(x, `operator stopped it before a forced promotion (fault #${f.id})`);
						this.#queue.push(this.T + f.durationMs, () => {
							if (!x.alive) this.#restart(x);
						});
					}
					const tryStart = (attempt: number) => {
						if (this.#start(target, 'forcePromote()', (lease) => lease.forcePromote())) return;
						if (attempt < 20) this.#queue.push(this.T + 500, () => tryStart(attempt + 1));
					};
					this.#log('op', `fault #${f.id}: operator force-promotes ${target.id}`);
					tryStart(0);
				});
				break;
			}
		}
	}

	#heal(): void {
		this.#log('op', 'heal: every fault over, gates restored, stopped nodes restarted, fenced nodes re-seeded');
		for (const c of this.contenders) {
			c.mayTakeOver = c.defaultGate;
			c.gateUntil = 0;
			if (!c.alive) this.#restart(c);
			else if (c.lease.status().role === 'fenced') {
				c.lease.resetAfterReseed();
				c.reseedPending = false;
			}
		}
	}

	// ── the run ────────────────────────────────────────────────────────────

	async run(): Promise<RunResult> {
		const first = this.contenders[0] as Contender;
		const bootstrapAt = this.#rng.int(0, 5_000);
		const bootstrap = () => {
			const ok = this.#start(first, 'bootstrap(1)', (lease) => lease.bootstrap(1), () => {
				if (first.lease.status().role !== 'primary' && this.#versions.length === 0)
					this.#queue.push(this.T + 5_000, bootstrap);
				else this.#scheduleTicks(first, this.T + this.profile.tickIntervalMs);
			});
			if (!ok) this.#queue.push(this.T + 1_000, bootstrap);
		};
		this.#queue.push(bootstrapAt, bootstrap);
		for (const c of this.contenders.slice(1)) this.#scheduleTicks(c, this.#rng.int(0, this.profile.tickIntervalMs));
		for (const f of this.faults) this.#queue.push(f.at, () => this.#inject(f));
		this.#queue.push(this.#healAt, () => this.#heal());

		while (this.#queue.size > 0 && !this.violation) {
			const item = this.#queue.pop() as QueueItem;
			if (item.at > this.profile.durationMs) break;
			this.T = item.at;
			this.events++;
			item.fn();
			await this.#settle();
			this.#observe();
		}
		this.T = Math.min(this.T, this.profile.durationMs);
		const actingNow = this.contenders.filter((c) => this.#acting(c));
		const roles = this.contenders.map((c) => {
			const s = c.lease.status();
			return `${c.id}:${c.alive ? s.role : 'down'}@${s.epoch}${c.mayTakeOver ? '' : ' (gate closed)'} — ${s.reason}`;
		});
		return {
			seed: this.seed,
			profile: this.profile.name,
			contenders: this.contenders.length,
			faults: this.faults,
			violation: this.violation,
			liveness: {
				primary: actingNow[0]?.id ?? null,
				stalled: !this.violation && actingNow.length === 0,
				roles,
			},
			events: this.events,
			trace: this.trace,
			takeovers: this.takeovers,
		};
	}
}

export async function runOnce(options: RunOptions): Promise<RunResult> {
	return new World(options).run();
}
