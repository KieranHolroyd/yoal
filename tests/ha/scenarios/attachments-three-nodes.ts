#!/usr/bin/env bun
/**
 * Scenario: the W4 exit (HA-PLAN §4 W4, H24; M1 "a container app in three copies on three nodes
 * uses one Postgres").
 *
 *   1. a container app (the checker app's image, loaded into every node's Podman) in three copies on
 *      lab-a, lab-b and lab-c, attached to one Postgres on lab-ctl, under the checker
 *   2. a manual promotion of a replica of that database (on --replica-node, a node that runs a copy,
 *      so the same-node case of H24 is exercised) changes no copy's environment and restarts no copy:
 *      each copy's unit invocation, start time and env-file hash are recorded once the copies have
 *      settled (two reads agree), then 20 s after the promotion and again after the checker exits
 *   3. a positive control, then a TCP scan from outside the overlay: from inside each copy's node
 *      its endpoint ports (21000–21999, read 23000–23999) are open, and every node's :80 answers the
 *      scanner; then a throwaway container on the lab bridge finds no endpoint, read endpoint,
 *      database (15432–16431) or pooler (16432–17431) port open on any node
 *
 * A container app reaches a database on another node only with `SERVICE_ENDPOINTS` (default on) and
 * `ENDPOINTS_GATEWAY` (opt-in) on (packages/core/src/databases.ts `crossNodeAllowed`); a process app
 * needs `SERVICE_ENDPOINTS`. The scenario reads the platform's resolved flags (`GET
 * /api/setup/status`). With a needed flag off it reports **skip** naming the flag (turn it on with
 * `bun tests/lab/lab.ts up --feature ENDPOINTS_GATEWAY=1`), and still runs the port scan. With the
 * flags on, a refused spread is a **fail**. `--runtime process` runs the same steps with a process
 * app, which exercises the harness.
 *
 *   bun tests/ha/scenarios/attachments-three-nodes.ts [--runtime container|process]
 *       [--target edge|direct] [--duration-s 240] [--promote-after-s 60] [--replica-node lab-a]
 *       [--rate 20] [--samples 45] [--skip-promotion] [--seed 1] [--project <slug>] [--out <dir>]
 *       [--accept …]
 *
 * `--skip-promotion` runs steps 1 and 3 only (no replica, no promotion, no before/after
 * comparison): a quicker check of placement, traffic and exposure.
 *
 * Judged:
 *   spread              three copies on three nodes with the database on a fourth (skip while a
 *                       needed flag is off; fail when the flags are on and the platform refuses)
 *   database-node       the database is on lab-ctl
 *   traffic             every copy served before the promotion (else invalid)
 *   promotion-baseline  every copy's unit, invocation and env hash read, after the copies settled
 *   promotion           the promotion completed
 *   promotion-no-env-change / promotion-no-restart   per copy, baseline vs both after-snapshots
 *   port-scan-positive-control  endpoint ports open from inside their node; :80 open from the bridge
 *   port-scan           nothing listens on the endpoint, read, database or pooler ranges from the bridge
 *   checker             no invariant failed, I6 passed, at least one write acknowledged
 */
import { parseArgs } from 'node:util';
import { LAB, labNode } from '../../lab/lab.config.ts';
import { api, fleetNodes, platformFeatures } from '../../lab/lib/api.ts';
import { DATABASE_POOLER_PORT_MAX, DATABASE_POOLER_PORT_MIN, DATABASE_PORT_MAX, DATABASE_PORT_MIN } from '../../../packages/contracts/src/database.ts';
import { endpointPortRange, readEndpointPortRange } from '../../../packages/contracts/src/endpoint.ts';
import { connectsFrom, copies, deployChecker, describeCopies, nodeId, nodeListeners, ScaleRefused, settledUnits, unitInfo, type Copy, type Runtime, type UnitInfo } from './lib/app.ts';
import { startChecker } from './lib/checker.ts';
import { attachmentFeatureGate, checkerVerdict, compareUnits, promotionBaseline, spreadRefusalVerdict } from './lib/judge.ts';
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
	[endpointPortRange.min, endpointPortRange.max], // primary endpoints (CLUSTERING §9.2)
	[readEndpointPortRange.min, readEndpointPortRange.max], // read endpoints (HA-PLAN F2)
];
/** What must not be reachable from outside the overlay: endpoints, databases and poolers. */
const SCAN_RANGES: Array<[number, number]> = [
	...ENDPOINT_RANGES,
	[DATABASE_PORT_MIN, DATABASE_PORT_MAX],
	[DATABASE_POOLER_PORT_MIN, DATABASE_POOLER_PORT_MAX],
];
/** The scanner's own positive control: every node's Caddy answers on :80 from the bridge. */
const OPEN_PORT = 80;
const project = flags.project ?? `ha-attach-${runtime}`;
const scenario = new Scenario(`attachments-three-nodes-${runtime}`, { ...flags, project, copyNodes: COPY_NODES, dbNode: DB_NODE }, flags);

/**
 * The port scan runs whatever else happened: it is a property of the fleet, not of this app. A
 * closed port proves nothing unless the scan can see an open one, so first a positive control:
 * every copy's node (`copyNodes`, the consumers) holds its endpoint listeners and accepts a
 * connection on them from inside; and the bridge scan itself must find every node's :80 open.
 */
function portScan(s: Scenario, copyNodes: string[]): void {
	const inside: Record<string, { listeners: string[]; connected: string | null }> = {};
	for (const node of copyNodes) {
		const listeners = nodeListeners(node, ENDPOINT_RANGES);
		const open = listeners.find((listener) => connectsFrom(node, listener.address, listener.port));
		inside[node] = { listeners: listeners.map((listener) => `${listener.address}:${listener.port}`), connected: open ? `${open.address}:${open.port}` : null };
	}
	const targets = LAB.nodes.map((node) => node.ip);
	const result = scanFromBridge(targets, [[OPEN_PORT, OPEN_PORT], ...SCAN_RANGES], { timeoutMs: 500 });
	const control = targets.filter((ip) => result.open.includes(`${ip}:${OPEN_PORT}`));
	const exposed = result.open.filter((entry) => !entry.endsWith(`:${OPEN_PORT}`));
	s.measure('portScan', { targets, ranges: SCAN_RANGES, probed: result.probed, open: result.open, inside, durationMs: result.durationMs });
	const noListener = copyNodes.filter((node) => !inside[node]!.connected);
	const controlOk = control.length === targets.length && noListener.length === 0;
	s.check(
		'port-scan-positive-control',
		controlOk ? 'pass' : 'fail',
		controlOk
			? null
			: [
					control.length < targets.length ? `the bridge scan did not see :${OPEN_PORT} open on ${targets.filter((ip) => !control.includes(ip)).join(', ')}, so it cannot tell closed from unreachable` : null,
					noListener.length ? `no endpoint port accepted a connection from inside ${noListener.join(', ')} (listeners: ${JSON.stringify(Object.fromEntries(noListener.map((node) => [node, inside[node]!.listeners])))}), so "closed from the bridge" would prove nothing` : null,
				]
					.filter(Boolean)
					.join('; '),
		{ openFromBridge: control.length, targets: targets.length, inside },
	);
	s.check('port-scan', exposed.length === 0 ? 'pass' : 'fail', exposed.length ? `endpoint, database or pooler ports reachable from the lab bridge: ${exposed.join(', ')}` : null, { probed: result.probed, open: exposed.length });
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
	const features = await platformFeatures();
	const gate = attachmentFeatureGate(runtime, features);
	s.measure('features', { SERVICE_ENDPOINTS: features?.SERVICE_ENDPOINTS ?? null, ENDPOINTS_GATEWAY: features?.ENDPOINTS_GATEWAY ?? null, off: gate.off });
	const copyNodes = COPY_NODES.filter((node) => node !== DB_NODE);

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
		const refused = spreadRefusalVerdict(runtime, gate, error.message);
		s.check('spread', refused.verdict, refused.reason, refused.values);
		// No copies to hold endpoints: the bridge's :80 is the only positive control left.
		portScan(s, []);
		s.stop(refused.verdict === 'skip' ? 'skip' : 'fail', refused.reason!);
	}
	s.check('spread', 'pass', null, { copies: describeCopies(placed) });
	// The exit says one database on a *fourth* node, not merely a database somewhere.
	const dbRow = (await api<any>('GET', `/api/v1/databases/${project}-db`)).body;
	const dbNode = dbRow?.nodeName ?? dbRow?.database?.nodeName ?? null;
	s.check('database-node', dbNode === DB_NODE ? 'pass' : 'fail', dbNode === DB_NODE ? null : `the database is on ${dbNode ?? 'an unknown node'}, not ${DB_NODE}`, { node: dbNode });
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
		portScan(s, copyNodes);
		s.stop(
			'invalid',
			target === 'edge'
				? `copies on ${silent.join(', ')} took no traffic through the edge (on a tree without F7 from ha/w1-fixes the edge's active health check sends no app Host, packages/site-config/src/compile.ts, and marks remote copies unhealthy). Run --target direct.`
				: `copies on ${silent.join(', ')} did not answer direct requests`,
		);
	}
	s.check('traffic', 'pass', null, { share: shareBefore });

	// --- checker, promotion -----------------------------------------------------------------------
	const checker = startChecker(s, route, { durationS, rate: Number(flags.rate), seed: Number(flags.seed), cli: flags.checker });
	let before: Map<string, UnitInfo> | null = null;
	let afterPromotion: Map<string, UnitInfo> | null = null;
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
		// The baseline only once the copies have settled: a copy still restarting after placement, or
		// an env file still being rewritten, would read as a change the promotion caused.
		const settled = await settledUnits(project);
		before = new Map<string, UnitInfo>(settled.units.map((info) => [info.copy, info]));
		s.measure('unitsBeforePromotion', settled.units);
		const baseline = promotionBaseline(settled.units, placed.length);
		if (!settled.settled) s.check('promotion-baseline', 'fail', `the copies did not settle within 90 s before the promotion (two reads 5 s apart disagreed): ${baseline.reason ?? 'units kept changing'}`, baseline.values);
		else s.check('promotion-baseline', baseline.verdict, baseline.reason, baseline.values);
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
			afterPromotion = new Map<string, UnitInfo>((await copies(project)).map((copy) => [copy.id, unitInfo(copy)]));
			s.measure('unitsAfterPromotion', [...afterPromotion.values()]);
		}
	}

	// --- 3. scan, then the checker's verdict and the second after-snapshot ---------------------------
	portScan(s, copyNodes);
	const checkerExit = await checker.exited;
	const finalCopies = await copies(project).catch(() => [] as Copy[]);
	s.measure('copiesAfter', describeCopies(finalCopies));
	if (before && afterPromotion) {
		// Later than any agent's reaction to the promotion: a restart the 20 s snapshot missed shows here.
		const afterChecker = new Map<string, UnitInfo>(finalCopies.map((copy) => [copy.id, unitInfo(copy)]));
		s.measure('unitsAfterChecker', [...afterChecker.values()]);
		const { envChanged, restarted } = compareUnits(before, [afterPromotion, afterChecker]);
		s.check('promotion-no-env-change', envChanged.length ? 'fail' : 'pass', envChanged.length ? `the environment of ${envChanged.join(', ')} changed` : null, { copies: before.size, changed: envChanged });
		s.check('promotion-no-restart', restarted.length ? 'fail' : 'pass', restarted.length ? `restarted: ${restarted.join(', ')}` : null, { copies: before.size, restarted });
	}
	const verdict = checkerVerdict(readCheckerReport(s.checkerReportPath), checkerExit, { requireWrites: true });
	s.check('checker', verdict.verdict, verdict.reason, verdict.values);
});
