#!/usr/bin/env bun
/**
 * Scenario: the W5 exit (HA-PLAN §4 W5, H25; M1 "a deploy with a release command drops no request").
 *
 *   A. contract probe: does the workload API keep `release: { command, timeoutSeconds }` and
 *      `readinessPath` (H25)? Without them (`RELEASE_PHASE` not built) B still runs; C and D skip.
 *   B. rolling deploy under load: the checker app (process, Postgres on lab-ctl) in three copies on
 *      lab-a, lab-b and lab-c; the checker at --rate (default 167/s: 10,000 requests a minute)
 *      through --target; at +--deploy-after-s a new release is deployed. Judged: zero non-2xx
 *      (edge target; a direct run records them), and the rollout reaching every copy.
 *   C. a release whose release command fails: every copy stays on the old release, none restarts.
 *   D. a release command under a partition (I16): the release command sleeps; the node it runs on is
 *      partitioned meanwhile; the release must start exactly once (the app's singletons for
 *      `release:<marker>`, merged with the checker's I16).
 *
 * The release command is tests/ha/scenarios/fixtures/release-command.ts, shipped into each release
 * directory with a marker file naming the release, so the scenario knows which singleton job to count.
 *
 *   bun tests/ha/scenarios/rolling-deploy-under-load.ts [--target edge|direct] [--rate 167]
 *       [--duration-s 180] [--deploy-after-s 30] [--seed 1] [--project ha-rolling] [--only B,C,D]
 *       [--out <dir>] [--accept …]
 */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTROL, LAB, containerName } from '../../lab/lab.config.ts';
import { exec } from '../../lab/lib/docker.ts';
import { api, fleetNodes } from '../../lab/lib/api.ts';
import { CHECKER_APP_DIR, appHost, appPort, copies, deployChecker, deployDirectory, describeCopies, ensureProject, scaling, unitInfo, workload, workloadSpec, type Copy, type UnitInfo } from './lib/app.ts';
import { startChecker } from './lib/checker.ts';
import { Faults } from './lib/faults.ts';
import { EDGE_BYPASSED_NOTE, formatShare, openTarget, parseTarget, shareUntil, type Target } from './lib/ingress.ts';
import { readCheckerReport } from './lib/report.ts';
import { COMMON_OPTIONS, Scenario, positiveInt, waitFor } from './lib/scenario.ts';

const { values: flags } = parseArgs({
	options: {
		...COMMON_OPTIONS,
		target: { type: 'string', default: 'edge' },
		rate: { type: 'string', default: '167' },
		'duration-s': { type: 'string', default: '180' },
		'deploy-after-s': { type: 'string', default: '30' },
		samples: { type: 'string', default: '45' },
		only: { type: 'string', default: 'B,C,D' },
	},
});

const COPY_NODES = ['lab-a', 'lab-b', 'lab-c'];
const DB_NODE = 'lab-ctl';
const project = flags.project ?? 'ha-rolling';
const parts = new Set(flags.only!.split(',').map((part) => part.trim().toUpperCase()));
const scenario = new Scenario('rolling-deploy-under-load', { ...flags, project, copyNodes: COPY_NODES, dbNode: DB_NODE }, flags);
const RELEASE_COMMAND = ['bun', 'release-command.ts'];
const FIXTURE = readFileSync(join(import.meta.dir, 'fixtures/release-command.ts'), 'utf8');

/** A release directory on lab-a: the checker app, the release-command fixture and a unique marker. */
function stageRelease(marker: string, options: { fail?: boolean; sleepS?: number } = {}): string {
	const dir = `/tmp/yoal-lab-releases/${marker}`;
	const box = containerName(CONTROL.name);
	exec(box, ['rm', '-rf', dir]);
	exec(box, ['mkdir', '-p', '/tmp/yoal-lab-releases']);
	exec(box, ['cp', '-r', CHECKER_APP_DIR, dir]);
	exec(box, ['tee', `${dir}/release-command.ts`], { stdin: FIXTURE });
	exec(box, ['tee', `${dir}/release-marker.txt`], { stdin: `${marker}\n` });
	if (options.fail) exec(box, ['tee', `${dir}/release-fail`], { stdin: '1\n' });
	if (options.sleepS) exec(box, ['tee', `${dir}/release-sleep-s`], { stdin: `${options.sleepS}\n` });
	return dir;
}

async function releaseStarts(target: Target, marker: string): Promise<number | null> {
	try {
		const response = await fetch(`${target.base}/singletons?job=${encodeURIComponent(`release:${marker}`)}`, { headers: { host: target.host }, signal: AbortSignal.timeout(5000) });
		if (!response.ok) return null;
		const body = (await response.json()) as unknown;
		const rows = Array.isArray(body) ? body : ((body as { singletons?: unknown[]; runs?: unknown[] }).singletons ?? (body as { runs?: unknown[] }).runs ?? []);
		return rows.length;
	} catch {
		return null;
	}
}

/** Copies keyed by id → the deployment each copy runs, read from the node (unit invocation). */
function snapshot(list: Copy[]): Map<string, UnitInfo> {
	return new Map(list.map((copy) => [copy.id, unitInfo(copy)]));
}

await scenario.run(async (s) => {
	const target = parseTarget(flags.target);
	const durationS = positiveInt('--duration-s', flags['duration-s']);
	const deployAfterS = positiveInt('--deploy-after-s', flags['deploy-after-s']);
	const samples = positiveInt('--samples', flags.samples);
	const rate = Number(flags.rate);
	if (!(rate > 0)) s.stop('error', '--rate must be positive');
	if (target === 'direct') s.notice(EDGE_BYPASSED_NOTE);
	s.measure('requestsPerMinute', Math.round(rate * 60));

	s.say('preflight');
	const fleet = await waitFor('every lab node online', 180_000, () => {
		const rows = fleetNodes();
		return LAB.nodes.every((node) => rows.find((row) => row.name === node.name)?.status === 'online') ? rows : null;
	}).catch((error: Error) => s.stop('error', `${error.message}: run \`bun tests/lab/lab.ts up\` first`));

	// --- A. does the platform keep the H25 fields? (before placing: a workload PUT replaces the
	// whole spec, `replicas` included, so after placement it would scale the app back to one copy)
	s.say('A. probing the workload API for release.command and readinessPath (H25, RELEASE_PHASE)');
	s.note(`project ${project}: ${await ensureProject(project, 'process')}`);
	const host = await appHost(project);
	const appEnv = { CHECKER_URL: `http://${CONTROL.ip}`, CHECKER_HOST: host };
	const extra = { release: { command: RELEASE_COMMAND, timeoutSeconds: 120 }, readinessPath: '/healthz?db=1' };
	const probe = await api('PUT', `/api/v1/projects/${project}/workload`, { ...workloadSpec({ runtime: 'process', port: appPort(project), env: appEnv }), ...extra }, { allowStatus: [400, 422] }).catch((error: Error) => ({ status: 0, body: error.message }));
	const readBack = await workload(project);
	const spec = readBack?.spec ?? readBack?.workload?.spec ?? readBack ?? {};
	const keepsRelease = probe.status === 200 && Array.isArray(spec?.release?.command);
	const keepsReadiness = probe.status === 200 && typeof spec?.readinessPath === 'string';
	const releasePhase = keepsRelease && keepsReadiness;
	s.measure('releasePhaseContract', { putStatus: probe.status, keepsRelease, keepsReadiness, refusal: probe.status === 200 ? null : JSON.stringify(probe.body).slice(0, 300) });
	const missing = `RELEASE_PHASE (W5, HA-PLAN H25) is not built: the workload API ${probe.status === 200 ? `accepted the spec but did not keep ${[keepsRelease ? null : '`release`', keepsReadiness ? null : '`readinessPath`'].filter(Boolean).join(' or ')}` : `refused it (${probe.status})`}`;
	s.note(releasePhase ? 'release phase present' : missing);

	s.say(`deploying ${project}: copies on ${COPY_NODES.join(', ')}, Postgres on ${DB_NODE}`);
	const deployed = await deployChecker(s, { project, runtime: 'process', nodes: COPY_NODES, dbNode: DB_NODE, message: 'rolling-deploy-under-load', env: appEnv, extra: releasePhase ? extra : undefined });

	const route = await openTarget(target, host, fleet, deployed.copies.map((copy) => copy.nodeName));
	s.onCleanup('close target', () => route.stop());
	s.note(route.describe());
	const shareBefore = await shareUntil(route.base, host, samples, COPY_NODES);
	s.measure('shareBefore', formatShare(shareBefore));
	const silent = COPY_NODES.filter((node) => !shareBefore[node]);
	if (silent.length) {
		s.check('traffic', 'invalid', `copies on ${silent.join(', ')} took no traffic`, { share: shareBefore });
		s.stop(
			'invalid',
			target === 'edge'
				? `copies on ${silent.join(', ')} took no traffic through the edge (on a tree without F7 from ha/w1-fixes the edge's active health check sends no app Host, packages/site-config/src/compile.ts, and marks remote copies unhealthy), so a rolling deploy cannot be judged. Run --target direct.`
				: `copies on ${silent.join(', ')} did not answer direct requests`,
		);
	}
	s.check('traffic', 'pass', null, { share: shareBefore });

	// --- B. rolling deploy under load -------------------------------------------------------------
	if (parts.has('B')) {
		s.say(`B. checker ${durationS} s at ${rate}/s; deploy a new release at +${deployAfterS} s`);
		const checker = startChecker(s, route, { durationS, rate, seed: Number(flags.seed), cli: flags.checker });
		await Promise.race([Bun.sleep(deployAfterS * 1000), checker.exited]);
		if (!checker.running()) s.stop('error', 'the checker exited before the deploy');
		const marker = `b-${Date.now().toString(36)}`;
		const dir = stageRelease(marker);
		s.setZero();
		s.event('deploy', { marker });
		const deployLine = deployDirectory(project, dir, `rolling ${marker}`);
		s.note(deployLine);
		let sawRollout = false;
		let done = false;
		while (checker.running()) {
			try {
				const view = await scaling(project);
				if (view.rollout && !sawRollout) {
					sawRollout = true;
					s.timing('rolloutStarted');
					s.event('rollout', { status: view.rollout.status, total: view.rollout.total, surge: view.rollout.surge });
				}
				if (view.rollout?.status === 'paused') s.event('rollout paused', { message: view.rollout.message });
				await route.setNodes(view.copies.filter((copy) => copy.status === 'running').map((copy) => copy.nodeName));
				if (!done && !view.rollout && view.copies.length === COPY_NODES.length && view.copies.every((copy) => copy.status === 'running' && copy.release !== 'previous') && Date.now() - s.zero > 5000) {
					done = true;
					s.timing('rolloutDone');
					s.event('rollout done', { copies: describeCopies(view.copies), lastRollback: view.lastRollback });
				}
			} catch {
				// next tick
			}
			await Promise.race([checker.exited, Bun.sleep(1000)]);
		}
		s.unobserved('rolloutStarted');
		s.unobserved('rolloutDone');
		const checkerExit = await checker.exited;
		const view = await scaling(project);
		s.measure('copiesAfterRollout', describeCopies(view.copies));
		s.measure('lastRollback', view.lastRollback);
		s.check('rollout-completed', done ? 'pass' : 'fail', done ? null : `the rollout did not reach every copy within ${durationS - deployAfterS} s (${view.rollout ? `${view.rollout.status}: ${view.rollout.message ?? ''} ${view.rollout.updated}/${view.rollout.total}` : 'no rollout in progress'})`, { doneAfterMs: s.report.timings.rolloutDone });
		const report = readCheckerReport(s.checkerReportPath);
		if (!report) s.check('checker', 'error', `no checker report (exit ${checkerExit})`);
		else {
			s.check('checker', report.failedInvariants.length ? 'fail' : 'pass', report.failedInvariants.length ? `invariants failed: ${report.failedInvariants.join(', ')}` : null, { exit: checkerExit });
			const perMinute = report.requests ? Math.round((report.requests / durationS) * 60) : null;
			s.measure('achievedRequestsPerMinute', perMinute);
			if (target === 'edge') {
				s.check('zero-non-2xx', report.failedRequests === 0 ? 'pass' : 'fail', report.failedRequests ? `${report.failedRequests} of ${report.requests} requests were not 2xx during the rolling deploy (${JSON.stringify(report.failedByStatus)})` : null, { requests: report.requests, failed: report.failedRequests, perMinute });
				if (perMinute !== null && perMinute < 10_000 * 0.95) s.check('load', 'invalid', `the checker achieved ${perMinute} requests a minute, below the 10,000 the W5 exit asks for`, { perMinute });
			} else s.measure('non2xx (not judged: harness balancer)', { failed: report.failedRequests, byStatus: report.failedByStatus });
		}
	}

	// --- C. a failing release command -------------------------------------------------------------
	if (parts.has('C')) {
		if (!releasePhase) s.check('failing-release-command', 'skip', `${missing}; nothing runs a release command, so a failing one cannot hold a rollout back`);
		else {
			s.say('C. deploying a release whose release command fails');
			const before = snapshot(await copies(project));
			const marker = `c-${Date.now().toString(36)}`;
			s.event('deploy failing release', { marker });
			yoalDeployAllowFailure(project, stageRelease(marker, { fail: true }), `failing ${marker}`, s);
			await Bun.sleep(45_000);
			const after = snapshot(await copies(project));
			const changed = [...before].filter(([id, info]) => after.get(id)?.invocationId !== info.invocationId).map(([id, info]) => `${id}@${info.node}`);
			const starts = await releaseStarts(route, marker);
			s.check('failing-release-command', changed.length ? 'fail' : 'pass', changed.length ? `copies restarted onto the failed release: ${changed.join(', ')}` : null, { restarted: changed, releaseCommandStarts: starts });
		}
	}

	// --- D. release command under a partition (I16) ------------------------------------------------
	if (parts.has('D')) {
		if (!releasePhase) s.check('release-once-under-partition', 'skip', `${missing}; no release command runs, so I16 cannot be exercised`);
		else {
			s.say('D. a release command held open while its node is partitioned');
			const marker = `d-${Date.now().toString(36)}`;
			const faults = new Faults(s);
			yoalDeployAllowFailure(project, stageRelease(marker, { sleepS: 40 }), `partitioned ${marker}`, s);
			// Which node runs it is the platform's choice; wait for its singleton to learn the node.
			const first = await waitFor('release command started', 120_000, async () => ((await releaseStarts(route, marker)) ?? 0) > 0, 1000).catch(() => false);
			let node = 'lab-b';
			try {
				const rows = (await (await fetch(`${route.base}/singletons?job=${encodeURIComponent(`release:${marker}`)}`, { headers: { host } })).json()) as any;
				node = (Array.isArray(rows) ? rows : (rows.singletons ?? []))[0]?.node ?? node;
			} catch {
				// keep lab-b
			}
			if (first) {
				const fault = await faults.apply('partition', LAB.nodes.find((item) => item.name === node)?.name ?? 'lab-b', { durationS: 90, fleet });
				await Bun.sleep(90_000);
				await fault.revert();
			}
			await Bun.sleep(30_000);
			const starts = await releaseStarts(route, marker);
			s.check('release-once-under-partition', starts === 1 ? 'pass' : 'fail', starts === 1 ? null : `release ${marker} started ${starts ?? 'an unknown number of'} times`, { starts, node });
		}
	}
});

function yoalDeployAllowFailure(project: string, dir: string, message: string, s: Scenario): void {
	try {
		s.note(deployDirectory(project, dir, message));
	} catch (error) {
		s.note(`deploy refused: ${(error as Error).message.split('\n').slice(-1)[0]}`);
	}
}
