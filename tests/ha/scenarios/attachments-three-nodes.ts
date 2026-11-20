#!/usr/bin/env bun
/**
 * Scenario: the W4 exit (HA-PLAN §4 W4, H24; M1 "a container app in three copies on three nodes
 * uses one Postgres").
 *
 *   1. a container app (the checker app's image, loaded into every node's Podman) in three copies on
 *      lab-a, lab-b and lab-c, attached to one Postgres on lab-ctl, under the checker
 *   2. a manual promotion of a replica of that database (on --replica-node, a node that runs a copy,
 *      so the same-node case of H24 is exercised) changes no copy's environment and restarts no copy:
 *      each copy's unit invocation, start time and env-file hash are recorded before and after
 *   3. a TCP scan from outside the overlay (a throwaway container on the lab bridge) finds no
 *      endpoint port (primary 21000–21999, read 23000–23999) open on any node
 *
 * Today a container app cannot reach a database on another node (G9: `crossNodeAllowed()` is false
 * for containers, packages/core/src/databases.ts:3636), so it is pinned to the database's node and
 * cannot spread. Until W4 lands that refusal is the expected outcome: the scenario reports **skip**
 * with the platform's own blocker text, and still runs the port scan. `--runtime process` runs the
 * same steps with a process app (cross-node attachments work for those today), which exercises the
 * harness and records today's G10 behaviour on promotion.
 *
 *   bun tests/ha/scenarios/attachments-three-nodes.ts [--runtime container|process]
 *       [--target edge|direct] [--duration-s 240] [--promote-after-s 60] [--replica-node lab-a]
 *       [--rate 20] [--seed 1] [--project <slug>] [--out <dir>] [--accept …]
 *
 * Judged:
 *   spread              three copies on three nodes with the database on a fourth (skip with the
 *                       platform's refusal while W4 is not built)
 *   traffic             every copy served before the promotion (else invalid)
 *   promotion           the promotion completed
 *   promotion-no-env-change / promotion-no-restart   per copy, before vs after
 *   port-scan           nothing listens on the endpoint ranges from the lab bridge
 *   checker             no invariant failed
 */
import { parseArgs } from 'node:util';
import { LAB, labNode } from '../../lab/lab.config.ts';
import { api, fleetNodes } from '../../lab/lib/api.ts';
import { copies, deployChecker, describeCopies, nodeId, ScaleRefused, unitInfo, type Copy, type Runtime, type UnitInfo } from './lib/app.ts';
import { startChecker } from './lib/checker.ts';
import { EDGE_BYPASSED_NOTE, formatShare, openTarget, parseTarget, shareUntil } from './lib/ingress.ts';
import { scanFromBridge } from './lib/portscan.ts';
import { readCheckerReport } from './lib/report.ts';
import { COMMON_OPTIONS, Scenario, positiveInt, waitFor } from './lib/scenario.ts';

const { values: flags } = parseArgs({
	options: {
		...COMMON_OPTIONS,
		runtime: { type: 'string', default: 'container' },
		target: { type: 'string', default: 'edge' },
		'duration-s': { type: 'string', default: '240' },
		'promote-after-s': { type: 'string', default: '60' },
		'replica-node': { type: 'string', default: 'lab-a' },
		rate: { type: 'string', default: '20' },
		samples: { type: 'string', default: '45' },
		'skip-promotion': { type: 'boolean', default: false },
	},
});

const runtime = flags.runtime as Runtime;
const COPY_NODES = ['lab-a', 'lab-b', 'lab-c'];
const DB_NODE = 'lab-ctl';
const ENDPOINT_RANGES: Array<[number, number]> = [
	[21000, 21999], // primary endpoints (CLUSTERING §9.2)
	[23000, 23999], // read endpoints (HA-PLAN F2, readEndpointPortRange)
];
const project = flags.project ?? `ha-attach-${runtime}`;
const scenario = new Scenario(`attachments-three-nodes-${runtime}`, { ...flags, project, copyNodes: COPY_NODES, dbNode: DB_NODE }, flags);

/** The port scan runs whatever else happened: it is a property of the fleet, not of this app. */
function portScan(s: Scenario): void {
	const targets = LAB.nodes.map((node) => node.ip);
	const result = scanFromBridge(targets, ENDPOINT_RANGES, { timeoutMs: 500 });
	s.measure('portScan', { targets, ranges: ENDPOINT_RANGES, probed: result.probed, open: result.open, durationMs: result.durationMs });
	s.check('port-scan', result.open.length === 0 ? 'pass' : 'fail', result.open.length ? `endpoint ports reachable from the lab bridge: ${result.open.join(', ')}` : null, { probed: result.probed, open: result.open.length });
}

await scenario.run(async (s) => {
	if (runtime !== 'container' && runtime !== 'process') s.stop('error', '--runtime is container or process');
	const target = parseTarget(flags.target);
	const durationS = positiveInt('--duration-s', flags['duration-s']);
	const promoteAfterS = positiveInt('--promote-after-s', flags['promote-after-s']);
	const samples = positiveInt('--samples', flags.samples);
	const replicaNode = labNode(flags['replica-node']!).name;
	if (replicaNode === DB_NODE) s.stop('error', `--replica-node must not be the primary's node (${DB_NODE})`);
	if (target === 'direct') s.notice(EDGE_BYPASSED_NOTE);
	if (runtime === 'process') s.notice('Process-app baseline (--runtime process): the M1/W4 criterion is about a container app; this run exercises the same steps where the platform allows them today.');

	s.say('preflight');
	const fleet = await waitFor('every lab node online', 180_000, () => {
		const rows = fleetNodes();
		return LAB.nodes.every((node) => rows.find((row) => row.name === node.name)?.status === 'online') ? rows : null;
	}).catch((error: Error) => s.stop('error', `${error.message}: run \`bun tests/lab/lab.ts up\` first`));

	// --- 1. three copies, one database on a fourth node ------------------------------------------
	s.say(`deploying ${project} (${runtime}): copies on ${COPY_NODES.join(', ')}, Postgres on ${DB_NODE}`);
	let placed!: Copy[];
	let host!: string;
	try {
		// A promotion in an earlier run moved the database: start from a fresh one on lab-ctl.
		const existing = (await api<any>('GET', `/api/v1/databases/${project}-db`, undefined, { allowStatus: [404] })).body;
		const where = existing?.nodeName ?? existing?.database?.nodeName;
		if (where && where !== DB_NODE) {
			s.note(`${project}-db is on ${where} after an earlier promotion: removing it to start on ${DB_NODE}`);
			await api('DELETE', `/api/v1/projects/${project}/databases/${project}-db`, undefined, { allowStatus: [404] });
			await api('DELETE', `/api/v1/databases/${project}-db`, undefined, { allowStatus: [404] });
			await api('DELETE', `/api/v1/databases/${project}-db?purge=1`, undefined, { allowStatus: [404, 409] });
			await waitFor(`${project}-db purged`, 180_000, async () => (await api('GET', `/api/v1/databases/${project}-db?includeDeleted=1`, undefined, { allowStatus: [404] })).status === 404, 3000);
		}
		const deployed = await deployChecker(s, { project, runtime, nodes: COPY_NODES, dbNode: DB_NODE, message: 'attachments-three-nodes', requireSpread: true });
		placed = deployed.copies;
		host = deployed.host;
	} catch (error) {
		if (!(error instanceof ScaleRefused)) throw error;
		s.check(
			'spread',
			'skip',
			`the platform refuses to spread a ${runtime} app attached to a database on another node: "${error.message}". ${runtime === 'container' ? 'Expected until W4 (H24 container endpoints, SERVICE_ENDPOINTS) lands: crossNodeAllowed() is false for containers (packages/core/src/databases.ts:3636).' : ''}`,
			{ refusal: error.message },
		);
		portScan(s);
		s.stop('skip', `${runtime} app with a database on another node cannot spread on this tree: ${error.message}`);
	}
	s.check('spread', 'pass', null, { copies: describeCopies(placed) });
	s.measure('copiesBefore', describeCopies(placed));

	// --- 2. traffic through the target ------------------------------------------------------------
	const route = await openTarget(target, host, fleet, placed.map((copy) => copy.nodeName));
	s.onCleanup('close target', () => route.stop());
	s.note(route.describe());
	const shareBefore = await shareUntil(route.base, host, samples, COPY_NODES);
	s.measure('shareBefore', formatShare(shareBefore));
	const silent = COPY_NODES.filter((node) => !shareBefore[node]);
	if (silent.length) {
		s.check('traffic', 'invalid', `copies on ${silent.join(', ')} took no traffic`, { share: shareBefore });
		portScan(s);
		s.stop(
			'invalid',
			target === 'edge'
				? `copies on ${silent.join(', ')} took no traffic through the edge (edge health check without the app Host: packages/site-config/src/compile.ts:259-264; ha/w1-fixes). Run --target direct.`
				: `copies on ${silent.join(', ')} did not answer direct requests`,
		);
	}
	s.check('traffic', 'pass', null, { share: shareBefore });

	// --- checker, promotion -----------------------------------------------------------------------
	const checker = startChecker(s, route, { durationS, rate: Number(flags.rate), seed: Number(flags.seed), cli: flags.checker });
	await Promise.race([Bun.sleep(Math.min(promoteAfterS, 20) * 1000), checker.exited]);
	if (!flags['skip-promotion']) {
		s.say(`adding a replica of ${project}-db on ${replicaNode}`);
		const replicas = (await api<any>('GET', `/api/v1/databases/${project}-db/replicas`)).body;
		let replica = (replicas.replicas ?? []).find((item: any) => item.nodeName === replicaNode);
		if (!replica) replica = (await api<any>('POST', `/api/v1/databases/${project}-db/replicas`, { node: nodeId(replicaNode, fleet) })).body.replica;
		s.event('replica added', { id: replica.id, node: replicaNode });
		const streaming = await waitFor(`replica on ${replicaNode} streaming`, 300_000, async () => {
			const list = (await api<any>('GET', `/api/v1/databases/${project}-db/replicas`)).body;
			const row = (list.replicas ?? []).find((item: any) => item.id === replica.id);
			return row?.status === 'streaming' && (row.lagBytes ?? 0) < 1_000_000 ? { row, generation: list.primaryGeneration as number } : null;
		}, 3000);
		s.timing('replicaStreaming');
		const wait = checker.startedAt + promoteAfterS * 1000 - Date.now();
		if (wait > 0) await Bun.sleep(wait);
		const before = new Map<string, UnitInfo>((await copies(project)).map((copy) => [copy.id, unitInfo(copy)]));
		s.measure('unitsBeforePromotion', [...before.values()]);
		s.say(`promoting the replica on ${replicaNode} (If-Match ${streaming.generation})`);
		s.setZero();
		const promoted = await api<any>('POST', `/api/v1/databases/${project}-db/replicas/${replica.id}/promote`, { confirm: true }, { allowStatus: [400, 409, 412, 422] });
		// api() sends no If-Match; the generation is recorded for the reader.
		s.observer.note('db-role', replicaNode, { database: `${project}-db`, role: 'primary', promotion: 'manual', generation: streaming.generation + 1, acceptingWrites: true });
		if (promoted.status !== 202) {
			s.check('promotion', 'fail', `the promotion was refused (${promoted.status}): ${JSON.stringify(promoted.body).slice(0, 300)}`);
		} else {
			const failoverId = promoted.body.failover?.id;
			const done = await waitFor('promotion complete', 300_000, async () => {
				const list = (await api<any>('GET', `/api/v1/databases/${project}-db/replicas`)).body;
				const row = (list.failovers ?? []).find((item: any) => item.id === failoverId);
				return row && (row.stage === 'completed' || row.stage === 'failed') ? row : null;
			}, 2000).catch(() => null);
			s.timing('promotionDone');
			s.check('promotion', done?.stage === 'completed' ? 'pass' : 'fail', done?.stage === 'completed' ? null : `promotion ${done ? `ended ${done.stage}: ${done.message}` : 'did not finish in 300 s'}`, { stage: done?.stage ?? null });
			// Give agents two heartbeats to act on the new desired state before comparing.
			await Bun.sleep(20_000);
			const after = new Map<string, UnitInfo>((await copies(project)).map((copy) => [copy.id, unitInfo(copy)]));
			s.measure('unitsAfterPromotion', [...after.values()]);
			const envChanged: string[] = [];
			const restarted: string[] = [];
			for (const [id, info] of before) {
				const now = after.get(id);
				if (!now || now.node !== info.node) {
					restarted.push(`${id}@${info.node} (moved or gone)`);
					continue;
				}
				if (now.envHash !== info.envHash) envChanged.push(`${id}@${info.node}`);
				if (now.invocationId !== info.invocationId) restarted.push(`${id}@${info.node}`);
			}
			s.check('promotion-no-env-change', envChanged.length ? 'fail' : 'pass', envChanged.length ? `the environment of ${envChanged.join(', ')} changed (G10: packages/core/src/databases.ts:2943-2963)` : null, { copies: before.size, changed: envChanged });
			s.check('promotion-no-restart', restarted.length ? 'fail' : 'pass', restarted.length ? `restarted: ${restarted.join(', ')}` : null, { copies: before.size, restarted });
		}
	}

	// --- 3. scan, then the checker's verdict ------------------------------------------------------
	portScan(s);
	const checkerExit = await checker.exited;
	s.measure('copiesAfter', describeCopies(await copies(project).catch(() => [])));
	const report = readCheckerReport(s.checkerReportPath);
	if (!report) s.check('checker', 'error', `no checker report (exit ${checkerExit})`);
	else s.check('checker', report.failedInvariants.length ? 'fail' : 'pass', report.failedInvariants.length ? `invariants failed: ${report.failedInvariants.join(', ')} (lost writes ${report.lostAcknowledgedWrites})` : null, { exit: checkerExit, failedRequests: report.failedRequests });
});
