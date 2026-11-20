#!/usr/bin/env bun
/**
 * Scenario: lose one node while the checker runs (HA-PLAN §1.2 "one app copy or its node"; M1 "the
 * lab kills a node and the checker is clean"; §7.2 Node family). Generalises kill-node-b.
 *
 * On a running lab (`bun tests/lab/lab.ts up`):
 *
 *   1. deploy the checker app (process, Postgres on --db-node) in two copies: one on --keeper, one
 *      on --node (the victim)
 *   2. measure each copy's share of traffic through --target; a victim copy that takes none makes
 *      the run `invalid` (losing it would lose nothing the checker can see)
 *   3. run the checker; at +--kill-after-s take the victim away (--method):
 *        kill       power off (docker kill)
 *        stop       orderly shutdown (docker stop)
 *        partition  cut it off from every lab and overlay address but its own (helper verb)
 *   4. watch: victim offline, its copy re-placed, the new copy running and answering
 *   5. restore the victim (unless --keep-down) and time its rejoin
 *
 *   bun tests/ha/scenarios/kill-node.ts [--node lab-b] [--method kill|stop|partition]
 *       [--target edge|direct] [--duration-s 300] [--kill-after-s 30] [--rate 20] [--seed 1]
 *       [--keeper lab-a] [--db-node lab-a] [--samples 30] [--rejoin-wait-s 180] [--keep-down]
 *       [--project ha-checker] [--out <dir>] [--accept invalid,skip]
 *
 * Judged (lib/report.ts verdicts):
 *   traffic-before   both copies served before the fault (else invalid)
 *   offline-detected the victim reported offline within 40 s (F9: 30–35 s, plus polling)
 *   replaced         the victim's copy re-placed, running and answering within the failover grace
 *                    + 120 s (HA-PLAN §1.2); skip when failover is off
 *   checker          no invariant failed (I6 lost writes, I4 duplicate singletons, …)
 *   no-failed-requests  edge target only: zero failed requests (§1.2: retried on another copy).
 *                    With --target direct the harness balancer decides retries, so failures are
 *                    recorded, not judged.
 */
import { parseArgs } from 'node:util';
import { CONTROL, LAB, labNode } from '../../lab/lab.config.ts';
import { api, fleetNodes, type FleetNode } from '../../lab/lib/api.ts';
import { copies, deployChecker, describeCopies, type Copy } from './lib/app.ts';
import { startChecker } from './lib/checker.ts';
import { Faults, FAULT_MAX_S, type FaultKind } from './lib/faults.ts';
import { EDGE_BYPASSED_NOTE, formatShare, openTarget, parseTarget, shareUntil, share, type Target } from './lib/ingress.ts';
import { LabRelay } from '../../lab/lib/relay.ts';
import { readCheckerReport } from './lib/report.ts';
import { COMMON_OPTIONS, Scenario, positiveInt, waitFor } from './lib/scenario.ts';

const { values: flags } = parseArgs({
	options: {
		...COMMON_OPTIONS,
		node: { type: 'string', default: 'lab-b' },
		method: { type: 'string', default: 'kill' },
		target: { type: 'string', default: 'edge' },
		'duration-s': { type: 'string', default: '300' },
		'kill-after-s': { type: 'string', default: '30' },
		rate: { type: 'string', default: '20' },
		keeper: { type: 'string' },
		'db-node': { type: 'string' },
		samples: { type: 'string', default: '30' },
		'rejoin-wait-s': { type: 'string', default: '180' },
		'keep-down': { type: 'boolean', default: false },
	},
});

/** The upstream addresses lab-a's edge Caddy has for `host` (from its live config). */
async function edgeDials(host: string): Promise<string[] | string> {
	const relay = new LabRelay(CONTROL.name);
	try {
		return await Promise.race([relay.dials(host), Bun.sleep(10_000).then(() => 'timed out')]);
	} catch (error) {
		return `unavailable: ${(error as Error).message}`;
	} finally {
		await relay.close();
	}
}

const victim = labNode(flags.node!).name;
const keeper = labNode(flags.keeper ?? (victim === CONTROL.name ? 'lab-b' : CONTROL.name)).name;
const dbNode = labNode(flags['db-node'] ?? (victim === CONTROL.name ? 'lab-ctl' : CONTROL.name)).name;
const method = flags.method as 'kill' | 'stop' | 'partition';
const project = flags.project ?? (dbNode === CONTROL.name ? 'ha-checker' : `ha-checker-${dbNode}`);
const name = `kill-node-${victim}-${method}`;
const scenario = new Scenario(name, { ...flags, node: victim, keeper, dbNode, project }, flags);

await scenario.run(async (s) => {
	const target = parseTarget(flags.target);
	if (!['kill', 'stop', 'partition'].includes(method)) s.stop('error', '--method is kill, stop or partition');
	if (keeper === victim) s.stop('error', '--keeper must differ from --node');
	if (dbNode === victim) s.stop('error', `--db-node ${dbNode} is the victim: this scenario loses an app copy, not the database (that is W11's)`);
	const durationS = positiveInt('--duration-s', flags['duration-s']);
	const killAfterS = positiveInt('--kill-after-s', flags['kill-after-s']);
	const samples = positiveInt('--samples', flags.samples);
	const rate = Number(flags.rate);
	if (killAfterS >= durationS) s.stop('error', '--kill-after-s must be less than --duration-s');
	if (method === 'partition' && durationS > FAULT_MAX_S) s.stop('error', `a partition is held for --duration-s, above the helper's ${FAULT_MAX_S} s`);
	if (target === 'direct') s.notice(EDGE_BYPASSED_NOTE);
	if (victim === CONTROL.name)
		s.notice(`${victim} holds the control plane and the only edge on this tree (HA-PLAN G1, G18): losing it stops routing and re-placement until it returns. ${target === 'direct' ? `The direct balancer relays through ${keeper}.` : ''}`);

	// --- preflight -------------------------------------------------------------------------------
	s.say('preflight');
	const fleet = await waitFor('every lab node online', 180_000, () => {
		const rows = fleetNodes();
		return LAB.nodes.every((node) => rows.find((row) => row.name === node.name)?.status === 'online') ? rows : null;
	}).catch((error: Error) => s.stop('error', `${error.message}: run \`bun tests/lab/lab.ts up\` first`));
	s.note(`fleet: ${fleet.map((node) => `${node.name}=${node.status}`).join(', ')}`);
	const cluster = (await api<any>('GET', '/api/v1/cluster/config')).body;
	const failover = cluster?.failover ?? cluster?.config?.failover ?? {};
	const graceS = Number(failover.graceSeconds ?? 120);
	const boundMs = (graceS + 120) * 1000;
	s.measure('failover', { enabled: Boolean(failover.enabled), graceSeconds: graceS, replacedBoundS: boundMs / 1000 });

	// --- deploy ----------------------------------------------------------------------------------
	s.say(`deploying ${project}: Postgres on ${dbNode}, copies on ${keeper} and ${victim}`);
	const deployed = await deployChecker(s, { project, runtime: 'process', nodes: [keeper, victim], dbNode, message: name });
	const placed = deployed.copies;
	const host = deployed.host;
	s.measure('copiesBefore', describeCopies(placed));
	for (const copy of placed) s.observer.note('route', copy.nodeName, { copy: copy.id, event: 'started', phase: 'before' });

	// --- who serves ------------------------------------------------------------------------------
	const routeNodes = (list: Copy[]) => list.filter((copy) => copy.status === 'running').map((copy) => copy.nodeName);
	const route: Target = await openTarget(target, host, fleet, routeNodes(placed), victim === CONTROL.name ? keeper : CONTROL.name);
	s.onCleanup('close target', () => route.stop());
	s.note(route.describe());
	const shareBefore = await shareUntil(route.base, host, samples, [keeper, victim]);
	s.measure('shareBefore', formatShare(shareBefore));
	if (!shareBefore[victim]) {
		s.check('traffic-before', 'invalid', `${victim}'s copy is running but took 0 of ${samples} requests through the ${target === 'edge' ? 'edge' : 'direct balancer'}`, { share: shareBefore });
		s.stop(
			'invalid',
			target === 'edge'
				? `${victim}'s copy took no traffic through the edge: on a tree without F7 from ha/w1-fixes the edge's active health check reaches a remote copy without the app's Host and marks it unhealthy (packages/site-config/src/compile.ts). Run --target direct to measure copy failover without the edge.`
				: `${victim}'s copy did not answer any direct request (${route.describe()})`,
		);
	}
	s.check('traffic-before', 'pass', null, { share: shareBefore });

	// --- checker, fault, watch -------------------------------------------------------------------
	s.say(`checker ${durationS} s at ${rate}/s; ${method} ${victim} at +${killAfterS} s`);
	const checker = startChecker(s, route, { durationS, rate, seed: Number(flags.seed), cli: flags.checker });
	await Promise.race([Bun.sleep(killAfterS * 1000), checker.exited]);
	if (!checker.running()) s.stop('error', `the checker exited (${checker.process.exitCode}) before the fault; see ${s.out}/checker.err.log`);
	const faults = new Faults(s);
	const kind: FaultKind = method === 'kill' ? 'power-off' : method === 'stop' ? 'stop' : 'partition';
	s.setZero();
	const fault = await faults.apply(kind, victim, { durationS, fleet });
	if (flags['keep-down']) faults.keep(fault);
	s.note(`${victim}: ${kind}${fault.id ? ` (fault ${fault.id})` : ''}`);
	// No `route {event: 'stopped'}` here: an unplanned loss stops a copy while it is still in the
	// upstreams by definition. I15 judges planned stops (drains); the fault observation covers this.

	let replacement: Copy | null = null;
	let lastFleet = 0;
	let edgeDialsAt = 0;
	while (checker.running()) {
		const now = Date.now();
		if (s.report.timings.victimOffline == null && now - lastFleet > 3000) {
			lastFleet = now;
			try {
				const status = fleetNodes().find((node) => node.name === victim)?.status;
				if (status && status !== 'online') {
					s.timing('victimOffline');
					s.note(`+${(s.rel() / 1000).toFixed(1)} s ${victim} is ${status}`);
				}
			} catch {
				// the control node is busy, or it is the victim
			}
		}
		try {
			const list = await copies(project);
			await route.setNodes(routeNodes(list).filter((node) => node !== victim || method === 'partition'));
			const moved = list.find((copy) => copy.nodeName !== keeper && copy.nodeName !== victim);
			if (moved && !replacement) {
				replacement = moved;
				s.timing('replacementPlaced');
				s.event('copy re-placed', { copy: moved.id, node: moved.nodeName, status: moved.status });
				s.note(`+${(s.rel() / 1000).toFixed(1)} s copy ${moved.id} placed on ${moved.nodeName} (${moved.status})`);
			}
			if (moved) {
				if (moved.status !== replacement?.status) s.event('re-placed copy status', { node: moved.nodeName, status: moved.status });
				replacement = moved;
				if (moved.status === 'running' && s.report.timings.replacementRunning == null) {
					s.timing('replacementRunning');
					s.observer.note('route', moved.nodeName, { copy: moved.id, event: 'added' });
					s.note(`+${(s.rel() / 1000).toFixed(1)} s copy running on ${moved.nodeName}`);
					edgeDialsAt = Date.now() + 15_000;
				}
			}
		} catch {
			// the control plane is slow, or down
		}
		if (edgeDialsAt && Date.now() >= edgeDialsAt) {
			// What lab-a's edge dials for the app 15 s after the re-placed copy runs (diagnostics).
			edgeDialsAt = 0;
			s.measure('edgeDialsAfterReplacement', await edgeDials(host));
		}
		if (replacement && s.report.timings.replacementAnswering == null && (await route.answers(replacement.nodeName))) {
			s.timing('replacementAnswering');
			s.note(`+${(s.rel() / 1000).toFixed(1)} s ${replacement.nodeName} answers`);
		}
		await Promise.race([checker.exited, Bun.sleep(2000)]);
	}
	for (const key of ['victimOffline', 'replacementPlaced', 'replacementRunning', 'replacementAnswering']) s.unobserved(key);
	const shareAfter = await share(route.base, host, samples);
	s.measure('shareAfter', formatShare(shareAfter));
	if (route.served()) s.measure('balancerServed', route.served());
	const checkerExit = await checker.exited;
	const after = await copies(project).catch(() => [] as Copy[]);
	s.measure('copiesAfter', describeCopies(after));
	s.measure('edgeDialsAtEnd', await edgeDials(host));

	// --- judge -----------------------------------------------------------------------------------
	const edgeMissing = (node: string): boolean => {
		const dials = s.report.measures.edgeDialsAtEnd;
		const address = fleet.find((row) => row.name === node)?.privateAddress;
		return target === 'edge' && Array.isArray(dials) && Boolean(address) && !dials.some((dial: string) => dial.includes(`${address}:`));
	};
	// F9: offline marking runs on the 5 s failover tick, so a silent node is offline within 30–35 s
	// (HA-PLAN §2.1 "offline at 30 s"); +5 s for this scenario's 3 s fleet polling.
	const offline = s.report.timings.victimOffline;
	const offlineBoundMs = 40_000;
	s.check(
		'offline-detected',
		typeof offline === 'number' && offline <= offlineBoundMs ? 'pass' : 'fail',
		typeof offline !== 'number' ? `${victim} was never reported offline` : offline > offlineBoundMs ? `${victim} was reported offline after ${(offline / 1000).toFixed(1)} s (bound ${offlineBoundMs / 1000} s: 30–35 s detection + polling)` : null,
		{ offlineAfterMs: offline, boundMs: offlineBoundMs },
	);
	const answering = s.report.timings.replacementAnswering;
	if (!failover.enabled) s.check('replaced', 'skip', 'failover.enabled is off on this lab: nothing re-places a copy', {});
	else if (typeof answering === 'number' && answering <= boundMs)
		s.check('replaced', 'pass', null, { answeringAfterMs: answering, boundMs, node: replacement?.nodeName });
	else {
		const why = !replacement
			? `no copy was re-placed within the ${durationS - killAfterS} s watched`
			: replacement.status !== 'running'
				? `the copy re-placed on ${replacement.nodeName} is ${replacement.status}${replacement.status === 'failed' || replacement.status === 'pending' ? ' (on a tree without F8 from ha/w1-fixes a re-placed copy gets no endpoint and so no DATABASE_URL: packages/core/src/workloads.ts moveReplica)' : ''}`
				: `the re-placed copy on ${replacement.nodeName} answered after ${typeof answering === 'number' ? `${(answering / 1000).toFixed(1)} s` : 'never'}${edgeMissing(replacement.nodeName) ? ` (lab-a's edge never listed it: dials ${JSON.stringify(s.report.measures.edgeDialsAtEnd)}; the copy's move to running does not bump the desired-state version, so the edge keeps the upstreams built while it was pending, packages/core/src/nodes.ts:1249-1268, until an unrelated change)` : ''}`;
		s.check('replaced', 'fail', `${why}; bound ${boundMs / 1000} s (failover grace ${graceS} s + 120 s)`, { answeringAfterMs: answering, boundMs, replacement: replacement ? `${replacement.id}@${replacement.nodeName}:${replacement.status}` : null });
	}
	const report = readCheckerReport(s.checkerReportPath);
	if (!report) s.check('checker', 'error', `no checker report (exit ${checkerExit})`, {});
	else if (report.failedInvariants.length)
		s.check('checker', 'fail', `invariants failed: ${report.failedInvariants.join(', ')} (lost writes ${report.lostAcknowledgedWrites})`, { exit: checkerExit });
	else if (report.invariants?.I6 !== 'pass')
		s.check('checker', 'fail', `I6 was ${report.invariants?.I6 ?? 'missing'}: no write survived to judge, so the checker is not evidence`, { exit: checkerExit });
	else s.check('checker', 'pass', null, { exit: checkerExit, lostAcknowledgedWrites: report.lostAcknowledgedWrites });
	if (report) {
		if (target === 'edge')
			s.check(
				'no-failed-requests',
				report.failedRequests === 0 ? 'pass' : 'fail',
				report.failedRequests === 0 ? null : `${report.failedRequests} of ${report.requests} requests failed (${JSON.stringify(report.failedByStatus)})`,
				{ failedRequests: report.failedRequests, failedByStatus: report.failedByStatus },
			);
		else s.measure('failedRequests (not judged: harness balancer)', { failed: report.failedRequests, byStatus: report.failedByStatus });
	}

	// --- restore ---------------------------------------------------------------------------------
	if (!flags['keep-down']) {
		await fault.revert();
		s.note(`${victim} restored; waiting up to ${flags['rejoin-wait-s']} s for it to rejoin`);
		const rejoinMs = Number(flags['rejoin-wait-s']) * 1000;
		const back = await waitFor(`${victim} online`, rejoinMs, () => fleetNodes().find((node: FleetNode) => node.name === victim)?.status === 'online', 3000).catch(() => false);
		if (back) s.timing('victimRejoined');
		else s.unobserved('victimRejoined');
	}
});
