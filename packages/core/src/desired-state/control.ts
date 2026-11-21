import type { DesiredState } from '@yoal/contracts';
import { featureEnabled } from '../config.ts';
import { nodeRoles } from '../ingress.ts';
import { DesiredStatePart } from './context.ts';

/**
 * Control-plane HA desired state (HA-PLAN H21/C6, W9-SPEC §4.4).
 *
 * Every agent receives the control address list in preference order and the highest epoch the
 * control plane asserts. It persists the epoch before applying state and refuses a lower one; when
 * no address answers it keeps serving its cached desired state (I11). Absent with `CONTROL_STANDBY`
 * off, so a single-node install's payload is byte-identical.
 *
 * Order: the current lease holder, then other online control nodes, then the rest. The address is
 * the operator-declared direct endpoint for that node (`YOAL_CONTROL_ADDRESSES`, `nodeId=url`
 * pairs) where given, else the platform origin — which is the ingress route that prefers the
 * primary. The declaration is bound by node id, so re-ordering never hands a node another's URL.
 */
export class ControlState extends DesiredStatePart {
	async desired(): Promise<DesiredState['control'] | undefined> {
		if (!featureEnabled(this.ctx.config, 'CONTROL_STANDBY')) return undefined;
		const { allNodes } = this.state;
		const controls = allNodes.filter((node) => nodeRoles(node).includes('control'));
		if (controls.length === 0) return undefined;
		const holder = this.ctx.controlPlane.snapshot()?.lease.holderNodeId ?? null;
		const ordered = [...controls].sort((a, b) => {
			if (a.id === holder) return -1;
			if (b.id === holder) return 1;
			const online = Number(b.status === 'online') - Number(a.status === 'online');
			return online !== 0 ? online : a.id.localeCompare(b.id);
		});
		const declared = new Map((this.ctx.config.controlAddresses ?? []).map((address) => [address.nodeId, address.url]));
		const nodes = ordered.map((node) => ({
			nodeId: node.id,
			// Bound by node id: reordering the list (the holder moves to the front) must not hand a
			// node another host's address.
			url: declared.get(node.id) ?? this.ctx.config.platformOrigin.replace(/\/+$/, ''),
			zone: 'default',
		}));
		return {
			nodes,
			epoch: await this.ctx.controlPlane.epochForDesiredState(),
		};
	}
}
