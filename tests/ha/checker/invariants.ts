/**
 * Invariants I1–I7 (CLUSTERING §19.1) and I11–I16 (HA-PLAN §1.3) as pure functions over the
 * checker's request log plus the lab's observation stream. Each returns `pass`, `fail` or
 * `not-observed`; with no relevant observation the answer is `not-observed`, never `pass`.
 * The observation fields each one reads are listed in tests/ha/README.md.
 */
import type { CheckerLog, RequestRecord, SingletonRun } from './log.ts';
import { type Observation, bool, num, str, strings } from './observations.ts';
import type { InvariantId, InvariantResult } from './report.ts';

export interface InvariantInput {
	log: CheckerLog;
	observations: Observation[];
	options?: InvariantOptions;
}

export interface InvariantOptions {
	/** I6: the database's stated RPO. 0 (sync) means no acknowledged write may be lost. */
	rpoMs?: number;
	/** I13 (and I3's sample lifetime): TTL of the database member lease when an observation has no `ttlMs`. */
	dbLeaseTtlMs?: number;
	/** I1: TTL of the control lease, how long one `holds:true` sample counts when it has no `ttlMs`. */
	controlLeaseTtlMs?: number;
}

type Check = (input: InvariantInput) => InvariantResult;

const MAX_EVIDENCE = 20;

class Verdict {
	observed = false;
	readonly failures: string[] = [];
	readonly notes: string[] = [];

	saw(): void {
		this.observed = true;
	}

	fail(message: string): void {
		this.observed = true;
		this.failures.push(message);
	}

	note(message: string): void {
		this.notes.push(message);
	}

	result(passSummary: string): InvariantResult {
		const cap = (lines: string[]) =>
			lines.length > MAX_EVIDENCE ? [...lines.slice(0, MAX_EVIDENCE), `… ${lines.length - MAX_EVIDENCE} more`] : lines;
		if (this.failures.length > 0) return { status: 'fail', evidence: cap([...this.failures, ...this.notes]) };
		if (!this.observed) return { status: 'not-observed', evidence: cap(this.notes) };
		return { status: 'pass', evidence: cap([passSummary, ...this.notes]) };
	}
}

const at = (t: number) => `t=${new Date(t).toISOString()}`;

/** Fault kinds that end every state a node reported: its process is gone. */
const CRASH_FAULTS = new Set(['crash', 'kill', 'stop', 'power-off', 'reboot', 'node-down']);

/** The node a `fault {state:'start'}` observation says crashed, or undefined. */
function crashedNode(o: Observation): string | undefined {
	if (o.kind !== 'fault' || str(o, 'state') !== 'start' || !CRASH_FAULTS.has(str(o, 'fault') ?? '')) return undefined;
	return o.node;
}
const ofKind = (obs: Observation[], kind: Observation['kind']) => obs.filter((o) => o.kind === kind);
const scopeOf = (o: Observation) => str(o, 'scope') ?? 'control';

// ── I1: at most one control-plane writer per epoch ────────────────────────────

/**
 * A `holds:true` (or primary) sample is evidence for one lease TTL (`ttlMs` on the sample, or the
 * option); a later `holds:false` or a crash fault on the node ends it sooner. A lab re-reports a held
 * state at least once per TTL (every lease tick does).
 */
function expire<T extends { until: number }>(state: Map<string, T>, now: number): void {
	for (const [key, sample] of state) if (sample.until < now) state.delete(key);
}

export const checkI1: Check = ({ observations, options }) => {
	const v = new Verdict();
	const ttl = options?.controlLeaseTtlMs ?? 30_000;
	const holds = new Map<string, { epoch: number | undefined; t: number; until: number }>();
	let maxTogether = 0;
	let samples = 0;
	for (const o of observations) {
		expire(holds, o.t);
		const crashed = crashedNode(o);
		if (crashed !== undefined) {
			holds.delete(crashed);
			continue;
		}
		if (o.kind !== 'lease' || scopeOf(o) !== 'control' || o.node === 'arbiter') continue;
		const h = bool(o, 'holds');
		if (h === undefined) continue;
		samples++;
		if (h) {
			v.saw(); // only a holder is evidence: a stream of holds:false proves nothing about I1
			holds.set(o.node, { epoch: num(o, 'epoch'), t: o.t, until: o.t + (num(o, 'ttlMs') ?? ttl) });
		} else holds.delete(o.node);
		maxTogether = Math.max(maxTogether, holds.size);
		if (holds.size > 1)
			v.fail(`${at(o.t)}: ${[...holds].map(([node, s]) => `${node}@epoch ${s.epoch ?? '?'} (sampled ${at(s.t)})`).join(' and ')} hold the control lease at once`);
	}
	if (samples > 0 && !v.observed) v.note(`${samples} control lease samples, none holding`);
	const writersByEpoch = new Map<number, Set<string>>();
	for (const o of ofKind(observations, 'write-attempt')) {
		if (str(o, 'target') !== 'control' || bool(o, 'accepted') !== true) continue;
		const epoch = num(o, 'epoch');
		if (epoch === undefined) continue;
		v.saw();
		const set = writersByEpoch.get(epoch) ?? new Set();
		set.add(o.node);
		writersByEpoch.set(epoch, set);
	}
	for (const [epoch, nodes] of writersByEpoch)
		if (nodes.size > 1) v.fail(`epoch ${epoch}: control writes accepted by ${[...nodes].join(', ')}`);
	return v.result(`at most ${maxTogether} lease holder at any instant; ${writersByEpoch.size} epochs with accepted control writes, one writer each`);
};

// ── I2: the epoch is strictly monotonic ───────────────────────────────────────

export const checkI2: Check = ({ observations }) => {
	const v = new Verdict();
	const seen = new Map<string, { epoch: number; t: number }>();
	let lastRecord: { epoch: number; holder: string; t: number } | null = null;
	const holderOfEpoch = new Map<number, string>();
	for (const o of observations) {
		const epoch = num(o, 'epoch');
		if (epoch === undefined) continue;
		if (o.kind === 'epoch' || (o.kind === 'lease' && scopeOf(o) === 'control' && o.node !== 'arbiter')) {
			v.saw();
			const key = `${o.node}/${o.kind === 'epoch' ? (str(o, 'source') ?? 'agent') : 'lease'}`;
			const prev = seen.get(key);
			if (prev && epoch < prev.epoch) v.fail(`${at(o.t)}: ${key} went from epoch ${prev.epoch} to ${epoch}`);
			if (!prev || epoch >= prev.epoch) seen.set(key, { epoch, t: o.t });
		}
		if (o.kind === 'lease' && scopeOf(o) === 'control' && o.node === 'arbiter') {
			const holder = str(o, 'holder');
			if (!holder) continue;
			v.saw();
			const owner = holderOfEpoch.get(epoch);
			if (owner && owner !== holder) v.fail(`epoch ${epoch} recorded for both ${owner} and ${holder}`);
			holderOfEpoch.set(epoch, owner ?? holder);
			if (lastRecord) {
				if (epoch < lastRecord.epoch) v.fail(`${at(o.t)}: the arbiter's epoch went from ${lastRecord.epoch} to ${epoch}`);
				else if (holder !== lastRecord.holder && epoch !== lastRecord.epoch + 1)
					v.fail(`${at(o.t)}: holder ${lastRecord.holder}→${holder} with epoch ${lastRecord.epoch}→${epoch}, not +1`);
			}
			lastRecord = { epoch, holder, t: o.t };
		}
	}
	return v.result(`${seen.size} epoch views never went down; ${holderOfEpoch.size} arbiter epochs, one holder each`);
};

// ── I3: at most one primary per database generation ───────────────────────────

export const checkI3: Check = ({ observations, options }) => {
	const v = new Verdict();
	const ttl = options?.dbLeaseTtlMs ?? 30_000;
	const primariesByGeneration = new Map<string, Set<string>>();
	const accepting = new Map<string, Map<string, { generation: number; until: number }>>(); // database → node → sample
	for (const o of observations) {
		for (const nodes of accepting.values()) expire(nodes, o.t);
		const crashed = crashedNode(o);
		if (crashed !== undefined) {
			for (const nodes of accepting.values()) nodes.delete(crashed);
			continue;
		}
		if (o.kind !== 'db-role') continue;
		const database = str(o, 'database');
		const role = str(o, 'role');
		if (!database || !role) continue;
		v.saw();
		const generation = num(o, 'generation');
		const isPrimary = role === 'primary';
		if (isPrimary && generation !== undefined) {
			const key = `${database}#${generation}`;
			const set = primariesByGeneration.get(key) ?? new Set();
			set.add(o.node);
			primariesByGeneration.set(key, set);
		}
		const nodes = accepting.get(database) ?? new Map<string, { generation: number; until: number }>();
		if (isPrimary && bool(o, 'acceptingWrites') !== false) nodes.set(o.node, { generation: generation ?? -1, until: o.t + (num(o, 'ttlMs') ?? ttl) });
		else nodes.delete(o.node);
		accepting.set(database, nodes);
		if (nodes.size > 1)
			v.fail(`${at(o.t)}: ${database} has ${nodes.size} primaries accepting writes: ${[...nodes].map(([n, s]) => `${n}@gen ${s.generation}`).join(', ')}`);
	}
	for (const [key, nodes] of primariesByGeneration)
		if (nodes.size > 1) v.fail(`${key}: primary on ${[...nodes].join(' and ')}`);
	return v.result(`${primariesByGeneration.size} database generations, one primary each`);
};

// ── I4: a singleton runs at most once ─────────────────────────────────────────

/**
 * Starts per key, merged across the app's records and the observations. The two sources are two
 * views of the same starts: each observed start is matched to a distinct app record of the same
 * copy (an observation's `copy`), else of the same node, else to one that names neither; only an
 * unmatched observation adds a start. So per copy the count is the larger of the two views, and
 * different copies add up. A lab names copies and nodes the way the app does (`x-checker-copy`,
 * `CHECKER_NODE` / `YOAL_NODE_ID`).
 */
class StartCounter {
	readonly #keys = new Map<string, { app: { node?: string; copy?: string; used: boolean }[]; observed: { node: string; copy?: string }[] }>();

	#entry(key: string) {
		const entry = this.#keys.get(key) ?? { app: [], observed: [] };
		this.#keys.set(key, entry);
		return entry;
	}

	addApp(key: string, node: string | undefined, copy: string | undefined): void {
		this.#entry(key).app.push({ node, copy, used: false });
	}

	addObserved(key: string, node: string, copy: string | undefined): void {
		this.#entry(key).observed.push({ node, copy });
	}

	/** key → total starts and where they ran. */
	totals(): Map<string, { starts: number; where: string[] }> {
		const out = new Map<string, { starts: number; where: string[] }>();
		for (const [key, { app, observed }] of this.#keys) {
			for (const a of app) a.used = false;
			const where = new Set(app.map((a) => a.copy ?? a.node ?? '?'));
			let unmatched = 0;
			for (const o of observed) {
				const free = app.filter((a) => !a.used);
				const match =
					(o.copy !== undefined ? free.find((a) => a.copy === o.copy) : undefined) ??
					free.find((a) => (o.copy === undefined || a.copy === undefined) && a.node === o.node) ??
					free.find((a) => a.node === undefined && (o.copy === undefined || a.copy === undefined));
				if (match) match.used = true;
				else {
					unmatched++;
					where.add(o.copy ?? o.node);
				}
			}
			out.set(key, { starts: app.length + unmatched, where: [...where] });
		}
		return out;
	}
}

function singletonCounts(runs: SingletonRun[], observations: Observation[]): Map<string, { starts: number; where: string[] }> {
	const counter = new StartCounter();
	for (const r of runs) counter.addApp(`${r.job} run ${r.run}`, r.node, r.copy);
	for (const o of ofKind(observations, 'singleton')) {
		const job = str(o, 'job');
		const run = str(o, 'run');
		const event = str(o, 'event') ?? 'start';
		if (job && run && event === 'start') counter.addObserved(`${job} run ${run}`, o.node, str(o, 'copy'));
	}
	return counter.totals();
}

/** Extra starts beyond the first, per (job, run), with the app's records and observations merged per copy. */
export function duplicateSingletonRuns(log: CheckerLog, observations: Observation[]): number {
	let extra = 0;
	for (const c of singletonCounts(log.singletonRuns, observations).values()) extra += Math.max(c.starts, 1) - 1;
	return extra;
}

export const checkI4: Check = ({ log, observations }) => {
	const v = new Verdict();
	const counts = singletonCounts(log.singletonRuns, observations);
	for (const [key, c] of counts) {
		v.saw();
		if (c.starts > 1) v.fail(`${key} started ${c.starts} times (on ${c.where.join(', ')})`);
	}
	return v.result(`${counts.size} singleton runs, each started once`);
};

// ── I5: a single-writer volume is read-write on at most one node ──────────────

export const checkI5: Check = ({ observations }) => {
	const v = new Verdict();
	const rw = new Map<string, Set<string>>();
	const volumes = new Set<string>();
	for (const o of observations) {
		if (o.kind === 'mount') {
			const volume = str(o, 'volume');
			const mode = str(o, 'mode');
			if (!volume || !mode) continue;
			v.saw();
			volumes.add(volume);
			const nodes = rw.get(volume) ?? new Set<string>();
			if (mode === 'rw') nodes.add(o.node);
			else nodes.delete(o.node);
			rw.set(volume, nodes);
			if (nodes.size > 1) v.fail(`${at(o.t)}: volume ${volume} is read-write on ${[...nodes].join(' and ')}`);
		} else if (o.kind === 'write-attempt' && str(o, 'target') === 'volume' && bool(o, 'accepted') === true) {
			const volume = str(o, 'volume');
			if (!volume || !rw.has(volume)) continue;
			v.saw();
			if (!rw.get(volume)?.has(o.node)) v.fail(`${at(o.t)}: ${o.node} wrote volume ${volume} without a read-write mount`);
		}
	}
	return v.result(`${volumes.size} volumes, never read-write on two nodes`);
};

// ── I6: no acknowledged write lost beyond the stated RPO ──────────────────────

export const checkI6: Check = ({ log, observations, options }) => {
	const v = new Verdict();
	const rpoMs = options?.rpoMs ?? 0;
	const acked = log.requests.filter((r) => r.kind === 'write' && r.status === 200);
	const verifies = new Map<number, RequestRecord>();
	for (const r of log.requests) if (r.kind === 'verify') verifies.set(r.n, r); // the last attempt wins
	const promotions = ofKind(observations, 'db-role')
		.filter((o) => str(o, 'role') === 'primary' && str(o, 'promotion') !== undefined)
		.map((o) => o.t);
	let readMisses = 0;
	const ackedAt = new Map(acked.map((r) => [r.n, r.endedAt]));
	for (const r of log.requests)
		if (r.kind === 'read' && r.status === 404 && (ackedAt.get(r.n) ?? Number.POSITIVE_INFINITY) <= r.startedAt) readMisses++;
	for (const w of acked) {
		v.saw();
		const check = verifies.get(w.n);
		if (!check || (check.status !== 200 && check.status !== 404)) {
			v.fail(`write n=${w.n} acknowledged ${at(w.endedAt)} could not be verified (${check ? (check.status || check.error) : 'never read back'})`);
			continue;
		}
		if (check.status === 200 && check.match === false) {
			v.fail(`write n=${w.n} reads back different content`);
			continue;
		}
		if (check.status === 404) {
			const covered = rpoMs > 0 && promotions.some((p) => w.endedAt <= p && p - w.endedAt <= rpoMs);
			if (covered) v.note(`write n=${w.n} lost within the ${rpoMs} ms RPO before a promotion`);
			else v.fail(`write n=${w.n} acknowledged ${at(w.endedAt)} is gone`);
		}
	}
	if (readMisses > 0) v.note(`${readMisses} mid-run reads of an acknowledged row returned 404 (see the final verification)`);
	return v.result(`${acked.length} acknowledged writes all read back (RPO ${rpoMs} ms)`);
};

// ── I7: a fenced node performs no writes ──────────────────────────────────────

export const checkI7: Check = ({ observations }) => {
	const v = new Verdict();
	const fenced = new Map<string, { since: number; component: string }[]>();
	let probed = 0;
	for (const o of observations) {
		if (o.kind === 'fence') {
			const isFenced = bool(o, 'fenced');
			if (isFenced === undefined) continue;
			const component = str(o, 'component') ?? '*';
			const list = (fenced.get(o.node) ?? []).filter((f) => f.component !== component);
			if (isFenced) list.push({ since: o.t, component });
			fenced.set(o.node, list);
		} else if (o.kind === 'write-attempt') {
			const target = str(o, 'target') ?? '*';
			const fence = (fenced.get(o.node) ?? []).find((f) => f.component === '*' || target === '*' || f.component === target);
			if (!fence) continue;
			probed++;
			v.saw();
			if (bool(o, 'accepted') === true)
				v.fail(`${at(o.t)}: ${o.node}, fenced (${fence.component}) since ${at(fence.since)}, accepted a ${target} write`);
		}
	}
	return v.result(`${probed} write attempts on fenced nodes, all refused`);
};

// ── I11: the request path needs no control plane ──────────────────────────────

interface Window {
	from: number;
	to: number;
}

function faultWindows(observations: Observation[], end: number, match: (o: Observation) => boolean): Window[] {
	const open = new Map<string, number>();
	const windows: Window[] = [];
	for (const o of ofKind(observations, 'fault')) {
		if (!match(o)) continue;
		const id = str(o, 'id') ?? `${o.node}/${str(o, 'fault') ?? ''}`;
		const state = str(o, 'state');
		if (state === 'start' && !open.has(id)) open.set(id, o.t);
		if (state === 'end' && open.has(id)) {
			windows.push({ from: open.get(id) as number, to: o.t });
			open.delete(id);
		}
	}
	for (const from of open.values()) windows.push({ from, to: end });
	return windows;
}

const isControlDown = (o: Observation) => str(o, 'fault') === 'control-down' || str(o, 'target') === 'control';
const inside = (t: number, ws: Window[]) => ws.some((w) => t >= w.from && t <= w.to);

export const checkI11: Check = ({ log, observations }) => {
	const v = new Verdict();
	const down = faultWindows(observations, log.endedAt, isControlDown);
	const other = faultWindows(observations, log.endedAt, (o) => !isControlDown(o));
	let served = 0;
	for (const r of log.requests) {
		if (r.kind === 'verify' || !inside(r.startedAt, down) || !inside(r.endedAt, down)) continue;
		if (inside(r.startedAt, other) || inside(r.endedAt, other)) continue; // another fault is to blame
		v.saw();
		if (r.status === 200) served++;
		else v.fail(`${at(r.startedAt)}: ${r.kind} n=${r.n} failed (${r.status || r.error}) with only the control plane down`);
	}
	if (down.length > 0) v.note(`${down.length} control-plane-down windows, ${Math.round(down.reduce((s, w) => s + w.to - w.from, 0) / 1000)} s in all`);
	return v.result(`${served} requests served with the control plane down`);
};

// ── I12: sync promotion only chooses a recorded synchronous replica ───────────

export const checkI12: Check = ({ observations }) => {
	const v = new Verdict();
	const syncSet = new Map<string, string[]>();
	for (const o of observations) {
		if (o.kind === 'lease' && o.node === 'arbiter' && scopeOf(o) === 'database') {
			const database = str(o, 'database');
			const set = strings(o, 'syncSet');
			if (database && set) syncSet.set(database, set);
		}
		if (o.kind === 'db-role' && str(o, 'role') === 'primary' && str(o, 'promotion') === 'auto') {
			const database = str(o, 'database');
			if (!database) continue;
			v.saw();
			const set = syncSet.get(database);
			if (!set) v.fail(`${at(o.t)}: ${o.node} auto-promoted for ${database} with no synchronous set recorded`);
			else if (!set.includes(o.node))
				v.fail(`${at(o.t)}: ${o.node} auto-promoted for ${database}, outside the recorded set [${set.join(', ')}]`);
		}
	}
	return v.result('every automatic promotion chose a recorded synchronous replica');
};

// ── I13: a primary that cannot prove its lease stops writes within one TTL ────

export const checkI13: Check = ({ observations, options }) => {
	const v = new Verdict();
	const defaultTtl = options?.dbLeaseTtlMs ?? 30_000;
	const proofs = new Map<string, { t: number; ttl: number }>(); // node/database → last proof
	// A database is judged once the lab reports member leases for it at all; from then on a node that
	// accepts its writes without ever holding the lease (a rogue writer) fails, member or not.
	const leased = new Set<string>();
	for (const o of observations) {
		const database = str(o, 'database');
		if (database && o.kind === 'lease' && scopeOf(o) === 'database' && o.node !== 'arbiter') leased.add(database);
	}
	let checked = 0;
	for (const o of observations) {
		const database = str(o, 'database');
		if (!database) continue;
		const key = `${o.node}/${database}`;
		if (o.kind === 'lease' && scopeOf(o) === 'database' && o.node !== 'arbiter') {
			if (bool(o, 'holds') === true) proofs.set(key, { t: o.t, ttl: num(o, 'ttlMs') ?? defaultTtl });
			continue;
		}
		const accepting =
			(o.kind === 'write-attempt' && str(o, 'target') === 'database' && bool(o, 'accepted') === true) ||
			(o.kind === 'db-role' && str(o, 'role') === 'primary' && bool(o, 'acceptingWrites') === true);
		if (!accepting) continue;
		if (!leased.has(database)) {
			v.note(`${at(o.t)}: ${o.node} accepted ${database} writes, but no member lease is reported for ${database}`);
			continue;
		}
		checked++;
		v.saw();
		const proof = proofs.get(key);
		if (!proof) v.fail(`${at(o.t)}: ${o.node} accepted ${database} writes without ever proving its lease`);
		else if (o.t - proof.t > proof.ttl)
			v.fail(`${at(o.t)}: ${o.node} accepted ${database} writes ${Math.round((o.t - proof.t) / 1000)} s after its last lease proof (TTL ${proof.ttl / 1000} s)`);
	}
	return v.result(`${checked} accepting-writes observations, each within one TTL of a lease proof`);
};

// ── I14: an ingress is never offered traffic it cannot serve ──────────────────

export const checkI14: Check = ({ observations }) => {
	const v = new Verdict();
	const state = new Map<string, { ready?: boolean; inRotation?: boolean; converged?: boolean }>();
	// Readiness is judged only when the lab reports it; then an ingress in rotation before it ever
	// reported ready fails (unknown is not ready).
	const readinessReported = observations.some((o) => o.kind === 'ingress' && bool(o, 'ready') !== undefined);
	let unjudged = 0;
	for (const o of observations) {
		if (o.kind !== 'ingress' && !(o.kind === 'route' && !str(o, 'copy') && bool(o, 'converged') !== undefined)) continue;
		const s = state.get(o.node) ?? {};
		if (o.kind === 'ingress') {
			const ready = bool(o, 'ready');
			const inRotation = bool(o, 'inRotation');
			if (ready !== undefined) s.ready = ready;
			if (inRotation !== undefined) s.inRotation = inRotation;
		} else s.converged = bool(o, 'converged');
		state.set(o.node, s);
		if (s.inRotation !== true) continue;
		if (!readinessReported) {
			if (s.converged === false) v.fail(`${at(o.t)}: ingress ${o.node} is in rotation but routes not converged`);
			else unjudged++;
			continue;
		}
		v.saw();
		if (s.ready !== true || s.converged === false)
			v.fail(
				`${at(o.t)}: ingress ${o.node} is in rotation but ${s.ready === false ? 'not ready' : s.ready === undefined ? 'never reported ready' : 'routes not converged'}`,
			);
	}
	if (unjudged > 0) v.note(`${unjudged} in-rotation samples not judged: the lab reports no ingress readiness`);
	return v.result(`${state.size} ingresses, never in rotation while unable to serve`);
};

// ── I15: a copy stops receiving new requests before it is stopped ─────────────

export const checkI15: Check = ({ log, observations }) => {
	const v = new Verdict();
	const removedAt = new Map<string, number | null>(); // copy → when it left the upstreams (null: in them)
	let stops = 0;
	const lateRequests = new Map<string, number[]>();
	const leftAt: { copy: string; from: number; to: number }[] = [];
	for (const o of ofKind(observations, 'route')) {
		const copy = str(o, 'copy');
		const event = str(o, 'event');
		if (!copy || !event) continue;
		if (event === 'added' || event === 'started') {
			const from = removedAt.get(copy);
			if (typeof from === 'number') leftAt.push({ copy, from, to: o.t });
			removedAt.set(copy, null);
		} else if (event === 'removed') removedAt.set(copy, o.t);
		else if (event === 'stopped') {
			stops++;
			v.saw();
			const from = removedAt.get(copy);
			if (typeof from !== 'number') v.fail(`${at(o.t)}: copy ${copy} stopped while still in the upstreams`);
		}
	}
	for (const [copy, from] of removedAt) if (typeof from === 'number') leftAt.push({ copy, from, to: Number.POSITIVE_INFINITY });
	for (const r of log.requests) {
		if (!r.copy || r.status === 0) continue;
		const window = leftAt.find((w) => w.copy === r.copy && r.startedAt > w.from && r.startedAt < w.to);
		if (window) lateRequests.set(r.copy, [...(lateRequests.get(r.copy) ?? []), r.startedAt]);
	}
	for (const [copy, times] of lateRequests)
		v.fail(`${times.length} requests reached copy ${copy} after it left the upstreams (first ${at(times[0] as number)})`);
	return v.result(`${stops} copy stops, each after the copy left the upstreams`);
};

// ── I16: a release command runs at most once and gates the rollout ────────────

export const checkI16: Check = ({ log, observations }) => {
	const v = new Verdict();
	const starts = new StartCounter(); // per release, the app's records and observations merged per copy
	const outcome = new Map<string, boolean>();
	for (const r of log.singletonRuns) {
		if (!r.job.startsWith('release:')) continue;
		v.saw();
		starts.addApp(r.job.slice('release:'.length), r.node, r.copy);
	}
	for (const o of ofKind(observations, 'release-command')) {
		const release = str(o, 'release');
		const event = str(o, 'event');
		if (!release || !event) continue;
		v.saw();
		if (event === 'start') starts.addObserved(release, o.node, str(o, 'copy'));
		else if (event === 'end') outcome.set(release, bool(o, 'ok') === true);
		else if (event === 'rollout-start') {
			const ok = outcome.get(release);
			if (ok === undefined) v.fail(`${at(o.t)}: rollout of ${release} started before its release command finished`);
			else if (!ok) v.fail(`${at(o.t)}: rollout of ${release} started after its release command failed`);
		}
	}
	const totals = starts.totals();
	for (const [release, c] of totals) if (c.starts > 1) v.fail(`release command for ${release} ran ${c.starts} times (on ${c.where.join(', ')})`);
	return v.result(`${totals.size} release commands, each run once, no rollout without a successful one`);
};

export const CHECKS: Record<InvariantId, Check> = {
	I1: checkI1,
	I2: checkI2,
	I3: checkI3,
	I4: checkI4,
	I5: checkI5,
	I6: checkI6,
	I7: checkI7,
	I11: checkI11,
	I12: checkI12,
	I13: checkI13,
	I14: checkI14,
	I15: checkI15,
	I16: checkI16,
};
