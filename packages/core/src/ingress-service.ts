import { eq } from 'drizzle-orm';
import { nodes } from '@yoal/db';
import {
	INGRESS_SET_CAPABILITY,
	type IngressSetView,
	type IngressSettings,
	type SteeringDriver,
	type SteeringDriverKind,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { nodeHasCapability } from './capability-gate.ts';
import { ingressNodeIds, nodeRoles } from './ingress.ts';
import {
	STEERING_DRIVER_FACTORIES,
	type SteeringDriverContext,
	type SteeringDriverFactory,
	type SteeringFinding,
	type SteeringFence,
	type SteeringNode,
	type SteeringTickResult,
} from './steering/registry.ts';

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

	/** What the dashboard and `yoal ha status` show. */
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
			steering: this.ctx.steering.selection(),
		};
	}

	private isFirst(nodeId: string): boolean {
		const first = this.nodes()[0];
		return first === nodeId;
	}
}

export interface SteeringSelection {
	kind: SteeringDriverKind;
	stacked: SteeringDriverKind[];
}

/**
 * Steering (HA-PLAN H18, Wave 2). The contract is in `@yoal/contracts`; the drivers live under
 * `./steering/<kind>/` and each passes the shared conformance suite.
 *
 * `direct` is what every install has today: it does nothing, probes nothing and writes nothing.
 * A configured non-`direct` driver only acts while the `STEERING` flag is on, so saving the setting
 * is inert. The controller calls `reconcile()` once per tick from the failover loop; a driver that
 * writes provider state is only called while the controller holds its lease.
 */
export class SteeringService {
	readonly #drivers = new Map<SteeringDriverKind, SteeringDriver>();

	constructor(
		private readonly ctx: CoreContext,
		private readonly factories: Readonly<Partial<Record<SteeringDriverKind, SteeringDriverFactory>>> = STEERING_DRIVER_FACTORIES,
	) {}

	/** The configured selection: `direct` while the flag is off, whatever the saved setting says. */
	selection(): SteeringSelection {
		if (!featureEnabled(this.ctx.config, 'STEERING')) return { kind: 'direct', stacked: [] };
		const { steering } = this.ctx.cluster.get();
		return { kind: steering.driver, stacked: [...steering.stacked] };
	}

	/** True when a non-`direct`, implemented driver is selected and the flag is on. */
	active(): boolean {
		const { kind } = this.selection();
		return kind !== 'direct' && this.factories[kind] !== undefined;
	}

	/** The driver for `kind`, cached for this process so its intended set survives between ticks. */
	driver(kind: SteeringDriverKind): SteeringDriver {
		const cached = this.#drivers.get(kind);
		if (cached) return cached;
		const factory = this.factories[kind];
		if (!factory) throw new Error(`not implemented (HA Wave 2): steering driver ${kind}`);
		const driver = factory(this.context());
		this.#drivers.set(kind, driver);
		return driver;
	}

	/** Validate the selection; empty when it is usable. */
	preflight(): { kind: SteeringDriverKind; findings: SteeringFinding[] } {
		const { kind } = this.selection();
		if (kind === 'direct') return { kind, findings: [] };
		try {
			return { kind, findings: this.driver(kind).preflight() };
		} catch (error) {
			return { kind, findings: [{ nodeId: null, reason: (error as Error).message }] };
		}
	}

	/**
	 * One controller tick. Read-only drivers (including `external-lb`) run every tick; a driver that
	 * writes runs only while the controller still holds the lease, checked immediately before the
	 * write (`fence.holds()`), never at the start of the tick.
	 */
	async reconcile(fence: SteeringFence | null = null): Promise<SteeringTickResult> {
		const { kind } = this.selection();
		const idle: SteeringTickResult = {
			kind,
			active: false,
			applied: false,
			writes: false,
			waitingForLease: false,
			observed: null,
			findings: [],
			error: null,
		};
		if (kind === 'direct') return idle;

		let driver: SteeringDriver;
		try {
			driver = this.driver(kind);
		} catch (error) {
			return { ...idle, active: true, error: (error as Error).message };
		}
		const findings = driver.preflight();
		if (findings.length > 0) return { ...idle, active: true, writes: driver.capabilities.writes, findings };

		const writes = driver.capabilities.writes;
		if (writes && !(fence?.holds() ?? false)) {
			return {
				...idle,
				active: true,
				writes: true,
				waitingForLease: true,
				observed: await driver.observe().catch(() => null),
			};
		}
		try {
			await driver.desired();
			const observed = await driver.observe();
			return { ...idle, active: true, applied: true, writes, observed };
		} catch (error) {
			return { ...idle, active: true, applied: false, writes, error: (error as Error).message };
		}
	}

	/** A read-only snapshot for the driver: no database handle, no writer, no provider client. */
	private context(): SteeringDriverContext {
		return {
			now: () => this.ctx.now(),
			nodes: () => this.snapshot(),
			settings: (): IngressSettings => this.ctx.cluster.get().ingress,
		};
	}

	private snapshot(): SteeringNode[] {
		const ingress = new Set(this.ctx.ingressSet.nodes());
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.map((row) => {
				const view = this.ctx.nodes.view(row);
				return {
					id: row.id,
					name: row.name,
					zone: row.zone,
					status: row.status,
					roles: view.roles,
					capabilities: view.capabilities,
					ingress: ingress.has(row.id),
					capable: nodeHasCapability(row, INGRESS_SET_CAPABILITY),
					lastHeartbeatAt: row.lastHeartbeatAt,
				};
			});
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
