#!/usr/bin/env bun
/**
 * Scenario: the single-node gate (HA-PLAN §4 "every workstream … carries the single-node regression
 * gate (flag off, one node, same behaviour)"; §7.3 "No phase merges without the single-node gate").
 * Every lane must pass it.
 *
 * On a one-node lab (`bun tests/lab/lab.ts up --only lab-a`: a plain install, no overlay, no cluster
 * settings):
 *
 *   0. preflight: the fleet is exactly one online node; every HA flag is off (the feature flags of
 *      HA-PLAN §9 that exist on this tree, read from the control node's environment and the
 *      defaults in packages/contracts/src/features.ts); `failover.enabled` is off
 *   1. deploy the checker app (process, Postgres on the same node)
 *   2. run the checker through the public route; during it:
 *        +--scale-after-s  scale to 2 copies (one node: the platform must refuse or leave the second
 *                          copy unplaced, without touching the first), then back to 1
 *        +--redeploy-after-s  deploy a new release; wait for it to run
 *   3. judge: every step did what a one-node install does; the checker is clean (no invariant
 *      failed); failed requests at most --max-failed (default 0)
 *
 *   bun tests/ha/scenarios/single-node-gate.ts [--duration-s 150] [--rate 20] [--seed 1]
 *       [--scale-after-s 20] [--redeploy-after-s 60] [--max-failed 0] [--project ha-single]
 *       [--allow-multi-node] [--out <dir>] [--accept …]
 *
 * `--allow-multi-node` runs the same steps on a bigger lab with every other node drained (for a
 * quick local check only: the gate's verdict is then `invalid`, never `pass`).
 */
import { parseArgs } from 'node:util';
import { FEATURE_FLAGS } from '../../../packages/contracts/src/features.ts';
import { CONTROL, containerName } from '../../lab/lab.config.ts';
import { exec } from '../../lab/lib/docker.ts';
import { api, fleetNodes, ownerAction } from '../../lab/lib/api.ts';
import { CHECKER_APP_DIR, copies, deployChecker, deployDirectory, describeCopies, scaling } from './lib/app.ts';
import { startChecker } from './lib/checker.ts';
import { openTarget, share, formatShare } from './lib/ingress.ts';
import { readCheckerReport } from './lib/report.ts';
import { COMMON_OPTIONS, Scenario, positiveInt, waitFor } from './lib/scenario.ts';

const { values: flags } = parseArgs({
	options: {
		...COMMON_OPTIONS,
		'duration-s': { type: 'string', default: '150' },
		rate: { type: 'string', default: '20' },
		'scale-after-s': { type: 'string', default: '20' },
		'redeploy-after-s': { type: 'string', default: '60' },
		'max-failed': { type: 'string', default: '0' },
		'allow-multi-node': { type: 'boolean', default: false },
	},
});

/**
 * The flags of HA-PLAN §4/§9 (one per workstream). Those not on this tree yet are listed so the gate
 * picks them up the day a lane registers them; DB_AUTO_PROMOTE is the existing opt-in (F1).
 */
const HA_FLAGS = ['INGRESS_SET', 'RELEASE_PHASE', 'CONTROL_STANDBY', 'DB_SYNC', 'DB_AUTO_FAILOVER', 'DB_AUTO_PROMOTE', 'REGIONS'];

const project = flags.project ?? 'ha-single';
const scenario = new Scenario('single-node-gate', { ...flags, project }, flags);

/** `YOAL_FEATURE_<NAME>` from the control node's environment files, if set. */
function featureOverrides(): Record<string, string> {
	const text = exec(containerName(CONTROL.name), ['sh', '-c', 'cat /etc/yoal/yoal.env /etc/yoal/agent.env 2>/dev/null || true']).stdout;
	const out: Record<string, string> = {};
	for (const match of text.matchAll(/^YOAL_FEATURE_([A-Z0-9_]+)=["']?([^"'\n]*)["']?$/gm)) out[match[1]!] = match[2]!;
	return out;
}

await scenario.run(async (s) => {
	const durationS = positiveInt('--duration-s', flags['duration-s']);
	const scaleAfterS = positiveInt('--scale-after-s', flags['scale-after-s']);
	const redeployAfterS = positiveInt('--redeploy-after-s', flags['redeploy-after-s']);
	const maxFailed = Number(flags['max-failed']);
	if (redeployAfterS + 60 > durationS) s.stop('error', '--duration-s must leave 60 s after the redeploy');

	// --- 0. one node, flags off -------------------------------------------------------------------
	s.say('preflight: one node, HA flags off');
	const fleet = await waitFor(`${CONTROL.name} online`, 180_000, () => {
		const rows = fleetNodes();
		return rows.find((row) => row.name === CONTROL.name)?.status === 'online' ? rows : null;
	}).catch((error: Error) => s.stop('error', `${error.message}: run \`bun tests/lab/lab.ts up --only ${CONTROL.name}\` first`));
	s.measure('fleet', fleet.map((node) => `${node.name}=${node.status}`));
	const singleNode = fleet.length === 1;
	if (!singleNode && !flags['allow-multi-node'])
		s.stop('invalid', `the fleet has ${fleet.length} nodes (${fleet.map((node) => node.name).join(', ')}); the gate runs on one: \`bun tests/lab/lab.ts down && bun tests/lab/lab.ts up --only ${CONTROL.name}\``);
	if (!singleNode) s.notice(`--allow-multi-node: ${fleet.length} nodes; the others are drained for the run. This is not the gate.`);
	const overrides = featureOverrides();
	const flagState = Object.fromEntries(
		HA_FLAGS.map((name) => {
			const definition = (FEATURE_FLAGS as Record<string, { default: boolean }>)[name];
			const override = overrides[name];
			const on = override !== undefined ? ['1', 'true', 'on', 'yes'].includes(override.toLowerCase()) : (definition?.default ?? false);
			return [name, definition ? (on ? 'on' : 'off') : 'not on this tree'];
		}),
	);
	const cluster = (await api<any>('GET', '/api/v1/cluster/config')).body;
	const failoverOn = Boolean((cluster?.failover ?? cluster?.config?.failover ?? {}).enabled);
	s.measure('haFlags', flagState);
	s.measure('failoverEnabled', failoverOn);
	const on = Object.entries(flagState).filter(([, state]) => state === 'on').map(([name]) => name);
	if (failoverOn) on.push('failover.enabled');
	if (on.length) s.stop('invalid', `HA settings are on (${on.join(', ')}); the gate runs with every HA flag off`);
	s.check('flags-off', 'pass', null, flagState);

	const drained: string[] = [];
	if (!singleNode) {
		const others = fleet.filter((node) => node.name !== CONTROL.name).map((node) => node.name);
		ownerAction(['--drain', others.join(',')]);
		drained.push(...others);
		s.onCleanup('resume drained nodes', () => ownerAction(['--resume', drained.join(',')]));
	}

	// --- 1. deploy ----------------------------------------------------------------------------------
	s.say(`deploying ${project} with Postgres on ${CONTROL.name}`);
	const deployed = await deployChecker(s, { project, runtime: 'process', nodes: [CONTROL.name], dbNode: CONTROL.name, message: 'single-node-gate' });
	s.check('deploy', deployed.copies.some((copy) => copy.status === 'running') ? 'pass' : 'fail', null, { copies: describeCopies(deployed.copies) });
	const route = await openTarget('edge', deployed.host, fleet, [CONTROL.name]);
	const before = await share(route.base, deployed.host, 10);
	s.measure('shareBefore', formatShare(before));
	if (!before[CONTROL.name]) s.stop('fail', `the app does not answer through the public route (${formatShare(before)})`);

	// --- 2. checker, scale, redeploy ----------------------------------------------------------------
	s.say(`checker ${durationS} s; scale 1→2→1 at +${scaleAfterS} s; redeploy at +${redeployAfterS} s`);
	const checker = startChecker(s, route, { durationS, rate: Number(flags.rate), seed: Number(flags.seed), cli: flags.checker });
	s.setZero(checker.startedAt);
	await Promise.race([Bun.sleep(scaleAfterS * 1000), checker.exited]);
	const firstCopy = (await copies(project))[0];
	const scaled = await api<any>('POST', `/api/v1/projects/${project}/scale`, { replicas: 2 }, { allowStatus: [400, 409, 422] });
	s.event('scale to 2', { status: scaled.status });
	await Bun.sleep(10_000);
	const view2 = await scaling(project);
	s.measure('scaleTo2', { status: scaled.status, answer: typeof scaled.body === 'object' ? (scaled.body?.error ?? scaled.body?.to ?? null) : String(scaled.body).slice(0, 200), copies: describeCopies(view2.copies), mode: view2.mode, blocker: view2.blocker });
	const firstStill = view2.copies.find((copy) => copy.id === firstCopy?.id);
	const placedElsewhere = view2.copies.filter((copy) => copy.id !== firstCopy?.id && copy.status === 'running');
	s.check(
		'scale-one-node',
		firstStill?.status === 'running' && firstStill.nodeName === CONTROL.name && placedElsewhere.every((copy) => copy.nodeName !== CONTROL.name) ? 'pass' : 'fail',
		firstStill?.status !== 'running' ? `scaling to 2 disturbed the first copy (${firstStill ? `${firstStill.status}@${firstStill.nodeName}` : 'gone'})` : placedElsewhere.some((copy) => copy.nodeName === CONTROL.name) ? 'a second HTTP copy started on the same node' : null,
		{ status: scaled.status, copies: describeCopies(view2.copies) },
	);
	if (scaled.status === 200) {
		await api('POST', `/api/v1/projects/${project}/scale`, { replicas: 1 });
		await waitFor(`${project} back to one copy`, 120_000, async () => (await copies(project)).length === 1);
		s.event('scale back to 1');
	}
	const wait = checker.startedAt + redeployAfterS * 1000 - Date.now();
	if (wait > 0) await Promise.race([Bun.sleep(wait), checker.exited]);
	const marker = `gate-${Date.now().toString(36)}`;
	const dir = `/tmp/yoal-lab-releases/${marker}`;
	exec(containerName(CONTROL.name), ['sh', '-c', `rm -rf ${dir} && mkdir -p /tmp/yoal-lab-releases && cp -r ${CHECKER_APP_DIR} ${dir} && echo ${marker} > ${dir}/release-marker.txt`]);
	s.event('redeploy', { marker });
	const redeployAt = Date.now();
	s.note(deployDirectory(project, dir, `single-node-gate ${marker}`));
	const deploymentsBefore = (await api<any>('GET', `/api/v1/projects/${project}/deployments?limit=1`)).body.deployments?.[0];
	const redeployed = await waitFor('the new release running', 180_000, async () => {
		const view = await scaling(project);
		return !view.rollout && view.copies.length === 1 && view.copies[0]!.status === 'running' && view.copies[0]!.release !== 'previous' ? view : null;
	}).catch(() => null);
	s.timing('redeployRunning');
	s.check('redeploy', redeployed ? 'pass' : 'fail', redeployed ? null : 'the new release was not running within 180 s', { deployment: deploymentsBefore?.id ?? null, afterMs: Date.now() - redeployAt });

	const checkerExit = await checker.exited;
	const report = readCheckerReport(s.checkerReportPath);
	if (!report) s.check('checker', 'error', `no checker report (exit ${checkerExit})`);
	else {
		s.check('checker', report.failedInvariants.length ? 'fail' : 'pass', report.failedInvariants.length ? `invariants failed: ${report.failedInvariants.join(', ')}` : null, { exit: checkerExit, lostAcknowledgedWrites: report.lostAcknowledgedWrites });
		s.check('failed-requests', (report.failedRequests ?? 0) <= maxFailed ? 'pass' : 'fail', (report.failedRequests ?? 0) <= maxFailed ? null : `${report.failedRequests} of ${report.requests} requests failed (allowed ${maxFailed}): ${JSON.stringify(report.failedByStatus)}`, { failed: report.failedRequests, byStatus: report.failedByStatus, longestWriteGapMs: report.longestWriteGapMs });
	}
	if (!singleNode) s.stop('invalid', 'ran with --allow-multi-node: not the gate');
});

