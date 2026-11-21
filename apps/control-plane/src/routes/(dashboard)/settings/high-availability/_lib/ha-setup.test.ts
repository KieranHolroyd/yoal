import { describe, expect, test } from 'bun:test';
import { HA_DRILL_CATALOGUE, haDrillScenario, type HaCheck } from '@yoal/contracts';
import { caStatus, failingChecks, migrationPlan, passingChecks, planView } from './ha-fixtures.js';
import {
	CA_ROTATE_CONFIRM,
	MIGRATE_CONFIRM,
	applyGate,
	caRotateGate,
	changedAnswers,
	checkRowKey,
	databaseFailoverState,
	drillConfirmValue,
	drillGate,
	formatRpo,
	groupChecks,
	migrationApplyProjects,
	migrationGate,
	setupSteps,
	type DatabaseFailoverFacts
} from './ha-setup.js';

const admin = { canApply: true };

describe('apply gate', () => {
	test('enabled once every required check passes and the flags match', () => {
		const gate = applyGate(planView('ha'), admin);
		expect(gate).toEqual({ enabled: true, reasons: [] });
	});

	test('disabled while a required check fails, naming the check', () => {
		const gate = applyGate(planView('ha', { checks: failingChecks('ha') }), admin);
		expect(gate.enabled).toBe(false);
		expect(gate.reasons.join(' ')).toContain('zones');
		expect(gate.reasons.join(' ')).toContain('registry-storage');
	});

	test('disabled when one required check fails among passes', () => {
		for (const id of ['flags-consistent', 'clocks', 'backups', 'steering'] as const) {
			const checks = passingChecks('ha').map((check): HaCheck =>
				check.id === id
					? { ...check, status: 'fail', fix: { kind: 'manual', value: 'Fix it.' } }
					: check
			);
			expect(applyGate(planView('ha', { checks }), admin).enabled).toBe(false);
		}
	});

	test('a required check that is skipped or missing blocks too: not run is not a pass', () => {
		const skipped = passingChecks('ha').map((check): HaCheck =>
			check.id === 'headroom' ? { ...check, status: 'skip', evidence: ['Not built yet.'] } : check
		);
		expect(applyGate(planView('ha', { checks: skipped }), admin).enabled).toBe(false);
		const missing = passingChecks('ha').filter(
			(check) => check.id !== 'arbiter-conditional-writes'
		);
		const gate = applyGate(planView('ha', { checks: missing }), admin);
		expect(gate.enabled).toBe(false);
		expect(gate.reasons.join(' ')).toContain('arbiter-conditional-writes');
	});

	test('a warning does not block, and a failure outside the required set does not either', () => {
		const checks = failingChecks('ha').map((check): HaCheck =>
			check.id === 'zones' || check.id === 'registry-storage'
				? { ...check, status: 'pass', fix: null }
				: check
		);
		// clocks warns; mail (not required for `ha`) fails.
		expect(checks.find((check) => check.id === 'mail')?.status).toBe('fail');
		expect(applyGate(planView('ha', { checks }), admin).enabled).toBe(true);
	});

	test('disabled while a flag still differs from the plan', () => {
		const gate = applyGate(planView('ha', { flagsSet: false }), admin);
		expect(gate.enabled).toBe(false);
		expect(gate.reasons.join(' ')).toContain('yoal.env');
	});

	test('disabled with no plan, a stale plan, during apply, or for a non-admin', () => {
		expect(applyGate(undefined, admin).enabled).toBe(false);
		expect(applyGate(planView('ha'), { canApply: true, stale: true }).enabled).toBe(false);
		expect(applyGate(planView('ha'), { canApply: true, applying: true }).enabled).toBe(false);
		const operator = applyGate(planView('ha'), { canApply: false });
		expect(operator.enabled).toBe(false);
		expect(operator.reasons[0]).toContain('platform admin');
	});

	test('ha-dr without a standby region answer is refused until answered', () => {
		const view = planView('ha-dr');
		// One other region, so the question has a default and is answered.
		expect(view.plan.unanswered).toEqual([]);
		const unanswered = { ...view, plan: { ...view.plan, unanswered: ['standbyRegion' as const] } };
		expect(applyGate(unanswered, admin).reasons).toContain('Answer the standbyRegion question.');
	});

	test('the server saying not ready blocks even when the page sees nothing wrong', () => {
		const view = { ...planView('ha'), ready: false, blockers: ['Another apply is in progress.'] };
		expect(applyGate(view, admin)).toEqual({
			enabled: false,
			reasons: ['Another apply is in progress.']
		});
	});
});

describe('undo', () => {
	test('returning to single plans the flags off and the recorded settings back', () => {
		const view = planView('single', { currentProfile: 'ha' });
		expect(view.plan.flags.every((flag) => flag.value === false)).toBe(true);
		expect(view.plan.settings.map((setting) => setting.path)).toContain('steering.driver');
		expect(applyGate(view, admin).enabled).toBe(true);
	});

	test('single is refused while something depends on an HA feature', () => {
		const checks: HaCheck[] = [
			{
				id: 'ha-dependents',
				title: 'A database is synchronous',
				status: 'fail',
				evidence: ['main still depends on an HA feature.'],
				fix: { kind: 'command', value: 'yoal db durability main --async' },
				subject: { kind: 'database', id: 'db_main', name: 'main' }
			}
		];
		const gate = applyGate(planView('single', { currentProfile: 'ha', checks }), admin);
		expect(gate.enabled).toBe(false);
		expect(gate.reasons.join(' ')).toContain('ha-dependents');
	});
});

describe('checks', () => {
	test('grouped by area in contract order, every required check marked', () => {
		const groups = groupChecks('ha', failingChecks('ha'));
		expect(groups[0]!.area).toBe('nodes');
		const zones = groups.flatMap((group) => group.rows).find((row) => row.check.id === 'zones')!;
		expect(zones).toMatchObject({ required: true, blocks: true });
		expect(zones.check.fix).toEqual({
			kind: 'command',
			value: 'yoal nodes update edge-b --zone uksouth-2'
		});
		const mail = groups.flatMap((group) => group.rows).find((row) => row.check.id === 'mail')!;
		expect(mail).toMatchObject({ required: false, blocks: false });
	});

	test('a required check that never reported is shown as not checked, blocking', () => {
		const rows = groupChecks('ha', []).flatMap((group) => group.rows);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((row) => row.check.status === 'skip' && row.blocks)).toBe(true);
	});

	test('platform-level findings are listed beside the per-node ones, repeats included', () => {
		// As lane B's preflight reports them: W12 findings have no subject, and one id can repeat.
		const platform = (id: HaCheck['id'], title: string, status: HaCheck['status']): HaCheck => ({
			id,
			title,
			status,
			evidence: [`${title}.`],
			fix: status === 'pass' ? null : { kind: 'setting', value: 'Settings → Registry → Storage' },
			subject: null
		});
		const checks: HaCheck[] = [
			...failingChecks('ha').filter(
				(check) => check.id !== 'platform-store' && check.id !== 'registry-storage'
			),
			platform('platform-store', 'The platform object store is the control host’s disk', 'fail'),
			platform('platform-store', 'Release artifacts are on the control host', 'warn'),
			platform('registry-storage', 'Registry blobs are on one node', 'fail'),
			{
				id: 'clocks',
				title: 'Clock skew',
				status: 'warn',
				evidence: ['edge-d is 3 s ahead.'],
				fix: { kind: 'manual', value: 'timedatectl set-ntp true' },
				subject: { kind: 'node', id: 'node_d', name: 'edge-d' }
			}
		];
		const groups = groupChecks('ha', checks);
		const rows = groups.flatMap((group) => group.rows);
		// Nothing is dropped: every reported entry is a row.
		expect(rows).toHaveLength(checks.length);
		const platformRows = groups.find((group) => group.area === 'platform')!.rows;
		expect(platformRows.filter((row) => row.check.id === 'platform-store')).toHaveLength(2);
		expect(
			platformRows.filter((row) => row.check.subject === null).map((row) => row.check.id)
		).toEqual(expect.arrayContaining(['platform-store', 'registry-storage', 'identity', 'mail']));
		expect(platformRows.find((row) => row.check.id === 'registry-storage')).toMatchObject({
			required: true,
			blocks: true
		});
		const clocks = groups.find((group) => group.area === 'time')!.rows;
		expect(clocks.map((row) => row.check.subject?.name)).toEqual(['edge-c', 'edge-d']);
		// Each row has its own key, so the list renders every one of them.
		const keys = groups.flatMap((group) => group.rows.map((row, index) => checkRowKey(row, index)));
		expect(new Set(keys).size).toBe(keys.length);
		expect(applyGate(planView('ha', { checks }), admin).reasons.join(' ')).toContain(
			'platform-store'
		);
	});

	test('on the way back to single, a steering entry the server excuses does not block', () => {
		const steering: HaCheck = {
			id: 'ha-dependents',
			title: 'A steering driver is in use',
			status: 'fail',
			evidence: ['external-lb still depends on an HA feature; turning the flags off would strand it.'],
			fix: { kind: 'setting', value: 'cluster_config steering.driver = direct' },
			subject: { kind: 'platform', id: 'external-lb', name: 'external-lb' }
		};
		const view = planView('single', { currentProfile: 'ha', checks: [steering] });
		// The server puts steering back to direct in the same write, so it names no blocker for it.
		const excused = { ...view, ready: true, blockers: [] };
		const row = groupChecks('single', [steering], excused.blockers)[0]!.rows[0]!;
		expect(row).toMatchObject({ blocks: false, clearedByApply: true });
		expect(applyGate(excused, admin).enabled).toBe(true);
		// A driver that wrote at a provider is named among the blockers: then it blocks.
		const named = {
			...view,
			ready: false,
			blockers: [`${steering.title}: Set steering to direct, then withdraw what vip put at the provider by hand.`]
		};
		expect(groupChecks('single', [steering], named.blockers)[0]!.rows[0]).toMatchObject({
			blocks: true,
			clearedByApply: false
		});
		expect(applyGate(named, admin).enabled).toBe(false);
		// Without the server's blockers, nothing is excused.
		expect(groupChecks('single', [steering])[0]!.rows[0]!.blocks).toBe(true);
	});
});

describe('steps and answers', () => {
	test('the stepper starts at the profile and reaches apply only when the gate opens', () => {
		const empty = setupSteps({
			chosen: null,
			view: undefined,
			gate: { enabled: false, reasons: [] }
		});
		expect(empty[0]).toEqual({ id: 'profile', state: 'current' });
		const failing = planView('ha', { checks: failingChecks('ha') });
		const blocked = setupSteps({ chosen: 'ha', view: failing, gate: applyGate(failing, admin) });
		expect(blocked.find((step) => step.id === 'checks')!.state).toBe('blocked');
		expect(blocked.find((step) => step.id === 'apply')!.state).toBe('todo');
		const ready = planView('ha');
		const steps = setupSteps({ chosen: 'ha', view: ready, gate: applyGate(ready, admin) });
		expect(steps.find((step) => step.id === 'apply')!.state).toBe('current');
	});

	test('only answers that differ from the default are sent', () => {
		const view = planView('ha');
		expect(changedAnswers(view, { steering: 'external-lb', certificates: 'per-node' })).toEqual({
			certificates: 'per-node'
		});
	});
});

describe('drills', () => {
	const flags = {
		INGRESS_SET: true,
		STEERING: true,
		SYNC_REPLICA: true,
		RELEASE_PHASE: true,
		REGIONS: true,
		CONTROL_STANDBY: true
	};
	const base = { resource: '', typed: '', confirmed: false, flags, canRun: true };

	test('a destructive scenario needs the resource name typed back exactly', () => {
		const scenario = haDrillScenario('ingress-offline');
		expect(scenario.destructive).toBe(true);
		expect(drillGate(scenario, { ...base, resource: 'edge-b' }).enabled).toBe(false);
		expect(drillGate(scenario, { ...base, resource: 'edge-b', typed: 'edge-' }).enabled).toBe(
			false
		);
		expect(drillGate(scenario, { ...base, resource: 'edge-b', typed: 'EDGE-B' }).enabled).toBe(
			false
		);
		expect(drillGate(scenario, { ...base, resource: 'edge-b', typed: 'edge-b' })).toEqual({
			enabled: true,
			reason: null
		});
		expect(drillConfirmValue(scenario, 'edge-b', false)).toBe('edge-b');
	});

	test('every typed scenario in the catalogue refuses an empty confirmation', () => {
		for (const scenario of HA_DRILL_CATALOGUE.filter(
			(entry) => entry.confirmation === 'typed' && entry.availability === 'fleet'
		)) {
			const gate = drillGate(scenario, { ...base, resource: 'shop', typed: '' });
			expect(gate.enabled).toBe(false);
			expect(gate.reason).toContain('type the name');
		}
	});

	test('a drill always names its resource', () => {
		const gate = drillGate(haDrillScenario('stale-generation-promote'), base);
		expect(gate.enabled).toBe(false);
		expect(gate.reason).toContain('Name the resource');
	});

	test('a safe scenario runs once the resource is named', () => {
		expect(
			drillGate(haDrillScenario('stale-generation-promote'), { ...base, resource: 'main' }).enabled
		).toBe(true);
	});

	test('the database failover drill needs the box ticked and a disposable copy', () => {
		const scenario = haDrillScenario('database-failover');
		expect(drillGate(scenario, { ...base, resource: 'main', confirmed: true }).reason).toContain(
			'disposable copy'
		);
		expect(
			drillGate(scenario, { ...base, resource: 'main', drillDatabase: 'main-drill' }).enabled
		).toBe(false);
		expect(
			drillGate(scenario, {
				...base,
				resource: 'main',
				drillDatabase: 'main-drill',
				confirmed: true
			}).enabled
		).toBe(true);
		expect(drillConfirmValue(scenario, '', true)).toBe(true);
	});

	test('lab-only scenarios never run here, and a missing flag is named', () => {
		const lab = drillGate(haDrillScenario('region-failover'), {
			...base,
			resource: 'ukwest',
			typed: 'ukwest'
		});
		expect(lab.enabled).toBe(false);
		expect(lab.reason).toContain('lab only');
		const kill = drillGate(haDrillScenario('postgres-kill'), {
			...base,
			resource: 'main',
			typed: 'main'
		});
		expect(kill.reason).toBe(
			'Runs in the lab only. Needs a fault verb, which a release build does not have.'
		);
		const flagless = drillGate(haDrillScenario('ingress-offline'), {
			...base,
			flags: {},
			resource: 'edge-b',
			typed: 'edge-b'
		});
		expect(flagless.reason).toContain('YOAL_FEATURE_INGRESS_SET=1');
	});

	test('an operator who is not an admin cannot run any drill', () => {
		expect(
			drillGate(haDrillScenario('stale-generation-promote'), {
				...base,
				resource: 'main',
				canRun: false
			}).enabled
		).toBe(false);
	});

	test('RPO reads as lost commits, then lag', () => {
		expect(formatRpo({ lostCommits: 0, lagBytes: null })).toBe('0 lost commits');
		expect(formatRpo({ lostCommits: null, lagBytes: 2048 })).toBe('2,048 bytes behind');
		expect(formatRpo({ lostCommits: null, lagBytes: null })).toBe('—');
	});
});

describe('database failover state', () => {
	const reportOnly: DatabaseFailoverFacts = {
		autoPromoteFlag: true,
		controllerEnabled: true,
		handlerInstalled: false,
		selfFencing: {
			active: false,
			reason:
				'The deployment has not asserted YOAL_DB_MEMBER_SELF_FENCING=1 after the lab proved node-side fencing.'
		}
	};

	test('report-only automatic failover reads "Not available yet" with the reason, never on', () => {
		const state = databaseFailoverState(reportOnly);
		expect(state.label).toBe('Not available yet');
		expect(state.reason).toContain('YOAL_DB_MEMBER_SELF_FENCING');
		expect(state.reason).toContain('a person promotes');
		// Even a database the status calls automatic is not shown as on while fencing is missing.
		expect(databaseFailoverState(reportOnly, { automatic: true }).label).toBe('Not available yet');
	});

	test('self-fencing without the installed path is still not available', () => {
		expect(
			databaseFailoverState({ ...reportOnly, selfFencing: { active: true, reason: '' } }).label
		).toBe('Not available yet');
	});

	test('flag off reads manual; automatic needs every fact', () => {
		expect(databaseFailoverState({ ...reportOnly, autoPromoteFlag: false }).label).toBe('Manual');
		const live = {
			...reportOnly,
			handlerInstalled: true,
			selfFencing: { active: true, reason: '' }
		};
		expect(databaseFailoverState(live, { automatic: true }).label).toBe('Automatic');
		expect(databaseFailoverState(live, { automatic: false }).label).toBe('Manual');
		expect(databaseFailoverState({ ...live, controllerEnabled: false }).label).toBe('Manual');
	});
});

describe('admin actions', () => {
	const ca = { inUse: true, authorities: caStatus.authorities.length, onPreviousCa: 0 };

	test('an operator without admin sees no rotate or apply control', () => {
		expect(caRotateGate(ca, { isAdmin: false, typed: CA_ROTATE_CONFIRM })).toEqual({
			visible: false,
			enabled: false,
			reason: null
		});
		expect(migrationGate(migrationPlan, { isAdmin: false, typed: MIGRATE_CONFIRM })).toEqual({
			visible: false,
			enabled: false,
			reason: null
		});
	});

	test('rotation is off while any node is on the previous CA, and says why', () => {
		const gate = caRotateGate(
			{ ...ca, onPreviousCa: caStatus.leaves.onPreviousCa },
			{ isAdmin: true, typed: CA_ROTATE_CONFIRM }
		);
		expect(gate.enabled).toBe(false);
		expect(gate.reason).toContain('1 node still holds a certificate from the previous CA');
	});

	test('rotation needs the confirmation word typed', () => {
		expect(caRotateGate(ca, { isAdmin: true, typed: '' }).enabled).toBe(false);
		expect(caRotateGate(ca, { isAdmin: true, typed: 'Rotate it' }).enabled).toBe(false);
		expect(caRotateGate(ca, { isAdmin: true, typed: CA_ROTATE_CONFIRM }).enabled).toBe(true);
		expect(
			caRotateGate({ ...ca, inUse: false }, { isAdmin: true, typed: CA_ROTATE_CONFIRM }).enabled
		).toBe(false);
	});

	test('apply moves the will-move apps of the confirmed dry run, never everything', () => {
		expect(migrationApplyProjects(migrationPlan)).toEqual(['shop']);
		expect(migrationApplyProjects(undefined)).toEqual([]);
		expect(
			migrationApplyProjects({
				projects: [
					{ slug: 'b', status: 'will-move' },
					{ slug: 'a', status: 'blocked' },
					{ slug: 'c', status: 'moved' },
					{ slug: 'd', status: 'will-move' }
				]
			})
		).toEqual(['b', 'd']);
	});

	test('migration applies only with apps to move and the word typed', () => {
		expect(migrationGate(migrationPlan, { isAdmin: true, typed: '' }).enabled).toBe(false);
		expect(migrationGate(migrationPlan, { isAdmin: true, typed: MIGRATE_CONFIRM }).enabled).toBe(
			true
		);
		const none = {
			...migrationPlan,
			projects: migrationPlan.projects.filter((item) => item.status !== 'will-move')
		};
		expect(migrationGate(none, { isAdmin: true, typed: MIGRATE_CONFIRM })).toMatchObject({
			enabled: false,
			reason: 'No app can move now.'
		});
		expect(
			migrationGate({ ...migrationPlan, gateway: false }, { isAdmin: true, typed: MIGRATE_CONFIRM })
				.enabled
		).toBe(false);
	});
});
