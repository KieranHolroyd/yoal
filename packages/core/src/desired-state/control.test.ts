import { describe, expect, test } from 'bun:test';
import type { CoreContext } from '../context.ts';
import { ControlState } from './control.ts';

const flagsOff = { CONTROL_STANDBY: false } as never;
const flagsOn = { CONTROL_STANDBY: true } as never;

function context(options: {
	enabled: boolean;
	controlNodeId?: string;
	addresses?: string[];
	holder?: string | null;
	epoch?: number;
}) {
	return {
		config: {
			features: options.enabled ? flagsOn : flagsOff,
			platformOrigin: 'https://control.example.com',
			controlAddresses: options.addresses,
		},
		controlPlane: {
			snapshot: () => (options.holder === undefined ? null : { lease: { holderNodeId: options.holder } }),
			epochForDesiredState: async () => options.epoch ?? 0,
		},
	} as unknown as CoreContext;
}

function part(ctx: CoreContext, allNodes: Array<{ id: string; status: string; rolesJson: string; mode: string; publicAddress: string | null; privateAddress: string | null }>) {
	return new ControlState({
		ctx,
		node: allNodes[0]!,
		allNodes,
	} as never);
}

const nodes = [
	{ id: 'nod_b', status: 'online', rolesJson: '["control"]', mode: 'worker', publicAddress: 'b.test', privateAddress: '10.0.0.2' },
	{ id: 'nod_a', status: 'online', rolesJson: '["control"]', mode: 'edge', publicAddress: 'a.test', privateAddress: '10.0.0.1' },
];

describe('control-plane desired state (W9-SPEC §4.4)', () => {
	test('off: no field at all, so the payload stays byte-identical', async () => {
		expect(await part(context({ enabled: false }), nodes).desired()).toBeUndefined();
	});

	test('on: the lease holder is first and the epoch comes from the control plane', async () => {
		const desired = await part(
			context({ enabled: true, holder: 'nod_b', epoch: 7, addresses: ['https://b.example.com', 'https://a.example.com'] }),
			nodes,
		).desired();
		expect(desired).toEqual({
			epoch: 7,
			nodes: [
				{ nodeId: 'nod_b', url: 'https://b.example.com', zone: 'default' },
				{ nodeId: 'nod_a', url: 'https://a.example.com', zone: 'default' },
			],
		});
	});

	test('on without declared addresses falls back to the platform origin; no control nodes is absent', async () => {
		const desired = await part(context({ enabled: true, holder: 'nod_a', epoch: 3 }), nodes).desired();
		expect(desired?.nodes.every((node) => node.url === 'https://control.example.com')).toBe(true);
		expect(await part(context({ enabled: true }), [nodes[0]!]).desired()).toBeDefined();
		expect(
			await part(context({ enabled: true }), [{ ...nodes[0]!, rolesJson: '["compute"]' }]).desired(),
		).toBeUndefined();
	});
});
