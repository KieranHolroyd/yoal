import { hostname } from 'node:os';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { controlState, migrations, nodes } from '@yoal/db';
import type { ControlLease as ControlLeaseView, ControlReport, ControlStatus, Principal } from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import { ControlLease } from './ha-lease.ts';
import { ArbiterUnavailableError, arbiterStore } from './ha-control-arbiter.ts';
import {
	CONTROL_STANDBY_TIMERS,
	ControlStandby,
	evaluatePromotion,
	type ControlGate,
	type ControlReplicaState,
	type ControlReadyz,
	type ControlStandbySnapshot,
	type PromotionEvidence,
} from './control-standby.ts';
import {
	controlConfigDigest,
	controlConfigEnvelope,
	masterKeyFingerprint,
	readControlEnrolment,
	readControlReplicaStatus,
	sealControlBundle,
	type ControlEnrolmentRecord,
	type SealedControlBundle,
} from './control-enrolment.ts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';

/**
 * Control-plane standby (HA-PLAN H21/C6, docs/build-plan/W9-SPEC.md §4): the process wiring around
 * `ControlLease` and `ControlStandby`.
 *
 * The service is deliberately thin: the lease owns the arbiter protocol and `ControlStandby` owns
 * the states, timers and gates. This class starts the loop, supplies the replica/enrolment evidence,
 * persists the highest epoch before serving, records status for `/api/v1/ha/status`, and exposes the
 * request gates the HTTP layer calls.
 *
 * With `CONTROL_STANDBY` off nothing here starts: no timer, no store call, no extra file, and a
 * single-node install keeps its exact previous behaviour.
 */
const EPOCH_FILE = 'ha-control-epoch.json';
const ENROLMENT_FILE = 'ha-control-enrolment.json';
const REPLICA_FILE = 'ha-control-replica.json';

export interface ControlPlaneEnrolmentInput {
	nodeId: string;
	csrPem: string;
	reason?: string;
}

export interface ControlPlaneEnrolmentResult {
	bundle: SealedControlBundle;
	/** Shown once on the primary and typed on the standby; never stored. */
	activationCode: string;
	certificate: { serial: string; certPem: string; notAfter: string };
}

export class ControlPlaneService {
	#runtime: ControlStandby | null = null;
	#lease: ControlLease | null = null;
	#timer: ReturnType<typeof setInterval> | null = null;
	#started = false;
	#nodeId: string;
	#failure: string | null = null;
	#lastSnapshot: ControlStandbySnapshot | null = null;
	#enrolment: ControlEnrolmentRecord | null = null;

	constructor(private readonly ctx: CoreContext) {
		this.#nodeId = (ctx.config.controlNodeId ?? process.env.YOAL_NODE_ID ?? hostname()).slice(0, 64);
	}

	enabled(): boolean {
		return featureEnabled(this.ctx.config, 'CONTROL_STANDBY');
	}

	/** This control node's lease identity. */
	get nodeId(): string {
		return this.#nodeId;
	}

	/**
	 * Start the lease loop. Idempotent; called once from the control-plane process. When the arbiter
	 * cannot be used, every HA surface fails closed instead of serving as if leases worked.
	 */
	async start(): Promise<void> {
		if (!this.enabled() || this.#started) return;
		this.#started = true;
		let store;
		try {
			store = arbiterStore(this.ctx.objectStore);
		} catch (error) {
			this.#failure = error instanceof ArbiterUnavailableError ? error.message : String(error);
			console.error(`[ha] control standby is unavailable: ${this.#failure}`);
			return;
		}
		const roleHint = this.ctx.config.controlRole === 'standby' ? 'standby' : 'primary';
		const baseline = await this.#highestEpoch();
		this.#lease = new ControlLease({
			store,
			nodeId: this.#nodeId,
			version: this.ctx.config.desiredAgentVersion,
			durableEpoch: () => this.#highestEpoch(),
			policy: {
				ttlMs: CONTROL_STANDBY_TIMERS.ttlMs,
				fenceAfterMs: CONTROL_STANDBY_TIMERS.fenceAfterMs,
				takeoverAfterMs: CONTROL_STANDBY_TIMERS.takeoverQuietMs,
				skewToleranceMs: 5_000,
			},
		});
		// A primary-capable process creates the object at `highest + 1` (epochs never decrease); an
		// existing object naming another holder is followed, never overwritten. A standby never
		// creates the lease (W9-SPEC §4.1).
		if (roleHint === 'primary') {
			try {
				await this.#lease.bootstrap(Math.max(baseline + 1, 1));
			} catch {
				// Existing lease held by another node, or a transient store error: follow it.
			}
		}
		this.#enrolment = await readControlEnrolment(this.#enrolmentPath());
		this.#runtime = new ControlStandby({
			lease: this.#lease,
			nodeId: this.#nodeId,
			roleHint,
			enrolled: this.#enrolment !== null,
			initialEpoch: baseline,
			evidence: () => this.#evidence(roleHint),
			persistEpoch: (epoch, reason) => this.#persistEpoch(epoch, reason),
			autoPromote: true,
			log: (level, message) => console[level === 'warn' ? 'warn' : 'info'](`[ha] ${message}`),
		});
		await this.#runtime.start();
		await this.#record();
		this.#timer = setInterval(() => {
			void this.#tick();
		}, CONTROL_STANDBY_TIMERS.renewMs);
		this.#timer.unref?.();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		this.#started = false;
	}

	async #tick(): Promise<void> {
		if (!this.#runtime) return;
		try {
			await this.#runtime.tick();
			this.#lastSnapshot = this.#runtime.snapshot();
			await this.#record();
		} catch (error) {
			// A tick failure is transient (SQLITE_BUSY, a disk write, a provider read). The lease
			// still decides; the gates read the runtime's own role, so do not wedge the process.
			console.error('[ha] control standby tick failed:', error instanceof Error ? error.message : error);
		}
	}

	/** `/readyz`: null when the feature is off, so the existing report is byte-identical. */
	readyz(): ControlReadyz | null {
		if (!this.enabled()) return null;
		if (this.#failure) return this.#failedReadyz();
		if (!this.#runtime) {
			return {
				status: 503,
				body: {
					ok: false,
					role: 'unavailable',
					epoch: 0,
					canPromote: false,
					reason: 'control standby has not started',
					lease: { holder: null, expiresAt: null, released: false, skewMs: null },
					replication: { restored: false, lagSeconds: null, position: null },
					promotion: { reasons: ['control standby has not started'] },
				},
			};
		}
		return this.#runtime.readyz();
	}

	/** `/api/agent/*` gate: only a confirmed primary serves agents (I11: everyone else 503). */
	agentGate(): ControlGate | null {
		if (!this.enabled()) return null;
		if (this.#failure) return this.#failedGate();
		return this.#runtime ? this.#runtime.agentGate() : this.#notStartedGate();
	}

	/** Every non-GET write: a fenced or non-primary control plane refuses it, reads stay. */
	writeGate(method: string, path: string): ControlGate | null {
		if (!this.enabled()) return null;
		if (this.#failure) return this.#failedGate();
		return this.#runtime ? this.#runtime.writeGate(method, path) : this.#notStartedGate();
	}

	/** A run lease may be renewed only while this node is a confirmed primary (W9-SPEC §4.6). */
	mayRenewRunLease(): boolean {
		if (!this.enabled()) return true;
		if (this.#failure || !this.#runtime) return false;
		return this.#runtime.mayRenewRunLease();
	}

	/** True only while this node is a confirmed primary (the flag off keeps today's behaviour). */
	mayActAsPrimary(): boolean {
		if (!this.enabled()) return true;
		return this.#runtime?.snapshot().role === 'primary';
	}

	/** The live snapshot for tests and the HTTP layer; null with the flag off. */
	snapshot(): ControlStandbySnapshot | null {
		return this.enabled() ? (this.#runtime?.snapshot() ?? this.#lastSnapshot) : null;
	}

	/** The highest epoch this node knows: live, else the persisted file, else `nodes.ha_epoch`. */
	async highestEpoch(): Promise<number> {
		return this.#highestEpoch();
	}

	/** Desired state's `control.epoch`: what the agents must not go below. */
	async epochForDesiredState(): Promise<number> {
		return this.#highestEpoch();
	}

	/**
	 * Record a control node's heartbeat report. The primary writes the cache; a standby does not
	 * write its followed database, and its live row is served from memory.
	 */
	report(report: ControlReport & { nodeId: string }): void {
		const now = this.ctx.now();
		this.ctx.db
			.insert(controlState)
			.values({
				nodeId: report.nodeId,
				role: report.role,
				epoch: report.epoch,
				holderNodeId: report.leaseHolderNodeId,
				leaseExpiresAt: report.leaseExpiresAt === null ? null : Date.parse(report.leaseExpiresAt),
				canPromote: report.canPromote,
				replicationLagSeconds: report.replicationLagSeconds,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: controlState.nodeId,
				set: {
					role: report.role,
					epoch: report.epoch,
					holderNodeId: report.leaseHolderNodeId,
					leaseExpiresAt: report.leaseExpiresAt === null ? null : Date.parse(report.leaseExpiresAt),
					canPromote: report.canPromote,
					replicationLagSeconds: report.replicationLagSeconds,
					updatedAt: now,
				},
			})
			.run();
	}

	status(): ControlStatus[] {		const rows = this.ctx.db
			.select({ state: controlState, node: nodes })
			.from(controlState)
			.innerJoin(nodes, eq(nodes.id, controlState.nodeId))
			.all()
			.map(({ state, node }) => ({
				nodeId: node.id,
				name: node.name,
				role: state.role as ControlStatus['role'],
				epoch: state.epoch,
				holderNodeId: state.holderNodeId,
				leaseExpiresAt: state.leaseExpiresAt === null ? null : new Date(state.leaseExpiresAt).toISOString(),
				canPromote: state.canPromote,
				replicationLagSeconds: state.replicationLagSeconds,
				version: node.version,
				updatedAt: new Date(state.updatedAt).toISOString(),
			}));
		const snapshot = this.snapshot();
		if (!snapshot) return rows.sort((a, b) => a.name.localeCompare(b.name));
		const live: ControlStatus = {
			nodeId: this.#nodeId,
			name: rows.find((row) => row.nodeId === this.#nodeId)?.name ?? this.#nodeId,
			role: snapshot.role,
			epoch: snapshot.epoch,
			holderNodeId: snapshot.lease.holderNodeId,
			leaseExpiresAt: snapshot.lease.expiresAt === null ? null : new Date(snapshot.lease.expiresAt).toISOString(),
			canPromote: snapshot.canPromote,
			replicationLagSeconds: snapshot.replica.lagSeconds,
			version: this.ctx.config.desiredAgentVersion ?? null,
			updatedAt: new Date(this.ctx.now()).toISOString(),
		};
		const merged = [...rows.filter((row) => row.nodeId !== this.#nodeId), live];
		return merged.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** The lease as this control plane last observed it; the arbiter is the authority. */
	lease(): ControlLeaseView | null {
		const snapshot = this.snapshot();
		if (!snapshot || snapshot.lease.expiresAt === null || snapshot.lease.holderNodeId === null) return null;
		return {
			epoch: snapshot.lease.epoch,
			holderNodeId: snapshot.lease.holderNodeId,
			holderVersion: this.ctx.config.desiredAgentVersion ?? 'unknown',
			expiresAt: new Date(snapshot.lease.expiresAt).toISOString(),
		};
	}

	/**
	 * `yoal ha control promote`: still a compare-and-swap at the ETag just read. The readiness check
	 * runs before the CAS, so an unverifiable node cannot win; a stale `expectedEpoch` is a 409.
	 */
	async promote(principal: Principal, expectedEpoch?: number, options: { breakGlass?: boolean } = {}): Promise<ControlStatus[]> {
		this.#assertPlatformAdmin(principal);
		if (!this.#runtime) throw new CoreError('conflict', 'Control-plane standby is not running on this node.', 409);
		const result = await this.#runtime.promoteNow(expectedEpoch, options);
		// A refusal while already primary (a stale --expect-epoch) must be a 409, not a 200.
		if (result.reason?.startsWith('promotion refused') || result.role !== 'primary')
			throw new CoreError('conflict', `Promotion refused: ${result.reason}`, 409);
		this.ctx.audit.record({
			principal,
			action: 'ha.control.promote',
			resource: 'control-plane',
			resourceId: this.#nodeId,
			result: 'ok',
			args: { epoch: result.epoch, expectedEpoch: expectedEpoch ?? null, breakGlass: options.breakGlass === true },
		});
		await this.#record();
		return this.status();
	}

	/**
	 * Approve a standby's CSR and seal the master key + allowlisted config for it. Requires a
	 * platform admin session that has proved a second factor (passkey/authenticator); the activation
	 * code is returned once and never stored.
	 */
	async enrol(principal: Principal, input: ControlPlaneEnrolmentInput): Promise<ControlPlaneEnrolmentResult> {
		this.#assertPlatformAdmin(principal);
		// The second factor is the session's step-up class, not a second password. A machine
		// principal (API key/MCP) has no step-up state and is refused.
		if (principal.verification?.class !== 'strong')
			throw new CoreError(
				'forbidden',
				'Enrolling a control standby needs a dashboard session that has proved a passkey or authenticator code.',
				403,
			);
		if (input.nodeId === this.#nodeId)
			throw new CoreError('conflict', 'A node cannot enrol itself as its own standby.', 409);
		const certificate = this.ctx.nodeCa.signCsr(input.nodeId, {
			csrPem: input.csrPem,
			// The CSR reason enum is for a node's own renewal path; an operator enrolment is `enrol`.
			reason: 'enrol',
		});
		const { bundle, activationCode } = sealControlBundle({
			nodeId: input.nodeId,
			primaryNodeId: this.#nodeId,
			masterKey: this.ctx.config.masterKey,
			envelope: controlConfigEnvelope(process.env),
			now: () => this.ctx.now(),
		});
		this.ctx.audit.record({
			principal,
			action: 'ha.control.enrol',
			resource: 'control-plane',
			resourceId: input.nodeId,
			result: 'ok',
			args: { certificateSerial: certificate.serial, configDigest: bundle.configDigest },
		});
		return { bundle, activationCode, certificate };
	}

	#assertPlatformAdmin(principal: Principal): void {
		if (this.ctx.platformIam.allows(principal, 'platform:nodes')) return;
		throw new CoreError('forbidden', 'Control-plane HA changes need a platform admin.', 403);
	}

	async #evidence(roleHint: 'primary' | 'standby'): Promise<PromotionEvidence> {
		const enrolment = this.#enrolment ?? (await readControlEnrolment(this.#enrolmentPath()));
		this.#enrolment = enrolment;
		// Only the original unenrolled owner may treat its live database as a current replica. Every
		// other host (an enrolled standby, or an ex-primary that is following) reads the restore
		// status, whatever its static hint says.
		const replica =
			!enrolment && roleHint === 'primary'
				? ({ restored: true, lagSeconds: 0, position: 'primary' } satisfies ControlReplicaState)
				: await readControlReplicaStatus(
						this.ctx.config.controlReplicaStatusPath ?? join(this.ctx.config.dataDir, REPLICA_FILE),
					);
		const actualKey = masterKeyFingerprint(this.ctx.config.masterKey);
		const actualConfig = controlConfigDigest(process.env);
		return {
			replica,
			masterKeyFingerprint: actualKey,
			expectedMasterKeyFingerprint: enrolment?.masterKeyFingerprint ?? null,
			configDigest: actualConfig,
			expectedConfigDigest: enrolment?.configDigest ?? this.ctx.config.controlConfigDigest ?? null,
			migrationsApplied: this.#migrationsApplied(),
		};
	}

	#migrationsApplied(): boolean {
		try {
			const applied = new Set(
				this.ctx.sqlite
					.query<{ id: string }, []>('SELECT id FROM yoal_migrations')
					.all()
					.map((row) => row.id),
			);
			return migrations.every((migration) => applied.has(migration.id));
		} catch {
			return false;
		}
	}

	/**
	 * Persist the highest epoch before it is used. The local file is the durable record every role
	 * writes (a standby does not write its followed SQLite); the database row is updated only when
	 * this node is serving, because a standby must not write.
	 */
	async #persistEpoch(epoch: number, reason: string): Promise<void> {
		const directory = this.ctx.config.dataDir;
		await mkdir(directory, { recursive: true, mode: 0o755 });
		const path = join(directory, EPOCH_FILE);
		const temporary = `${path}.tmp-${process.pid}`;
		// Never write a lower epoch over one already durable on this host: a stale lease object must
		// not let the file that fences agents go backwards.
		const durable = Math.max(await this.#readEpochFile(), epoch);
		await writeFile(temporary, `${JSON.stringify({ epoch: durable, reason, at: new Date(this.ctx.now()).toISOString() })}\n`, {
			mode: 0o600,
		});
		await rename(temporary, path);
		if (this.#runtime?.snapshot().role === 'primary') {
			this.ctx.db.update(nodes).set({ haEpoch: durable, updatedAt: this.ctx.now() }).where(eq(nodes.id, this.#nodeId)).run();
		}
	}

	async #highestEpoch(): Promise<number> {
		const live = this.#runtime?.snapshot().epoch ?? 0;
		const record = await this.#readEpochFile();
		let database = 0;
		try {
			const row = this.ctx.sqlite.query<{ epoch: number | null }, []>('SELECT max(ha_epoch) AS epoch FROM nodes').get();
			database = row?.epoch ?? 0;
		} catch {
			database = 0;
		}
		return Math.max(live, record, database);
	}

	async #readEpochFile(): Promise<number> {
		try {
			const value = JSON.parse(await readFile(join(this.ctx.config.dataDir, EPOCH_FILE), 'utf8')) as {
				epoch?: unknown;
			};
			return typeof value.epoch === 'number' && Number.isInteger(value.epoch) && value.epoch >= 0 ? value.epoch : 0;
		} catch {
			return 0;
		}
	}

	async #record(): Promise<void> {
		const snapshot = this.#runtime?.snapshot();
		if (!snapshot) return;
		this.#lastSnapshot = snapshot;
		// A standby must not write its followed database. Its live status is served from memory and
		// the primary's row is the one readers use.
		if (snapshot.role !== 'primary') return;
		const now = this.ctx.now();
		this.ctx.db.update(nodes).set({ haEpoch: snapshot.epoch, updatedAt: now }).where(eq(nodes.id, this.#nodeId)).run();
		this.ctx.db
			.insert(controlState)
			.values({
				nodeId: this.#nodeId,
				role: snapshot.role,
				epoch: snapshot.epoch,
				holderNodeId: snapshot.lease.holderNodeId,
				leaseExpiresAt: snapshot.lease.expiresAt,
				canPromote: snapshot.canPromote,
				replicationLagSeconds: snapshot.replica.lagSeconds,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: controlState.nodeId,
				set: {
					role: snapshot.role,
					epoch: snapshot.epoch,
					holderNodeId: snapshot.lease.holderNodeId,
					leaseExpiresAt: snapshot.lease.expiresAt,
					canPromote: snapshot.canPromote,
					replicationLagSeconds: snapshot.replica.lagSeconds,
					updatedAt: now,
				},
			})
			.run();
	}

	#enrolmentPath(): string {
		return this.ctx.config.controlEnrolmentPath ?? join(this.ctx.config.dataDir, ENROLMENT_FILE);
	}

	#failedReadyz(): ControlReadyz {
		return {
			status: 503,
			body: {
				ok: false,
				role: 'unavailable',
				epoch: this.#lastSnapshot?.epoch ?? 0,
				canPromote: false,
				reason: this.#failure ?? 'unavailable',
				lease: { holder: null, expiresAt: null, released: false, skewMs: null },
				replication: { restored: false, lagSeconds: null, position: null },
				promotion: { reasons: [this.#failure ?? 'unavailable'] },
			},
		};
	}

	#failedGate(): ControlGate {
		return {
			status: 503,
			headers: {
				'x-yoal-role': 'unavailable',
				'x-yoal-epoch': String(this.#lastSnapshot?.epoch ?? 0),
				'cache-control': 'no-store',
				'retry-after': '5',
			},
			reason: this.#failure ?? 'control-plane HA is unavailable',
		};
	}

	#notStartedGate(): ControlGate {
		return {
			status: 503,
			headers: {
				'x-yoal-role': 'unavailable',
				'x-yoal-epoch': '0',
				'cache-control': 'no-store',
				'retry-after': '5',
			},
			reason: 'control standby has not started',
		};
	}
}

/** Exported for tests: the digest a standby must match. */
export const controlStandbyConfigDigest = controlConfigDigest;

/** Exported for tests: the pure promotion predicate. */
export const controlStandbyPromotion = evaluatePromotion;

/** Exported for tests: the epoch file name, so a fixture can seed it. */
export const CONTROL_EPOCH_FILE = EPOCH_FILE;

/** Exported for tests: the fingerprint helper used by the promotion check. */
export const controlMasterKeyFingerprint = masterKeyFingerprint;
