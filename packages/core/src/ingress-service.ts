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
					certificateFingerprint: null,
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

/** Drivers a lane installs behind the one seam; a missing kind keeps the "not implemented" refusal. */
export interface SteeringServiceOptions {
	drivers?: Partial<Record<SteeringDriverKind, SteeringDriver>>;
}

/**
 * Steering (HA-PLAN H18, Wave 2). The contract is in `@yoal/contracts`; the drivers are lane D/E.
 * `direct` does nothing, which is exactly today's behaviour. `dns-failover` is installed by lane E
 * when `STEERING` is on; an `external-lb` driver registers under the same option key.
 */
export class SteeringService {
	constructor(
		private readonly ctx: CoreContext,
		private readonly options: SteeringServiceOptions = {},
	) {}

	driver(kind: SteeringDriverKind): SteeringDriver {
		const registered = this.options.drivers?.[kind];
		if (registered) return registered;
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
 * Shared certificates (HA-PLAN H20, Wave 2 lane B). The tables are reserved by 0122; nothing writes
 * them while `SHARED_CERTIFICATES` is off, and a single-node install keeps its per-node issuance.
 */
export class CertificateService {
	constructor(private readonly ctx: CoreContext) {}

	/** The fleet fingerprint a node reports in its heartbeat; null until the flag is on. */
	fingerprint(): string | null {
		if (!featureEnabled(this.ctx.config, 'SHARED_CERTIFICATES')) return null;
		throw new Error('not implemented (HA Wave 2 lane B): shared certificate fingerprint');
	}
}
