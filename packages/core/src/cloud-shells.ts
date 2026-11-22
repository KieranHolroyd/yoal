import { and, eq, inArray, ne } from 'drizzle-orm';
import { cloudShells, nodes } from '@yoal/db';
import {
	CLOUD_SHELL_CAPABILITY,
	CLOUD_SHELL_HOME,
	CLOUD_SHELL_ID_PREFIX,
	CLOUD_SHELL_IMAGE_REPOSITORY,
	cloudShellLimits,
	orgNetworkName,
	type CloudShellState,
	type CloudShellStatus,
	type CloudShellView,
	type Principal,
	type WorkloadActivation,
	type WorkloadDesired,
} from '@yoal/contracts';
import { nodeHasCapability } from './capability-gate.ts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError } from './errors.ts';
import { buildSystemPrincipal } from './iam/system.ts';
import { newId, sha256Hex } from './util.ts';

type CloudShellRow = typeof cloudShells.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;

/** Shell states that are in the node's desired state. */
const ACTIVE: CloudShellStatus[] = ['starting', 'running'];

/** Nominal container port: a cloud shell is a worker, so nothing is published or probed. */
const SHELL_PORT = 8080;

/** What the console token for a cloud shell names (D236 on top of D127). */
export interface CloudShellConsoleTarget {
	shellId: string;
	nodeId: string;
	orgId: string;
	userId: string;
}

/**
 * Cloud shell (D236, docs/CLOUD-SHELL.md). Each person gets one shell per org: a `csh_…`
 * container workload on a compute node, with the `yoal` CLI signed in through a short-lived
 * access key and a 1 GiB ext4 home disk that the helper keeps on that node.
 *
 * Starting puts the workload in the node's desired state; stopping takes it out again (the disk
 * stays). The maintenance sweep stops a shell nobody has used for `idleMs`, or that has run for
 * `maxSessionMs`, and revokes its key. A reset hands the disk to the node to delete
 * (`cloudShellPurges`); the row goes once the node reports it gone.
 */
export class CloudShellService {
	constructor(private readonly ctx: CoreContext) {}

	enabled(): boolean {
		return featureEnabled(this.ctx.config, 'CLOUD_SHELL');
	}

	isShellId(id: string): boolean {
		return id.startsWith(CLOUD_SHELL_ID_PREFIX);
	}

	/** The image every shell runs: the operator's override, else this release's published tag. */
	image(): string {
		if (this.ctx.config.cloudShellImage) return this.ctx.config.cloudShellImage;
		const version = this.ctx.config.desiredAgentVersion;
		const tag = version && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version.replace(/\+/g, '-') : 'latest';
		return `${CLOUD_SHELL_IMAGE_REPOSITORY}:${tag}`;
	}

	// --- people ---------------------------------------------------------------------------

	/** The caller's own shell and the limits it runs with. */
	state(principal: Principal): CloudShellState {
		this.requireUse(principal);
		const row = this.current(principal);
		return {
			enabled: this.enabled(),
			shell: row ? this.view(row) : null,
			limits: {
				diskMb: cloudShellLimits.diskMb,
				memoryMb: cloudShellLimits.memoryMb,
				idleMinutes: Math.round(cloudShellLimits.idleMs / 60_000),
			},
		};
	}

	/**
	 * Start (or keep) the caller's shell. The first start picks a compute node and that node keeps
	 * the disk from then on: the shell can only run where its files are.
	 */
	start(principal: Principal): CloudShellView {
		this.requireEnabled();
		this.requireUse(principal);
		this.requirePerson(principal);
		let row = this.current(principal);
		if (row && ACTIVE.includes(row.status)) {
			this.touch(principal);
			return this.view(row);
		}

		let node = row?.nodeId ? this.node(row.nodeId) : undefined;
		if (row && !node) {
			// The node (and the disk with it) was removed from the install: start over elsewhere.
			this.ctx.db.delete(cloudShells).where(eq(cloudShells.id, row.id)).run();
			row = undefined;
		}
		if (row && node) {
			if (node.status === 'offline')
				throw new ConflictError(
					`The node holding your cloud shell's disk (${node.name}) is offline. Wait for it to come back, or reset the shell to start a new one on another node (the files on the old disk are lost).`,
				);
			if (!nodeHasCapability(node, CLOUD_SHELL_CAPABILITY))
				throw new ConflictError(`Node ${node.name} runs an agent without the cloud shell. Update the node first.`);
		}
		if (!row) {
			node = this.pickNode();
			const now = this.ctx.now();
			const id = newId(CLOUD_SHELL_ID_PREFIX);
			try {
				this.ctx.db
					.insert(cloudShells)
					.values({
						id,
						orgId: principal.orgId,
						userId: principal.userId,
						nodeId: node.id,
						status: 'stopped',
						diskMb: cloudShellLimits.diskMb,
						createdAt: now,
						updatedAt: now,
					})
					.run();
			} catch (error) {
				// A second tab's start won the one-shell-per-person index (0137): use its shell.
				const winner = this.current(principal);
				if (!winner) throw error;
				return this.view(winner);
			}
			row = this.row(id)!;
		}

		const key = this.mintKey(principal);
		const now = this.ctx.now();
		this.ctx.db
			.update(cloudShells)
			.set({
				status: 'starting',
				generation: row.generation + 1,
				startedAt: now,
				lastActiveAt: now,
				accessKeyId: key?.id ?? null,
				accessKeySealed: key ? this.ctx.secrets.seal(principal.orgId, key.value) : null,
				message: null,
				updatedAt: now,
			})
			.where(eq(cloudShells.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'cloud_shell.start',
			resource: 'cloud_shell',
			resourceId: row.id,
			args: { node: node!.name, cliSignedIn: Boolean(key) },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.view(this.row(row.id)!);
	}

	/** Stop the caller's shell. Its disk stays on the node for the next start. */
	stop(principal: Principal): CloudShellView | null {
		this.requireUse(principal);
		const row = this.current(principal);
		if (!row) return null;
		if (ACTIVE.includes(row.status)) this.stopRow(row, principal, 'stopped');
		return this.view(this.row(row.id)!);
	}

	/**
	 * Throw the caller's shell away: stop it and have its node delete the disk. The next start
	 * makes a new shell with an empty home, possibly on another node.
	 */
	reset(principal: Principal): { reset: boolean } {
		this.requireUse(principal);
		this.requirePerson(principal);
		const row = this.current(principal);
		if (!row) return { reset: false };
		if (ACTIVE.includes(row.status)) this.stopRow(row, principal, 'reset');
		const node = row.nodeId ? this.node(row.nodeId) : undefined;
		if (!node) this.ctx.db.delete(cloudShells).where(eq(cloudShells.id, row.id)).run();
		else
			this.ctx.db
				.update(cloudShells)
				.set({ status: 'deleting', updatedAt: this.ctx.now() })
				.where(eq(cloudShells.id, row.id))
				.run();
		this.ctx.audit.record({
			principal,
			action: 'cloud_shell.reset',
			resource: 'cloud_shell',
			resourceId: row.id,
			args: { node: node?.name ?? null },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return { reset: true };
	}

	/** Note activity (opening, typing, reading output); written at most every `touchEveryMs`. */
	touch(principal: Principal): void {
		const row = this.current(principal);
		if (!row || !ACTIVE.includes(row.status)) return;
		const now = this.ctx.now();
		if (row.lastActiveAt !== null && now - row.lastActiveAt < cloudShellLimits.touchEveryMs) return;
		this.ctx.db.update(cloudShells).set({ lastActiveAt: now }).where(eq(cloudShells.id, row.id)).run();
	}

	/** Shell opens and closes; keystrokes never reach the audit log. */
	record(principal: Principal, op: 'exec.open' | 'exec.close' | 'files.read' | 'files.download', args: Record<string, unknown> = {}): void {
		const row = this.current(principal);
		this.ctx.audit.record({
			principal,
			action: `cloud_shell.${op}`,
			resource: 'cloud_shell',
			resourceId: row?.id ?? 'none',
			args,
			result: 'ok',
		});
	}

	/** The running shell a console call for this person may reach, or a refusal that says why. */
	consoleTarget(principal: Principal): CloudShellConsoleTarget {
		this.requireEnabled();
		this.requireUse(principal);
		this.requirePerson(principal);
		const row = this.current(principal);
		if (!row || !ACTIVE.includes(row.status) || !row.nodeId)
			throw new ConflictError('Your cloud shell is not running. Start it first.');
		this.touch(principal);
		return { shellId: row.id, nodeId: row.nodeId, orgId: row.orgId, userId: row.userId };
	}

	/** The node's side of a console token: the shell must still be the person's and run here. */
	verifyConsoleTarget(nodeId: string, target: { shellId: string; orgId: string; userId: string }): void {
		if (!this.enabled()) throw new ConflictError('The cloud shell is disabled on this control plane.');
		const row = this.row(target.shellId);
		if (!row || row.orgId !== target.orgId || row.userId !== target.userId) throw new NotFoundError('Cloud shell');
		if (!ACTIVE.includes(row.status) || row.nodeId !== nodeId)
			throw new ConflictError('That cloud shell is no longer running on this node.');
	}

	// --- maintenance ----------------------------------------------------------------------

	/**
	 * Stop shells that went idle or ran too long, all of them while the feature is off, and drop
	 * reset shells whose node no longer exists. Runs from the maintenance loop.
	 */
	sweep(): { stopped: number } {
		const now = this.ctx.now();
		let stopped = 0;
		const enabled = this.enabled();
		for (const row of this.ctx.db.select().from(cloudShells).where(inArray(cloudShells.status, ACTIVE)).all()) {
			if (enabled && row.status === 'starting' && now - (row.startedAt ?? now) >= cloudShellLimits.startTimeoutMs) {
				const node = row.nodeId ? this.node(row.nodeId) : undefined;
				this.stopRow(
					row,
					buildSystemPrincipal('system:cloud-shell', row.orgId),
					'start failed',
					`${node?.name ?? 'Its node'} did not start your cloud shell within ${cloudShellLimits.startTimeoutMs / 60_000} minutes${node && node.status !== 'online' ? ` (the node is ${node.status})` : ''}. Try starting it again; if it keeps failing, an operator can read \`journalctl -u yoal-workload-${row.id}\` on that node.`,
				);
				stopped += 1;
				continue;
			}
			const idle = now - (row.lastActiveAt ?? row.startedAt ?? now) >= cloudShellLimits.idleMs;
			const expired = now - (row.startedAt ?? now) >= cloudShellLimits.maxSessionMs;
			if (enabled && !idle && !expired) continue;
			const reason = !enabled ? 'disabled' : expired ? 'session limit' : 'idle';
			this.stopRow(row, buildSystemPrincipal('system:cloud-shell', row.orgId), reason);
			stopped += 1;
		}
		for (const row of this.ctx.db.select().from(cloudShells).where(eq(cloudShells.status, 'deleting')).all())
			if (!row.nodeId || !this.node(row.nodeId)) this.ctx.db.delete(cloudShells).where(eq(cloudShells.id, row.id)).run();
		return { stopped };
	}

	// --- nodes ----------------------------------------------------------------------------

	/** Running shells on this node, as container workloads with the `cloudShell` profile. */
	desiredForNode(nodeId: string): WorkloadDesired[] {
		if (!this.enabled()) return [];
		const node = this.node(nodeId);
		if (!node || !nodeHasCapability(node, CLOUD_SHELL_CAPABILITY)) return [];
		const isolated = featureEnabled(this.ctx.config, 'ORG_NETWORKS');
		return this.ctx.db
			.select()
			.from(cloudShells)
			.where(and(eq(cloudShells.nodeId, nodeId), inArray(cloudShells.status, ACTIVE)))
			.all()
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((row) => ({
				id: row.id,
				projectId: row.id,
				projectSlug: 'cloud-shell',
				deploymentId: row.id,
				// Same network rule as apps: the org's own network while ORG_NETWORKS is on.
				...(isolated ? { orgId: row.orgId, networkName: orgNetworkName(row.orgId) } : {}),
				runtime: 'container',
				status: 'running',
				release: null,
				image: this.image(),
				upstream: `127.0.0.1:${SHELL_PORT}`,
				memoryMb: cloudShellLimits.memoryMb,
				cpus: cloudShellLimits.cpus,
				port: SHELL_PORT,
				healthPath: '/',
				socketActivation: false,
				activationVersion: this.activationVersion(row),
				env: {},
				secrets: [],
				dataSizeMb: null,
				ingress: 'none',
				cloudShell: { diskMb: row.diskMb },
			}));
	}

	/** Reset shells whose disk this node must delete, then report in `purgedCloudShells`. */
	purgesForNode(nodeId: string): string[] {
		const node = this.node(nodeId);
		if (!node || !nodeHasCapability(node, CLOUD_SHELL_CAPABILITY)) return [];
		return this.ctx.db
			.select({ id: cloudShells.id })
			.from(cloudShells)
			.where(and(eq(cloudShells.nodeId, nodeId), eq(cloudShells.status, 'deleting')))
			.all()
			.map((row) => row.id)
			.sort();
	}

	applyPurged(nodeId: string, ids: readonly string[]): void {
		const shells = ids.filter((id) => this.isShellId(id));
		if (shells.length === 0) return;
		this.ctx.db
			.delete(cloudShells)
			.where(and(eq(cloudShells.nodeId, nodeId), eq(cloudShells.status, 'deleting'), inArray(cloudShells.id, shells)))
			.run();
	}

	/**
	 * A starting shell is running once its node says its container is. One whose container failed,
	 * or keeps exiting (an image that cannot be pulled, say), is stopped with the reason, instead
	 * of saying "starting" until the idle timer gives up on it.
	 */
	applyHeartbeat(nodeId: string, reports: Array<{ id: string; status: string; restarts?: number }>): void {
		for (const report of reports) {
			if (!this.isShellId(report.id)) continue;
			if (report.status === 'running') {
				this.ctx.db
					.update(cloudShells)
					.set({ status: 'running', updatedAt: this.ctx.now() })
					.where(and(eq(cloudShells.id, report.id), eq(cloudShells.nodeId, nodeId), eq(cloudShells.status, 'starting')))
					.run();
				continue;
			}
			const restarts = report.restarts ?? 0;
			if (report.status !== 'failed' && restarts < cloudShellLimits.startRestartLimit) continue;
			const row = this.row(report.id);
			if (!row || row.nodeId !== nodeId || row.status !== 'starting') continue;
			const node = this.node(nodeId);
			this.stopRow(
				row,
				buildSystemPrincipal('system:cloud-shell', row.orgId),
				'start failed',
				`${node?.name ?? 'The node'} could not start your cloud shell: its container ${report.status === 'failed' ? 'failed to start' : `exited ${restarts} times in a row`}. The usual cause is that the node cannot pull the image ${this.image()}. An operator can read \`journalctl -u yoal-workload-${row.id}\` on that node.`,
			);
		}
	}

	/** Nodes with a running shell, for the console gateway routes. */
	nodesWithShells(): Set<string> {
		if (!this.enabled()) return new Set();
		const out = new Set<string>();
		for (const row of this.ctx.db.select({ nodeId: cloudShells.nodeId }).from(cloudShells).where(inArray(cloudShells.status, ACTIVE)).all())
			if (row.nodeId) out.add(row.nodeId);
		return out;
	}

	/**
	 * The shell's environment, fetched by its node: where the control plane is and the CLI's key.
	 * The key never travels in desired state.
	 */
	activation(nodeId: string, id: string): WorkloadActivation {
		const row = this.row(id);
		if (!row || !ACTIVE.includes(row.status)) throw new NotFoundError('Cloud shell');
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This cloud shell is placed on another node.', 403);
		const token = row.accessKeySealed ? this.ctx.secrets.open(row.orgId, row.accessKeySealed) : null;
		return {
			workloadId: id,
			activationVersion: this.activationVersion(row),
			env: {
				YOAL_URL: this.ctx.config.platformOrigin.replace(/\/$/, ''),
				YOAL_CONTENT_DOMAIN: this.ctx.config.contentDomain,
				YOAL_CLOUD_SHELL: '1',
				...(token ? { YOAL_TOKEN: token } : {}),
			},
			files: {},
		};
	}

	// --- internals ------------------------------------------------------------------------

	private stopRow(row: CloudShellRow, actor: Principal, reason: string, message: string | null = null): void {
		if (row.accessKeyId) {
			try {
				this.ctx.accessKeys.revokeManaged(
					actor.kind === 'system' ? actor : buildSystemPrincipal('system:cloud-shell', row.orgId),
					row.accessKeyId,
					`cloud shell ${reason}`,
				);
			} catch (error) {
				// The key expires on its own; a failed revoke must not keep the shell running.
				console.error('[cloud-shell] revoking the CLI key failed:', error);
			}
		}
		this.ctx.db
			.update(cloudShells)
			.set({ status: 'stopped', accessKeyId: null, accessKeySealed: null, message, updatedAt: this.ctx.now() })
			.where(eq(cloudShells.id, row.id))
			.run();
		this.ctx.audit.record({
			principal: actor,
			action: 'cloud_shell.stop',
			resource: 'cloud_shell',
			resourceId: row.id,
			args: { reason, userId: row.userId, ...(message ? { message } : {}) },
			result: message ? 'error' : 'ok',
			...(message ? { error: message } : {}),
		});
		this.ctx.projects.bump(row.orgId);
	}

	/**
	 * A key for the shell's CLI, only when the person's role may create access keys: the shell
	 * never hands out a credential the person could not have minted themselves.
	 */
	private mintKey(principal: Principal): { id: string; value: string } | null {
		if (!principal.permissions.has('accessKey:create')) return null;
		const created = this.ctx.accessKeys.create(principal, {
			name: 'Cloud shell',
			expiresInSeconds: cloudShellLimits.keyTtlSeconds,
		});
		return { id: created.accessKey.id, value: created.key };
	}

	/** An online compute node with the capability, preferring the one with fewest shells. */
	private pickNode(): NodeRow {
		const counts = new Map<string, number>();
		for (const row of this.ctx.db.select({ nodeId: cloudShells.nodeId }).from(cloudShells).where(ne(cloudShells.status, 'deleting')).all())
			if (row.nodeId) counts.set(row.nodeId, (counts.get(row.nodeId) ?? 0) + 1);
		const candidates = this.ctx.db
			.select()
			.from(nodes)
			.all()
			.filter(
				(node) =>
					node.status === 'online' &&
					nodeHasCapability(node, CLOUD_SHELL_CAPABILITY) &&
					this.ctx.nodes.view(node).roles.includes('compute'),
			)
			.sort((a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0) || a.name.localeCompare(b.name));
		const chosen = candidates[0];
		if (!chosen)
			throw new ConflictError(
				'No online compute node can run a cloud shell yet. Update a node to an agent that advertises "cloud-shell".',
			);
		return chosen;
	}

	private activationVersion(row: CloudShellRow): string {
		return sha256Hex(
			JSON.stringify({
				id: row.id,
				generation: row.generation,
				image: this.image(),
				key: row.accessKeyId,
				url: this.ctx.config.platformOrigin,
				content: this.ctx.config.contentDomain,
			}),
		);
	}

	private view(row: CloudShellRow): CloudShellView {
		const node = row.nodeId ? this.node(row.nodeId) : undefined;
		const active = ACTIVE.includes(row.status);
		const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
		const stopsAt =
			active && row.startedAt !== null
				? Math.min((row.lastActiveAt ?? row.startedAt) + cloudShellLimits.idleMs, row.startedAt + cloudShellLimits.maxSessionMs)
				: null;
		return {
			id: row.id,
			status: row.status,
			node: node ? { id: node.id, name: node.name, online: node.status === 'online' } : null,
			diskMb: row.diskMb,
			home: CLOUD_SHELL_HOME,
			image: this.image(),
			cliSignedIn: active && row.accessKeyId !== null,
			startedAt: active ? iso(row.startedAt) : null,
			lastActiveAt: iso(row.lastActiveAt),
			stopsAt: iso(stopsAt),
			message: row.message ?? null,
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}

	private current(principal: Principal): CloudShellRow | undefined {
		return this.ctx.db
			.select()
			.from(cloudShells)
			.where(
				and(eq(cloudShells.orgId, principal.orgId), eq(cloudShells.userId, principal.userId), ne(cloudShells.status, 'deleting')),
			)
			.get();
	}

	private row(id: string): CloudShellRow | undefined {
		return this.ctx.db.select().from(cloudShells).where(eq(cloudShells.id, id)).get();
	}

	private node(id: string): NodeRow | undefined {
		return this.ctx.db.select().from(nodes).where(eq(nodes.id, id)).get();
	}

	private requireEnabled(): void {
		if (!this.enabled()) throw new ConflictError('The cloud shell is disabled on this control plane.');
	}

	private requireUse(principal: Principal): void {
		this.ctx.iam.require(principal, 'cloudShell:use', { type: 'org' });
	}

	/** A shell runs as the person: only a signed-in person opens or resets one (D29, D127). */
	private requirePerson(principal: Principal): void {
		if (principal.kind !== 'user' || principal.credential !== 'session')
			throw new CoreError('forbidden', 'The cloud shell is opened from the dashboard by a signed-in person.', 403);
	}
}
