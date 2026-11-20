/**
 * Faults with a timeline: apply one, revert it (or let the helper's own `durationS` revert it),
 * and record both in the scenario's timeline and in the observation log the checker reads
 * (`fault {fault, state: 'start'|'end', id}`; `power-off`/`stop` end a lease sample, see
 * tests/ha/README.md "Sample lifetime").
 *
 * Kinds:
 * - `power-off`: `docker kill` (the processes stop at once; the page cache and disk are the host's);
 *   revert: `docker start`, the node rejoins on its own.
 * - `stop`: `docker stop` (systemd shuts down in order); revert: `docker start`.
 * - `partition`: the helper's partition verb isolating the node from everything on the lab network
 *   and the overlay except its own addresses (s3lab and the host gateway included); revert:
 *   `clear-all` on that node (the verb also reverts itself after `durationS`).
 * - `freeze`: the helper's freeze verb (`SIGSTOP` to every process of a unit) for `durationS`;
 *   revert: the verb's own `revert`, else it thaws itself after `durationS`.
 */
import { LAB, containerName, labNode } from '../../../lab/lab.config.ts';
import { docker, exec } from '../../../lab/lib/docker.ts';
import { helperCall, type FleetNode } from '../../../lab/lib/api.ts';
import { cidrComplement } from '../../../lab/lib/net.ts';
import type { Scenario } from './scenario.ts';

/** The lab's overlay (tests/lab/README.md: managed WireGuard 10.47.0.0/22). */
export const OVERLAY = '10.47.0.0/22';
/** The helper's limit for a fault's `durationS` (apps/helper/src/faults.ts MAX_DURATION_S). */
export const FAULT_MAX_S = 3600;

export type FaultKind = 'power-off' | 'stop' | 'partition' | 'freeze';

export interface FaultOptions {
	/** partition/freeze: how long the helper holds it before reverting itself (1–3600). */
	durationS?: number;
	/** freeze: the unit (default yoal-agent.service). */
	unit?: string;
	/** partition: the fleet, for the node's overlay address. */
	fleet?: FleetNode[];
}

export interface FaultHandle {
	kind: FaultKind;
	node: string;
	id: string | null;
	appliedAt: number;
	revertedAt: number | null;
	detail: Record<string, unknown>;
	revert(): Promise<void>;
}

export class Faults {
	private readonly active: FaultHandle[] = [];
	private readonly kept = new Set<FaultHandle>();

	constructor(private readonly scenario: Scenario) {
		scenario.onCleanup('revert faults', () => this.revertAll());
	}

	async apply(kind: FaultKind, node: string, options: FaultOptions = {}): Promise<FaultHandle> {
		const box = containerName(labNode(node).name);
		const durationS = options.durationS ?? 600;
		if ((kind === 'partition' || kind === 'freeze') && (durationS < 1 || durationS > FAULT_MAX_S))
			throw new Error(`${kind} durationS ${durationS} is outside the helper's 1–${FAULT_MAX_S} s`);
		let id: string | null = null;
		const detail: Record<string, unknown> = {};
		const appliedAt = Date.now();
		switch (kind) {
			case 'power-off':
				docker(['kill', box]);
				break;
			case 'stop':
				docker(['stop', '-t', '30', box]);
				break;
			case 'partition': {
				const own = [labNode(node).ip];
				const overlay = options.fleet?.find((row) => row.name === node)?.privateAddress ?? null;
				const peers = [...cidrComplement(LAB.network.subnet, own), ...cidrComplement(OVERLAY, overlay ? [overlay] : [])];
				const result = helperCall(node, 'POST', '/v1/faults/partition', { peers, direction: 'both', durationS });
				if (result.status !== 200) throw new Error(`partition ${node} failed (${result.status}): ${JSON.stringify(result.body)}`);
				id = result.body?.fault?.id ?? null;
				detail.cidrs = peers.length;
				detail.durationS = durationS;
				// Proof from inside: the node can reach neither s3lab, nor MinIO, nor the control node.
				const probe = (argv: string[]) => exec(box, argv, { allowFailure: true }).code;
				const s3 = probe(['curl', '-s', '-o', '/dev/null', '--max-time', '3', `http://${LAB.s3lab.proxyIp}:${LAB.s3lab.s3Port}/minio/health/live`]);
				const minio = probe(['curl', '-s', '-o', '/dev/null', '--max-time', '3', `http://${LAB.s3lab.minioIp}:${LAB.s3lab.s3Port}/minio/health/live`]);
				const control = probe(['ping', '-c', '1', '-W', '1', LAB.nodes[0]!.ip]);
				detail.check = { s3lab: s3, minio, control };
				if (s3 === 0 || minio === 0 || (node !== LAB.nodes[0]!.name && control === 0))
					throw new Error(`the partition left ${node} able to reach the lab: ${JSON.stringify(detail.check)}`);
				break;
			}
			case 'freeze': {
				const unit = options.unit ?? 'yoal-agent.service';
				const result = helperCall(node, 'POST', '/v1/faults/freeze', { unit, durationS });
				if (result.status !== 200) throw new Error(`freeze ${unit} on ${node} failed (${result.status}): ${JSON.stringify(result.body)}`);
				id = result.body?.fault?.id ?? null;
				detail.unit = unit;
				detail.durationS = durationS;
				break;
			}
		}
		const handle: FaultHandle = {
			kind,
			node,
			id,
			appliedAt,
			revertedAt: null,
			detail,
			revert: async () => {
				if (handle.revertedAt !== null) return;
				handle.revertedAt = Date.now();
				switch (kind) {
					case 'power-off':
					case 'stop':
						docker(['start', box]);
						break;
					case 'partition':
						helperCall(node, 'POST', '/v1/faults/clear-all', {});
						break;
					case 'freeze':
						if (id) helperCall(node, 'POST', '/v1/faults/revert', { id });
						break;
				}
				this.scenario.observer.note('fault', node, { fault: kind, state: 'end', id });
				this.scenario.event(`revert ${kind}`, { node, id });
			},
		};
		this.active.push(handle);
		this.scenario.observer.note('fault', node, { fault: kind, state: 'start', id, ...detail });
		this.scenario.event(`apply ${kind}`, { node, id, ...detail });
		return handle;
	}

	/** A fault that reverted itself (the helper's durationS): record its end without acting. */
	expired(handle: FaultHandle, at = Date.now()): void {
		if (handle.revertedAt !== null) return;
		handle.revertedAt = at;
		this.scenario.observer.note('fault', handle.node, { fault: handle.kind, state: 'end', id: handle.id, reason: 'durationS elapsed' });
		this.scenario.event(`${handle.kind} ended (durationS elapsed)`, { node: handle.node, id: handle.id });
	}

	/** Leave this fault in place when the scenario ends (`--keep-down`). */
	keep(handle: FaultHandle): void {
		this.kept.add(handle);
		this.scenario.notice(`${handle.kind} on ${handle.node} is left in place (--keep-down); revert it with \`bun tests/lab/lab.ts ${handle.kind === 'partition' || handle.kind === 'freeze' ? `fault ${handle.node} clear-all` : `start ${handle.node}`}\`.`);
	}

	async revertAll(): Promise<void> {
		for (const handle of [...this.active].reverse()) {
			if (handle.revertedAt !== null || this.kept.has(handle)) continue;
			await handle.revert();
		}
	}
}
