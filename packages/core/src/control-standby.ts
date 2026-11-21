import type { ControlRole } from '@yoal/contracts';
import type { ControlLease, ControlLeaseStatus } from './ha-lease.ts';

/**
 * The W9 control-plane machine (docs/build-plan/W9-SPEC.md §4, Revision 1).
 *
 * `ControlLease` owns the object-store protocol: expiry on the arbiter's clock, the 30 s TTL, the
 * 20 s fence and the 40 s takeover quiet window. This class owns the **role** the rest of the
 * process is allowed to act on, and the gates between the two:
 *
 * - `joining` / `standby-behind` / `promoting` are not `primary` for any purpose: `/api/agent/*`
 *   gets 503 and no run lease is renewed, even while the lease object names this node.
 * - `primary` requires the lease to still be confirmed *and* the promotion evidence (master key
 *   fingerprint, config digest, migrations, replay) to have been checked before serving.
 * - `fenced` is sticky until the holder has been stable and this node's replica is current; only
 *   then may it rejoin as a standby. It never serves a write or an agent request meanwhile.
 * - The highest epoch seen is persisted **before** the node serves or writes at it (W9-SPEC §1).
 *
 * All times are monotonic milliseconds; the wall clock is never consulted. The caller supplies
 * the replica/evidence snapshot, so this class stays free of SQLite, HTTP and process state.
 */

export const CONTROL_STANDBY_TIMERS = {
	/** CONTROL_TTL: lease validity on the arbiter's clock. */
	ttlMs: 30_000,
	/** CONTROL_RENEW: the holder renews three times per TTL. */
	renewMs: 10_000,
	/** CONTROL_TAKEOVER_QUIET: unchanged object window before a takeover CAS. */
	takeoverQuietMs: 40_000,
	/** CONTROL_FENCE_AFTER: a holder that cannot confirm stops serving. */
	fenceAfterMs: 20_000,
	/** A standby is promotable only when replay is this close. */
	maxReplicaLagSeconds: 5,
	/** Errors that are not CAS conflicts, this long with no safe role, make `unavailable`. */
	unavailableAfterMs: 30_000,
	/** W9-SPEC §4.3 `fenced -> standby`: the holder observed stable, and the replica current. */
	rejoinAfterFenceMs: 5_000,
} as const;

/** What this node knows about its own control replica. */
export interface ControlReplicaState {
	/** The replica exists and has been restored on this host. */
	restored: boolean;
	/** Seconds behind the primary, or null when it cannot be measured. */
	lagSeconds: number | null;
	/** A replay position for `/readyz`, e.g. `ltx:42/9f`. Never a secret. */
	position: string | null;
}

/**
 * The evidence a promotion is allowed. A primary that cannot decrypt its own state is not a
 * primary (W9-SPEC decision 5), so every field is required and fails closed when missing.
 */
export interface PromotionEvidence {
	replica: ControlReplicaState;
	/** Fingerprint of the key actually loaded on this host (`sha256` of the key bytes). */
	masterKeyFingerprint: string | null;
	/** Fingerprint the primary's sealed delivery says this host must hold. */
	expectedMasterKeyFingerprint: string | null;
	/** Digest of the allowlisted platform config on this host. */
	configDigest: string | null;
	/** Digest the primary delivered at enrolment. */
	expectedConfigDigest: string | null;
	/** Every migration in this release is applied. */
	migrationsApplied: boolean;
}

export interface PromotionCheck {
	ok: boolean;
	/** `ok` with replay current; the value `/readyz` reports. */
	canPromote: boolean;
	/** One human-readable refusal per failed condition, in a stable order. */
	reasons: string[];
}

/** Pure, so `canPromote` is tested without a store, a clock or a running process. */
export function evaluatePromotion(evidence: PromotionEvidence): PromotionCheck {
	const reasons: string[] = [];
	const replica = evidence.replica;
	if (!replica.restored) reasons.push('the control replica is not restored on this host');
	else if (replica.lagSeconds === null) reasons.push('replica replay lag cannot be measured');
	else if (replica.lagSeconds > CONTROL_STANDBY_TIMERS.maxReplicaLagSeconds)
		reasons.push(`replica replay is ${Math.round(replica.lagSeconds)} s behind (at most ${CONTROL_STANDBY_TIMERS.maxReplicaLagSeconds} s)`);

	if (!evidence.masterKeyFingerprint) reasons.push('the master key is not present');
	else if (!evidence.expectedMasterKeyFingerprint)
		reasons.push('no master-key fingerprint was delivered at enrolment, so the key cannot be verified');
	else if (evidence.masterKeyFingerprint !== evidence.expectedMasterKeyFingerprint)
		reasons.push('the master key fingerprint differs from the one delivered at enrolment');

	if (!evidence.configDigest) reasons.push('the allowlisted platform config is missing');
	else if (!evidence.expectedConfigDigest)
		reasons.push('no config digest was delivered at enrolment, so the config cannot be verified');
	else if (evidence.configDigest !== evidence.expectedConfigDigest)
		reasons.push('the allowlisted platform config differs from the primary’s');

	if (!evidence.migrationsApplied) reasons.push('this release’s migrations are not applied on this host');

	return { ok: reasons.length === 0, canPromote: reasons.length === 0, reasons };
}

/** A primary is already authoritative: it needs its key, its schema and a readable state, not a
 * peer's fingerprint. A standby needs the full comparison. */
export function evaluatePrimaryReadiness(evidence: PromotionEvidence): PromotionCheck {
	const reasons: string[] = [];
	if (!evidence.masterKeyFingerprint) reasons.push('the master key is not present');
	if (!evidence.migrationsApplied) reasons.push('this release’s migrations are not applied on this host');
	if (!evidence.replica.restored) reasons.push('the control database is not readable');
	return { ok: reasons.length === 0, canPromote: reasons.length === 0, reasons };
}

export type ControlStandbyState = Exclude<ControlRole, 'primary'> | 'primary';

export interface ControlStandbyOptions {
	lease: ControlLease;
	nodeId: string;
	/** `primary` for the node that already owns the install; `standby` for an enrolled node. */
	roleHint: 'primary' | 'standby';
	/**
	 * Whether this host holds an enrolment record from the primary (master-key fingerprint, config
	 * digest). Promotion is refused without it: an unverified node must not win a term. This is a
	 * property of the host, not the static role hint.
	 */
	enrolled?: boolean;
	/** The highest epoch already on disk, so status and promotion start above it. */
	initialEpoch?: number;
	/** Read fresh on every tick; may be async (a file or a helper call). */
	evidence: () => PromotionEvidence | Promise<PromotionEvidence>;
	/** Persist the highest epoch before this node serves or writes at it. */
	persistEpoch?: (epoch: number, reason: string) => void | Promise<void>;
	/** Monotonic milliseconds; defaults to the lease's clock if it exposes one. */
	monotonic?: () => number;
	/** Wall clock for the ISO timestamps in `/readyz`; never used for a safety decision. */
	wallClock?: () => number;
	/** A standby takes over by itself when every check passes (W9-SPEC §4.3). */
	autoPromote?: boolean;
	/** After this long, a fenced node whose replica is current may rejoin as a standby. */
	rejoinAfterFenceMs?: number;
	log?: (level: 'info' | 'warn', message: string) => void;
}

export interface ControlGate {
	status: 503;
	headers: Record<string, string>;
	reason: string;
}

export interface ControlReadyz {
	status: 200 | 503;
	body: {
		ok: boolean;
		role: ControlRole;
		epoch: number;
		canPromote: boolean;
		reason: string;
		lease: { holder: string | null; expiresAt: string | null; released: boolean; skewMs: number | null };
		replication: { restored: boolean; lagSeconds: number | null; position: string | null };
		promotion: { reasons: string[] };
	};
}

export interface ControlStandbySnapshot {
	state: ControlStandbyState;
	epoch: number;
	/** The role as the wire contract spells it; a primary that lost `holds()` reports `fenced`. */
	role: ControlRole;
	canPromote: boolean;
	reason: string;
	replica: ControlReplicaState;
	promotionReasons: string[];
	lease: ControlLeaseStatus;
	changedAt: number;
}

export class ControlStandby {
	readonly #lease: ControlLease;
	readonly #nodeId: string;
	readonly #roleHint: 'primary' | 'standby';
	readonly #enrolled: boolean;
	readonly #evidence: () => PromotionEvidence | Promise<PromotionEvidence>;
	readonly #persistEpoch: (epoch: number, reason: string) => void | Promise<void>;
	readonly #monotonic: () => number;
	readonly #wallClock: () => number;
	readonly #autoPromote: boolean;
	readonly #rejoinAfterFenceMs: number;
	readonly #log?: (level: 'info' | 'warn', message: string) => void;

	#state: ControlStandbyState = 'joining';
	#epoch = 0;
	#persistedEpoch = 0;
	#reason = 'not started';
	#changedAt = 0;
	#fencedAt: number | null = null;
	#lastArbiterOkAt: number | null = null;
	#lastErrorAt: number | null = null;
	#promotionStartedAt: number | null = null;
	#evidenceSnapshot: PromotionEvidence = {
		replica: { restored: false, lagSeconds: null, position: null },
		masterKeyFingerprint: null,
		expectedMasterKeyFingerprint: null,
		configDigest: null,
		expectedConfigDigest: null,
		migrationsApplied: false,
	};
	#promotionCheck: PromotionCheck = { ok: false, canPromote: false, reasons: ['not evaluated yet'] };

	constructor(options: ControlStandbyOptions) {
		this.#lease = options.lease;
		this.#nodeId = options.nodeId;
		this.#roleHint = options.roleHint;
		this.#enrolled = options.enrolled ?? false;
		this.#evidence = options.evidence;
		this.#persistEpoch = options.persistEpoch ?? (() => undefined);
		this.#monotonic = options.monotonic ?? (() => performance.now());
		this.#wallClock = options.wallClock ?? Date.now;
		this.#autoPromote = options.autoPromote ?? true;
		this.#rejoinAfterFenceMs = options.rejoinAfterFenceMs ?? CONTROL_STANDBY_TIMERS.rejoinAfterFenceMs;
		this.#log = options.log;
		this.#epoch = options.initialEpoch ?? 0;
		this.#persistedEpoch = options.initialEpoch ?? 0;
		this.#changedAt = this.#monotonic();
	}

	/** The current role for gates and status, without a store round trip. */
	snapshot(): ControlStandbySnapshot {
		const lease = this.#lease.status();
		const healthyPrimary = this.#state === 'primary' && this.#lease.holds();
		return {
			state: this.#state,
			epoch: this.#epoch,
			role: healthyPrimary ? 'primary' : this.#state === 'primary' ? 'fenced' : this.#state,
			canPromote: this.#promotionCheck.canPromote,
			reason: healthyPrimary ? this.#reason : this.#state === 'primary' ? 'the lease is no longer confirmed' : this.#reason,
			replica: this.#evidenceSnapshot.replica,
			promotionReasons: this.#promotionCheck.reasons,
			lease,
			changedAt: this.#changedAt,
		};
	}

	/** One protocol step. Call every `CONTROL_RENEW`; also safe to call on any event. */
	async tick(): Promise<ControlStandbySnapshot> {
		const now = this.#monotonic();
		if (this.#state === 'fenced') {
			await this.#maybeRejoin(now);
			if (this.#state === 'fenced') return this.snapshot();
		}

		const evidence = await this.#evidence();
		this.#evidenceSnapshot = evidence;
		this.#promotionCheck = this.#check(evidence);

		// A standby may promote only from healthy `standby`, and only when every check passes. The
		// node must be enrolled (the fingerprint/digest comparison is evidence, not a role hint), so
		// an ex-primary that was re-seeded and enrolled can take over again. The lease's own 40 s
		// quiet window is the final gate: `mayTakeOver` cannot shorten it.
		const mayTakeOver =
			this.#autoPromote &&
			this.#enrolled &&
			this.#state === 'standby' &&
			this.#promotionCheck.ok;

		const status = await this.#lease.tick({ mayTakeOver });
		await this.#absorb(status, now);
		return this.snapshot();
	}

	/**
	 * Start: learn the object, and for a primary-capable node let the service bootstrap if the
	 * object is absent. A standby never creates a lease (W9-SPEC §4.1).
	 */
	async start(): Promise<ControlStandbySnapshot> {
		if (this.#roleHint === 'primary') {
			this.#state = 'promoting';
			this.#reason = 'starting the control plane: promotion checks are running';
		} else {
			this.#state = 'joining';
			this.#reason = 'joining: waiting for a restored control replica';
		}
		this.#changedAt = this.#monotonic();
		return this.tick();
	}

	/**
	 * Operator promotion (`yoal ha control promote`). The readiness checks run before the CAS, so
	 * an unverifiable or unenrolled node never wins it. The lease still applies expiry and the 40 s
	 * quiet window unless `breakGlass` is explicit, and `expectedEpoch` is compared against the
	 * record read for this CAS, not a cached value.
	 */
	async promoteNow(expectedEpoch?: number, options: { breakGlass?: boolean } = {}): Promise<ControlStandbySnapshot> {
		if (this.#state === 'primary' && this.#lease.holds()) {
			// Already serving: still verify --expect-epoch against the object just read, so the command
			// never reports success for the wrong term. No CAS happens here.
			if (expectedEpoch === undefined) return this.snapshot();
			try {
				await this.#lease.operatorTakeOver({ expectedEpoch });
			} catch (error) {
				this.#reason = `promotion refused: ${error instanceof Error ? error.message : String(error)}`;
			}
			return this.snapshot();
		}
		if (!this.#enrolled) {
			this.#reason = 'promotion refused: this host has no enrolment record, so the master key and config cannot be verified';
			return this.snapshot();
		}
		const evidence = await this.#evidence();
		this.#evidenceSnapshot = evidence;
		this.#promotionCheck = this.#check(evidence);
		if (!this.#promotionCheck.ok) {
			this.#reason = `promotion refused: ${this.#promotionCheck.reasons.join('; ')}`;
			return this.snapshot();
		}
		if (this.#state === 'fenced') {
			this.#reason = 'promotion refused: a fenced node is re-seeded before it can be promoted';
			return this.snapshot();
		}
		const now = this.#monotonic();
		let status: ControlLeaseStatus;
		try {
			status = await this.#lease.operatorTakeOver({ expectedEpoch, breakGlass: options.breakGlass });
		} catch (error) {
			this.#reason = `promotion refused: ${error instanceof Error ? error.message : String(error)}`;
			return this.snapshot();
		}
		await this.#absorb(status, now, 'operator');
		if (this.#state === 'primary' || this.#state === 'promoting') await this.#confirm(now);
		return this.snapshot();
	}

	/** `/api/agent/*` and run-lease gate. `null` means serve; otherwise a 503 payload. */
	agentGate(): ControlGate | null {
		const snapshot = this.snapshot();
		if (snapshot.role === 'primary') return null;
		return {
			status: 503,
			headers: {
				'x-yoal-role': snapshot.role,
				'x-yoal-epoch': String(snapshot.epoch),
				...(snapshot.role === 'fenced' ? { 'x-yoal-fenced': '1' } : {}),
				'cache-control': 'no-store',
				'retry-after': '5',
			},
			reason: snapshot.reason,
		};
	}

	/** A write outside `/api/agent/*`: fenced and non-primary nodes refuse it, reads stay. */
	writeGate(method: string, path: string): ControlGate | null {
		// Agent requests are refused by every non-primary role, even a GET.
		if (path.startsWith('/api/agent/')) return this.agentGate();
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
		// The one write a standby must be able to make is its own CAS. The action still needs
		// `canPromote` and refuses a fenced node; without this exemption the Promote button would
		// be served by the standby but its POST would 503.
		if (path === '/api/v1/ha/control/promote') return null;
		const snapshot = this.snapshot();
		if (snapshot.role === 'primary') return null;
		return {
			status: 503,
			headers: {
				'x-yoal-role': snapshot.role,
				'x-yoal-epoch': String(snapshot.epoch),
				'x-yoal-fenced': snapshot.role === 'fenced' ? '1' : '0',
				'cache-control': 'no-store',
				'retry-after': '5',
			},
			reason: snapshot.reason,
		};
	}

	/** The last control-plane action may renew a run lease only while serving as primary. */
	mayRenewRunLease(): boolean {
		return this.snapshot().role === 'primary';
	}

	readyz(): ControlReadyz {
		const snapshot = this.snapshot();
		const serving = snapshot.role === 'primary';
		const humans = serving || snapshot.role === 'standby' || snapshot.role === 'standby-behind' || snapshot.role === 'promoting';
		const status: 200 | 503 = humans ? 200 : 503;
		return {
			status,
			body: {
				ok: status === 200,
				role: snapshot.role,
				epoch: snapshot.epoch,
				canPromote: this.#promotionCheck.canPromote,
				reason: snapshot.reason,
				lease: {
					holder: snapshot.lease.holderNodeId,
					expiresAt: snapshot.lease.expiresAt === null ? null : new Date(snapshot.lease.expiresAt).toISOString(),
					released: snapshot.lease.released,
					skewMs: snapshot.lease.skewMs,
				},
				replication: {
					restored: snapshot.replica.restored,
					lagSeconds: snapshot.replica.lagSeconds,
					position: snapshot.replica.position,
				},
				promotion: { reasons: this.#promotionCheck.reasons },
			},
		};
	}

	#check(evidence: PromotionEvidence): PromotionCheck {
		// An enrolled node is a candidate even if its static hint says `primary`: after a failover the
		// old primary must be able to win a later term once re-seeded and enrolled. Only the initial
		// unenrolled owner uses the lighter primary check, and it is not allowed to take over.
		return this.#enrolled || this.#roleHint === 'standby'
			? evaluatePromotion(evidence)
			: evaluatePrimaryReadiness(evidence);
	}

	async #absorb(status: ControlLeaseStatus, now: number, source: 'tick' | 'operator' = 'tick'): Promise<void> {
		const previous = this.#state;
		const previousEpoch = this.#epoch;
		this.#epoch = Math.max(this.#epoch, status.epoch);
		if (this.#epoch > previousEpoch) {
			// Persisted before any role change; a crash between the two leaves the safe side.
			await this.#persist(this.#epoch, 'the arbiter reported a higher epoch');
			if (status.role === 'fenced' && status.epoch > previousEpoch) this.#reason = 'a higher epoch was observed; fencing before any write';
		}

		if (status.role === 'fenced') {
			this.#set('fenced', status.reason, now);
			this.#fencedAt ??= now;
			return;
		}
		if (status.role === 'unavailable' || !status.reachable) {
			this.#noteArbiterError(now, status.reason);
			return;
		}
		this.#lastArbiterOkAt = now;
		this.#lastErrorAt = null;

		if (status.role === 'primary') {
			if (this.#state === 'primary') {
				if (!this.#lease.holds()) {
					this.#set('fenced', 'the lease is no longer confirmed (fence window elapsed)', now);
					this.#fencedAt = now;
					return;
				}
				this.#reason = `primary at epoch ${this.#epoch}`;
				return;
			}
			this.#set('promoting', source === 'operator' ? 'promoted by an operator; finishing checks' : `won the arbitration at epoch ${this.#epoch}`, now);
			this.#promotionStartedAt = now;
			await this.#confirm(now);
			return;
		}

		// Following another holder, or the object is absent/unknown.
		this.#promotionStartedAt = null;
		const replica = this.#evidenceSnapshot.replica;
		if (!replica.restored) {
			this.#set('joining', this.#roleHint === 'primary' ? 'waiting for this control node’s replica to be restored' : status.reason, now);
			return;
		}
		if (replica.lagSeconds === null) {
			this.#set('standby-behind', 'replica replay lag cannot be measured', now);
			return;
		}
		if (replica.lagSeconds > CONTROL_STANDBY_TIMERS.maxReplicaLagSeconds) {
			this.#set('standby-behind', `replica replay is ${Math.round(replica.lagSeconds)} s behind`, now);
			return;
		}
		if (this.#state === 'fenced') {
			this.#reason = 'fenced: following the holder again, but not serving';
			return;
		}
		this.#set('standby', status.reason, now);
		if (this.#autoPromote && this.#enrolled && this.#promotionCheck.ok && previous === 'standby')
			this.#reason = `${status.reason}; takeover needs the object unchanged for ${Math.round(this.#lease.policy.takeoverAfterMs / 1000)} s`;
	}

	async #confirm(now: number): Promise<void> {
		if (this.#state !== 'promoting') return;
		const evidence = await this.#evidence();
		this.#evidenceSnapshot = evidence;
		this.#promotionCheck = this.#check(evidence);
		if (!this.#promotionCheck.ok) {
			this.#reason = `promotion blocked: ${this.#promotionCheck.reasons.join('; ')}`;
			// The node already won the lease. It must not hold a term it cannot serve: release it
			// so another standby may take over, then fence before any write.
			await this.#lease.release().catch(() => undefined);
			this.#set('fenced', this.#reason, now);
			this.#fencedAt = now;
			return;
		}
		if (!this.#lease.holds()) {
			this.#set('fenced', 'the lease was not confirmed after the takeover', now);
			this.#fencedAt = now;
			return;
		}
		await this.#persist(this.#epoch, 'serving as primary');
		this.#log?.('info', `control plane is primary at epoch ${this.#epoch}`);
		this.#set('primary', `primary at epoch ${this.#epoch}`, now);
	}

	/** Persist before the role can serve. A failed write keeps the role non-serving. */
	async #persist(epoch: number, reason: string): Promise<void> {
		if (epoch <= this.#persistedEpoch) return;
		await this.#persistEpoch(epoch, reason);
		this.#persistedEpoch = epoch;
	}

	async #maybeRejoin(now: number): Promise<void> {
		if (this.#fencedAt === null || now - this.#fencedAt < this.#rejoinAfterFenceMs) return;
		const evidence = await this.#evidence();
		this.#evidenceSnapshot = evidence;
		if (!evidence.replica.restored || (evidence.replica.lagSeconds ?? Number.POSITIVE_INFINITY) > CONTROL_STANDBY_TIMERS.maxReplicaLagSeconds)
			return;
		// W9-SPEC §4.3: the holder’s epoch is observed and stable and replay is current. The arbiter
		// must actually answer and name another holder; an unreachable store is not stability. This
		// only rejoins as a standby — a later term still needs a fresh 40 s-quiet CAS.
		const probe = await this.#lease.probe();
		if (!probe.reachable || probe.absent || probe.holderNodeId === this.#nodeId) return;
		this.#lease.resetAfterReseed();
		this.#fencedAt = null;
		this.#set('joining', `rejoining as a standby after fencing; ${probe.holderNodeId} holds epoch ${probe.epoch}`, now);
		this.#changedAt = now;
	}

	#noteArbiterError(now: number, reason: string): void {
		this.#lastErrorAt ??= now;
		if (this.#state === 'primary') return; // `ControlLease` fences a primary itself.
		if (now - this.#lastErrorAt >= CONTROL_STANDBY_TIMERS.unavailableAfterMs) {
			this.#set('unavailable', `the arbiter is unusable: ${reason}`, now);
			return;
		}
		this.#reason = `arbiter error: ${reason}`;
	}

	#set(state: ControlStandbyState, reason: string, now: number): void {
		if (this.#state !== state) {
			this.#state = state;
			this.#changedAt = now;
		}
		this.#reason = reason;
	}

	/** Node id, exposed for tests and status without reaching into a private field. */
	get nodeId(): string {
		return this.#nodeId;
	}

	/** ISO wall time a state was entered, for `/api/v1/ha/status`; never a safety input. */
	get changedAtIso(): string {
		// `stats.changedAt` is monotonic, so only the age is meaningful on the wire. Callers that
		// need an absolute time use `updatedAt` from the report row.
		return new Date(this.#wallClock() - (this.#monotonic() - this.#changedAt)).toISOString();
	}
}
