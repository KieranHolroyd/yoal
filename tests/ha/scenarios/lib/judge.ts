/**
 * The scenarios' judging logic as pure functions, so each verdict is unit-tested (judge.test.ts)
 * without a lab. A scenario gathers the numbers on the lab and asks these what they mean.
 */
import { FEATURE_FLAGS, parseFeatureFlagValue } from '../../../../packages/contracts/src/features.ts';
import { checkI16 } from '../../checker/invariants.ts';
import type { Observation } from '../../checker/observations.ts';
import type { SingletonRun } from '../../checker/log.ts';
import type { UnitInfo } from './app.ts';
import type { CheckerSummary, Verdict } from './report.ts';

export interface Judged {
	verdict: Verdict;
	reason: string | null;
	values?: Record<string, unknown>;
}

// --- feature flags ---------------------------------------------------------------------------

export interface FeatureGate {
	on: boolean;
	/** Required flags the platform does not report on (all of them when it does not answer). */
	off: string[];
}

/** Are all `required` flags on in the platform's resolved features (`GET /api/setup/status`)? */
export function featureGate(features: Record<string, boolean> | null, required: string[]): FeatureGate {
	const off = required.filter((name) => features?.[name] !== true);
	return { on: off.length === 0, off };
}

/**
 * What an app attached to a database on another node needs (packages/core/src/databases.ts
 * `crossNodeAllowed`): `SERVICE_ENDPOINTS` (default on), and for a container `ENDPOINTS_GATEWAY`.
 */
export function attachmentFeatureGate(runtime: 'process' | 'container', features: Record<string, boolean> | null): FeatureGate {
	return featureGate(features, runtime === 'container' ? ['SERVICE_ENDPOINTS', 'ENDPOINTS_GATEWAY'] : ['SERVICE_ENDPOINTS']);
}

export function enableHint(off: string[]): string {
	return `bun tests/lab/lab.ts up ${off.map((name) => `--feature ${name}=1`).join(' ')}`;
}

/** The platform refused to spread the app: skip only when a flag it needs is off. */
export function spreadRefusalVerdict(runtime: 'process' | 'container', gate: FeatureGate, refusal: string): Judged {
	if (!gate.on)
		return {
			verdict: 'skip',
			reason: `${gate.off.join(' and ')} ${gate.off.length > 1 ? 'are' : 'is'} off on this lab, so a ${runtime} app cannot reach a database on another node (the platform said: "${refusal}"). Turn ${gate.off.length > 1 ? 'them' : 'it'} on with \`${enableHint(gate.off)}\`.`,
			values: { refusal, off: gate.off },
		};
	return { verdict: 'fail', reason: `the flags are on, yet the platform refused to spread a ${runtime} app attached to a database on another node: "${refusal}"`, values: { refusal } };
}

/**
 * rolling-deploy A: whether parts C and D run. With `RELEASE_PHASE` off they skip; with it on, a
 * workload API that refuses or drops `release`/`readinessPath` is a failure (the flag promised them).
 */
export function releasePhaseDecision(input: { flagOn: boolean; putStatus: number; keepsRelease: boolean; keepsReadiness: boolean }): Judged & { run: boolean } {
	if (!input.flagOn)
		return {
			run: false,
			verdict: 'skip',
			reason: `RELEASE_PHASE is off on this lab, so the platform runs no release command. Turn it on with \`${enableHint(['RELEASE_PHASE'])}\`.`,
		};
	if (input.putStatus === 200 && input.keepsRelease && input.keepsReadiness) return { run: true, verdict: 'pass', reason: null };
	const lost = [input.keepsRelease ? null : '`release`', input.keepsReadiness ? null : '`readinessPath`'].filter(Boolean).join(' and ');
	return {
		run: false,
		verdict: 'fail',
		reason: input.putStatus === 200 ? `RELEASE_PHASE is on, but the workload API did not keep ${lost}` : `RELEASE_PHASE is on, but the workload API refused the spec (${input.putStatus})`,
	};
}

/**
 * single-node-gate: every flag whose registry default is false, on or off. The platform's resolved
 * value wins; the control node's env file counts only when the platform does not answer.
 */
export function optInFlagState(envOverrides: Record<string, string>, platform: Record<string, boolean> | null): Record<string, 'on' | 'off'> {
	return Object.fromEntries(
		Object.values(FEATURE_FLAGS)
			.filter((flag) => !flag.default)
			.map((flag) => {
				const on = platform && typeof platform[flag.name] === 'boolean' ? platform[flag.name]! : (parseFeatureFlagValue(envOverrides[flag.name]) ?? false);
				return [flag.name, on ? 'on' : 'off'];
			}),
	);
}

// --- checker -----------------------------------------------------------------------------------

/**
 * The checker's verdict for a scenario. Any failed invariant fails; so does I6 not passing (no
 * write survived to judge, so the checker is not evidence: 7af9fe6f); with `requireWrites`, so
 * does a run with no acknowledged write.
 */
export function checkerVerdict(report: CheckerSummary | null, exit: number, options: { requireWrites?: boolean } = {}): Judged {
	if (!report) return { verdict: 'error', reason: `no checker report (exit ${exit})`, values: { exit } };
	const values = { exit, failedRequests: report.failedRequests, acknowledgedWrites: report.acknowledgedWrites, lostAcknowledgedWrites: report.lostAcknowledgedWrites };
	if (report.failedInvariants.length) return { verdict: 'fail', reason: `invariants failed: ${report.failedInvariants.join(', ')} (lost writes ${report.lostAcknowledgedWrites})`, values };
	const i6 = report.invariants?.I6;
	if (i6 !== 'pass') return { verdict: 'fail', reason: `I6 was ${i6 ?? 'missing'}: no write survived to judge, so the checker is not evidence`, values };
	if (options.requireWrites && (report.acknowledgedWrites ?? 0) === 0) return { verdict: 'fail', reason: 'no write was acknowledged: the app was not proven to serve from the database', values };
	return { verdict: 'pass', reason: null, values };
}

type WindowCounts = Record<string, { requests: number; failed: number; byStatus: Record<string, number> }>;

/**
 * Failed requests, judged on both targets. On `direct` the harness balancer decides retries, so
 * with a named fault `window` (a node lost) failures inside it are allowed there (passive
 * mark-down after the first failure) and only failures outside it fail; without a window, as on
 * the edge, none may fail.
 */
export function failedRequestsVerdict(target: 'edge' | 'direct', report: CheckerSummary, options: { windows?: WindowCounts; window?: string } = {}): Judged {
	const failed = report.failedRequests ?? 0;
	const via = target === 'direct' ? ' through the harness balancer (--target direct: the edge was bypassed)' : '';
	if (target === 'direct' && options.windows && options.window) {
		const outside = options.windows.outside ?? { requests: 0, failed: 0, byStatus: {} };
		const inside = options.windows[options.window] ?? { requests: 0, failed: 0, byStatus: {} };
		const values = { failed, inside, outside, window: options.window };
		return outside.failed === 0
			? { verdict: 'pass', reason: null, values }
			: { verdict: 'fail', reason: `${outside.failed} of ${outside.requests} requests outside the ${options.window} window failed${via} (${JSON.stringify(outside.byStatus)})`, values };
	}
	const values = { failed, requests: report.requests, failedByStatus: report.failedByStatus };
	return failed === 0 ? { verdict: 'pass', reason: null, values } : { verdict: 'fail', reason: `${failed} of ${report.requests} requests failed${via} (${JSON.stringify(report.failedByStatus)})`, values };
}

// --- units and env (attachments-three-nodes) ---------------------------------------------------

/** sha256('') cut to 16 hex: what `cat <nothing> | sort | sha256sum` prints when no env file was read. */
export const EMPTY_ENV_HASH = 'e3b0c44298fc1c14';

/** The node's hash output, or null when it read nothing (no file, unreadable, empty). */
export function envHashOrNull(output: string): string | null {
	const hash = output.trim();
	return hash && hash !== EMPTY_ENV_HASH ? hash : null;
}

/** Every copy's unit, invocation and env hash read, for every placed copy: else "no restart" is vacuous. */
export function promotionBaseline(units: UnitInfo[], expected: number): Judged {
	const unreadable = units.filter((info) => !(info.unit && info.invocationId && info.envHash)).map((info) => `${info.copy}@${info.node}`);
	if (units.length === expected && unreadable.length === 0) return { verdict: 'pass', reason: null, values: { copies: units.length } };
	return {
		verdict: 'fail',
		reason: `could not read a unit, invocation and env hash for every copy (${units.length - unreadable.length} of ${expected}${unreadable.length ? `; unreadable: ${unreadable.join(', ')}` : ''}); "no restart" would pass vacuously`,
		values: { copies: units.length, unreadable },
	};
}

/** Two reads of the copies' units agree, and every unit was read: the copies have settled. */
export function unitsSettled(a: UnitInfo[], b: UnitInfo[]): boolean {
	if (a.length !== b.length || a.length === 0) return false;
	const key = (info: UnitInfo) => `${info.copy}|${info.node}|${info.invocationId}|${info.envHash}`;
	if (a.some((info) => !info.invocationId || !info.envHash)) return false;
	const seen = new Set(a.map(key));
	return b.every((info) => seen.has(key(info)));
}

const SNAPSHOT_LABELS = ['after promotion', 'after checker'];

/** Each copy in `before` against every later snapshot: env changed, or restarted (moved, gone). */
export function compareUnits(before: Map<string, UnitInfo>, afters: Array<Map<string, UnitInfo>>): { envChanged: string[]; restarted: string[] } {
	const envChanged: string[] = [];
	const restarted: string[] = [];
	afters.forEach((after, index) => {
		const label = SNAPSHOT_LABELS[index] ?? `snapshot ${index + 1}`;
		for (const [id, info] of before) {
			const now = after.get(id);
			if (!now || now.node !== info.node) {
				restarted.push(`${id}@${info.node} (moved or gone, ${label})`);
				continue;
			}
			if (now.envHash !== info.envHash) envChanged.push(`${id}@${info.node} (${label})`);
			if (now.invocationId !== info.invocationId) restarted.push(`${id}@${info.node} (${label})`);
		}
	});
	return { envChanged, restarted };
}

/** `ss -ltnH` lines → listeners whose port is in one of `ranges`. */
export function parseListeners(ss: string, ranges: Array<[number, number]>): Array<{ address: string; port: number }> {
	const out: Array<{ address: string; port: number }> = [];
	for (const line of ss.split('\n')) {
		const fields = line.trim().split(/\s+/);
		if (fields[0] !== 'LISTEN' || fields.length < 5) continue;
		const local = fields[3]!;
		const colon = local.lastIndexOf(':');
		const port = Number(local.slice(colon + 1));
		const address = local.slice(0, colon).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
		if (ranges.some(([from, to]) => port >= from && port <= to)) out.push({ address, port });
	}
	return out;
}

// --- release commands (rolling-deploy D, I16) --------------------------------------------------

/** One row of the platform's `release_command_runs` (packages/core/src/release-commands.ts). */
export interface ReleaseRunRow {
	id: string;
	/** The deployment the command prepares. */
	releaseId: string;
	attempt: number;
	status: string;
	nodeName: string | null;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	exitCode: number | null;
}

/** The checker app's `GET /singletons` body (`{ runs }`; an array or `{ singletons }` too). */
export function singletonRows(body: unknown): SingletonRun[] {
	const rows = Array.isArray(body) ? body : ((body as { runs?: unknown[]; singletons?: unknown[] } | null)?.runs ?? (body as { singletons?: unknown[] } | null)?.singletons ?? []);
	return (rows as SingletonRun[]).filter((row) => row && typeof row.job === 'string');
}

export function windowsOverlap(a: [number, number | null], b: [number, number | null]): boolean {
	const aEnd = a[1] ?? Number.POSITIVE_INFINITY;
	const bEnd = b[1] ?? Number.POSITIVE_INFINITY;
	return a[0] <= bEnd && b[0] <= aEnd;
}

/**
 * `release-command` observations for the checker (tests/ha/README.md, I16) from the platform's
 * runs: a start per attempt that started (copy = the run id, so attempts never merge), an end, and
 * the rollout's start when the scenario saw one. The release key is the deployment id; the app's
 * own records use the scenario's marker, so the two sources are counted separately and neither
 * can hide the other's second start.
 */
export function releaseRunObservations(runs: ReleaseRunRow[], options: { rolloutStartedAt?: number | null }): Observation[] {
	const out: Observation[] = [];
	for (const run of runs) {
		if (run.startedAt === null) continue;
		const node = run.nodeName ?? 'unknown';
		out.push({ t: run.startedAt, kind: 'release-command', node, release: run.releaseId, event: 'start', copy: run.id });
		if (run.finishedAt !== null) out.push({ t: run.finishedAt, kind: 'release-command', node, release: run.releaseId, event: 'end', ok: run.status === 'succeeded', copy: run.id });
	}
	const first = runs.find((run) => run.startedAt !== null);
	if (first && options.rolloutStartedAt) out.push({ t: options.rolloutStartedAt, kind: 'release-command', node: first.nodeName ?? 'unknown', release: first.releaseId, event: 'rollout-start' });
	// The checker reads observations in time order (observations.ts parseObservations sorts them).
	return out.sort((a, b) => a.t - b.t);
}

/**
 * rolling-deploy D: the release command ran exactly once under a partition of its own node. The
 * platform shows one started attempt, I16 holds over its runs and the app's records, and the
 * partition overlapped the run (else the run proves nothing: invalid).
 */
export function judgeReleaseOnce(input: {
	runs: ReleaseRunRow[];
	appRows: SingletonRun[];
	marker: string;
	partition: [number, number | null] | null;
	rolloutStartedAt?: number | null;
}): Judged {
	const started = input.runs.filter((run) => run.startedAt !== null);
	const observations = releaseRunObservations(input.runs, { rolloutStartedAt: input.rolloutStartedAt });
	const i16 = checkI16({ log: { seed: 0, writer: 'scenario', startedAt: 0, endedAt: 0, requests: [], singletonRuns: input.appRows.filter((row) => row.job === `release:${input.marker}`) }, observations });
	const values = { attempts: input.runs.map((run) => `${run.id}#${run.attempt}:${run.status}@${run.nodeName ?? '?'}`), started: started.length, i16: i16.status, evidence: i16.evidence, partition: input.partition };
	if (started.length === 0) return { verdict: 'fail', reason: `no release command run started for this deployment (${input.runs.length} attempts recorded)`, values };
	if (started.length > 1) return { verdict: 'fail', reason: `${started.length} attempts started on ${started.map((run) => run.nodeName).join(', ')}: the release command ran more than once`, values };
	if (i16.status === 'fail') return { verdict: 'fail', reason: `I16: ${i16.evidence.join('; ')}`, values };
	const run = started[0]!;
	if (!input.partition) return { verdict: 'invalid', reason: 'the node running the release command was never partitioned', values };
	if (!windowsOverlap([run.startedAt!, run.finishedAt], input.partition))
		return { verdict: 'invalid', reason: `the partition (${input.partition.join('–')}) did not overlap the run (${run.startedAt}–${run.finishedAt ?? 'running'}), so I16 was not exercised`, values };
	return { verdict: 'pass', reason: null, values };
}
