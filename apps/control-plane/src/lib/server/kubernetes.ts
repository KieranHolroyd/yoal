import type { Principal, ServiceLogEvent, ServiceLogQueryResult } from '@yoal/contracts';
import { core } from './core';

/**
 * Managed Kubernetes cluster logs (docs/KUBERNETES.md §11) in the shape the managed-service log
 * tail (`ServiceLogs.svelte`) reads, so the REST tail and the dashboard page share one format.
 * `serviceLogKinds` has no `kubernetes` member yet, so the kind is carried as a plain string.
 */
export function kubernetesLogPage(
	principal: Principal,
	name: string,
	options: { after?: number; limit?: number } = {}
): ServiceLogQueryResult {
	const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
	const cluster = core.kubernetes.requireRow(principal, name, { includeDeleted: true });
	const lines = core.kubernetes.logs(principal, name, { ...options, limit });
	const events = lines.map(
		(line) =>
			({
				seq: line.seq,
				ts: Date.parse(line.at),
				kind: 'kubernetes',
				serviceId: cluster.id,
				machineId: line.machineId,
				source: line.source,
				stream: line.stream,
				level: line.level,
				message: line.message
			}) as unknown as ServiceLogEvent
	);
	return {
		events,
		cursor: lines.at(-1)?.seq ?? options.after ?? 0,
		hasMore: lines.length >= limit
	};
}

/** `?after=` as a non-negative integer cursor, or undefined. */
export function parseLogCursor(value: string | null): number | undefined {
	if (value === null || !Number.isFinite(Number(value))) return undefined;
	return Math.max(0, Math.floor(Number(value)));
}

/**
 * Whether the dashboard shows the Kubernetes area (docs/KUBERNETES.md §11): the feature is on and
 * some node has the component, or the org already has a cluster. Platform admins read the
 * component table (installs in flight count); everyone else reads node capabilities.
 */
export function kubernetesAreaVisible(principal: Principal, enabled: boolean): boolean {
	if (!enabled) return false;
	try {
		if (core.ctx.platformIam.canAdminister(principal)) {
			const components = core.kubernetes.components(principal);
			if (components.some((item) => item.installed || item.pending?.action === 'install'))
				return true;
		} else if (core.kubernetes.capableNodes(principal).length > 0) return true;
	} catch {
		// No kubernetes:read: fall through to the org's own clusters.
	}
	try {
		return core.kubernetes.list(principal, { includeDeleted: true }).length > 0;
	} catch {
		return false;
	}
}
