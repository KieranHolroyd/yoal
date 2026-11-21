#!/usr/bin/env bun
/**
 * Scenario: the W5 exit (HA-PLAN §4 W5, H25; M1 "a deploy with a release command drops no request").
 *
 *   A. contract probe: with `RELEASE_PHASE` on (the platform's resolved flags, `GET
 *      /api/setup/status`), the workload API must keep `release: { command, timeoutSeconds }` and
 *      `readinessPath` (H25); losing either then fails. With the flag off, B still runs and C and D
 *      skip, naming the flag (`bun tests/lab/lab.ts up --feature RELEASE_PHASE=1`).
 *   B. rolling deploy under load: the checker app (process, Postgres on lab-ctl) in three copies on
 *      lab-a, lab-b and lab-c; the checker at --rate (default 167/s: 10,000 requests a minute)
 *      through --target; at +--deploy-after-s a new release is deployed. Judged: zero failed
 *      requests on either target (on `direct` they go through the harness balancer, and the reason
 *      says so), and the rollout reaching every copy.
 *   C. a release whose release command fails: every copy stays on the old release, none restarts.
 *   D. a release command under a partition (I16): the release command sleeps; the node the platform
 *      leased the run to (`release_command_runs.node_id`) is partitioned while it runs; the run must
 *      start exactly once. The partition must overlap the run (else invalid), the platform's runs
 *      become `release-command` observations, and I16 is judged over them and the app's singletons
 *      for `release:<marker>` (tests/ha/checker/invariants.ts checkI16).
 *
 * The release command is tests/ha/scenarios/fixtures/release-command.ts, shipped into each release
 * directory with a marker file naming the release, so the scenario knows which singleton job to count.
 * The platform's runs are read from the control plane's database on lab-a, read-only
 * (tests/lab/node/release-runs.ts): no REST route lists them yet.
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
import { api, fleetNodes, platformFeatures } from '../../lab/lib/api.ts';
import { CHECKER_APP_DIR, appHost, appPort, copies, deployChecker, deployDirectory, describeCopies, ensureProject, releaseRuns, scaling, unitInfo, workload, workloadSpec, type Copy, type UnitInfo } from './lib/app.ts';
import { startChecker } from './lib/checker.ts';
import { checkerVerdict, failedRequestsVerdict, judgeReleaseOnce, releasePhaseDecision, releaseRunObservations, singletonRows, type ReleaseRunRow } from './lib/judge.ts';
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

/** The app's singleton records for `release:<marker>` (the release command records itself), or null. */
async function releaseAppRows(target: Target, marker: string) {
	try {
		const response = await fetch(`${target.base}/singletons?job=${encodeURIComponent(`release:${marker}`)}`, { headers: { host: target.host }, signal: AbortSignal.timeout(5000) });
		return response.ok ? singletonRows(await response.json()) : null;
	} catch {
		return null;
	}
}

async function releaseStarts(target: Target, marker: string): Promise<number | null> {
	return (await releaseAppRows(target, marker))?.length ?? null;
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
	const features = await platformFeatures();
	const decision = releasePhaseDecision({ flagOn: features?.RELEASE_PHASE === true, putStatus: probe.status, keepsRelease, keepsReadiness });
	const releasePhase = decision.run;
	s.measure('releasePhaseContract', { flag: features?.RELEASE_PHASE ?? null, putStatus: probe.status, keepsRelease, keepsReadiness, refusal: probe.status === 200 ? null : JSON.stringify(probe.body).slice(0, 300) });
	// With the flag off, C and D carry the skip; with it on, the contract is judged.
	if (decision.verdict !== 'skip') s.check('release-phase-contract', decision.verdict, decision.reason, { putStatus: probe.status, keepsRelease, keepsReadiness });
	const missing = decision.reason ?? '';
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
		const verdict = checkerVerdict(report, checkerExit);
		s.check('checker', verdict.verdict, verdict.reason, verdict.values);
		if (report) {
			const perMinute = report.requests ? Math.round((report.requests / durationS) * 60) : null;
			s.measure('achievedRequestsPerMinute', perMinute);
			const failed = failedRequestsVerdict(target, report);
			s.check('zero-non-2xx', failed.verdict, failed.reason ? `${failed.reason} during the rolling deploy` : null, { ...failed.values, perMinute });
			if (target === 'edge' && perMinute !== null && perMinute < 10_000 * 0.95) s.check('load', 'fail', `the checker achieved ${perMinute} requests a minute, below the 10,000 the W5 exit asks for`, { perMinute });
		}
	}

	// --- C. a failing release command -------------------------------------------------------------
	if (parts.has('C')) {
		if (!releasePhase) s.check('failing-release-command', decision.verdict === 'skip' ? 'skip' : 'fail', missing);
		else {
			s.say('C. deploying a release whose release command fails');
			const before = snapshot(await copies(project));
			const marker = `c-${Date.now().toString(36)}`;
			const deployAt = Date.now();
			s.event('deploy failing release', { marker });
			yoalDeployAllowFailure(project, stageRelease(marker, { fail: true }), `failing ${marker}`, s);
			await Bun.sleep(45_000);
			const after = snapshot(await copies(project));
			const changed = [...before].filter(([id, info]) => after.get(id)?.invocationId !== info.invocationId).map(([id, info]) => `${id}@${info.node}`);
			const starts = await releaseStarts(route, marker);
			// The command must have run and failed; a refused or ignored deploy proves nothing.
			const ok = changed.length === 0 && after.size === before.size && starts === 1;
			const why = starts !== 1
				? `the failing release command ran ${starts ?? 0} times, so the deploy never reached it`
				: changed.length
					? `copies restarted onto the failed release: ${changed.join(', ')}`
					: after.size !== before.size
						? `the copy set changed from ${before.size} to ${after.size} across a failed release command`
						: null;
			const runs = safeReleaseRuns(project, deployAt - 1000);
			for (const observation of releaseRunObservations(runs, {})) s.observer.note('release-command', observation.node, observation);
			s.check('failing-release-command', ok ? 'pass' : 'fail', why, { restarted: changed, releaseCommandStarts: starts, copiesBefore: before.size, copiesAfter: after.size, platformRuns: runs.map((run) => `${run.id}:${run.status}@${run.nodeName ?? '?'}`) });
		}
	}

	// --- D. release command under a partition (I16) ------------------------------------------------
	if (parts.has('D')) {
		if (!releasePhase) s.check('release-once-under-partition', decision.verdict === 'skip' ? 'skip' : 'fail', missing);
		else {
			s.say('D. a release command held open while its node is partitioned');
			const marker = `d-${Date.now().toString(36)}`;
			const faults = new Faults(s);
			const deployAt = Date.now();
			yoalDeployAllowFailure(project, stageRelease(marker, { sleepS: 40 }), `partitioned ${marker}`, s);
			// The node is the platform's choice: the one it leased the run to.
			const run = await waitFor('the release command run started on a node', 120_000, () => safeReleaseRuns(project, deployAt - 1000).find((row) => row.startedAt !== null && row.nodeName), 1000).catch(() => null);
			let partition: [number, number | null] | null = null;
			let rolloutStartedAt: number | null = null;
			const watchRollout = async () => {
				if (rolloutStartedAt !== null) return;
				try {
					const view = await scaling(project);
					if (view.rollout) rolloutStartedAt = Date.now();
				} catch {
					// the API may be unreachable while lab-a is partitioned
				}
			};
			if (run) {
				const node = run.nodeName!;
				s.event('release command running', { run: run.id, node, release: run.releaseId });
				const fault = await faults.apply('partition', node, { durationS: 90, fleet });
				partition = [fault.appliedAt, null];
				const until = Date.now() + 90_000;
				while (Date.now() < until) {
					await watchRollout();
					await Bun.sleep(2000);
				}
				await fault.revert();
				partition[1] = fault.revertedAt;
			}
			const settleUntil = Date.now() + 60_000;
			while (Date.now() < settleUntil) {
				await watchRollout();
				await Bun.sleep(2000);
			}
			const runs = safeReleaseRuns(project, deployAt - 1000).filter((row) => !run || row.releaseId === run.releaseId);
			// The platform's runs as observations for the checker (I16), in its own clock.
			for (const observation of releaseRunObservations(runs, { rolloutStartedAt })) s.observer.note('release-command', observation.node, observation);
			const appRows = (await releaseAppRows(route, marker)) ?? [];
			const judged = judgeReleaseOnce({ runs, appRows, marker, partition, rolloutStartedAt });
			s.check('release-once-under-partition', judged.verdict, run ? judged.reason : `the release command never started on a node within 120 s (${runs.length} attempts recorded)`, { ...judged.values, node: run?.nodeName ?? null, appStarts: appRows.length });
		}
	}
});

/** The platform's runs, or none when lab-a cannot be read (partitioned, say). */
function safeReleaseRuns(project: string, since: number): ReleaseRunRow[] {
	try {
		return releaseRuns(project, since);
	} catch {
		return [];
	}
}

function yoalDeployAllowFailure(project: string, dir: string, message: string, s: Scenario): void {
	try {
		s.note(deployDirectory(project, dir, message));
	} catch (error) {
		s.note(`deploy refused: ${(error as Error).message.split('\n').slice(-1)[0]}`);
	}
}
