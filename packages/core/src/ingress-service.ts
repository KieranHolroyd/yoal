import { eq } from 'drizzle-orm';
import { nodes } from '@yoal/db';
import {
	INGRESS_SET_CAPABILITY,
	type IngressActivation,
	type IngressSetView,
	type SteeringDriver,
	type SteeringDriverKind,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { nodeHasCapability } from './capability-gate.ts';
import { ConflictError, ForbiddenError } from './errors.ts';
import { ingressNodeIds, nodeRoles } from './ingress.ts';

/**
 * How long an ingress may report an older applied version before it is `drifted` (CLUSTERING
 * §7.1). The window absorbs a pull and one failed converge; past it, stale routes can serve a
 * deleted site, so the steering drivers must withhold traffic (they own the action; this service
 * only reports).
 */
export const INGRESS_DRIFT_AFTER_MS = 120_000;

/**
 * The ingress set (HA-PLAN H17, Wave 2). One service answers membership for the desired state,
 * preflight and the steering drivers. With `INGRESS_SET` off membership is the compatibility first
 * ingress, so the desired state is unchanged; with it on, every capable node with the `ingress`
 * role joins the compatibility set, which keeps `mode: 'edge'` and `setEdge` working.
 */
export class IngressSetService {
	constructor(private readonly ctx: CoreContext) {}

	/** The ids whose node serves the edge payload. */
	nodes(): string[] {
		const all = this.ctx.db.select({ id: nodes.id, mode: nodes.mode, rolesJson: nodes.rolesJson }).from(nodes).all();
		const compatible = ingressNodeIds(all, this.ctx.config.edgeNodeId ?? null);
		if (!featureEnabled(this.ctx.config, 'INGRESS_SET')) return compatible;
		// A role member must also declare `ingress-set`: the payload includes listeners and TLS, and
		// an older agent would silently keep serving on its env-configured address.
		return [
			...new Set([
				...compatible,
				...all
					.filter((node) => nodeRoles(node).includes('ingress') && this.capable(node.id))
					.map((node) => node.id),
			]),
		];
	}

	isIngress(nodeId: string): boolean {
		return this.nodes().includes(nodeId);
	}

	capable(nodeId: string): boolean {
		const node = this.ctx.db.select({ capabilitiesJson: nodes.capabilitiesJson }).from(nodes).where(eq(nodes.id, nodeId)).get();
		return node ? nodeHasCapability(node, INGRESS_SET_CAPABILITY) : false;
	}

	/**
	 * Whether the node is behind the fleet's version for longer than the drift window. `actual` is
	 * what the agent reported applying and `since` when that value last changed. A node that has
	 * not reported yet is not drifted (there is nothing to compare), and neither is one at the
	 * current version. Older agents report 0 until their first converge, so the window keeps a
	 * freshly updated agent from being withdrawn before it finishes its first pull.
	 */
	drifted(nodeId: string, now = this.ctx.now()): boolean {
		const node = this.ctx.db
			.select({ actualStateVersion: nodes.actualStateVersion, actualStateAt: nodes.actualStateAt })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		if (!node || node.actualStateVersion === null) return false;
		const desired = this.ctx.nodes.stateVersion();
		if (node.actualStateVersion >= desired) return false;
		// The window starts when the node first fell behind: the later of its last applied change
		// and the watermark's last advance. Using only `actualStateAt` marks every converged node
		// drifted the instant any project is published.
		const advancedAt =
			this.ctx.sqlite
				.query<{ updated_at: number }, []>("SELECT updated_at FROM settings WHERE key = 'state_version'")
				.get()?.updated_at ?? 0;
		const since = Math.max(node.actualStateAt ?? 0, advancedAt);
		return since <= now - INGRESS_DRIFT_AFTER_MS;
	}

	/** The drift of every ingress, for steering drivers and the dashboard (H17, §7.1). */
	drift(now = this.ctx.now()): Array<{ nodeId: string; desiredStateVersion: number; actualStateVersion: number | null; drifted: boolean }> {
		const desiredStateVersion = this.ctx.nodes.stateVersion();
		const rows = this.ctx.db
			.select({ id: nodes.id, actualStateVersion: nodes.actualStateVersion })
			.from(nodes)
			.all();
		const ids = new Set(this.nodes());
		return rows
			.filter((row) => ids.has(row.id))
			.map((row) => ({
				nodeId: row.id,
				desiredStateVersion,
				actualStateVersion: row.actualStateVersion,
				drifted: this.drifted(row.id, now),
			}));
	}

	/**
	 * The shared secrets an ingress fetches after it is admitted (HA-PLAN H20, G8). Node
	 * authenticated by the route, and refused for a node that is not in the set or cannot apply
	 * the payload. These values never ride desired state.
	 */
	activation(nodeId: string): IngressActivation {
		if (!featureEnabled(this.ctx.config, 'INGRESS_SET'))
			throw new ForbiddenError('The ingress set is not enabled on this install.');
		if (!this.isIngress(nodeId)) throw new ForbiddenError('This node is not in the ingress set.');
		if (!this.capable(nodeId))
			throw new ConflictError('This node’s agent does not declare the ingress-set capability; update it first.');
		// A missing access secret is a configuration gap to fix, not a reason to withhold every
		// secret: return what exists and let the installer/env report the gap.
		return {
			accessJwtSecret: this.ctx.config.accessJwtSecret ?? null,
			siteCookieSecret: this.ctx.config.siteCookieSecret,
			cloudflareApiToken: this.ctx.config.cloudflareApiToken ?? null,
		};
	}

	/** What the dashboard and `yoal ha status` show; the lanes add the settings and driver. */
	view(): IngressSetView {
		const settings = this.ctx.cluster.get().ingress;
		const ids = new Set(this.nodes());
		const all = this.ctx.db
			.select({
				id: nodes.id,
				name: nodes.name,
				zone: nodes.zone,
				status: nodes.status,
				actualStateVersion: nodes.actualStateVersion,
			})
			.from(nodes)
			.all();
		return {
			nodes: all
				.filter((node) => ids.has(node.id))
				.map((node) => ({
					id: node.id,
					name: node.name,
					zone: node.zone,
					status: node.status,
					first: node.id === (this.ctx.config.edgeNodeId ?? null) || this.isFirst(node.id),
					capable: this.capable(node.id),
					certificateFingerprint: this.ctx.certificates.reportedFingerprint(node.id),
					actualStateVersion: node.actualStateVersion,
					drifted: this.drifted(node.id),
				})),
			settings,
			steering: { kind: 'direct', stacked: [] },
		};
	}

	private isFirst(nodeId: string): boolean {
		const first = this.nodes()[0];
		return first === nodeId;
	}
}

/**
 * Steering (HA-PLAN H18, Wave 2). The contract is in `@yoal/contracts`; the drivers are lane D/E.
 * `direct` is the only one that exists today: it does nothing, which is exactly today's behaviour.
 */
export class SteeringService {
	constructor(private readonly ctx: CoreContext) {}

	driver(kind: SteeringDriverKind): SteeringDriver {
		if (kind === 'direct')
			return {
				kind: 'direct',
				capabilities: { probes: 'none', writes: false, preservesClientIp: 'native' },
				preflight: () => [],
				desired: async () => undefined,
				observe: async () => ({}),
			};
		throw new Error(`not implemented (HA Wave 2): steering driver ${kind}`);
	}
}

/**
 * Shared certificates (HA-PLAN H20, W7). Implemented in `certificates/service.ts`; re-exported here
 * because the foundation's context and `createCore` name this module.
 */
export {
	CertificateService,
	type CertificateAlert,
	type CertificateListView,
	type CertificateRenewalReport,
	type CertificateSweepReport,
	type ClaimedLease,
} from './certificates/service.ts';
