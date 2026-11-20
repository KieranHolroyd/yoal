import { eq } from 'drizzle-orm';
import { nodes } from '@yoal/db';
import {
	INGRESS_SET_CAPABILITY,
	type IngressActivation,
	type IngressSetView,
	type IngressSettings,
	type SteeringDriver,
	type SteeringDriverKind,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { nodeHasCapability } from './capability-gate.ts';
import { ConflictError, ForbiddenError } from './errors.ts';
import { ingressNodeIds, nodeRoles } from './ingress.ts';
import { nodeAddress } from './steering/snapshot.ts';
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

	/** What the dashboard and `yoal ha status` show. */
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
		let findings: Array<{ nodeId: string | null; reason: string }>;
		let writes: boolean;
		try {
			findings = driver.preflight();
			writes = driver.capabilities.writes;
		} catch (error) {
			// A provider-backed preflight can throw; the caller runs the database tick after this,
			// and a driver failure must not stop database failover.
			return { ...idle, active: true, error: (error as Error).message };
		}
		if (findings.length > 0) return { ...idle, active: true, writes, findings };
		if (writes && !(fence?.holds() ?? false)) {
			return {
				...idle,
				active: true,
				writes: true,
				waitingForLease: true,
				observed: await driver.observe().catch(() => null),
			};
		}
		// A driver with its own leased writer (`dns-failover`) is applied by the failover tick under
		// the lease epoch (FailoverService #dnsFailoverTick), so the provider is written once per tick.
		if (typeof (driver as { apply?: unknown }).apply === 'function') {
			return { ...idle, active: true, writes, observed: await driver.observe().catch(() => null) };
		}
		try {
			await driver.desired();
			const observed = await driver.observe();
			return { ...idle, active: true, applied: true, writes, observed };
		} catch (error) {
			return { ...idle, active: true, applied: false, writes, error: (error as Error).message };
		}
	}

	/** The same read-only context the registry gives a driver, for adapters built in `index.ts`. */
	driverContext(): SteeringDriverContext {
		return this.context();
	}

	/** A read-only snapshot for the driver: no database handle, no writer, no provider client. */
	private context(): SteeringDriverContext {
		return {
			now: () => this.ctx.now(),
			nodes: () => this.snapshot(),
			// The cache is live: a driver must not be able to mutate the running config (and then make
			// `view()` serve the change) by pushing into this object.
			settings: (): IngressSettings => structuredClone(this.ctx.cluster.get().ingress),
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
					address: nodeAddress(row),
					lastHeartbeatAt: row.lastHeartbeatAt,
				};
			});
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
