import { BROKER_PORT_MAX, BROKER_PORT_MIN } from './broker.ts';
import { CONTAINER_CONSOLE_DEFAULT_PORT } from './container-console.ts';
import { DATABASE_POOLER_PORT_MAX, DATABASE_POOLER_PORT_MIN, DATABASE_PORT_MAX, DATABASE_PORT_MIN } from './database.ts';
import { STUDIO_DEFAULT_PORT } from './database-studio.ts';
import { PUBLIC_DATABASE_PORT_MAX, PUBLIC_DATABASE_PORT_MIN } from './database-public-access.ts';
import { endpointPortRange, readEndpointPortRange } from './endpoint.ts';
import { FUNCTION_ANALYTICS_PORT } from './function.ts';
import { IDENTITY_DEFAULT_PORT } from './identity.ts';
import { INGRESS_HEALTH_PORT } from './ingress.ts';
import { KUBERNETES_API_PORT_MIN, KUBERNETES_INGRESS_PORT_MAX } from './kubernetes.ts';
import { STORAGE_PORT_MAX, STORAGE_PORT_MIN } from './object-storage.ts';
import { REGISTRY_DEFAULT_PORT } from './registry.ts';
import { WORKLOAD_IDENTITY_PORT } from './workload-identity.ts';

/**
 * Host ports the platform owns on every node (D225, docs/DESIGN.md §3.4.2).
 *
 * An app's loopback port is host-global: a container publishes `127.0.0.1:<port>` and a process
 * app without socket activation binds it directly, and Caddy routes the project's public host to
 * that port. If the app is not the one listening there, the public host reaches whatever is: a
 * neighbour's app, or a platform service such as the container console or the database studio.
 * Apps therefore never take a port from this list, and Yoal never routes to one for an app.
 */

export interface ReservedPortRange {
	min: number;
	max: number;
	/** What holds it, for the refusal message ("the container console"). */
	owner: string;
}

/** Ports managed services are given from (databases, poolers, storage, brokers, compose, endpoints). */
export const COMPOSE_HOST_PORT_MIN = 30_000;
export const COMPOSE_HOST_PORT_MAX = 39_999;

/** Default loopback ports of the node gateways (`YOAL_STORAGE_GATEWAY_PORT`, `YOAL_DATABASE_GATEWAY_PORT`). */
export const STORAGE_GATEWAY_DEFAULT_PORT = 8081;
export const DATABASE_GATEWAY_DEFAULT_PORT = 8082;
/** The node's telemetry ClickHouse HTTP port. */
export const TELEMETRY_CLICKHOUSE_PORT = 18_123;

export const PLATFORM_HOST_PORTS: readonly ReservedPortRange[] = [
	{ min: 1, max: 1023, owner: 'privileged ports (Caddy on 80/443, mail, SSH, DNS)' },
	{ min: STORAGE_GATEWAY_DEFAULT_PORT, max: STORAGE_GATEWAY_DEFAULT_PORT, owner: 'the storage gateway' },
	{ min: DATABASE_GATEWAY_DEFAULT_PORT, max: DATABASE_GATEWAY_DEFAULT_PORT, owner: 'the database gateway' },
	{ min: STUDIO_DEFAULT_PORT, max: STUDIO_DEFAULT_PORT, owner: 'the database studio' },
	{ min: CONTAINER_CONSOLE_DEFAULT_PORT, max: CONTAINER_CONSOLE_DEFAULT_PORT, owner: 'the container console' },
	{ min: FUNCTION_ANALYTICS_PORT, max: FUNCTION_ANALYTICS_PORT, owner: "the agent's analytics sink" },
	{ min: INGRESS_HEALTH_PORT, max: INGRESS_HEALTH_PORT, owner: "the ingress health endpoint" },
	{ min: WORKLOAD_IDENTITY_PORT, max: WORKLOAD_IDENTITY_PORT, owner: 'the workload identity endpoint' },
	{ min: IDENTITY_DEFAULT_PORT, max: IDENTITY_DEFAULT_PORT, owner: 'the identity service' },
	{ min: BROKER_PORT_MIN, max: BROKER_PORT_MAX, owner: 'managed brokers' },
	{ min: REGISTRY_DEFAULT_PORT, max: REGISTRY_DEFAULT_PORT, owner: 'the container registry' },
	{ min: DATABASE_PORT_MIN, max: DATABASE_PORT_MAX, owner: 'managed databases' },
	{ min: DATABASE_POOLER_PORT_MIN, max: DATABASE_POOLER_PORT_MAX, owner: 'database poolers' },
	{ min: TELEMETRY_CLICKHOUSE_PORT, max: TELEMETRY_CLICKHOUSE_PORT, owner: 'the telemetry store' },
	{ min: STORAGE_PORT_MIN, max: STORAGE_PORT_MAX, owner: 'managed object storage and link tests' },
	{ min: endpointPortRange.min, max: endpointPortRange.max, owner: 'service endpoints' },
	{ min: KUBERNETES_API_PORT_MIN, max: KUBERNETES_INGRESS_PORT_MAX, owner: 'Kubernetes clusters' },
	{ min: PUBLIC_DATABASE_PORT_MIN, max: PUBLIC_DATABASE_PORT_MAX, owner: 'public database access' },
	{ min: COMPOSE_HOST_PORT_MIN, max: COMPOSE_HOST_PORT_MAX, owner: 'compose service routes' },
];

/**
 * Ranges reserved for a platform feature that nothing allocates yet (HA-PLAN F2). Unlike
 * `PLATFORM_HOST_PORTS`, they do not stop an app that already holds such a port from being served
 * or redeployed on it: only a new app, or a port change, is refused. The workstream that starts
 * allocating a range moves its apps off first, then moves the range into `PLATFORM_HOST_PORTS`.
 */
export const RESERVED_LATER_HOST_PORTS: readonly ReservedPortRange[] = [
	{ min: readEndpointPortRange.min, max: readEndpointPortRange.max, owner: 'service read endpoints' },
];

/** Which reserved-for-later range holds `port`; null when none. */
export function laterPortOwner(port: number): string | null {
	for (const range of RESERVED_LATER_HOST_PORTS) if (port >= range.min && port <= range.max) return range.owner;
	return null;
}

/**
 * The upstream a route gets when its node must not proxy to the app (RouteSpec `unavailable`).
 * Nothing listens on it, so even an agent that ignores `unavailable` returns an error page.
 */
export const UNAVAILABLE_UPSTREAM = 'unix//run/yoal/route-unavailable.sock';

/** Who owns `port` among the platform ranges (plus install-specific `extra` ones); null when free. */
export function platformPortOwner(port: number, extra: readonly ReservedPortRange[] = []): string | null {
	for (const range of [...PLATFORM_HOST_PORTS, ...extra]) if (port >= range.min && port <= range.max) return range.owner;
	return null;
}

/**
 * The loopback TCP ports an app's workload holds on its node. Socket-activated processes and
 * functions listen on a unix socket, workers listen on nothing, and compose stacks carry their
 * own Yoal-assigned route ports. Everything else (a container, a process app with socket
 * activation off) holds `port`.
 */
export function appHostPorts(spec: {
	runtime: string;
	port: number;
	ingress?: string;
	socketActivation?: boolean;
	compose?: { routes: Array<{ hostPort?: number | null }> } | null;
}): number[] {
	if (spec.ingress === 'none') return [];
	if (spec.runtime === 'compose')
		return (spec.compose?.routes ?? []).flatMap((route) => (route.hostPort ? [route.hostPort] : []));
	if (spec.runtime === 'container') return [spec.port];
	if (spec.runtime === 'process' && spec.socketActivation === false) return [spec.port];
	return [];
}

/** The ports an app may pick itself (process and container): every TCP port, minus the platform's. */
export function appPortProblem(port: number, extra: readonly ReservedPortRange[] = []): string | null {
	const owner = platformPortOwner(port, extra);
	return owner ? `Port ${port} is reserved for ${owner} on every node. Pick another port for this app (1024 or higher, outside the platform ranges).` : null;
}
