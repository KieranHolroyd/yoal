import { describe, expect, test } from 'bun:test';
import { formatControlStatus, formatHaStatus, type HaStatusView } from './ha.ts';

const view: HaStatusView = {
	enabled: true,
	policy: { graceSeconds: 120, replicaGraceSeconds: 120, maxPerMinute: 6, perTargetPerMinute: 2, queueExpirySeconds: 600, leaseTtlSeconds: 30, tickSeconds: 5 },
	lease: { state: 'holder', epoch: 3, holderId: 'cp-a:42:abcd', self: true, expiresAt: '2026-11-07T12:00:30.000Z' },
	lastTickAt: '2026-11-07T12:00:00.000Z',
	nodes: [
		{ id: 'nod_1', name: 'edge', zone: 'cloud-a', status: 'online', silentSeconds: 2, lost: false, replicaFailoverAt: null, copies: 0 },
		{ id: 'nod_2', name: 'w1', zone: 'home', status: 'offline', silentSeconds: 300, lost: true, replicaFailoverAt: '2026-11-07T11:57:00.000Z', copies: 1 },
	],
	ingress: { driver: 'dns-failover', steers: false, rotates: true, nodes: [{ id: 'nod_1', name: 'edge', healthy: true, inRotation: true, pinned: false }] },
	databases: [{ name: 'billing', nodeName: 'w1', primaryLost: true, replicas: 1, candidate: null, refusals: ['w2: lag 90s'], automatic: false }],
	counts: { lastMinute: 1, inProgress: 1, queued: 0 },
	recent: [
		{
			id: 'fov_1',
			kind: 'replica',
			status: 'in-progress',
			stage: 'promote',
			subjectId: 'wrl_1',
			subjectName: 'web [r0]',
			fromNodeId: 'nod_2',
			fromNodeName: 'w1',
			toNodeId: 'nod_3',
			toNodeName: 'w3',
			reason: 'w1 has not sent a heartbeat since 2026-11-07T11:55:00.000Z. Moving to w3.',
			epoch: 3,
			detectedAt: '2026-11-07T11:57:00.000Z',
			appliedAt: '2026-11-07T11:57:00.000Z',
			finishedAt: null,
		},
	],
};

describe('yoal ha status', () => {
	test('prints the lease, lost nodes, database candidates and recent events', () => {
		const text = formatHaStatus(view);
		expect(text).toContain('Automatic failover: on');
		expect(text).toContain('Lease: holder at epoch 3, held by cp-a:42:abcd (this control plane)');
		expect(text).toMatch(/w1\s+home\s+offline\s+300s\s+yes\s+1\s+2026-11-07 11:57:00Z/);
		expect(text).toContain('withdrawals and re-adds are manual DNS steps');
		expect(text).toContain('none (w2: lag 90s)');
		expect(text).toMatch(/replica\s+in-progress\s+web \[r0\]\s+w1\s+w3/);
	});

	test('says when automatic failover is off and there is no history', () => {
		const text = formatHaStatus({ ...view, enabled: false, recent: [], databases: [] });
		expect(text).toContain('off (drains still move replica copies)');
		expect(text).toContain('No failover events yet.');
		expect(formatHaStatus(view, { events: 0 })).not.toContain('events');
	});

	test('prints control-plane roles, epochs and canPromote', () => {
		const text = formatControlStatus([
			{
				nodeId: 'nod_a',
				name: 'edge-a',
				role: 'primary',
				epoch: 7,
				holderNodeId: 'nod_a',
				leaseExpiresAt: '2026-11-20T20:41:12.000Z',
				canPromote: true,
				replicationLagSeconds: null,
				version: '0.16.3',
				updatedAt: '2026-11-20T20:41:00.000Z',
			},
			{
				nodeId: 'nod_b',
				name: 'edge-b',
				role: 'standby-behind',
				epoch: 7,
				holderNodeId: 'nod_a',
				leaseExpiresAt: '2026-11-20T20:41:12.000Z',
				canPromote: false,
				replicationLagSeconds: 12,
				version: '0.16.3',
				updatedAt: null,
			},
		]);
		expect(text).toMatch(/edge-a\s+primary\s+7\s+nod_a\s+yes/);
		expect(text).toMatch(/edge-b\s+standby-behind\s+7\s+nod_a\s+no\s+12s/);
		expect(formatControlStatus([])).toContain('No control nodes have reported');
	});
});
