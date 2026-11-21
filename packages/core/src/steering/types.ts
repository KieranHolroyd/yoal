import type { IngressSettings, SteeringDriver, SteeringDriverKind } from '@yoal/contracts';

/**
 * What a steering driver is allowed to read (HA-PLAN H18).
 *
 * A driver is built for one install and sees a snapshot of the fleet at the moment it is asked;
 * it has no database handle, no event writer and no provider client beyond the one it owns. That
 * is what makes "writes nothing" checkable: the context exposes reads only.
 */
export interface SteeringNode {
	id: string;
	name: string;
	zone: string;
	/** The node's region (HA-PLAN H26); `default` unless an operator named one. */
	region: string;
	status: string;
	roles: readonly string[];
	capabilities: readonly string[];
	/**
	 * Offered traffic: `IngressSetService.nodes()` contains this id and, when the fleet spans regions
	 * (`REGIONS`), the node is in the active region, or that region has no online ingress (H18
	 * stacked steering, `regionSteeringSet`). With one region this is the whole ingress set.
	 */
	ingress: boolean;
	/** The agent advertises `ingress-set`, so it can answer the health endpoint (H19). */
	capable: boolean;
	/** The node's public/overlay address when the snapshot has one; drivers may also resolve it. */
	address?: string | null;
	lastHeartbeatAt: number | null;
}

export interface SteeringDriverContext {
	now(): number;
	/** Every node in the fleet; a driver filters on `ingress`. */
	nodes(): readonly SteeringNode[];
	settings(): IngressSettings;
}

/**
 * The controller lease as a driver sees it. `holds()` is checked immediately before a write, never
 * once at the start of a tick (HA-PLAN H18: every write is made under the controller lease).
 */
export interface SteeringFence {
	epoch: number;
	holds(): boolean;
}

export interface SteeringFinding {
	/** The node the finding is about, or null when it is fleet-wide. */
	nodeId: string | null;
	reason: string;
}

/** The conventional `observe()` shape every driver in this package returns. */
export interface SteeringObserved {
	kind: SteeringDriverKind;
	observedAt: number;
	/** Nodes the provider currently considers healthy. */
	healthy: string[];
	/** Nodes the driver intends to keep receiving traffic; never empty while one is healthy. */
	serving: string[];
	[key: string]: unknown;
}

export interface SteeringTickResult {
	kind: SteeringDriverKind;
	/** True when a non-`direct` driver is selected by the cluster configuration and the flag is on. */
	active: boolean;
	/** `desired()` ran (always true for a write-free driver that preflighted cleanly). */
	applied: boolean;
	/** The selected driver writes provider state. */
	writes: boolean;
	/** A write-capable driver that did not act because the controller lease is not held. */
	waitingForLease: boolean;
	observed: Record<string, unknown> | null;
	findings: SteeringFinding[];
	error: string | null;
}

/** A driver factory. The registry builds one instance per kind per control-plane process. */
export type SteeringDriverFactory = (context: SteeringDriverContext) => SteeringDriver;
