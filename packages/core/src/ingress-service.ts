import { eq } from 'drizzle-orm';
import { nodes } from '@yoal/db';
import {
	INGRESS_SET_CAPABILITY,
	type IngressSetView,
	type SteeringDriver,
	type SteeringDriverKind,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { nodeHasCapability } from './capability-gate.ts';
import { ingressNodeIds, nodeRoles } from './ingress.ts';

/**
 * The ingress set (HA-PLAN H17, Wave 2 opening). One service answers membership for the desired
 * state, preflight and the steering drivers. Until the W6 payload lane lands, membership is still
 * the compatibility first ingress, so the desired state is unchanged with `INGRESS_SET` off.
 */
export class IngressSetService {
	constructor(private readonly ctx: CoreContext) {}

	/** The ids whose node serves the edge payload. */
	nodes(): string[] {
		const all = this.ctx.db.select({ id: nodes.id, mode: nodes.mode, rolesJson: nodes.rolesJson }).from(nodes).all();
		const compatible = ingressNodeIds(all, this.ctx.config.edgeNodeId ?? null);
		if (!featureEnabled(this.ctx.config, 'INGRESS_SET')) return compatible;
		// The W6 payload lane widens this to every capable node with the `ingress` role. It is the
		// same rule in one place so every caller agrees; the flag keeps it off until M2 passes.
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

	/** What the dashboard and `yoal ha status` show; the lanes add the settings and driver. */
	view(): IngressSetView {
		const settings = this.ctx.cluster.get().ingress;
		const ids = new Set(this.nodes());
		const all = this.ctx.db.select({ id: nodes.id, name: nodes.name, zone: nodes.zone, status: nodes.status }).from(nodes).all();
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
