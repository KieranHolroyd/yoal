import { desc, eq, inArray } from 'drizzle-orm';
import { nodes, projects, workloadReplicas, workloadScaleEvents, workloadScaling, workloadUsage, workloads } from '@yoal/db';
import {
	parseWorkloadReplicaId,
	scaleRequestSchema,
	scalingPolicySchema,
	workloadReplicaId,
	type AutoscaleMetric,
	type Principal,
	type ScaleResult,
	type ScalingCopyView,
	type ScalingPolicy,
	type ScalingView,
	type WorkloadSpec,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, ValidationError } from './errors.ts';
import type { ProjectRow } from './projects.ts';
import { newId } from './util.ts';
import type { WorkloadRow } from './workloads.ts';

type ScalingRow = typeof workloadScaling.$inferSelect;
type UsageRow = typeof workloadUsage.$inferSelect;

/** A usage sample older than this says nothing about the copy now. */
export const USAGE_FRESH_MS = 90_000;
/** Weight of the newest sample in the smoothed value: two or three heartbeats settle it. */
const SMOOTHING = 0.4;
/** Inside this band around the target the autoscaler leaves the number of copies alone. */
const TOLERANCE = 0.1;
/** Seconds between two scale-ups of one app, so a new copy has time to take load first. */
export const SCALE_UP_COOLDOWN_MS = 60_000;

export interface ScalingAlert {
	key: string;
	title: string;
	detail: string;
	severity: 'info' | 'warning';
}

/**
 * Horizontal scaling for one app (docs/SCALING.md, D218–D220).
 *
 * The number of copies is operational state: `scale` changes it without a deploy, and an
 * autoscaling policy changes it between two bounds to hold a measured signal near a target. The
 * placement itself is `WorkloadService.scaleCopies`; this service owns the policy, the usage the
 * policy reads, the history and the view.
 */
export class ScalingService {
	constructor(private readonly ctx: CoreContext) {}

	// ------------------------------------------------------------------ usage

	/**
	 * Keep the latest usage per copy from a node's heartbeat. CPU arrives as a running total, so
	 * the rate is the difference between two samples; a total that went backwards is a restart and
	 * yields no rate for that round.
	 */
	applyUsage(nodeId: string, reports: ReadonlyArray<{ id: string; memoryBytes?: number; cpuNanos?: number }>): void {
		const samples = reports.filter((report) => report.id.startsWith('wld_') && (report.memoryBytes !== undefined || report.cpuNanos !== undefined));
		if (samples.length === 0) return;
		const now = this.ctx.now();
		const previous = new Map(
			this.ctx.db
				.select()
				.from(workloadUsage)
				.where(inArray(workloadUsage.copyId, samples.map((sample) => sample.id)))
				.all()
				.map((row) => [row.copyId, row]),
		);
		for (const sample of samples) {
			const last = previous.get(sample.id);
			const elapsedMs = last && last.nodeId === nodeId ? now - last.sampledAt : 0;
			let cpuMillis: number | null = null;
			if (sample.cpuNanos !== undefined && last?.cpuNanos != null && elapsedMs > 0 && sample.cpuNanos >= last.cpuNanos)
				// nanoseconds of CPU per millisecond of wall time: 1e6 is one whole core, 1000 millis.
				cpuMillis = (sample.cpuNanos - last.cpuNanos) / elapsedMs / 1_000;
			const smooth = (value: number | null, average: number | null | undefined): number | null =>
				value === null ? (average ?? null) : average == null || elapsedMs > USAGE_FRESH_MS ? value : average + SMOOTHING * (value - average);
			// Peaks per UTC day, with yesterday's kept beside today's, so right-sizing reads a full day.
			const day = Math.floor(now / 86_400_000);
			const sameDay = last?.peakDay === day;
			const rolled = last && last.peakDay !== null && last.peakDay === day - 1;
			const peak = (value: number | null, current: number | null | undefined): number | null =>
				value === null ? (sameDay ? (current ?? null) : null) : sameDay && current != null ? Math.max(current, value) : value;
			const values = {
				peakDay: day,
				memoryPeakBytes: peak(sample.memoryBytes ?? null, last?.memoryPeakBytes),
				cpuPeakMillis: peak(cpuMillis, last?.cpuPeakMillis),
				memoryPeakPrevBytes: sameDay ? (last?.memoryPeakPrevBytes ?? null) : rolled ? (last?.memoryPeakBytes ?? null) : null,
				cpuPeakPrevMillis: sameDay ? (last?.cpuPeakPrevMillis ?? null) : rolled ? (last?.cpuPeakMillis ?? null) : null,
				workloadId: parseWorkloadReplicaId(sample.id).workloadId,
				nodeId,
				memoryBytes: sample.memoryBytes ?? null,
				memoryBytesAvg: smooth(sample.memoryBytes ?? null, last?.memoryBytesAvg),
				cpuNanos: sample.cpuNanos ?? null,
				cpuMillis,
				cpuMillisAvg: smooth(cpuMillis, last?.nodeId === nodeId ? last.cpuMillisAvg : null),
				sampledAt: now,
			};
			this.ctx.db
				.insert(workloadUsage)
				.values({ copyId: sample.id, ...values })
				.onConflictDoUpdate({ target: workloadUsage.copyId, set: values })
				.run();
		}
	}

	// ------------------------------------------------------------------ surfaces

	view(principal: Principal, project: ProjectRow): ScalingView {
		this.ctx.iam.require(principal, 'deployment:read', { type: 'project', id: project.id });
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get() ?? null;
		const spec = this.#spec(project, workload);
		const policy = this.#policy(project.id);
		const row = this.ctx.db.select().from(workloadScaling).where(eq(workloadScaling.projectId, project.id)).get();
		const limit = this.ctx.cluster.get().replicas.max;
		if (!spec)
			return {
				project: project.slug,
				deployed: false,
				replicas: 1,
				mode: 'single',
				blocker: 'it is a static site; the edge serves it',
				capacity: 1,
				limit,
				memoryMb: 0,
				cpuMillis: 0,
				copies: [],
				sizing: { memoryPeakMb: null, cpuPeakMillis: null, settled: false, advice: null, suggestedMemoryMb: null },
				rollout: null,
				lastRollback: null,
				policy,
				autoscale: { observed: null, desired: null, reason: null, evaluatedAt: null, scaledAt: null, available: false },
				events: [],
			};
		// Ask about a second copy: with one copy every mode looks the same.
		const { mode, blocker } = this.ctx.workloads.scalingMode(project, { ...spec, replicas: Math.max(2, spec.replicas) }, workload);
		const copies = workload ? this.#copies(workload, spec) : [];
		const waiting = workload
			? this.ctx.db
					.select()
					.from(workloadReplicas)
					.where(eq(workloadReplicas.workloadId, workload.id))
					.all()
					.filter((copy) => copy.deploymentId !== null && copy.deploymentId !== workload.deploymentId).length
			: 0;
		return {
			project: project.slug,
			deployed: Boolean(workload),
			replicas: spec.replicas,
			mode,
			blocker,
			capacity: this.ctx.workloads.scaleCapacity(project, workload, spec),
			limit,
			memoryMb: spec.memoryMb,
			cpuMillis: Math.round((spec.cpus ?? 1) * 1000),
			copies,
			sizing: this.#sizing(workload, spec),
			rollout:
				workload?.rolloutStatus === 'rolling' || workload?.rolloutStatus === 'paused'
					? {
							status: workload.rolloutStatus,
							message: workload.rolloutMessage,
							startedAt: workload.rolloutStartedAt ? new Date(workload.rolloutStartedAt).toISOString() : null,
							updated: copies.length - waiting,
							total: copies.length,
							surge: workload.rolloutSurge,
							automatic: workload.rolloutAuto,
						}
					: null,
			lastRollback:
				workload?.rollbackNote && workload.rollbackAt
					? { at: new Date(workload.rollbackAt).toISOString(), note: workload.rollbackNote }
					: null,
			policy,
			autoscale: {
				observed: row?.lastObserved ?? null,
				desired: row?.lastDesired ?? null,
				reason: row?.lastReason ?? null,
				evaluatedAt: row?.lastEvaluatedAt ? new Date(row.lastEvaluatedAt).toISOString() : null,
				scaledAt: row?.lastScaledAt ? new Date(row.lastScaledAt).toISOString() : null,
				available: this.#metricAvailable(policy.metric, copies),
			},
			events: this.ctx.db
				.select()
				.from(workloadScaleEvents)
				.where(eq(workloadScaleEvents.projectId, project.id))
				.orderBy(desc(workloadScaleEvents.createdAt))
				.limit(20)
				.all()
				.map((event) => ({
					id: event.id,
					from: event.fromReplicas,
					to: event.toReplicas,
					reason: event.reason,
					detail: event.detail,
					actor: event.actor,
					at: new Date(event.createdAt).toISOString(),
				})),
		};
	}

	/** Set the number of copies. Takes effect at once; no deploy, and running copies are not restarted. */
	scale(principal: Principal, project: ProjectRow, raw: unknown): ScaleResult {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const input = scaleRequestSchema.parse(raw);
		const policy = this.#policy(project.id);
		if (policy.enabled && (input.replicas < policy.min || input.replicas > policy.max))
			throw new ValidationError(
				`Autoscaling keeps "${project.slug}" between ${policy.min} and ${policy.max} copies. Change those bounds, or turn autoscaling off, to run ${input.replicas}.`,
			);
		const result = this.ctx.workloads.scaleCopies(project, input.replicas);
		this.#record(project, result.from, result.to, 'manual', null, principal.userId);
		this.ctx.audit.record({
			principal,
			action: 'workload.scale',
			resource: 'project',
			resourceId: project.id,
			args: { project: project.slug, from: result.from, to: result.to },
			result: 'ok',
		});
		return this.#result(project, result);
	}

	policy(principal: Principal, project: ProjectRow): ScalingPolicy {
		this.ctx.iam.require(principal, 'deployment:read', { type: 'project', id: project.id });
		return this.#policy(project.id);
	}

	/** Save the autoscaling policy. Turning it on brings the app inside its bounds straight away. */
	setPolicy(principal: Principal, project: ProjectRow, raw: unknown): ScalingView {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const parsed = scalingPolicySchema.safeParse(raw);
		if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid autoscaling policy.', parsed.error.issues);
		const policy = parsed.data;
		const limit = this.ctx.cluster.get().replicas.max;
		if (policy.max > limit) throw new ValidationError(`This install allows at most ${limit} replicas per workload.`);
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get() ?? null;
		const spec = this.#spec(project, workload);
		if (!spec) throw new ValidationError(`"${project.slug}" is a static site; it has no copies to scale.`);
		if (policy.enabled && policy.max > 1) {
			const { mode, blocker } = this.ctx.workloads.scalingMode(project, { ...spec, replicas: policy.max }, workload);
			if (mode === 'single') throw new ValidationError(`"${project.slug}" cannot autoscale: ${blocker}.`);
		}
		const now = this.ctx.now();
		const values = {
			orgId: project.orgId,
			enabled: policy.enabled,
			minReplicas: policy.min,
			maxReplicas: policy.max,
			metric: policy.metric,
			target: policy.target,
			scaleDownMinutes: policy.scaleDownMinutes,
			belowSince: null,
			updatedAt: now,
		};
		this.ctx.db
			.insert(workloadScaling)
			.values({ projectId: project.id, ...values })
			.onConflictDoUpdate({ target: workloadScaling.projectId, set: values })
			.run();
		this.ctx.audit.record({
			principal,
			action: 'workload.autoscale',
			resource: 'project',
			resourceId: project.id,
			args: { project: project.slug, ...policy },
			result: 'ok',
		});
		// The bounds apply now, not at the next evaluation: an app below its minimum is short of copies.
		if (policy.enabled && workload) {
			const bounded = Math.min(policy.max, Math.max(policy.min, spec.replicas));
			if (bounded !== spec.replicas) {
				const result = this.ctx.workloads.scaleCopies(project, bounded, { partial: true });
				this.#record(project, result.from, result.to, 'autoscale', `Brought inside the ${policy.min}–${policy.max} bounds.`, null);
			}
		}
		return this.view(principal, project);
	}

	// ------------------------------------------------------------------ autoscaler

	/**
	 * Evaluate every enabled policy that is due. Scaling up is immediate (bounded to doubling, with
	 * a short cooldown); scaling down removes one copy at a time and only after the load has stayed
	 * low for the policy's window, so a brief lull never costs capacity. Called under the failover
	 * controller's lease, so two control planes never scale the same app.
	 */
	async autoscaleTick(now: number = this.ctx.now()): Promise<ScalingAlert[]> {
		const alerts: ScalingAlert[] = [];
		const intervalMs = this.ctx.cluster.get().scheduling.autoscaleIntervalSeconds * 1000;
		const due = this.ctx.db
			.select()
			.from(workloadScaling)
			.where(eq(workloadScaling.enabled, true))
			.all()
			.filter((row) => now - (row.lastEvaluatedAt ?? 0) >= intervalMs);
		for (const row of due) {
			try {
				const alert = await this.#evaluate(row, now);
				if (alert) alerts.push(alert);
			} catch (error) {
				this.#note(row.projectId, now, { reason: `Not evaluated: ${error instanceof Error ? error.message : String(error)}` });
			}
		}
		return alerts;
	}

	async #evaluate(row: ScalingRow, now: number): Promise<ScalingAlert | null> {
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, row.projectId)).get() as ProjectRow | undefined;
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, row.projectId)).get();
		if (!project || project.deletedAt || !workload) return null;
		const spec = this.#spec(project, workload);
		if (!spec) return null;
		const current = spec.replicas;
		const min = row.minReplicas;
		const max = row.maxReplicas;
		// A rollout changes copies one at a time; adding or removing some under it would fight it.
		if (workload.rolloutStatus) {
			this.#note(row.projectId, now, { reason: 'Waiting for the rollout to finish.' });
			return null;
		}

		let desired = current;
		let observed: number | null = null;
		let reason: string;
		if (current < min) {
			desired = min;
			reason = `Below the minimum of ${min}.`;
		} else if (current > max) {
			desired = max;
			reason = `Above the maximum of ${max}.`;
		} else {
			const measured = await this.#observe(row.metric as AutoscaleMetric, workload, spec, now);
			if (measured.value === null) {
				this.#note(row.projectId, now, { reason: measured.reason, observed: null, desired: current });
				return null;
			}
			observed = measured.value;
			const ratio = observed / row.target;
			const unit = row.metric === 'requests' ? ' req/s per copy' : '%';
			if (Math.abs(ratio - 1) <= TOLERANCE) reason = `${label(row.metric)} is ${fmt(observed)}${unit}, on target (${fmt(row.target)}${unit}).`;
			else {
				desired = Math.min(max, Math.max(min, Math.ceil(current * ratio - 1e-9)));
				reason = `${label(row.metric)} is ${fmt(observed)}${unit} against a target of ${fmt(row.target)}${unit}.`;
			}
		}

		if (desired > current) {
			if (now - (row.lastScaledAt ?? 0) < SCALE_UP_COOLDOWN_MS) {
				this.#note(row.projectId, now, { reason: `${reason} Waiting for the last scale-up to take load.`, observed, desired, belowSince: null });
				return null;
			}
			// At most double in one step: a spike in a signal should not ask for the whole fleet at once.
			const target = Math.min(desired, Math.max(current + 1, current * 2));
			try {
				const result = this.ctx.workloads.scaleCopies(project, target, { partial: true });
				this.#record(project, result.from, result.to, 'autoscale', reason, null);
				const short = result.to < target;
				this.#note(row.projectId, now, {
					reason: short ? `${reason} Wanted ${target} copies; only ${result.to} fit on the fleet.` : reason,
					observed,
					desired,
					scaled: true,
					belowSince: null,
				});
				return short ? this.#capacityAlert(project, target, result.to, reason) : null;
			} catch (error) {
				const message = error instanceof CoreError ? error.message : String(error);
				this.#note(row.projectId, now, { reason: `${reason} Could not add a copy: ${message}`, observed, desired, belowSince: null });
				return this.#capacityAlert(project, target, current, `${reason} ${message}`);
			}
		}
		if (desired < current) {
			const since = row.belowSince ?? now;
			const waitMs = row.scaleDownMinutes * 60_000;
			if (now - since < waitMs) {
				this.#note(row.projectId, now, {
					reason: `${reason} Removing a copy if it stays this low for ${row.scaleDownMinutes} min.`,
					observed,
					desired,
					belowSince: since,
				});
				return null;
			}
			const result = this.ctx.workloads.scaleCopies(project, current - 1);
			this.#record(project, result.from, result.to, 'autoscale', reason, null);
			// Each further copy has to earn its own quiet window.
			this.#note(row.projectId, now, { reason, observed, desired, scaled: true, belowSince: null });
			return null;
		}
		this.#note(row.projectId, now, { reason, observed, desired, belowSince: null });
		return null;
	}

	/** The policy's signal right now, averaged over the copies that are up and recently sampled. */
	async #observe(
		metric: AutoscaleMetric,
		workload: WorkloadRow,
		spec: WorkloadSpec,
		now: number,
	): Promise<{ value: number | null; reason: string }> {
		if (metric === 'requests') {
			const telemetry = this.ctx.telemetry;
			if (!telemetry || !(await telemetry.ready()))
				return { value: null, reason: 'Request rate needs telemetry (Settings → Telemetry). Use CPU or memory, or install it.' };
			// The last two whole minutes: one minute alone is too jumpy to scale on.
			const to = Math.floor(now / 60_000) * 60_000;
			const report = await telemetry.report({ projectId: workload.projectId, from: to - 120_000, to, interval: '1m' });
			return { value: report.totals.requests / 120 / Math.max(1, spec.replicas), reason: '' };
		}
		const fresh = this.#usage(workload.id).filter((row) => now - row.sampledAt <= USAGE_FRESH_MS);
		const values = fresh
			.map((row) =>
				metric === 'cpu'
					? row.cpuMillisAvg === null
						? null
						: (row.cpuMillisAvg / Math.max(1, (spec.cpus ?? 1) * 1000)) * 100
					: row.memoryBytesAvg === null
						? null
						: (row.memoryBytesAvg / (spec.memoryMb * 1024 * 1024)) * 100,
			)
			.filter((value): value is number => value !== null);
		if (values.length === 0)
			return {
				value: null,
				reason:
					metric === 'cpu'
						? 'No CPU usage reported yet. It needs two heartbeats from a node on a current agent.'
						: 'No memory usage reported yet.',
			};
		return { value: values.reduce((sum, value) => sum + value, 0) / values.length, reason: '' };
	}

	#capacityAlert(project: ProjectRow, wanted: number, got: number, detail: string): ScalingAlert {
		return {
			key: `scaling:capacity:${project.id}`,
			title: `${project.slug} needs ${wanted} copies; the fleet fits ${got}`,
			detail: `${detail} Add a node, raise the memory overcommit, or lower the app's reservation.`,
			severity: 'warning',
		};
	}

	#note(
		projectId: string,
		now: number,
		patch: { reason: string; observed?: number | null; desired?: number; scaled?: boolean; belowSince?: number | null },
	): void {
		this.ctx.db
			.update(workloadScaling)
			.set({
				lastEvaluatedAt: now,
				lastReason: patch.reason.slice(0, 500),
				...(patch.observed !== undefined ? { lastObserved: patch.observed } : {}),
				...(patch.desired !== undefined ? { lastDesired: patch.desired } : {}),
				...(patch.scaled ? { lastScaledAt: now } : {}),
				...(patch.belowSince !== undefined ? { belowSince: patch.belowSince } : {}),
			})
			.where(eq(workloadScaling.projectId, projectId))
			.run();
	}

	// ------------------------------------------------------------------ internals

	#spec(project: ProjectRow, workload: WorkloadRow | null): WorkloadSpec | null {
		if (project.runtime === 'static' && !workload) return null;
		const configured = this.ctx.workloads.projectSpec(project);
		if (!workload) return configured;
		// The live spec is what runs; `projectSpec` is what the next deploy would run.
		return this.ctx.workloads.liveSpec(project, workload);
	}

	#policy(projectId: string): ScalingPolicy {
		const row = this.ctx.db.select().from(workloadScaling).where(eq(workloadScaling.projectId, projectId)).get();
		return {
			enabled: row?.enabled ?? false,
			min: row?.minReplicas ?? 1,
			max: row?.maxReplicas ?? 3,
			metric: (row?.metric as AutoscaleMetric | undefined) ?? 'cpu',
			target: row?.target ?? 70,
			scaleDownMinutes: row?.scaleDownMinutes ?? 5,
		};
	}

	#usage(workloadId: string): UsageRow[] {
		return this.ctx.db.select().from(workloadUsage).where(eq(workloadUsage.workloadId, workloadId)).all();
	}

	#copies(workload: WorkloadRow, spec: WorkloadSpec): ScalingCopyView[] {
		const nodeRows = new Map(this.ctx.db.select().from(nodes).all().map((node) => [node.id, node]));
		const usage = new Map(this.#usage(workload.id).map((row) => [row.copyId, row]));
		const now = this.ctx.now();
		const rows = this.ctx.db
			.select()
			.from(workloadReplicas)
			.where(eq(workloadReplicas.workloadId, workload.id))
			.all()
			.sort((a, b) => a.replicaIndex - b.replicaIndex);
		// Without rows every copy shares the workload's node (one copy, a function, a runner pool).
		const placed =
			rows.length > 0
				? rows.map((row) => ({ index: row.replicaIndex, nodeId: row.nodeId, status: row.status as string, previous: row.deploymentId !== null && row.deploymentId !== workload.deploymentId }))
				: workload.nodeId
					? Array.from({ length: spec.replicas }, (_, index) => ({ index, nodeId: workload.nodeId!, status: workload.status as string, previous: false }))
					: [];
		return placed.map((copy) => {
			const id = workloadReplicaId(workload.id, copy.index);
			const sample = usage.get(id);
			const fresh = sample && now - sample.sampledAt <= USAGE_FRESH_MS ? sample : null;
			const node = nodeRows.get(copy.nodeId);
			return {
				id,
				index: copy.index,
				nodeId: copy.nodeId,
				nodeName: node?.name ?? copy.nodeId,
				zone: node?.zone ?? 'default',
				status: node && node.status === 'offline' ? 'unreachable' : copy.status,
				release: copy.previous ? 'previous' : 'current',
				memoryBytes: fresh?.memoryBytes ?? null,
				cpuMillis: fresh?.cpuMillisAvg ?? null,
				sampledAt: fresh ? new Date(fresh.sampledAt).toISOString() : null,
			};
		});
	}

	/**
	 * Right-sizing from measured peaks. The advice is deliberately cautious: it wants a whole day
	 * of data, leaves a quarter of headroom above the busiest moment, and only speaks up when the
	 * reservation is far from what the app used.
	 */
	#sizing(workload: WorkloadRow | null, spec: WorkloadSpec): ScalingView['sizing'] {
		const rows = workload ? this.#usage(workload.id) : [];
		const max = (values: Array<number | null>): number | null => {
			const present = values.filter((value): value is number => value !== null);
			return present.length ? Math.max(...present) : null;
		};
		const memoryPeak = max(rows.flatMap((row) => [row.memoryPeakBytes, row.memoryPeakPrevBytes]));
		const cpuPeak = max(rows.flatMap((row) => [row.cpuPeakMillis, row.cpuPeakPrevMillis]));
		const settled = rows.some((row) => row.memoryPeakPrevBytes !== null);
		const memoryPeakMb = memoryPeak === null ? null : Math.ceil(memoryPeak / 1048576);
		let advice: ScalingView['sizing']['advice'] = null;
		let suggestedMemoryMb: number | null = null;
		if (memoryPeakMb !== null) {
			// A quarter above the peak, to the next 32 MB, and never under the 32 MB floor.
			const wanted = Math.max(32, Math.ceil((memoryPeakMb * 1.25) / 32) * 32);
			if (memoryPeakMb >= spec.memoryMb * 0.9) {
				advice = 'raise';
				suggestedMemoryMb = Math.max(wanted, spec.memoryMb + 32);
			} else if (settled && wanted <= spec.memoryMb * 0.6) {
				advice = 'lower';
				suggestedMemoryMb = wanted;
			}
		}
		return { memoryPeakMb, cpuPeakMillis: cpuPeak === null ? null : Math.round(cpuPeak), settled, advice, suggestedMemoryMb };
	}

	#metricAvailable(metric: AutoscaleMetric, copies: ScalingCopyView[]): boolean {
		if (metric === 'requests') return Boolean(this.ctx.telemetry?.installed);
		if (copies.length === 0) return true;
		return copies.some((copy) => (metric === 'cpu' ? copy.cpuMillis !== null : copy.memoryBytes !== null));
	}

	#record(project: ProjectRow, from: number, to: number, reason: string, detail: string | null, actor: string | null): void {
		if (from === to) return;
		this.ctx.db
			.insert(workloadScaleEvents)
			.values({
				id: newId('wse_'),
				orgId: project.orgId,
				projectId: project.id,
				fromReplicas: from,
				toReplicas: to,
				reason,
				detail: detail?.slice(0, 500) ?? null,
				actor,
				createdAt: this.ctx.now(),
			})
			.run();
	}

	#result(
		project: ProjectRow,
		result: { from: number; to: number; added: Array<{ index: number; nodeId: string }>; removed: Array<{ index: number; nodeId: string }> },
	): ScaleResult {
		const names = new Map(this.ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).all().map((node) => [node.id, node.name]));
		const named = (copy: { index: number; nodeId: string }) => ({ ...copy, nodeName: names.get(copy.nodeId) ?? copy.nodeId });
		return { project: project.slug, from: result.from, to: result.to, added: result.added.map(named), removed: result.removed.map(named) };
	}
}

const label = (metric: string): string => (metric === 'cpu' ? 'CPU' : metric === 'memory' ? 'Memory' : 'Request rate');
const fmt = (value: number): string => (value >= 100 ? String(Math.round(value)) : (Math.round(value * 10) / 10).toString());
