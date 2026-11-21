import { describe, expect, test } from 'bun:test';
import { doctorCommand, doctorUsage } from './commands/doctor.ts';
import { haCommand } from './commands/ha.ts';
import {
	drillTargets,
	formatCatalogue,
	formatChecks,
	formatDrillAll,
	formatDrillRun,
	formatInitApplied,
	formatInitPlan,
	type HaChecksReport,
	type HaDrillRunView,
	type HaInitPlanView,
} from './ha-checks.ts';

const report = (overrides: Partial<HaChecksReport> = {}): HaChecksReport => ({
	profile: 'ha',
	mode: 'preflight',
	ok: false,
	counts: { pass: 1, warn: 0, fail: 1, skip: 1 },
	checks: [
		{ id: 'flags-consistent', title: 'Control-plane hosts run the same flags', status: 'pass', evidence: ['1 control-plane host(s) agree.'], fix: null, subject: null },
		{
			id: 'nodes',
			title: 'Not enough nodes with the HA roles',
			status: 'fail',
			evidence: ['ingress: 1 online (needs 2).'],
			fix: { kind: 'command', value: 'yoal nodes enrol' },
			subject: null,
		},
		{ id: 'clocks', title: 'No clock reading from a2', status: 'skip', evidence: ['a2 has not sent a timed heartbeat.'], fix: null, subject: null },
	],
	generatedAt: '2026-11-21T10:00:00.000Z',
	...overrides,
});

describe('yoal ha preflight and yoal doctor output', () => {
	test('a preflight lists failures first, each with its evidence and exact fix, and passes as one line', () => {
		const text = formatChecks(report());
		const lines = text.split('\n');
		expect(lines[0]).toBe('Preflight for ha: not ready (1 ok, 0 warn, 1 fail, 1 skip)');
		expect(lines[1]).toMatch(/^FAIL {2}nodes/);
		expect(text).toContain('fix (command): yoal nodes enrol');
		expect(text).toContain('a2 has not sent a timed heartbeat.');
		expect(lines.at(-1)).toMatch(/^ok {4}flags-consistent/);
		expect(text).not.toContain('1 control-plane host(s) agree.');
	});

	test('a doctor report says healthy or needs attention', () => {
		expect(formatChecks(report({ mode: 'doctor', ok: true, profile: 'single' })).split('\n')[0]).toBe(
			'Doctor (profile single): healthy (1 ok, 0 warn, 1 fail, 1 skip)',
		);
	});
});

const plan = (overrides: Partial<HaInitPlanView> = {}): HaInitPlanView => ({
	plan: {
		profile: 'ha',
		questions: [
			{ id: 'steering', prompt: 'How does traffic reach the ingress nodes?', options: ['external-lb'], default: 'external-lb', value: 'external-lb' },
		],
		unanswered: [],
		flags: [
			{ name: 'STEERING', value: true, env: 'YOAL_FEATURE_STEERING=1' },
			{ name: 'INGRESS_SET', value: true, env: 'YOAL_FEATURE_INGRESS_SET=1' },
		],
		settings: [
			{ path: 'ha.profile', value: 'ha' },
			{ path: 'steering.driver', value: 'external-lb' },
		],
		standbyRegion: null,
		preflight: ['nodes'],
		envLines: ['YOAL_FEATURE_STEERING=1', 'YOAL_FEATURE_INGRESS_SET=1'],
		notes: [],
	},
	flagsToChange: [{ name: 'STEERING', value: true, env: 'YOAL_FEATURE_STEERING=1' }],
	settingsToChange: [{ path: 'ha.profile', value: 'ha' }],
	preflight: report(),
	ready: false,
	blockers: ['Set YOAL_FEATURE_STEERING=1 in yoal.env on every control-plane host, then restart each control plane.'],
	...overrides,
});

describe('yoal ha init output', () => {
	test('the plan shows the env lines to change, the settings, and why it is refused', () => {
		const text = formatInitPlan(plan());
		expect(text).toContain('  steering       external-lb (default)');
		expect(text).toContain('  YOAL_FEATURE_STEERING=1   ← change this, then restart');
		expect(text).toContain('  YOAL_FEATURE_INGRESS_SET=1   (running)');
		expect(text).toContain('  steering.driver = external-lb   (already set)');
		expect(text).toContain('Refused until:\n  - Set YOAL_FEATURE_STEERING=1');
		expect(text).not.toContain('Ready to apply.');
	});

	test('a ready plan says so; an applied one says how to undo it', () => {
		expect(formatInitPlan(plan({ blockers: [], ready: true, flagsToChange: [] }))).toContain('Ready to apply.');
		expect(formatInitPlan(plan({ blockers: [], ready: false, settingsToChange: [] }))).toContain('already applied');
		expect(formatInitApplied({ profile: 'ha', applied: [{ path: 'failover.enabled', value: true }], auditId: 'aud_1' })).toBe(
			'Applied the ha profile (audit aud_1):\n  failover.enabled = true\nUndo with: yoal ha init --profile single',
		);
	});
});

const run = (overrides: Partial<HaDrillRunView> = {}): HaDrillRunView => ({
	id: 'hdr_1',
	scenario: 'database-failover',
	resource: { kind: 'database', id: 'db_1', name: 'main' },
	status: 'passed',
	startedAt: '2026-11-21T10:00:00.000Z',
	finishedAt: '2026-11-21T10:00:21.000Z',
	measured: { rtoMs: 21_400, lostCommits: 0, lagBytes: null, failedRequests: null, refused: null },
	bound: { rtoSeconds: 30, rpo: 'zero' },
	recordId: 'drl_9',
	message: null,
	...overrides,
});

describe('yoal ha drill output', () => {
	test('a run shows RTO against its bound and lost commits', () => {
		const text = formatDrillRun(run());
		expect(text).toContain('Drill hdr_1: database-failover on database main: passed');
		expect(text).toContain('measured: RTO 21.4 s (bound 30 s); lost commits 0');
		expect(text).toContain('record:   drl_9');
		expect(formatDrillRun(run({ measured: { ...run().measured, rtoMs: 31_000 } }))).toContain('OVER');
		expect(formatDrillRun(run({ scenario: 'stale-generation-promote', measured: { rtoMs: null, lostCommits: null, lagBytes: null, failedRequests: null, refused: true } }))).toContain(
			'refused, as it must be',
		);
	});

	test('--all lists what ran and every skipped scenario with its reason', () => {
		const text = formatDrillAll({ runs: [run()], skipped: [{ scenario: 'node-offline', reason: 'Needs a typed confirmation.' }], passed: true });
		expect(text.split('\n')[0]).toBe('Drill --all: passed');
		expect(text).toContain('Skipped:\n  node-offline');
		expect(formatDrillAll({ runs: [], skipped: [], passed: false }).split('\n')[0]).toBe('Drill --all: nothing ran');
	});

	test('the catalogue shows where each scenario runs and how it is confirmed', () => {
		const text = formatCatalogue([
			{
				id: 'node-offline',
				family: 'node',
				title: 'One node goes dark',
				resourceKind: 'node',
				destructive: true,
				confirmation: 'typed',
				measures: ['rto'],
				availability: 'fleet',
				fleetUnavailableReason: null,
				flags: [],
				minHaLevel: null,
				bound: { rtoSeconds: null, rpo: null },
			},
		]);
		expect(text).toMatch(/node-offline\s+node\s+fleet\s+type name\s+-\s+-\s+-/);
	});

	test('--all targets come from the shorthand flags and --target', () => {
		expect(
			drillTargets({ targets: ['project:shop'], nodes: ['a1'], ingressNodes: ['a2'], databases: ['main:main-copy', 'other'], projects: [] }),
		).toEqual([
			{ kind: 'project', resource: 'shop' },
			{ kind: 'node', resource: 'a1' },
			{ kind: 'ingress-node', resource: 'a2' },
			{ kind: 'database', resource: 'main', drillDatabase: 'main-copy' },
			{ kind: 'database', resource: 'other' },
		]);
		expect(() => drillTargets({ targets: ['main'], nodes: [], ingressNodes: [], databases: [], projects: [] })).toThrow(/kind:resource/);
	});
});

describe('the ha init, preflight, drill and doctor dispatchers', () => {
	test('refuse bad input before they need a login', async () => {
		await expect(haCommand(['init'])).rejects.toThrow(/Missing --profile/);
		await expect(haCommand(['init', '--profile', 'cluster'])).rejects.toThrow(/Missing --profile/);
		await expect(haCommand(['preflight', '--profile', 'cluster'])).rejects.toThrow(/--profile must be/);
		await expect(haCommand(['drill', 'node-offline', '--resource', 'a1', '--minutes', '90'])).rejects.toThrow(/--minutes/);
		await expect(haCommand(['drill', 'node-offline', '--all'])).rejects.toThrow(/takes no scenario/);
		await expect(haCommand(['drill', '--all', '--target', 'main'])).rejects.toThrow(/kind:resource/);
		await expect(haCommand(['drill', 'runs', '--limit', '0'])).rejects.toThrow(/--limit/);
		await expect(doctorCommand(['extra'])).rejects.toThrow(/Usage: yoal doctor/);
	});

	test('doctor prints its usage', async () => {
		const original = console.log;
		const lines: string[] = [];
		console.log = (value: unknown) => lines.push(String(value));
		try {
			await doctorCommand(['--help']);
		} finally {
			console.log = original;
		}
		expect(lines.join('\n')).toBe(doctorUsage);
	});
});

describe('yoal nodes enrol', () => {
	test('validates --roles before it needs a login, and renders the join line with the roles the token allows', async () => {
		const { nodesCommand, enrolCommandLine } = await import('./commands/nodes.ts');
		await expect(nodesCommand(['enrol', '--roles', 'ingress,router'])).rejects.toThrow(/--roles/);
		await expect(nodesCommand(['enrol', 'extra'])).rejects.toThrow(/Usage: yoal nodes enrol/);
		expect(enrolCommandLine('https://control.example.com', 'node-b', ['ingress', 'compute'])).toBe(
			'curl -fsSL https://control.example.com/install/node.sh -o node.sh && sudo sh node.sh --token-file <file> --name node-b --roles ingress,compute',
		);
		expect(enrolCommandLine('https://control.example.com', null, [])).toBe(
			'curl -fsSL https://control.example.com/install/node.sh -o node.sh && sudo sh node.sh --token-file <file> --name <name>',
		);
	});
});
