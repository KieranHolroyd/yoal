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
	/** Clear the inherited `synchronous_standby_names` as the new primary. */
	clearSync(databaseId: string): Promise<void>;
}

export type MemberEventKind =
	| 'candidate'
	| 'promoted'
	| 'cas-lost'
	| 'fenced'
	| 'fence-notice-sent'
	| 'fence-notice-missed'
	| 'fence-notice-received'
	| 'fence-notice-ignored'
	| 'lease-renewed'
	| 'failsafe-held'
	| 'refused';

export interface MemberEvent {
	kind: MemberEventKind;
	databaseId: string;
	nodeId: string;
	at: number;
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
	/** The last notice this member holds, keyed by its generation, newest wins. */
	notice: FenceNotice | null;
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
	now?: () => number;
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
	private readonly log: NonNullable<DatabaseMemberRunnerOptions['log']>;
	private readonly onEvent: (event: MemberEvent) => void;
	private readonly leaseTtlMs: number;
	private readonly streamDownMs: number;
	private readonly keepAliveMs: number;
	private readonly renewMs: number;
	private readonly states = new Map<string, DatabaseMemberState>();
	private readonly lastReports = new Map<string, DatabaseMemberReport>();
	/** A notice delivered before the first desired-state pass (state is created on observe). */
	private readonly pendingNotices = new Map<string, FenceNotice>();

	constructor(options: DatabaseMemberRunnerOptions) {
		this.nodeId = options.nodeId;
		this.helper = options.helper;
		this.arbiter = options.arbiter;
		this.peer = options.peer;
		this.now = options.now ?? Date.now;
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
			// keep the notice so the candidate check can use it, but never treat it as authorisation
			// on its own (the check validates generation, sender and epoch).
			this.pendingNotices.set(databaseId, notice);
			this.#event('fence-notice-received', databaseId, 0, `notice for generation ${notice.generation} (awaiting state)`, notice);
			return;
		}
		// Store a cross-generation notice (so a stale delivery is observable) but only the candidate
		// check authorises it. A duplicate is idempotent.
		if (state.notice && notice.at && state.notice.at && notice.at < state.notice.at && notice.generation === state.notice.generation)
			return;
		state.notice = notice;
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
			await this.#keepPrimary(desired, state, wasPrimary);
		} else if (desiredRole === 'replica') {
			await this.#tryCandidate(desired, state, state.notice);
		}
		// A fenced old primary is never resurrected here: desired state's rewind task re-attaches it
		// as a replica. This machine only stops it serving.
		this.#report(desired, state, status.lsn);
	}

	/** Renew, or fence when the lease cannot be proved and the H21 failsafe does not hold. */
	async #keepPrimary(desired: DatabaseMembersDesired, state: DatabaseMemberState, wasPrimary: boolean): Promise<void> {
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
			await this.#fence(desired, state, `a higher generation or another holder is visible (generation ${record.lease.generation})`);
			return;
		}

		if (record && record.lease.holderNodeId === this.nodeId) {
			const expiry = Date.parse(record.lease.expiresAt);
			// A lease that is already expired by the arbiter clock cannot be resurrected: this member
			// failed to prove it before the TTL, so it fences rather than renewing back to life.
			if (!Number.isFinite(expiry) || expiry <= arbiterNow) {
				await this.#fence(desired, state, 'the lease expired before this member could renew it');
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
							await this.#fence(desired, state, 'the lease was taken at another generation');
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
		if (wasPrimary && proofAge !== null && proofAge > this.leaseTtlMs) await this.#fence(desired, state, 'cannot prove the lease and the failsafe does not hold');
	}

	/** §4: evaluate candidate conditions and, only if all hold, CAS `generation + 1`. */
	async #tryCandidate(desired: DatabaseMembersDesired, state: DatabaseMemberState, notice: FenceNotice | null): Promise<void> {
		if (state.busy) return;
		const failover = desired.failover;
		if (!failover || failover.mode !== 'auto') return;
		const acceptDataLoss = failover.acceptDataLoss;
		// W11-MODEL assumption 9: a downgraded sync database without acceptDataLoss is async now.
		if (desired.durabilityEffective === 'async' && !acceptDataLoss && desired.durability === 'sync') return;
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
					state.notice = null;
					return;
				}
				state.leaseExpiresAt = latest!.lease.expiresAt;
			}
			const outcome = await this.helper.promote(desired.databaseId, desired.databaseId);
			if (!outcome.promoted) {
				this.#event('refused', desired.databaseId, next.generation, outcome.error ?? 'pg_ctl promote did not complete');
				return;
			}
			// §5.3: clear the inherited sync setting and become the new primary.
			await this.helper.clearSync(desired.databaseId).catch((error: unknown) =>
				this.log('warn', `could not clear the sync setting for ${desired.databaseId}: ${errorText(error)}`),
			);
			state.generation = next.generation;
			state.role = 'primary';
			state.promoted = { generation: next.generation, lsn: outcome.lsn };
			state.notice = null;
			this.#event('promoted', desired.databaseId, next.generation, outcome.lsn ?? undefined);
		} catch (error) {
			this.#event('refused', desired.databaseId, state.generation, errorText(error));
		} finally {
			state.busy = false;
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
	 * §5.0/§1.8: stop serving first, send the notice to every reachable member within 2 s, then
	 * fence Postgres. Delivery is best effort; the lease and keep-alive rules remain the authority.
	 */
	async #fence(desired: DatabaseMembersDesired, state: DatabaseMemberState, reason: string): Promise<void> {
		if (state.role === 'fenced' || state.role === 'fencing') return;
		state.role = 'fencing';
		const decidedAt = this.now();
		const notice: FenceNotice = {
			generation: state.generation,
			// W9's database lease has a generation, not a separate epoch; the notice names both.
			epoch: state.generation,
			from: this.nodeId,
			at: new Date(decidedAt).toISOString(),
		};
		const peers = await this.peer.peers(desired.databaseId).catch(() => []);
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
		// §5.0: the notice attempt is best effort and must not delay stopping Postgres past 2 s.
		await Promise.race([Promise.all(sends), deadline(2_000)]);
		const sentAt = this.now();
		this.#event(
			delivered > 0 ? 'fence-notice-sent' : 'fence-notice-missed',
			desired.databaseId,
			state.generation,
			`${reason}; notice reached ${delivered}/${peers.length} peer(s)${fenceNoticeWithinBudget(decidedAt, sentAt) ? '' : ' (over the 2 s budget)'}`,
			notice,
		);
		try {
			await this.helper.fence(desired.databaseId, 'readonly');
		} catch (error) {
			this.log('error', `could not fence ${desired.databaseId}: ${errorText(error)}`);
		}
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
			notice: this.pendingNotices.get(databaseId) ?? null,
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
					: this.peer.lastAnsweredToPrimary(desired.databaseId) === null
						? null
						: new Date(this.peer.lastAnsweredToPrimary(desired.databaseId)!).toISOString(),
			observedAt: new Date(this.now()).toISOString(),
		});
	}

	#event(kind: MemberEventKind, databaseId: string, generation: number, detail?: string, notice?: FenceNotice): void {
		this.onEvent({ kind, databaseId, nodeId: this.nodeId, at: this.now(), generation, detail, notice });
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
		clearSync: (databaseId) => helper.syncConfigure(databaseId, []),
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
