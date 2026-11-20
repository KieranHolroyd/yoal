import {
	ENDPOINTS_GATEWAY_CAPABILITY,
	OBJECT_STORE_KINDS_CAPABILITY,
	RELEASE_PHASE_CAPABILITY,
	type DesiredState,
	type ObjectStoreTargetKind,
} from '@yoal/contracts';
import { parseJson } from './util.ts';

/**
 * Mixed-version safety for HA Wave 1 (HA-PLAN §9 "Mixed versions", CLUSTERING §13.7).
 *
 * The control plane renders a new desired-state field only to a node that advertises the
 * capability for it. An older agent drops unknown keys, so most fields would be ignored anyway,
 * but silently: a node that ignores `drainSeconds` stops a copy without draining it, one that
 * ignores `gatewayAddress` leaves a container with nothing to dial. Stripping here makes "the node
 * cannot do this" visible to the planner instead of hoping.
 *
 * Every desired-state builder calls `gateDesiredState` last, with the node's stored capabilities.
 * A state with none of the gated fields comes back as the same object, so single-node and
 * flags-off installs render byte-for-byte what they did. Placement and enablement call
 * `nodesMissingCapability` first and refuse with the node's name (§13.7 rules 2 and 3); this
 * function is the backstop, not the plan.
 */

/** The capabilities a node stored from its last heartbeat. An empty list means unknown. */
export function nodeCapabilityList(capabilitiesJson: string | null | undefined): string[] {
	const parsed = parseJson<unknown>(capabilitiesJson ?? null, []);
	return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function nodeHasCapability(node: { capabilitiesJson: string | null }, capability: string): boolean {
	return nodeCapabilityList(node.capabilitiesJson).includes(capability);
}

/** The nodes in `nodes` that lack `capability`, for a refusal that names them (§13.7 rule 2). */
export function nodesMissingCapability<Node extends { id: string; name: string; capabilitiesJson: string | null }>(
	nodes: readonly Node[],
	capability: string,
): Node[] {
	return nodes.filter((node) => !nodeHasCapability(node, capability));
}

/** A refusal for enabling a feature while involved nodes lack its capability, or null. */
export function missingCapabilityMessage(
	feature: string,
	capability: string,
	missing: readonly { name: string }[],
): string | null {
	if (missing.length === 0) return null;
	const names = missing.map((node) => node.name).join(', ');
	return `${feature} needs every involved node to run an agent with "${capability}"; update ${names} first.`;
}

/**
 * Whether a node may be handed an object-store target of `kind` (a PITR repository, a Litestream
 * replica). `s3` needs nothing; `azure` and `gcs` need `object-store-kinds`.
 */
export function objectStoreKindAllowed(capabilities: readonly string[], kind: ObjectStoreTargetKind): boolean {
	return kind === 's3' || capabilities.includes(OBJECT_STORE_KINDS_CAPABILITY);
}

type Workload = DesiredState['workloads'][number];
type Route = DesiredState['routes'][number];
type Endpoint = DesiredState['serviceEndpoints'][number];
type Provider = DesiredState['serviceProviders'][number];

function stripWorkload(workload: Workload, gateway: boolean, release: boolean): Workload {
	let next = workload;
	if (!gateway && next.addHosts !== undefined) {
		const { addHosts: _addHosts, ...rest } = next;
		next = rest;
	}
	if (!release && (next.readinessPath !== undefined || next.drainSeconds !== undefined || next.stopTimeoutSeconds !== undefined)) {
		const { readinessPath: _readiness, drainSeconds: _drain, stopTimeoutSeconds: _stop, ...rest } = next;
		next = rest;
	}
	return next;
}

function stripRoute(route: Route): Route {
	if (route.readinessPath === undefined) return route;
	const { readinessPath: _readiness, ...rest } = route;
	return rest;
}

function stripEndpoint(endpoint: Endpoint): Endpoint {
	if (endpoint.role === undefined && endpoint.gatewayAddress === undefined && endpoint.trust === undefined && endpoint.version === undefined)
		return endpoint;
	const { role: _role, gatewayAddress: _gateway, trust: _trust, version: _version, ...rest } = endpoint;
	return rest;
}

function stripProvider(provider: Provider): Provider {
	if (provider.clientAuth === undefined && provider.allowedClientNodeIds === undefined) return provider;
	const { clientAuth: _auth, allowedClientNodeIds: _ids, ...rest } = provider;
	return rest;
}

function mapIfChanged<T>(items: T[], fn: (item: T) => T): T[] {
	let changed = false;
	const next = items.map((item) => {
		const mapped = fn(item);
		if (mapped !== item) changed = true;
		return mapped;
	});
	return changed ? next : items;
}

/**
 * Remove every HA Wave 1 field the node cannot act on:
 * - without `endpoints-gateway`: `readEndpoints`, `nodeTrust`, `workloads[].addHosts`,
 *   `serviceEndpoints[].role|gatewayAddress|trust|version`,
 *   `serviceProviders[].clientAuth|allowedClientNodeIds`;
 * - without `release-phase`: `releaseCommands`, `workloads[].readinessPath|drainSeconds|
 *   stopTimeoutSeconds`, `routes[].readinessPath`.
 * Returns `state` itself when nothing was removed.
 */
export function gateDesiredState(state: DesiredState, capabilities: readonly string[]): DesiredState {
	const gateway = capabilities.includes(ENDPOINTS_GATEWAY_CAPABILITY);
	const release = capabilities.includes(RELEASE_PHASE_CAPABILITY);
	if (gateway && release) return state;
	let next: DesiredState = state;
	const set = <K extends keyof DesiredState>(key: K, value: DesiredState[K]) => {
		if (value !== next[key]) next = { ...next, [key]: value };
	};
	if (!gateway) {
		if (next.readEndpoints !== undefined || next.nodeTrust !== undefined) {
			const { readEndpoints: _read, nodeTrust: _trust, ...rest } = next;
			next = rest;
		}
		set('serviceEndpoints', mapIfChanged(next.serviceEndpoints, stripEndpoint));
		set('serviceProviders', mapIfChanged(next.serviceProviders, stripProvider));
	}
	if (!release) {
		if (next.releaseCommands !== undefined) {
			const { releaseCommands: _commands, ...rest } = next;
			next = rest;
		}
		set('routes', mapIfChanged(next.routes, stripRoute));
	}
	set('workloads', mapIfChanged(next.workloads, (workload) => stripWorkload(workload, gateway, release)));
	return next;
}
