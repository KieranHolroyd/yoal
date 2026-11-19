import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
	KUBERNETES_CAPABILITY,
	KUBERNETES_COMPONENT_MARKER,
	KUBERNETES_TRUSTED_CAPABILITY,
	KUBERNETES_USERNS_CAPABILITY,
	kubernetesComponentReportSchema,
	type DesiredState,
	type KubernetesBackupResult,
	type KubernetesComponentReport,
	type KubernetesComponentResult,
	type KubernetesStatusSample,
} from '@yoal/contracts';

/**
 * The agent side of managed Kubernetes (docs/KUBERNETES.md).
 *
 * - The optional node component writes a marker (`/usr/lib/yoal/k3s/installed.json`) with the
 *   minors it installed and the isolation tiers its probe accepted. The agent advertises
 *   `kubernetes` plus one capability per tier only while the marker is there, so a node that never
 *   asked is never offered a cluster.
 * - Manifests (RBAC, access keys, attachment Secrets) are fetched from the control plane when their
 *   generation changes and handed to the helper. They never touch desired-state.json (D43).
 * - Once a minute each server machine here is sampled for API readiness and node counts.
 */

export const KUBERNETES_STATUS_INTERVAL_MS = 60_000;

/** The component report, or null when the component is not installed (or the marker is unreadable). */
export function readKubernetesComponent(markerPath: string = process.env.YOAL_K8S_MARKER ?? KUBERNETES_COMPONENT_MARKER): KubernetesComponentReport | null {
	if (!existsSync(markerPath)) return null;
	try {
		const parsed = kubernetesComponentReportSchema.safeParse(JSON.parse(readFileSync(markerPath, 'utf8')));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Capabilities the component adds. None when it is missing, failed its checks or has no minors. */
export function kubernetesCapabilities(report: KubernetesComponentReport | null): string[] {
	if (!report || report.error || report.minors.length === 0) return [];
	const out = [KUBERNETES_CAPABILITY];
	if (report.tiers.includes('userns')) out.push(KUBERNETES_USERNS_CAPABILITY);
	if (report.tiers.includes('trusted')) out.push(KUBERNETES_TRUSTED_CAPABILITY);
	return out;
}

export interface KubernetesHelper {
	kubernetesStatus(
		id: string,
		signal?: AbortSignal,
		keep?: readonly string[],
	): Promise<{ apiReady: boolean; nodesReady: number; nodesTotal: number; deprecatedApis: string[] }>;
	kubernetesSnapshot?(id: string, datastore: 'sqlite' | 'etcd'): Promise<ReadableStream<Uint8Array>>;
	kubernetesRestore?(id: string, body: ReadableStream<Uint8Array>): Promise<void>;
	kubernetesManifests(id: string, files: Record<string, string>, signal?: AbortSignal): Promise<void>;
	startKubernetesComponent(
		action: 'install' | 'remove',
		purge: boolean,
		signal?: AbortSignal,
	): Promise<{ running: boolean; startedAt: string | null; finishedAt: string | null; error: string | null }>;
	kubernetesComponentJob(
		signal?: AbortSignal,
	): Promise<{ running: boolean; startedAt: string | null; finishedAt: string | null; error: string | null }>;
}

export interface KubernetesSyncOptions {
	helper: KubernetesHelper;
	/** Fetch a server machine's manifests from the control plane (node-authenticated). */
	fetchManifests(machineId: string, signal: AbortSignal): Promise<{ generation: string; files: Record<string, string> }>;
	/** Whether a machine's unit is up (the runtime's newest report). */
	isRunning(machineId: string): boolean;
	log(level: 'info' | 'warn' | 'error', message: string): void;
	now?: () => number;
}

export class KubernetesSync {
	private readonly applied = new Map<string, string>();
	private samples = new Map<string, KubernetesStatusSample>();
	private lastStatusAt = 0;
	/** The component request being worked on, and the outcome waiting for a heartbeat. */
	private componentRequestId: string | null = null;
	private componentResult: KubernetesComponentResult | null = null;
	private readonly backupsRunning = new Set<string>();
	private readonly backupsDone = new Set<string>();
	private readonly backupResults = new Map<string, KubernetesBackupResult>();

	constructor(private readonly options: KubernetesSyncOptions) {}

	/**
	 * Drive a component install/remove the control plane asked for. The helper runs it in the
	 * background; this polls it each tick and keeps the outcome until a heartbeat carries it.
	 */
	async componentTick(state: DesiredState | null, signal: AbortSignal): Promise<void> {
		const request = state?.kubernetesComponentRequest ?? null;
		if (!request) {
			this.componentRequestId = null;
			return;
		}
		if (this.componentResult?.id === request.id) return;
		try {
			if (this.componentRequestId !== request.id) {
				await this.options.helper.startKubernetesComponent(request.action, request.purge, signal);
				this.componentRequestId = request.id;
				this.options.log('info', `Kubernetes component: ${request.action} started`);
				return;
			}
			const job = await this.options.helper.kubernetesComponentJob(signal);
			if (job.running) return;
			this.componentResult = { id: request.id, ok: job.error === null, message: job.error };
			this.options.log(job.error ? 'warn' : 'info', `Kubernetes component: ${request.action} ${job.error ? `failed: ${job.error}` : 'finished'}`);
		} catch (error) {
			this.componentResult = { id: request.id, ok: false, message: errorText(error).slice(0, 1000) };
		}
	}

	pendingComponentResult(): KubernetesComponentResult | null {
		return this.componentResult;
	}

	acknowledgeComponentResult(sent: KubernetesComponentResult | null): void {
		if (sent && this.componentResult === sent) {
			this.componentResult = null;
			this.componentRequestId = null;
		}
	}

	/** One pass: sync changed manifests, then sample status when it is due. Never throws. */
	async tick(state: DesiredState | null, signal: AbortSignal): Promise<void> {
		if (!state) return;
		const wanted = state.kubernetesManifests ?? [];
		const live = new Set(wanted.map((entry) => entry.machineId));
		for (const id of [...this.applied.keys()]) if (!live.has(id)) this.applied.delete(id);
		for (const entry of wanted) {
			if (signal.aborted) return;
			if (this.applied.get(entry.machineId) === entry.generation) continue;
			// k3s creates the auto-deploy directory and applies files only once it is running.
			if (!this.options.isRunning(entry.machineId)) continue;
			try {
				const manifests = await this.options.fetchManifests(entry.machineId, signal);
				await this.options.helper.kubernetesManifests(entry.machineId, manifests.files, signal);
				this.applied.set(entry.machineId, manifests.generation);
				this.options.log('info', `Kubernetes ${entry.machineId}: manifests synced (${Object.keys(manifests.files).length} files)`);
			} catch (error) {
				this.options.log('warn', `Kubernetes ${entry.machineId}: manifest sync failed: ${errorText(error)}`);
			}
		}

		const now = (this.options.now ?? Date.now)();
		if (now - this.lastStatusAt < KUBERNETES_STATUS_INTERVAL_MS) return;
		this.lastStatusAt = now;
		const servers = state.workloads.filter((workload) => workload.kubernetes?.role === 'server');
		const next = new Map<string, KubernetesStatusSample>();
		for (const server of servers) {
			if (signal.aborted) return;
			const clusterId = server.kubernetes!.clusterId;
			if (!this.options.isRunning(server.id)) continue;
			try {
				const keep = state.kubernetesManifests?.find((entry) => entry.machineId === server.id)?.nodes ?? [];
				const status = await this.options.helper.kubernetesStatus(server.id, signal, keep);
				next.set(clusterId, { clusterId, at: new Date(now).toISOString(), ...status });
			} catch (error) {
				this.options.log('warn', `Kubernetes ${server.id}: status failed: ${errorText(error)}`);
			}
		}
		this.samples = next;
	}

	/**
	 * Snapshots and restores (K14): a snapshot streams from the helper straight to its presigned PUT,
	 * hashed on the way; a restore streams the presigned GET into the helper before the machine
	 * first starts. Each task runs once; its outcome waits for a heartbeat.
	 */
	async backupTick(state: DesiredState | null, signal: AbortSignal): Promise<void> {
		const tasks = state?.kubernetesBackupTasks ?? [];
		const present = new Set(tasks.map((task) => task.id));
		for (const id of [...this.backupsDone]) if (!present.has(id)) this.backupsDone.delete(id);
		await Promise.all(
			tasks.map(async (task) => {
				if (this.backupsDone.has(task.id) || this.backupsRunning.has(task.id) || this.backupResults.has(task.id)) return;
				if (task.action === 'backup' && !this.options.isRunning(task.machineId)) return;
				this.backupsRunning.add(task.id);
				try {
					if (task.action === 'backup') {
						if (!this.options.helper.kubernetesSnapshot) throw new Error('this helper cannot take snapshots');
						const stream = await this.options.helper.kubernetesSnapshot(task.machineId, task.datastore);
						const hash = createHash('sha256');
						let size = 0;
						const counted = stream.pipeThrough(
							new TransformStream<Uint8Array, Uint8Array>({
								transform(chunk, controller) {
									hash.update(chunk);
									size += chunk.byteLength;
									controller.enqueue(chunk);
								},
							}),
						);
						const upload = await fetch(task.url, {
							method: 'PUT',
							headers: { 'content-type': 'application/gzip' },
							body: counted as never,
							duplex: 'half',
							signal,
						} as RequestInit & { duplex: 'half' });
						if (!upload.ok) throw new Error(`object upload -> ${upload.status}: ${(await upload.text().catch(() => '')).slice(0, 300)}`);
						this.backupResults.set(task.id, { taskId: task.id, action: 'backup', status: 'ok', sizeBytes: size, sha256: hash.digest('hex') });
						this.options.log('info', `Kubernetes ${task.machineId}: snapshot ${task.id} stored (${size} bytes)`);
					} else {
						if (!this.options.helper.kubernetesRestore) throw new Error('this helper cannot restore snapshots');
						const download = await fetch(task.url, { signal });
						if (!download.ok || !download.body) throw new Error(`object download -> ${download.status}`);
						await this.options.helper.kubernetesRestore(task.machineId, download.body);
						this.backupResults.set(task.id, { taskId: task.id, action: 'restore', status: 'ok' });
						this.options.log('info', `Kubernetes ${task.machineId}: snapshot unpacked`);
					}
				} catch (error) {
					this.backupResults.set(task.id, { taskId: task.id, action: task.action, status: 'failed', error: errorText(error).slice(0, 1000) });
					this.options.log('error', `Kubernetes ${task.machineId}: ${task.action} failed: ${errorText(error)}`);
				} finally {
					this.backupsRunning.delete(task.id);
				}
			}),
		);
	}

	pendingBackupResults(): KubernetesBackupResult[] {
		return [...this.backupResults.values()];
	}

	acknowledgeBackupResults(sent: readonly KubernetesBackupResult[]): void {
		for (const result of sent) {
			this.backupResults.delete(result.taskId);
			this.backupsDone.add(result.taskId);
		}
	}

	/** Samples for the next heartbeat; the newest per cluster replaces older ones. */
	pending(): KubernetesStatusSample[] {
		return [...this.samples.values()];
	}

	acknowledge(sent: readonly KubernetesStatusSample[]): void {
		for (const sample of sent) if (this.samples.get(sample.clusterId) === sample) this.samples.delete(sample.clusterId);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
