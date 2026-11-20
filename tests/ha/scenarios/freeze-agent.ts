#!/usr/bin/env bun
/**
 * Scenario: freeze the agent on a copy's node for 60 s, then let it resume (HA-PLAN §7.2 Process
 * family: "freeze the primary's agent for 60 s then resume (the classic stale-leader case)").
 *
 * The agent is SIGSTOPped (the helper's `freeze` verb, which thaws itself after --freeze-s); the
 * app copy, Caddy and Postgres keep running. Today an agent is not a leader of anything, so this is
 * the baseline the database member (W11) must keep: a frozen agent costs no request, re-places no
 * copy within the failover grace, restarts nothing, and its node comes back by itself.
 *
 *   bun tests/ha/scenarios/freeze-agent.ts [--node lab-b] [--freeze-s 60] [--target edge|direct]
 *       [--duration-s 180] [--freeze-after-s 30] [--rate 20] [--seed 1] [--keeper lab-a]
 *       [--db-node lab-a] [--samples 30] [--project ha-checker] [--out <dir>] [--accept …]
 *
 * Judged:
 *   traffic-before      both copies served before the freeze (else invalid)
 *   copy-kept-serving   the frozen node's copy answered every `/healthz?db=1` probe during the
 *                       freeze (so it still reached its database, through the node's endpoint
 *                       forwarder when the database is elsewhere)
 *   no-restart          the copy's unit kept its invocation (it was not restarted, before or after thaw)
 *   no-replacement      no copy was re-placed (the freeze is shorter than the failover grace)
 *   agent-recovers      the node is reported online again within 60 s of the thaw
 *   checker             no invariant failed
 *   no-failed-requests  edge target only, as kill-node
 */
import { parseArgs } from 'node:util';
import { CONTROL, LAB, labNode } from '../../lab/lab.config.ts';
import { api, fleetNodes } from '../../lab/lib/api.ts';
import { copies, deployChecker, describeCopies, unitInfo, type Copy } from './lib/app.ts';
import { startChecker } from './lib/checker.ts';
import { Faults } from './lib/faults.ts';
import { EDGE_BYPASSED_NOTE, formatShare, openTarget, parseTarget, shareUntil } from './lib/ingress.ts';
import { readCheckerReport } from './lib/report.ts';
import { COMMON_OPTIONS, Scenario, positiveInt, waitFor } from './lib/scenario.ts';

const { values: flags } = parseArgs({
	options: {
		...COMMON_OPTIONS,
		node: { type: 'string', default: 'lab-b' },
		'freeze-s': { type: 'string', default: '60' },
		target: { type: 'string', default: 'edge' },
		'duration-s': { type: 'string', default: '180' },
		'freeze-after-s': { type: 'string', default: '30' },
		rate: { type: 'string', default: '20' },
		keeper: { type: 'string' },
		'db-node': { type: 'string' },
		samples: { type: 'string', default: '30' },
	},
});

const node = labNode(flags.node!).name;
const keeper = labNode(flags.keeper ?? (node === CONTROL.name ? 'lab-b' : CONTROL.name)).name;
const dbNode = labNode(flags['db-node'] ?? CONTROL.name).name;
const project = flags.project ?? (dbNode === CONTROL.name ? 'ha-checker' : `ha-checker-${dbNode}`);
const scenario = new Scenario(`freeze-agent-${node}`, { ...flags, node, keeper, dbNode, project }, flags);

await scenario.run(async (s) => {
	const target = parseTarget(flags.target);
	const freezeS = positiveInt('--freeze-s', flags['freeze-s']);
	const durationS = positiveInt('--duration-s', flags['duration-s']);
	const freezeAfterS = positiveInt('--freeze-after-s', flags['freeze-after-s']);
	const samples = positiveInt('--samples', flags.samples);
	if (node === keeper) s.stop('error', '--keeper must differ from --node');
	if (freezeAfterS + freezeS + 30 > durationS) s.stop('error', '--duration-s must cover the freeze plus 30 s after it');
	if (node === CONTROL.name) s.notice(`${node}'s agent reaches the control plane over a unix socket and also runs the edge's Caddy config: freezing it freezes route changes for the whole fleet.`);
	if (target === 'direct') s.notice(EDGE_BYPASSED_NOTE);

	s.say('preflight');
	const fleet = await waitFor('every lab node online', 180_000, () => {
		const rows = fleetNodes();
		return LAB.nodes.every((item) => rows.find((row) => row.name === item.name)?.status === 'online') ? rows : null;
	}).catch((error: Error) => s.stop('error', `${error.message}: run \`bun tests/lab/lab.ts up\` first`));
	const cluster = (await api<any>('GET', '/api/v1/cluster/config')).body;
	const graceS = Number((cluster?.failover ?? cluster?.config?.failover ?? {}).graceSeconds ?? 120);
	s.measure('failoverGraceSeconds', graceS);
	if (freezeS >= graceS) s.notice(`The freeze (${freezeS} s) is not shorter than the failover grace (${graceS} s): a re-placement is expected and no-replacement is not judged.`);

	s.say(`deploying ${project}: copies on ${keeper} and ${node}, Postgres on ${dbNode}`);
	const deployed = await deployChecker(s, { project, runtime: 'process', nodes: [keeper, node], dbNode, message: 'freeze-agent' });
	const victimCopy = deployed.copies.find((copy) => copy.nodeName === node)!;
	const unitBefore = unitInfo(victimCopy);
	s.measure('unitBefore', unitBefore);
	if (!unitBefore.invocationId) s.stop('error', `could not read ${node}'s unit for copy ${victimCopy.id}`);

	const route = await openTarget(target, deployed.host, fleet, deployed.copies.map((copy) => copy.nodeName));
	s.onCleanup('close target', () => route.stop());
	s.note(route.describe());
	const shareBefore = await shareUntil(route.base, deployed.host, samples, [keeper, node]);
	s.measure('shareBefore', formatShare(shareBefore));
	if (!shareBefore[node]) {
		s.check('traffic-before', 'invalid', `${node}'s copy took 0 of ${samples} requests`, { share: shareBefore });
		s.stop(
			'invalid',
			target === 'edge'
				? `${node}'s copy took no traffic through the edge (on a tree without F7 from ha/w1-fixes the edge's active health check sends no app Host, packages/site-config/src/compile.ts, and marks remote copies unhealthy). Run --target direct.`
				: `${node}'s copy did not answer direct requests`,
		);
	}
	s.check('traffic-before', 'pass', null, { share: shareBefore });

	s.say(`checker ${durationS} s; freeze yoal-agent on ${node} at +${freezeAfterS} s for ${freezeS} s`);
	const checker = startChecker(s, route, { durationS, rate: Number(flags.rate), seed: Number(flags.seed), cli: flags.checker });
	await Promise.race([Bun.sleep(freezeAfterS * 1000), checker.exited]);
	if (!checker.running()) s.stop('error', 'the checker exited before the freeze');
	const faults = new Faults(s);
	s.setZero();
	const freeze = await faults.apply('freeze', node, { unit: 'yoal-agent.service', durationS: freezeS });
	const thawAt = freeze.appliedAt + freezeS * 1000;

	const probes = { during: { answered: 0, failed: 0 }, after: { answered: 0, failed: 0 } };
	let replaced: Copy | null = null;
	let maxCopies = deployed.copies.length;
	let lastFleet = 0;
	while (checker.running()) {
		const now = Date.now();
		const phase = now < thawAt ? 'during' : 'after';
		if (phase === 'after' && freeze.revertedAt === null) faults.expired(freeze, thawAt);
		// /healthz?db=1: the copy must reach its database too (through the node's endpoint, when the
		// database is on another node), not only answer.
		if ((await route.answers(node, '/healthz?db=1')) === true) probes[phase].answered++;
		else probes[phase].failed++;
		if (now - lastFleet > 3000) {
			lastFleet = now;
			try {
				const status = fleetNodes().find((row) => row.name === node)?.status;
				if (status && status !== 'online' && s.report.timings.nodeOffline == null) {
					s.timing('nodeOffline');
					s.note(`+${(s.rel() / 1000).toFixed(1)} s ${node} is ${status}`);
				}
				if (status === 'online' && s.report.timings.nodeOffline != null && s.report.timings.nodeOnlineAgain == null) {
					s.timing('nodeOnlineAgain');
					s.note(`+${(s.rel() / 1000).toFixed(1)} s ${node} is online again`);
				}
			} catch {
				// next tick
			}
			try {
				const list = await copies(project);
				maxCopies = Math.max(maxCopies, list.length);
				const moved = list.find((copy) => copy.nodeName !== keeper && copy.nodeName !== node);
				if (moved && !replaced) {
					replaced = moved;
					s.timing('copyReplaced');
					s.event('copy re-placed', { copy: moved.id, node: moved.nodeName, status: moved.status });
				}
			} catch {
				// next tick
			}
		}
		await Promise.race([checker.exited, Bun.sleep(1000)]);
	}
	for (const key of ['nodeOffline', 'nodeOnlineAgain', 'copyReplaced']) s.unobserved(key);
	const checkerExit = await checker.exited;
	const unitAfter = unitInfo(victimCopy);
	s.measure('unitAfter', unitAfter);
	s.measure('probes', probes);
	s.measure('copiesAfter', describeCopies(await copies(project).catch(() => [])));
	if (route.served()) s.measure('balancerServed', route.served());

	s.check(
		'copy-kept-serving',
		probes.during.failed === 0 && probes.during.answered > 0 ? 'pass' : 'fail',
		probes.during.failed === 0
			? null
			: `${probes.during.failed} of ${probes.during.answered + probes.during.failed} /healthz?db=1 probes to ${node}'s copy failed while its agent was frozen${dbNode !== node ? ` (its database is on ${dbNode}: the consumer endpoint forwarder runs inside the agent, apps/agent/src/endpoints.ts, so a frozen agent cuts the copy off from Postgres)` : ''}`,
		probes.during,
	);
	s.check(
		'no-restart',
		unitAfter.invocationId === unitBefore.invocationId ? 'pass' : 'fail',
		unitAfter.invocationId === unitBefore.invocationId ? null : `${unitBefore.unit} was restarted (invocation ${unitBefore.invocationId} → ${unitAfter.invocationId})`,
		{ before: unitBefore.invocationId, after: unitAfter.invocationId },
	);
	if (freezeS < graceS)
		s.check(
			'no-replacement',
			replaced || maxCopies > deployed.copies.length ? 'fail' : 'pass',
			replaced ? `a ${freezeS} s agent freeze re-placed a copy on ${replaced.nodeName} (grace ${graceS} s)` : null,
			{ maxCopies, replaced: replaced?.nodeName ?? null },
		);
	const offline = s.report.timings.nodeOffline;
	const online = s.report.timings.nodeOnlineAgain;
	const recoveredMs = typeof online === 'number' ? online - freezeS * 1000 : null;
	s.check(
		'agent-recovers',
		offline == null || (recoveredMs !== null && recoveredMs <= 60_000) ? 'pass' : 'fail',
		offline == null ? null : recoveredMs === null ? `${node} never came back online` : recoveredMs > 60_000 ? `${node} was online again ${(recoveredMs / 1000).toFixed(1)} s after the thaw` : null,
		{ offlineAfterMs: offline, onlineAgainAfterThawMs: recoveredMs },
	);
	const report = readCheckerReport(s.checkerReportPath);
	if (!report) s.check('checker', 'error', `no checker report (exit ${checkerExit})`);
	else s.check('checker', report.failedInvariants.length ? 'fail' : 'pass', report.failedInvariants.length ? `invariants failed: ${report.failedInvariants.join(', ')}` : null, { exit: checkerExit });
	if (report && target === 'edge')
		s.check('no-failed-requests', report.failedRequests === 0 ? 'pass' : 'fail', report.failedRequests ? `${report.failedRequests} of ${report.requests} requests failed` : null, { failedByStatus: report.failedByStatus });
	else if (report) s.measure('failedRequests (not judged: harness balancer)', { failed: report.failedRequests, byStatus: report.failedByStatus });
});
