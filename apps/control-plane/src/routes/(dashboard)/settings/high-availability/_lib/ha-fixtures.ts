import {
	haCheckIds,
	haInitPlan,
	summarizeHaChecks,
	type HaCheck,
	type HaCheckId,
	type HaDrillRunView,
	type HaInitAnswers,
	type HaInitPlanView,
	type HaProfile,
	type RegionsView
} from '@yoal/contracts';
import type { AttachmentMigrationResponse, CaStatusResponse } from './ha-types.js';

/**
 * Fake responses for the guided setup, in the contract's shapes. The tests use them, and so does
 * the page in development when the URL carries `?ha-fixtures` (see `ha-api.ts`), so every step can
 * be seen before the plan, preflight and drill endpoints exist on the control plane. Production
 * builds never load this module.
 */

const AT = '2026-11-21T09:00:00.000Z';

const TITLES: Readonly<Record<HaCheckId, string>> = {
	nodes: 'Enough online nodes with each role',
	'node-capabilities': 'Every involved agent supports the profile',
	zones: 'Ingress, data and control nodes span three zones',
	regions: 'The standby region has an online data node',
	clocks: 'Clocks agree within the lease skew budget',
	'overlay-links': 'Every overlay link is up',
	'arbiter-conditional-writes': 'The arbiter answers conditional writes',
	certificates: 'Every ingress holds its certificates',
	steering: 'The steering driver sees every ingress',
	backups: 'Databases have a verified off-node backup',
	headroom: 'The fleet can lose its largest zone',
	'platform-store': 'The platform object store is external',
	'registry-storage': 'Registry blobs are on the object store',
	identity: 'Identity has a capable online node',
	mail: 'The mail node is online',
	'telemetry-spool': 'Agents spool telemetry to disk',
	'flags-consistent': 'Every control-plane host runs the same flags',
	'ha-dependents': 'Nothing depends on an HA feature'
};

const pass = (id: HaCheckId, evidence: string): HaCheck => ({
	id,
	title: TITLES[id],
	status: 'pass',
	evidence: [evidence],
	fix: null,
	subject: null
});

/** Every check passing, with plausible evidence. */
export function passingChecks(profile: HaProfile): HaCheck[] {
	const evidence: Partial<Record<HaCheckId, string>> = {
		nodes: '4 online nodes: 3 ingress, 3 data, 2 control.',
		zones: 'uksouth-1, uksouth-2, uksouth-3: each holds ingress, data and control.',
		regions:
			profile === 'ha-dr' ? 'ukwest has 1 online data node (edge-d).' : 'One region: default.',
		clocks: 'Largest skew 41 ms; the budget is 500 ms.',
		'overlay-links': '6 of 6 links handshaked within 2 min.',
		'arbiter-conditional-writes':
			'If-None-Match and If-Match answered correctly (azure://lynxnet-platform).',
		backups: '2 databases: latest verified backup 3 h ago, PITR on.',
		headroom: 'Losing uksouth-2 leaves 31% CPU and 44% memory free.'
	};
	return haCheckIds
		.filter((id) => id !== 'regions' || profile === 'ha-dr')
		.map((id) => pass(id, evidence[id] ?? 'Checked.'));
}

/** The checks with the failures an install typically starts with. */
export function failingChecks(profile: HaProfile): HaCheck[] {
	return passingChecks(profile).map((check): HaCheck => {
		if (check.id === 'zones')
			return {
				...check,
				status: 'fail',
				evidence: ['edge-a and edge-b are both in uksouth-1; losing it loses both data nodes.'],
				fix: { kind: 'command', value: 'yoal nodes update edge-b --zone uksouth-2' },
				subject: { kind: 'node', id: 'node_b', name: 'edge-b' }
			};
		if (check.id === 'clocks')
			return {
				...check,
				status: 'warn',
				evidence: ['edge-c is 310 ms ahead of the control plane; the budget is 500 ms.'],
				fix: {
					kind: 'manual',
					value: 'Point edge-c at the same NTP servers as the other nodes (chronyc sources).'
				},
				subject: { kind: 'node', id: 'node_c', name: 'edge-c' }
			};
		if (check.id === 'registry-storage')
			return {
				...check,
				status: 'fail',
				evidence: ['Registry blobs are on edge-a’s disk.'],
				fix: { kind: 'setting', value: 'Settings → Registry → Storage: platform object store' }
			};
		if (check.id === 'mail')
			return {
				...check,
				status: 'fail',
				evidence: ['The mail node edge-c is offline.'],
				fix: {
					kind: 'setting',
					value: 'Settings → High availability → Mail: move it to an online node'
				}
			};
		return check;
	});
}

/** A plan view as `POST /api/v1/ha/init` returns it. */
export function planView(
	profile: HaProfile,
	options: {
		answers?: HaInitAnswers;
		checks?: HaCheck[];
		flagsSet?: boolean;
		currentProfile?: HaProfile;
	} = {}
): HaInitPlanView {
	const plan = haInitPlan(profile, options.answers ?? {}, {
		otherRegions: ['ukwest'],
		settings: { 'steering.driver': 'direct', 'failover.enabled': false },
		applied:
			profile === 'single' && options.currentProfile !== 'single'
				? {
						profile: 'ha',
						flags: [
							'ENDPOINTS_GATEWAY',
							'RELEASE_PHASE',
							'INGRESS_SET',
							'SHARED_CERTIFICATES',
							'STEERING',
							'CONTROL_STANDBY',
							'SYNC_REPLICA',
							'PITR_REWIND',
							'DB_AUTO_PROMOTE'
						],
						settings: [
							{ path: 'steering.driver', previous: 'direct' },
							{ path: 'failover.enabled', previous: false },
							{ path: 'replicas.spread', previous: 'node' }
						]
					}
				: null
	});
	const checks =
		options.checks ??
		(profile === 'single'
			? [
					{
						id: 'ha-dependents' as const,
						title: TITLES['ha-dependents'],
						status: 'pass' as const,
						evidence: [
							'No sync or armed database, gateway attachment, control standby, region or steering driver.'
						],
						fix: null,
						subject: null
					}
				]
			: passingChecks(profile));
	const summary = summarizeHaChecks(profile, checks);
	const flagsToChange = options.flagsSet === false ? plan.flags : [];
	const settingsToChange = plan.settings.filter(
		(setting) => setting.path !== 'ha.profile' || options.currentProfile !== profile
	);
	const blockers: string[] = [];
	if (flagsToChange.length)
		blockers.push('Set the flags in yoal.env and restart the control plane first.');
	if (!summary.ok) blockers.push('A required check fails.');
	if (plan.unanswered.length) blockers.push(`Answer: ${plan.unanswered.join(', ')}.`);
	return {
		plan,
		flagsToChange,
		settingsToChange,
		preflight: {
			profile,
			mode: 'preflight',
			ok: summary.ok,
			counts: summary.counts,
			checks,
			generatedAt: AT
		},
		ready: blockers.length === 0,
		blockers
	};
}

export const drillRuns: HaDrillRunView[] = [
	{
		id: 'hdr_1',
		scenario: 'stale-generation-promote',
		resource: { kind: 'database', id: 'db_main', name: 'main' },
		status: 'passed',
		startedAt: '2026-11-21T08:40:00.000Z',
		finishedAt: '2026-11-21T08:40:02.000Z',
		measured: {
			rtoMs: null,
			lostCommits: null,
			lagBytes: null,
			failedRequests: null,
			refused: true
		},
		bound: { rtoSeconds: null, rpo: null },
		recordId: 'hdr_1',
		message: null
	},
	{
		id: 'hdr_2',
		scenario: 'database-failover',
		resource: { kind: 'database', id: 'db_main', name: 'main' },
		status: 'passed',
		startedAt: '2026-11-21T08:20:00.000Z',
		finishedAt: '2026-11-21T08:20:31.000Z',
		measured: {
			rtoMs: 18_400,
			lostCommits: 0,
			lagBytes: null,
			failedRequests: null,
			refused: null
		},
		bound: { rtoSeconds: 30, rpo: 'zero' },
		recordId: 'dfd_9',
		message: null
	},
	{
		id: 'hdr_3',
		scenario: 'ingress-offline',
		resource: { kind: 'ingress-node', id: 'node_b', name: 'edge-b' },
		status: 'failed',
		startedAt: '2026-11-20T16:05:00.000Z',
		finishedAt: '2026-11-20T16:10:00.000Z',
		measured: {
			rtoMs: 22_000,
			lostCommits: null,
			lagBytes: null,
			failedRequests: 3,
			refused: null
		},
		bound: { rtoSeconds: 15, rpo: null },
		recordId: 'hdr_3',
		message:
			'edge-b left rotation after 22 s; the bound is 15 s. Check the balancer probe interval.'
	}
];

export const caStatus: CaStatusResponse = {
	inUse: true,
	authorities: [
		{
			fingerprint: 'a3f1c0de9b8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a392817060000',
			subject: 'CN=Yoal install CA',
			notBefore: '2026-11-01T00:00:00.000Z',
			notAfter: '2036-11-01T00:00:00.000Z',
			state: 'active',
			createdAt: '2026-11-01T00:00:00.000Z'
		},
		{
			fingerprint: '0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c',
			subject: 'CN=Yoal install CA',
			notBefore: '2026-01-01T00:00:00.000Z',
			notAfter: '2036-01-01T00:00:00.000Z',
			state: 'previous',
			createdAt: '2026-01-01T00:00:00.000Z'
		}
	],
	leaves: {
		issued: 6,
		live: 4,
		nodes: 4,
		revoked: 2,
		renewDue: 0,
		onPreviousCa: 1,
		nextExpiry: '2027-01-30T00:00:00.000Z'
	}
};

export const migrationPlan: AttachmentMigrationResponse = {
	apply: false,
	gateway: true,
	alreadyMoved: 3,
	projects: [
		{
			projectId: 'prj_1',
			slug: 'shop',
			runtime: 'container',
			nodes: ['edge-a', 'edge-b'],
			databases: ['main'],
			status: 'will-move',
			reason: 'Moves to its stable endpoint; the app restarts once.'
		},
		{
			projectId: 'prj_2',
			slug: 'blog',
			runtime: 'process',
			nodes: ['edge-c'],
			databases: ['blog-db'],
			status: 'blocked',
			reason: 'Cannot move: edge-c runs an agent without the endpoints gateway.'
		}
	]
};

export const regions: RegionsView = {
	enabled: true,
	regions: [
		{
			name: 'uksouth',
			zones: ['uksouth-1', 'uksouth-2', 'uksouth-3'],
			nodes: [
				{
					id: 'node_a',
					name: 'edge-a',
					zone: 'uksouth-1',
					online: true,
					roles: ['ingress', 'data', 'control']
				},
				{
					id: 'node_b',
					name: 'edge-b',
					zone: 'uksouth-2',
					online: true,
					roles: ['ingress', 'data', 'control']
				},
				{
					id: 'node_c',
					name: 'edge-c',
					zone: 'uksouth-3',
					online: true,
					roles: ['ingress', 'data']
				}
			],
			primary: true,
			databases: { primaries: 2, standbys: 0 }
		},
		{
			name: 'ukwest',
			zones: ['ukwest-1'],
			nodes: [
				{ id: 'node_d', name: 'edge-d', zone: 'ukwest-1', online: true, roles: ['data', 'control'] }
			],
			primary: false,
			databases: { primaries: 0, standbys: 2 }
		}
	],
	conflicts: [],
	active: null,
	recent: [],
	notes: []
};
