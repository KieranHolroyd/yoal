import {
	DB_MEMBER_CAPABILITY,
	evaluateCandidate,
	fenceNoticeWithinBudget,
	oldPrimaryAction,
	promotionLease,
	type CandidateDecision,
	type DatabaseLease,
	type DatabaseMemberReport,
	type DatabaseMembersDesired,
	type DesiredState,
	type FenceNotice,
} from '@yoal/contracts';
import type { HelperApi } from './helper-client.ts';

/**
 * The W11 database member machine (docs/build-plan/W11-SPEC.md Revision 4, extending W9-SPEC §5).
 *
 * Each data node keeps one instance. On a *replica* it watches its own WAL receiver and the
 * arbiter's clock and becomes a candidate only when §4 holds; it CASes `generation + 1` and, only
 * on a win, runs the helper's fixed `replicaPromote` verb. On a *primary* it renews the lease,
 * listens for the H21 failsafe agreement, and — when it decides to fence — stops serving agents and
 * writes *before* stopping Postgres, sending a best-effort `fencing {generation, epoch}` notice to
 * every reachable member within §5.0's 2 s budget. A valid notice lets a candidate acquire at lease
 * expiry without the extra keep-alive TTL and waives the stream-down debounce; it never authorises
 * a live stream, an unexpired lease or an ineligible member.
 *
 * The transport is deliberately injected: the member machine reads the arbiter and talks to peers,
 * while this file contains no decision that uses a local wall clock (W9-SPEC assumption 2). The
 * helper supplies only fixed verbs; nothing here runs SQL. `DatabaseMemberRunner` never decides a
 * manual promotion and never writes the control-plane row.
 */

/** The arbiter's answer; `arbiterNow` is the store's clock, never this node's. */
export interface MemberLeaseRecord {
	lease: DatabaseLease;
	etag: string;
	arbiterNow: number;
}

export interface MemberLeaseArbiter {
	read(databaseId: string): Promise<MemberLeaseRecord | null>;
	/** Conditional write. `expectedEtag` null means create. The result carries the store's clock. */
	compareAndSwap(
		databaseId: string,
		expectedEtag: string | null,
		lease: DatabaseLease,
	): Promise<{ ok: boolean; arbiterNow: number }>;
}

/** A peer this member can reach (mTLS in production); `reachable` is the last authenticated probe. */
export interface MemberPeerView {
	nodeId: string;
	reachable: boolean;
}

export interface MemberPeerTransport {
	/** Peers of one database, from desired state, with a fresh reachability probe. */
	peers(databaseId: string): Promise<MemberPeerView[]>;
	/** Send the primary's best-effort fence notice; false means the delivery attempt failed. */
	sendFenceNotice(databaseId: string, peerNodeId: string, notice: FenceNotice): Promise<boolean>;
	/** Send this member's keep-alive to the primary and return whether every peer answered. */
	keepAlive(databaseId: string, primaryNodeId: string | null): Promise<{ everyPeerAnswered: boolean }>;
	/** When this member last answered the primary's keep-alive (its own view), or null. */
	lastAnsweredToPrimary(databaseId: string): number | null;
}

/** The fixed helper verbs the machine needs; a test supplies a fake, production the helper client. */
export interface MemberOperations {
	status(workloadId: string): Promise<{ inRecovery: boolean; streaming: boolean; lsn: string | null; readOnly: boolean }>;
	fence(workloadId: string, mode: 'stop' | 'readonly'): Promise<void>;
	/** `pg_ctl promote` on the replica workload; `promoted` may be true with a hand-over error. */
	promote(workloadId: string, databaseId: string): Promise<{ promoted: boolean; lsn: string | null; error?: string }>;
	/** Clear the inherited `synchronous_standby_names` on the promoted workload. */
	clearSync(workloadId: string): Promise<void>;
}

export type MemberEventKind =
	| 'candidate'
	| 'promoted'
	| 'cas-lost'
	| 'fenced'
	| 'fence-failed'
	| 'fence-notice-sent'
	| 'fence-notice-missed'
	| 'fence-notice-received'
	| 'lease-renewed'
	| 'failsafe-held'
	| 'promotion-retry'
	| 'promotion-failed'
	| 'refused';

export interface MemberEvent {
	kind: MemberEventKind;
	databaseId: string;
	nodeId: string;
	/** Wall-clock time for humans; never a safety decision. */
	at: string;
	generation: number;
	detail?: string;
	notice?: FenceNotice;
}

interface DatabaseMemberState {
	role: DatabaseMemberReport['role'];
	generation: number;
	streaming: boolean;
	streamDownSince: number | null;
	lsn: string | null;
	/** Fence notices keyed by the generation the sender held (cross-generation is observable). */
	notices: Map<number, FenceNotice>;
	/** A CAS this member won but could not promote yet; retried as the changing-lease holder. */
	pendingPromotion: { generation: number; attempts: number; lastAttemptAt: number } | null;
	/** Consecutive fence attempts that did not confirm; reported until one succeeds. */
	fenceFailures: number;
	/** Monotonic time of the last successful lease read or write (the proof window). */
	lastProofAt: number | null;
	lastRenewAt: number | null;
	arbiterReachable: boolean;
	leaseExpiresAt: string | null;
	busy: boolean;
	/** A promotion that completed; rides the heartbeat until the control plane records it. */
	promoted: { generation: number; lsn: string | null } | null;
}

export interface DatabaseMemberRunnerOptions {
	nodeId: string;
	helper: MemberOperations;
	/** Null means this deployment has no node-side arbiter: the machine stays report-only. */
	arbiter: MemberLeaseArbiter | null;
	peer: MemberPeerTransport;
	/** Monotonic clock for debounce/keep-alive/proof ages (never `Date.now`). */
	now?: () => number;
	/** Wall clock only for report/event timestamps. */
	wallNow?: () => number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	onEvent?: (event: MemberEvent) => void;
	/** Overridable for tests; §9's values are the defaults. */
	leaseTtlMs?: number;
	streamDownMs?: number;
	keepAliveMs?: number;
	renewMs?: number;
}

/** The workload id a database's primary or replica runs under on this node. */
function workloadIdFor(desired: DatabaseMembersDesired, nodeId: string): string | null {
	const member = desired.members.find((item) => item.nodeId === nodeId);
	if (!member) return null;
	return member.workloadId ?? (member.role === 'primary' ? desired.databaseId : null);
}

export class DatabaseMemberRunner {
	private readonly nodeId: string;
	private readonly helper: DatabaseMemberRunnerOptions['helper'];
	private readonly arbiter: MemberLeaseArbiter | null;
	private readonly peer: MemberPeerTransport;
	private readonly now: () => number;
	private readonly wallNow: () => number;
	private readonly log: NonNullable<DatabaseMemberRunnerOptions['log']>;
	private readonly onEvent: (event: MemberEvent) => void;
	private readonly leaseTtlMs: number;
	private readonly streamDownMs: number;
	private readonly keepAliveMs: number;
	private readonly renewMs: number;
	private readonly states = new Map<string, DatabaseMemberState>();
	private readonly lastReports = new Map<string, DatabaseMemberReport>();
	/** A notice delivered before the first desired-state pass (state is created on observe). */
	private readonly pendingNotices = new Map<string, Map<number, FenceNotice>>();
	private readonly events: MemberEvent[] = [];

	constructor(options: DatabaseMemberRunnerOptions) {
		this.nodeId = options.nodeId;
		this.helper = options.helper;
		this.arbiter = options.arbiter;
		this.peer = options.peer;
		this.now = options.now ?? (() => performance.now());
		this.wallNow = options.wallNow ?? Date.now;
		this.log = options.log ?? (() => undefined);
		this.onEvent = options.onEvent ?? (() => undefined);
		this.leaseTtlMs = options.leaseTtlMs ?? 15_000;
		this.streamDownMs = options.streamDownMs ?? 5_000;
		this.keepAliveMs = options.keepAliveMs ?? 15_000;
		this.renewMs = options.renewMs ?? 5_000;
	}

	/** Whether the node has a member machine that can fence itself; false is report-only. */
	get selfFencing(): boolean {
		return this.arbiter !== null;
	}

	/**
	 * Run one pass over desired state. This is the only entry point; it is safe to call every
	 * heartbeat. A failure on one database never stops another (a transient helper RPC is normal).
	 */
	async runOnce(state: DesiredState, signal: AbortSignal): Promise<void> {
		const present = new Set<string>();
		for (const desired of state.databaseMembers ?? []) {
			if (signal.aborted) return;
			const member = desired.members.find((item) => item.nodeId === this.nodeId);
			if (!member) continue;
			present.add(desired.databaseId);
			try {
				await this.#observe(desired, member.role);
			} catch (error) {
				this.log('warn', `database member ${desired.databaseId}: ${errorText(error)}`);
			}
		}
		for (const id of [...this.states.keys()]) if (!present.has(id)) this.states.delete(id);
	}

	/** Accept a fence notice delivered by a peer (mTLS-authenticated in production). */
	receiveFenceNotice(databaseId: string, notice: FenceNotice): void {
		const state = this.states.get(databaseId);
		if (!state) {
			// The lease may have expired before the next desired-state pass created the member state;
			// keep the notice keyed by generation so the candidate check can use it, but never treat
			// it as authorisation on its own.
			const pending = this.pendingNotices.get(databaseId) ?? new Map<number, FenceNotice>();
			pending.set(notice.generation, notice);
			this.pendingNotices.set(databaseId, pending);
			this.#event('fence-notice-received', databaseId, 0, `notice for generation ${notice.generation} (awaiting state)`, notice);
			return;
		}
		const existing = state.notices.get(notice.generation);
		// A duplicate is idempotent; a later delivery of the same generation is still the same promise.
		if (!existing) state.notices.set(notice.generation, notice);
		this.#event('fence-notice-received', databaseId, state.generation, `notice for generation ${notice.generation}`, notice);
	}

	/** The W11 heartbeat reports for this node's members, newest first. */
	reports(): DatabaseMemberReport[] {
		return [...this.lastReports.values()].slice(0, 50);
	}

	/** A promotion this member performed, handed to the heartbeat until acknowledged. */
	pendingPromotionReports(): Array<{ databaseId: string; generation: number; lsn: string | null }> {
		return [...this.states.entries()]
			.filter(([, state]) => state.promoted !== null)
			.map(([databaseId, state]) => ({ databaseId, generation: state.promoted!.generation, lsn: state.promoted!.lsn }));
	}

	/** Member events since the last acknowledged heartbeat (fence failures, notices, promotions). */
	pendingEvents(): MemberEvent[] {
		return this.events.slice(0, 50);
	}

	acknowledgeEvents(count: number): void {
		this.events.splice(0, Math.max(0, Math.min(count, this.events.length)));
	}

	acknowledgePromotion(databaseId: string): void {
		const state = this.states.get(databaseId);
		if (state) state.promoted = null;
	}

	// ---------------------------------------------------------------- per-database pass

	async #observe(desired: DatabaseMembersDesired, desiredRole: 'primary' | 'replica'): Promise<void> {
		const workloadId = workloadIdFor(desired, this.nodeId);
		if (!workloadId) return;
		const status = await this.helper.status(workloadId).catch(() => null);
		if (!status) return;
		const state = this.#state(desired.databaseId, desiredRole, desired.generation);
		state.streaming = status.streaming;
		state.lsn = status.lsn;
		// W11-SPEC §4.1: the debounce starts when the receiver is first observed not streaming.
		if (status.streaming) state.streamDownSince = null;
		else if (state.streamDownSince === null) state.streamDownSince = this.now();

		const role: DatabaseMemberReport['role'] = status.inRecovery
			? status.streaming
				? 'streaming'
				: 'rewind'
			: status.readOnly
				? 'fenced'
				: 'primary';
		const wasPrimary = state.role === 'primary';
		state.role = role;

		if (role === 'primary') {
			await this.#keepPrimary(desired, state, wasPrimary, workloadId);
		} else if (desiredRole === 'replica') {
			await this.#tryCandidate(desired, state, workloadId, state.notices);
		}
		// A fenced old primary is never resurrected here: desired state's rewind task re-attaches it
		// as a replica. This machine only stops it serving.
		this.#report(desired, state, status.lsn);
	}

	/** Renew, or fence when the lease cannot be proved and the H21 failsafe does not hold. */
	async #keepPrimary(
		desired: DatabaseMembersDesired,
		state: DatabaseMemberState,
		wasPrimary: boolean,
		workloadId: string,
	): Promise<void> {
		if (!this.arbiter) {
			state.arbiterReachable = false;
			return;
		}
		let record: MemberLeaseRecord | null = null;
		let reachable = true;
		try {
			record = await this.arbiter.read(desired.databaseId);
		} catch {
			reachable = false;
		}
		state.arbiterReachable = reachable;
		state.leaseExpiresAt = record?.lease.expiresAt ?? state.leaseExpiresAt;
		const arbiterNow = record?.arbiterNow ?? this.now();
		if (record) state.lastProofAt = this.now();

		// A higher generation or another holder is observed: the primary fences before its TTL ends.
		const action = oldPrimaryAction({
			generation: state.generation,
			highestGenerationSeen: Math.max(state.generation, record?.lease.generation ?? 0),
			leaseHolderNodeId: record?.lease.holderNodeId ?? null,
			nodeId: this.nodeId,
			role: 'primary',
			higherPrimaryReachable: false,
		});
		if (record && action === 'fence') {
			await this.#fence(desired, state, workloadId, `a higher generation or another holder is visible (generation ${record.lease.generation})`);
			return;
		}

		if (record && record.lease.holderNodeId === this.nodeId) {
			const expiry = Date.parse(record.lease.expiresAt);
			// A lease that is already expired by the arbiter clock cannot be resurrected: this member
			// failed to prove it before the TTL, so it fences rather than renewing back to life.
			if (!Number.isFinite(expiry) || expiry <= arbiterNow) {
				await this.#fence(desired, state, workloadId, 'the lease expired before this member could renew it');
				return;
			}
			const due = state.lastRenewAt === null || this.now() - state.lastRenewAt >= this.renewMs || expiry - arbiterNow < this.leaseTtlMs / 2;
			if (due) {
				try {
					const next: DatabaseLease = {
						...record.lease,
						expiresAt: new Date(Math.max(arbiterNow, expiry || 0) + this.leaseTtlMs).toISOString(),
					};
					const result = await this.arbiter.compareAndSwap(desired.databaseId, record.etag, next);
					state.lastRenewAt = this.now();
					if (result.ok) {
						state.lastProofAt = this.now();
						state.leaseExpiresAt = next.expiresAt;
						this.#event('lease-renewed', desired.databaseId, state.generation, next.expiresAt);
					} else {
						// A lost renew is not immediately fatal: re-read and fence if the lease moved.
						const latest = await this.arbiter.read(desired.databaseId).catch(() => null);
						if (latest && (latest.lease.generation > state.generation || latest.lease.holderNodeId !== this.nodeId))
							await this.#fence(desired, state, workloadId, 'the lease was taken at another generation');
					}
				} catch {
					state.arbiterReachable = false;
				}
			}
			return;
		}

		// No provable lease. The failsafe holds while every member answers the keep-alive; otherwise
		// the primary fences before one TTL. A node that never had a lease (a mis-configured newly
		// promoted primary) is not stopped on first sight: it must have served as a primary first.
		const proofAge = state.lastProofAt === null ? null : this.now() - state.lastProofAt;
		if (!reachable) {
			const { everyPeerAnswered } = await this.peer.keepAlive(desired.databaseId, null).catch(() => ({ everyPeerAnswered: false }));
			if (everyPeerAnswered) {
				this.#event('failsafe-held', desired.databaseId, state.generation, 'arbiter unreachable; every member answered the keep-alive');
				return;
			}
		}
		if (wasPrimary && proofAge !== null && proofAge > this.leaseTtlMs) await this.#fence(desired, state, workloadId, 'cannot prove the lease and the failsafe does not hold');
	}

	/** §4: evaluate candidate conditions and, only if all hold, CAS `generation + 1`. */
	async #tryCandidate(
		desired: DatabaseMembersDesired,
		state: DatabaseMemberState,
		workloadId: string,
		notices: ReadonlyMap<number, FenceNotice>,
	): Promise<void> {
		if (state.busy) return;
		if (!this.arbiter) return;
		let record: MemberLeaseRecord | null;
		try {
			record = await this.arbiter.read(desired.databaseId);
		} catch {
			state.arbiterReachable = false;
			return;
		}
		state.arbiterReachable = true;
		state.leaseExpiresAt = record?.lease.expiresAt ?? state.leaseExpiresAt;
		const arbiterNow = record?.arbiterNow ?? this.now();

		// Review blocker 7: after a CAS win, keep promoting as the holder of the changing lease. Never
		// abandon a won generation: renew it while retrying, and report every failed attempt.
		if (state.pendingPromotion) {
			const pending = state.pendingPromotion;
			if (!record) return;
			if (record.lease.generation === pending.generation && record.lease.holderNodeId === this.nodeId) {
				// Keep the won lease alive while `pg_ctl promote` is retried; it stays non-promotable.
				await this.#renewChangingLease(desired, record, arbiterNow).catch(() => undefined);
				if (this.now() - pending.lastAttemptAt >= 2_000) {
					state.busy = true;
					try {
						await this.#runPromotion(desired, state, workloadId);
					} finally {
						state.busy = false;
					}
				}
				return;
			}
			this.#event(
				'promotion-failed',
				desired.databaseId,
				pending.generation,
				`generation ${pending.generation} is no longer held by this member; the promotion is abandoned`,
			);
			state.pendingPromotion = null;
		}

		const failover = desired.failover;
		if (!failover || failover.mode !== 'auto') return;
		const acceptDataLoss = failover.acceptDataLoss;
		// W11-MODEL assumption 9: a downgraded sync database without acceptDataLoss is async now.
		if (desired.durabilityEffective === 'async' && !acceptDataLoss && desired.durability === 'sync') return;
		const notice = notices.get(record?.lease.generation ?? -1) ?? null;
		const decision = this.#candidate(desired, state, record, arbiterNow, notice);
		if (!decision.eligible) {
			this.log('info', `database member ${desired.databaseId} is not a candidate: ${decision.refusals.map((refusal) => refusal.code).join(', ')}`);
			return;
		}
		this.#event('candidate', desired.databaseId, state.generation, undefined, notice ?? undefined);
		state.busy = true;
		try {
			const next = promotionLease(record!.lease, this.nodeId, arbiterNow, this.leaseTtlMs);
			let won = false;
			try {
				won = (await this.arbiter.compareAndSwap(desired.databaseId, record!.etag, next)).ok;
			} catch {
				won = false;
			}
			if (!won) {
				// A lost response may still have applied the write. Re-read: a lease that names this
				// member at generation + 1 proves the win; anything else is a loss, so re-follow.
				const latest = await this.arbiter.read(desired.databaseId).catch(() => null);
				won = latest?.lease.generation === next.generation && latest.lease.holderNodeId === this.nodeId;
				if (!won) {
					this.#event('cas-lost', desired.databaseId, state.generation, `generation ${next.generation} was taken by another member`);
					return;
				}
				state.leaseExpiresAt = latest!.lease.expiresAt;
			}
			state.pendingPromotion = { generation: next.generation, attempts: 0, lastAttemptAt: 0 };
			await this.#runPromotion(desired, state, workloadId);
		} catch (error) {
			this.#event('refused', desired.databaseId, state.generation, errorText(error));
		} finally {
			state.busy = false;
		}
	}

	/** `pg_ctl promote` on the replica workload, retried while this member holds the changing lease. */
	async #runPromotion(desired: DatabaseMembersDesired, state: DatabaseMemberState, workloadId: string): Promise<void> {
		const pending = state.pendingPromotion;
		if (!pending) return;
		pending.attempts += 1;
		pending.lastAttemptAt = this.now();
		let outcome: { promoted: boolean; lsn: string | null; error?: string };
		try {
			outcome = await this.helper.promote(workloadId, desired.databaseId);
		} catch (error) {
			outcome = { promoted: false, lsn: null, error: errorText(error) };
		}
		if (!outcome.promoted) {
			this.#event(
				pending.attempts > 1 ? 'promotion-failed' : 'promotion-retry',
				desired.databaseId,
				pending.generation,
				`pg_ctl promote attempt ${pending.attempts} did not complete: ${outcome.error ?? 'unknown error'}; the changing lease is kept and retried`,
			);
			return;
		}
		// §5: the winner must prove the generation before serving writes. If the lease moved while
		// `pg_ctl promote` ran, this member must not report a primary; it fences immediately.
		const proof = await this.arbiter?.read(desired.databaseId).catch(() => null);
		if (!proof || proof.lease.generation !== pending.generation || proof.lease.holderNodeId !== this.nodeId) {
			state.pendingPromotion = null;
			this.#event('promotion-failed', desired.databaseId, pending.generation, 'pg_ctl promote completed but the lease is no longer held; fencing');
			await this.#fence(desired, state, workloadId, 'the lease moved while pg_ctl promote ran');
			return;
		}
		// §5.3: clear the inherited sync setting **on the promoted replica workload** (the database
		// primary workload does not exist on this node yet) and become the new primary. A failure is
		// surfaced, not only logged: the new primary must not keep the old setting.
		try {
			await this.helper.clearSync(workloadId);
		} catch (error) {
			this.#event(
				'promotion-failed',
				desired.databaseId,
				pending.generation,
				`promoted, but clearing the inherited sync setting failed on ${workloadId}: ${errorText(error)}`,
			);
		}
		state.generation = pending.generation;
		state.role = 'primary';
		state.promoted = { generation: pending.generation, lsn: outcome.lsn };
		state.pendingPromotion = null;
		// Only the generation being acquired matters; older notices are diagnostics.
		for (const generation of state.notices.keys()) if (generation < pending.generation) state.notices.delete(generation);
		this.#event('promoted', desired.databaseId, pending.generation, outcome.lsn ?? undefined);
	}

	/** Keep the won `changing` lease alive while `pg_ctl promote` retries (same generation, holder). */
	async #renewChangingLease(desired: DatabaseMembersDesired, record: MemberLeaseRecord, arbiterNow: number): Promise<void> {
		if (!this.arbiter) return;
		const expiry = Date.parse(record.lease.expiresAt);
		const base = Number.isFinite(expiry) ? Math.max(arbiterNow, expiry) : arbiterNow;
		const next: DatabaseLease = { ...record.lease, expiresAt: new Date(base + this.leaseTtlMs).toISOString() };
		const result = await this.arbiter.compareAndSwap(desired.databaseId, record.etag, next);
		if (result.ok) {
			const state = this.states.get(desired.databaseId);
			if (state) {
				state.leaseExpiresAt = next.expiresAt;
				state.lastRenewAt = this.now();
			}
		} else {
			this.#event('promotion-failed', desired.databaseId, record.lease.generation, 'the changing lease could not be renewed while retrying promotion');
		}
	}

	#candidate(
		desired: DatabaseMembersDesired,
		state: DatabaseMemberState,
		record: MemberLeaseRecord | null,
		arbiterNow: number,
		notice: FenceNotice | null,
	): CandidateDecision {
		return evaluateCandidate({
			nodeId: this.nodeId,
			arbiterNow,
			lease: record?.lease ?? null,
			arbiterReachable: true,
			streaming: state.streaming,
			streamDownSince: state.streamDownSince,
			autoArmed: desired.failover?.mode === 'auto',
			acceptDataLoss: desired.failover?.acceptDataLoss ?? false,
			lastPrimaryAnswerAt: this.peer.lastAnsweredToPrimary(desired.databaseId),
			monotonicNow: this.now(),
			notice,
			casInFlight: state.busy,
			streamDownMs: this.streamDownMs,
			keepAliveTtlMs: this.keepAliveMs,
		});
	}

	/**
	 * Stop writes/read-only and **confirm** (review blocker 4), then send the fence notice to every
	 * reachable member within 2 s, then report `fenced`. A fence that cannot be confirmed is retried
	 * and reported (`fence-failed`); the notice is only sent after the primary has stopped serving.
	 */
	async #fence(
		desired: DatabaseMembersDesired,
		state: DatabaseMemberState,
		workloadId: string,
		reason: string,
	): Promise<void> {
		if (state.role === 'fenced') return;
		state.role = 'fencing';
		const decidedAt = this.now();
		// 1. Stop serving writes and confirm it took effect before promising anything to a peer.
		let confirmed = false;
		try {
			await this.helper.fence(workloadId, 'readonly');
			const status = await this.helper.status(workloadId);
			// `readOnly` is the authoritative drain flag; a stopped/moved member is in recovery.
			confirmed = status.readOnly || status.inRecovery;
		} catch (error) {
			this.log('error', `could not fence ${desired.databaseId}: ${errorText(error)}`);
		}
		if (!confirmed) {
			state.fenceFailures += 1;
			this.#event(
				'fence-failed',
				desired.databaseId,
				state.generation,
				`the fence was not confirmed (attempt ${state.fenceFailures}); retrying before any notice; ${reason}`,
			);
			return;
		}
		state.fenceFailures = 0;
		// F3: the 2 s notice window starts **after** the fence is confirmed; a slow fence no longer
		// consumes it. Report the fence and fan-out times separately.
		const noticeStartedAt = this.now();
		const fenceMs = noticeStartedAt - decidedAt;
		const notice: FenceNotice = {
			generation: state.generation,
			// W9's database lease has a generation, not a separate epoch; the notice names both.
			epoch: state.generation,
			from: this.nodeId,
			at: new Date(this.wallNow()).toISOString(),
		};
		// Best-effort fan-out, bounded by §5.0's 2 s from the notice attempt (including peers()).
		const budget = () => Math.max(0, 2_000 - (this.now() - noticeStartedAt));
		const peers = (await Promise.race([this.peer.peers(desired.databaseId).catch(() => []), deadline(budget())])) ?? [];
		let delivered = 0;
		const sends = peers
			.filter((peer) => peer.reachable && peer.nodeId !== this.nodeId)
			.map((peer) =>
				this.peer
					.sendFenceNotice(desired.databaseId, peer.nodeId, notice)
					.then((sent) => {
						if (sent) delivered += 1;
					})
					.catch(() => undefined),
			);
		await Promise.race([Promise.all(sends), deadline(budget())]);
		const sentAt = this.now();
		const noticeMs = sentAt - noticeStartedAt;
		this.#event(
			delivered > 0 ? 'fence-notice-sent' : 'fence-notice-missed',
			desired.databaseId,
			state.generation,
			`${reason}; fence ${fenceMs} ms, fan-out ${noticeMs} ms, notice reached ${delivered}/${peers.length} peer(s)${fenceNoticeWithinBudget(noticeStartedAt, sentAt) ? '' : ' (fan-out over the 2 s budget)'}`,
			notice,
		);
		// 3. Only now is the old primary `fenced`.
		state.role = 'fenced';
		this.#event('fenced', desired.databaseId, state.generation, reason);
	}

	#state(databaseId: string, desiredRole: 'primary' | 'replica', generation: number): DatabaseMemberState {
		const existing = this.states.get(databaseId);
		if (existing) return existing;
		const state: DatabaseMemberState = {
			role: desiredRole === 'primary' ? 'primary' : 'streaming',
			generation,
			streaming: desiredRole === 'replica',
			streamDownSince: null,
			lsn: null,
			notices: this.pendingNotices.get(databaseId) ?? new Map<number, FenceNotice>(),
			pendingPromotion: null,
			fenceFailures: 0,
			lastProofAt: null,
			lastRenewAt: null,
			arbiterReachable: false,
			leaseExpiresAt: null,
			busy: false,
			promoted: null,
		};
		this.pendingNotices.delete(databaseId);
		this.states.set(databaseId, state);
		return state;
	}

	#report(
		desired: DatabaseMembersDesired,
		state: DatabaseMemberState,
		lsn: string | null,
	): void {
		this.lastReports.set(desired.databaseId, {
			databaseId: desired.databaseId,
			role: state.role,
			generation: state.generation,
			epoch: desired.leaseEpoch,
			streaming: state.streaming,
			inRecovery: state.role !== 'primary',
			lsn,
			readOnly: state.role === 'fenced',
			fenced: state.role === 'fenced',
			leaseGeneration: desired.leaseGeneration,
			leaseEpoch: desired.leaseEpoch,
			durabilityEffective: desired.durabilityEffective,
			syncState: desired.syncState,
			arbiterReachable: state.arbiterReachable,
			leaseExpiresAt: state.leaseExpiresAt,
			primaryKeepAliveAt:
				state.role === 'primary'
					? null
					: (() => {
							const answered = this.peer.lastAnsweredToPrimary(desired.databaseId);
							return answered === null ? null : new Date(this.wallNow() - (this.now() - answered)).toISOString();
						})(),
			observedAt: new Date(this.wallNow()).toISOString(),
		});
	}

	#event(kind: MemberEventKind, databaseId: string, generation: number, detail?: string, notice?: FenceNotice): void {
		const event = { kind, databaseId, nodeId: this.nodeId, at: new Date(this.wallNow()).toISOString(), generation, detail, notice };
		this.events.push(event);
		if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
		this.onEvent(event);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Resolve after `ms`; used only to bound a best-effort fan-out, never as a safety clock. */
function deadline(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		(timer as { unref?: () => void }).unref?.();
	});
}

/**
 * The helper verbs a production runner needs, narrowed so the agent's `HelperClient` satisfies it.
 * The machine calls only these; `memberStatus` returns the authoritative `pg_is_in_recovery`.
 */
export function memberOperations(helper: Pick<HelperApi, 'memberStatus' | 'fenceWorkload' | 'replicaPromote' | 'syncConfigure'>): MemberOperations {
	return {
		status: (workloadId) => helper.memberStatus(workloadId),
		fence: (workloadId, mode) => helper.fenceWorkload(workloadId, mode),
		promote: (workloadId, databaseId) => helper.replicaPromote(workloadId, databaseId),
		clearSync: (workloadId) => helper.syncConfigure(workloadId, []),
	};
}

/** Whether an agent capability list can host the machine (W11-SPEC §3). */
export function declaresDbMember(capabilities: readonly string[]): boolean {
	return capabilities.includes(DB_MEMBER_CAPABILITY);
}

/**
 * The report-only peer transport: no mTLS member RPC is configured yet. It keeps the machine
 * running as an honest observer (role/generation reports) and makes every peer unreachable, so no
 * fence notice is claimed and the keep-alive gate stays closed. The design question is recorded in
 * LANE-A-HANDOFF.md: a node needs direct arbiter credentials and a peer channel before automatic
 * promotion can be enabled outside the lab.
 */
export function reportOnlyPeerTransport(): MemberPeerTransport {
	return {
		async peers(): Promise<MemberPeerView[]> {
			return [];
		},
		async sendFenceNotice(): Promise<boolean> {
			return false;
		},
		async keepAlive(): Promise<{ everyPeerAnswered: boolean }> {
			return { everyPeerAnswered: false };
		},
		lastAnsweredToPrimary(): number | null {
			return null;
		},
	};
}
