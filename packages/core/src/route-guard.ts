import { appHostPorts, workloadSpecSchema, type WorkloadSpec } from '@yoal/contracts';
import { parseJson } from './util.ts';

/**
 * The desired-state route guard (D225): the last check before a node's Caddy is told to proxy a
 * project's public host to a local app.
 *
 * Admission (`host-ports.ts`) keeps two apps off one port, but rows written before it existed, a
 * race between two deploys, or a bug in a placement path would still put one project's visitors
 * on another project's listener. This guard works from what a node is actually about to serve,
 * so it holds whatever path wrote the rows.
 */

interface GuardWorkload {
	id: string;
	projectId: string;
	status: string;
	upstream: string | null;
	specJson: string;
	createdAt: number;
}

/** For each loopback port on the node, the project whose app owns it: the one placed first. */
export function tcpPortWinners(rows: GuardWorkload[]): Map<number, string> {
	const winners = new Map<number, { projectId: string; createdAt: number; id: string }>();
	for (const row of rows) {
		const spec = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null)).data as WorkloadSpec | undefined;
		if (!spec) continue;
		const ports = new Set(appHostPorts(spec));
		const dialled = loopbackPort(row.upstream);
		if (dialled !== null) ports.add(dialled);
		for (const port of ports) {
			const current = winners.get(port);
			if (!current || row.createdAt < current.createdAt || (row.createdAt === current.createdAt && row.id < current.id))
				winners.set(port, { projectId: row.projectId, createdAt: row.createdAt, id: row.id });
		}
	}
	return new Map([...winners].map(([port, winner]) => [port, winner.projectId]));
}

/** `127.0.0.1:3000` → 3000; null for a unix socket, a remote node or nothing. */
export function loopbackPort(upstream: string | null | undefined): number | null {
	const match = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(upstream ?? '');
	if (!match) return null;
	const port = Number(match[1]);
	return port >= 1 && port <= 65_535 ? port : null;
}

/**
 * Why this node must not proxy a local app route; null when it may. `runtime` is the project's
 * effective runtime. Static sites and functions are not guarded here: a static site has no
 * upstream by design, and a function's assets are meant to be served from its release.
 */
export function routeBlockReason(input: {
	runtime: string;
	workload: GuardWorkload | null;
	portWinners: ReadonlyMap<number, string>;
	reserved: (port: number) => string | null;
}): string | null {
	const { runtime, workload } = input;
	if (runtime !== 'process' && runtime !== 'container' && runtime !== 'compose') return null;
	if (!workload || !workload.upstream || workload.upstream === 'none')
		return 'The app has no running workload on this node yet.';
	// Status is not a gate: `failed` also marks an app that restarted five times and is serving
	// again, and its own port answers nothing else, so a dead app only costs a dial error (503).
	const port = loopbackPort(workload.upstream);
	if (port === null) return null;
	// Compose route ports come from the platform's own compose range, so only apps are refused there.
	const owner = runtime === 'compose' ? null : input.reserved(port);
	if (owner) return `Port ${port} is reserved for ${owner}; the app cannot be served from it.`;
	const winner = input.portWinners.get(port);
	if (winner && winner !== workload.projectId) return `Port ${port} on this node belongs to another app.`;
	return null;
}
