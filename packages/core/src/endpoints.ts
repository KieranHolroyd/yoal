import {
	endpointPortRange,
	readEndpointPortRange,
	type EndpointRole,
	type ServiceEndpoint,
	type ServiceKind,
} from '@yoal/contracts';

/**
 * Service endpoint planning (docs/CLUSTERING.md §4.3, phase C2; HA-PLAN H24).
 *
 * Pure so port allocation and stability are testable without a network: a consumer keeps the same
 * loopback port for a service across provider moves. A remote attachment always gets one; with the
 * endpoint gateway on, a same-node attachment does too, so a promotion never changes an app's
 * environment (G10). A database also gets a pooled endpoint and, when it has readable replicas, a
 * stable read endpoint in the read range (G11).
 */

export interface EndpointService {
	kind: ServiceKind;
	serviceId: string;
	upstreamNodeId: string;
	upstreamPort: number;
	/** `primary` (absent) for the attachment itself, `pool` for the database's PgBouncer. */
	role?: 'primary' | 'pool';
	/** Provider overlay address; null until known. */
	address?: string | null;
	tlsFingerprint?: string | null;
}

export interface ExistingEndpoint {
	kind: ServiceKind;
	serviceId: string;
	localPort: number;
	role?: 'primary' | 'pool';
}

export interface EndpointPlan {
	endpoints: ServiceEndpoint[];
	/** `kind:serviceId:role` keys the caller must delete. */
	removed: string[];
}

/** Stable identity of one consumer's endpoint for a service and role. */
export function endpointKey(kind: ServiceKind, serviceId: string, role: EndpointRole = 'primary'): string {
	return `${kind}:${serviceId}:${role}`;
}

export function endpointId(consumerNodeId: string, service: EndpointService): string {
	const suffix = service.role === 'pool' ? '_pool' : '';
	return `sep_${consumerNodeId}_${service.kind}_${service.serviceId}${suffix}`.slice(0, 100);
}

/**
 * Plan one consumer's primary and pooled endpoints. Existing ports are reused; freed ports are not
 * numbered down. `includeSameNode` is the gateway case: an attachment on the consumer's own node
 * still goes through a stable loopback port.
 */
export function planServiceEndpoints(
	consumerNodeId: string,
	services: EndpointService[],
	existing: ExistingEndpoint[],
	range: { min: number; max: number } = endpointPortRange,
	options: { includeSameNode?: boolean } = {},
): EndpointPlan {
	const wanted = dedupe(
		services.filter((service) => options.includeSameNode || service.upstreamNodeId !== consumerNodeId),
	);
	const existingByKey = new Map(existing.map((item) => [endpointKey(item.kind, item.serviceId, item.role ?? 'primary'), item]));
	const wantedKeys = new Set(wanted.map((service) => endpointKey(service.kind, service.serviceId, service.role)));
	// Ports a kept endpoint already owns are taken before any new one is allocated, so a new
	// service planned ahead of an existing one can never be handed that one's port.
	const used = new Set<number>(
		existing
			.filter((item) => wantedKeys.has(endpointKey(item.kind, item.serviceId, item.role ?? 'primary')))
			.map((item) => item.localPort),
	);
	const endpoints: ServiceEndpoint[] = [];

	for (const service of wanted) {
		const role = service.role ?? 'primary';
		const previous = existingByKey.get(endpointKey(service.kind, service.serviceId, role));
		const localPort = previous?.localPort ?? allocatePort(used, range);
		used.add(localPort);
		endpoints.push({
			id: endpointId(consumerNodeId, service),
			kind: service.kind,
			serviceId: service.serviceId,
			localPort,
			upstream: {
				nodeId: service.upstreamNodeId,
				address: service.address ?? null,
				port: service.upstreamPort,
			},
			tlsFingerprint: service.tlsFingerprint ?? null,
			...(role === 'primary' ? {} : { role }),
		});
	}

	const removed = existing
		.filter((item) => !wantedKeys.has(endpointKey(item.kind, item.serviceId, item.role ?? 'primary')))
		.map((item) => endpointKey(item.kind, item.serviceId, item.role ?? 'primary'));
	return { endpoints: endpoints.sort((a, b) => a.localPort - b.localPort), removed };
}

/** A read endpoint's one representative upstream while it is allocated; rendering uses every replica. */
export interface ReadEndpointService {
	serviceId: string;
	upstreamNodeId: string;
	upstreamPort: number;
}

export interface ExistingReadEndpoint {
	serviceId: string;
	localPort: number;
}

export interface ReadEndpointPlan {
	endpoints: Array<{ id: string; serviceId: string; localPort: number; upstreamNodeId: string; upstreamPort: number }>;
	removed: string[];
}

/** Plan one consumer's stable read ports (23000–23999): one per database with readable replicas. */
export function planReadEndpoints(
	consumerNodeId: string,
	services: ReadEndpointService[],
	existing: ExistingReadEndpoint[],
	range: { min: number; max: number } = readEndpointPortRange,
): ReadEndpointPlan {
	const wanted = new Map<string, ReadEndpointService>();
	for (const service of services) if (!wanted.has(service.serviceId)) wanted.set(service.serviceId, service);
	const existingByService = new Map(existing.map((item) => [item.serviceId, item]));
	const used = new Set<number>(
		existing.filter((item) => wanted.has(item.serviceId)).map((item) => item.localPort),
	);
	const endpoints: ReadEndpointPlan['endpoints'] = [];
	for (const service of wanted.values()) {
		const previous = existingByService.get(service.serviceId);
		const localPort = previous?.localPort ?? allocatePort(used, range);
		used.add(localPort);
		endpoints.push({
			id: `sep_${consumerNodeId}_database_${service.serviceId}_read`.slice(0, 100),
			serviceId: service.serviceId,
			localPort,
			upstreamNodeId: service.upstreamNodeId,
			upstreamPort: service.upstreamPort,
		});
	}
	const removed = existing.filter((item) => !wanted.has(item.serviceId)).map((item) => item.serviceId);
	return { endpoints: endpoints.sort((a, b) => a.localPort - b.localPort), removed };
}

/** One endpoint per service and role: two projects on a node attached to one database share it. */
function dedupe(services: EndpointService[]): EndpointService[] {
	const seen = new Map<string, EndpointService>();
	for (const service of services) {
		const key = endpointKey(service.kind, service.serviceId, service.role);
		if (!seen.has(key)) seen.set(key, service);
	}
	return [...seen.values()];
}

function allocatePort(used: Set<number>, range: { min: number; max: number }): number {
	for (let port = range.min; port <= range.max; port++) if (!used.has(port)) return port;
	throw new Error(`No free service endpoint port in ${range.min}–${range.max}.`);
}
