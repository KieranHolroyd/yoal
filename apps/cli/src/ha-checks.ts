/**
 * `yoal ha init`, `yoal ha preflight`, `yoal doctor` and the catalogue drills (HA-PLAN H27, §8,
 * W14). The CLI ships without `@yoal/contracts`, so these are the response shapes it reads, kept
 * to the fields it prints; the control plane's contracts are `ha-check.ts`, `ha-init.ts` and
 * `ha-drill.ts`.
 */
import { renderTable } from './output.ts';

export type HaCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface HaCheckView {
	id: string;
	title: string;
	status: HaCheckStatus;
	evidence: string[];
	fix: { kind: 'command' | 'setting' | 'env' | 'manual'; value: string } | null;
	subject: { kind: string; id: string; name: string } | null;
}

export interface HaChecksReport {
	profile: 'single' | 'ha' | 'ha-dr';
	mode: 'preflight' | 'doctor';
	ok: boolean;
	counts: Record<HaCheckStatus, number>;
	checks: HaCheckView[];
	generatedAt: string;
}

export interface HaInitQuestionView {
	id: 'steering' | 'certificates' | 'standbyRegion';
	prompt: string;
	options: string[];
	default: string | null;
	value: string | null;
}

export interface HaInitFlagView {
	name: string;
	value: boolean;
	env: string;
}

export interface HaInitSettingView {
	path: string;
	value: unknown;
}

export interface HaInitPlanView {
	plan: {
		profile: 'single' | 'ha' | 'ha-dr';
		questions: HaInitQuestionView[];
		unanswered: string[];
		flags: HaInitFlagView[];
		settings: HaInitSettingView[];
		standbyRegion: string | null;
		preflight: string[];
		envLines: string[];
		notes: string[];
	};
	flagsToChange: HaInitFlagView[];
	settingsToChange: HaInitSettingView[];
	preflight: HaChecksReport;
	ready: boolean;
	blockers: string[];
}

export interface HaInitApplyView {
	profile: string;
	applied: HaInitSettingView[];
	auditId: string | null;
}

export interface HaDrillScenarioView {
	id: string;
	family: string;
	title: string;
	resourceKind: string;
	destructive: boolean;
	confirmation: 'none' | 'confirm' | 'typed';
	measures: string[];
	availability: 'fleet' | 'lab';
	fleetUnavailableReason: string | null;
	flags: string[];
	minHaLevel: string | null;
	bound: { rtoSeconds: number | null; rpo: 'zero' | 'lag' | null };
}

export interface HaDrillRunView {
	id: string;
	scenario: string;
	resource: { kind: string; id: string; name: string };
	status: 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped';
	startedAt: string | null;
	finishedAt: string | null;
	measured: { rtoMs: number | null; lostCommits: number | null; lagBytes: number | null; failedRequests: number | null; refused: boolean | null };
	bound: { rtoSeconds: number | null; rpo: 'zero' | 'lag' | null };
	recordId: string | null;
	message: string | null;
}

export interface HaDrillAllView {
	runs: HaDrillRunView[];
	skipped: Array<{ scenario: string; reason: string }>;
	passed: boolean;
}

const STATUS_LABEL: Record<HaCheckStatus, string> = { fail: 'FAIL', warn: 'WARN', skip: 'SKIP', pass: 'ok' };

/** One check report, failures first with their evidence and fix, passes as one line each. */
export function formatChecks(report: HaChecksReport): string {
	const { counts } = report;
	const head =
		report.mode === 'doctor'
			? `Doctor (profile ${report.profile}): ${report.ok ? 'healthy' : 'needs attention'}`
			: `Preflight for ${report.profile}: ${report.ok ? 'ready' : 'not ready'}`;
	const lines = [`${head} (${counts.pass} ok, ${counts.warn} warn, ${counts.fail} fail, ${counts.skip} skip)`];
	const rank: Record<HaCheckStatus, number> = { fail: 0, warn: 1, skip: 2, pass: 3 };
	const sorted = [...report.checks].sort((a, b) => rank[a.status] - rank[b.status]);
	for (const check of sorted) {
		const about = check.subject && !check.title.includes(check.subject.name) ? ` [${check.subject.name}]` : '';
		lines.push(`${STATUS_LABEL[check.status].padEnd(4)}  ${check.id.padEnd(26)}  ${check.title}${about}`);
		if (check.status === 'pass') continue;
		for (const fact of check.evidence) lines.push(`${' '.repeat(34)}${fact}`);
		if (check.fix) lines.push(`${' '.repeat(34)}fix (${check.fix.kind}): ${check.fix.value}`);
	}
	return lines.join('\n');
}

const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/** The `ha init` plan: questions, the yoal.env lines, the settings, the preflight and the blockers. */
export function formatInitPlan(view: HaInitPlanView): string {
	const { plan } = view;
	const lines = [`HA profile: ${plan.profile}`];
	if (plan.questions.length > 0) {
		lines.push('', 'Answers:');
		for (const question of plan.questions)
			lines.push(
				`  ${question.id.padEnd(14)} ${question.value ?? '(no answer)'}${question.value !== null && question.value === question.default ? ' (default)' : ''}  — ${question.prompt}`,
			);
	}
	if (plan.flags.length > 0) {
		const changing = new Set(view.flagsToChange.map((flag) => flag.name));
		lines.push('', 'Flags (yoal.env on every control-plane host; ha init never writes them):');
		for (const flag of plan.flags) lines.push(`  ${flag.env}${changing.has(flag.name) ? '   ← change this, then restart' : '   (running)'}`);
	}
	if (plan.settings.length > 0) {
		const changing = new Set(view.settingsToChange.map((setting) => setting.path));
		lines.push('', 'Cluster settings:');
		for (const setting of plan.settings) lines.push(`  ${setting.path} = ${show(setting.value)}${changing.has(setting.path) ? '' : '   (already set)'}`);
	}
	for (const note of plan.notes) lines.push('', `Note: ${note}`);
	const { counts } = view.preflight;
	lines.push('', `Preflight: ${counts.pass} ok, ${counts.warn} warn, ${counts.fail} fail, ${counts.skip} skip (yoal ha preflight --profile ${plan.profile} shows each).`);
	if (view.blockers.length > 0) {
		lines.push('', 'Refused until:');
		for (const blocker of view.blockers) lines.push(`  - ${blocker}`);
	} else if (view.settingsToChange.length === 0) lines.push('', `Nothing to change: the ${plan.profile} profile is already applied.`);
	else lines.push('', 'Ready to apply.');
	return lines.join('\n');
}

export function formatInitApplied(view: HaInitApplyView): string {
	if (view.applied.length === 0) return `Nothing changed: the ${view.profile} profile was already applied.`;
	return [
		`Applied the ${view.profile} profile${view.auditId ? ` (audit ${view.auditId})` : ''}:`,
		...view.applied.map((setting) => `  ${setting.path} = ${show(setting.value)}`),
		view.profile === 'single'
			? 'Every setting ha init changed is back to its earlier value.'
			: 'Undo with: yoal ha init --profile single',
	].join('\n');
}

export function formatCatalogue(scenarios: HaDrillScenarioView[]): string {
	return renderTable(
		['SCENARIO', 'RESOURCE', 'WHERE', 'CONFIRM', 'MIN LEVEL', 'BOUND', 'FLAGS'],
		scenarios.map((entry) => [
			entry.id,
			entry.resourceKind,
			entry.availability,
			entry.confirmation === 'typed' ? 'type name' : entry.confirmation,
			entry.minHaLevel ?? '-',
			[entry.bound.rtoSeconds === null ? null : `RTO ${entry.bound.rtoSeconds} s`, entry.bound.rpo === null ? null : `RPO ${entry.bound.rpo}`].filter(Boolean).join(', ') || '-',
			entry.flags.join(',') || '-',
		]),
	);
}

const ms = (value: number | null) => (value === null ? '-' : value < 1_000 ? `${value} ms` : `${Math.round(value / 100) / 10} s`);

function measured(run: HaDrillRunView): string {
	const parts: string[] = [];
	if (run.measured.rtoMs !== null) {
		const bound = run.bound.rtoSeconds;
		parts.push(`RTO ${ms(run.measured.rtoMs)}${bound === null ? '' : ` (bound ${bound} s${run.measured.rtoMs > bound * 1000 ? ', OVER' : ''})`}`);
	}
	if (run.measured.lostCommits !== null) parts.push(`lost commits ${run.measured.lostCommits}`);
	if (run.measured.lagBytes !== null) parts.push(`lag ${run.measured.lagBytes} B`);
	if (run.measured.failedRequests !== null) parts.push(`failed requests ${run.measured.failedRequests}`);
	if (run.measured.refused !== null) parts.push(run.measured.refused ? 'refused, as it must be' : 'NOT refused');
	return parts.join('; ') || '-';
}

export function formatDrillRun(run: HaDrillRunView): string {
	const lines = [
		`Drill ${run.id}: ${run.scenario} on ${run.resource.kind} ${run.resource.name}: ${run.status}`,
		`  measured: ${measured(run)}`,
	];
	if (run.startedAt) lines.push(`  started:  ${run.startedAt}${run.finishedAt ? `, finished ${run.finishedAt}` : ''}`);
	if (run.recordId && run.recordId !== run.id) lines.push(`  record:   ${run.recordId}`);
	if (run.message) lines.push(`  ${run.message}`);
	if (run.status === 'running') lines.push(`  Follow it with: yoal ha drill show ${run.id}`);
	return lines.join('\n');
}

export function formatDrillRuns(runs: HaDrillRunView[]): string {
	if (runs.length === 0) return 'No catalogue drills yet. yoal ha drill catalogue lists them.';
	return renderTable(
		['ID', 'SCENARIO', 'RESOURCE', 'STATUS', 'MEASURED', 'STARTED'],
		runs.map((run) => [run.id, run.scenario, run.resource.name, run.status, measured(run), run.startedAt ?? '-']),
	);
}

export function formatDrillAll(view: HaDrillAllView): string {
	const lines = [`Drill --all: ${view.passed ? 'passed' : view.runs.length === 0 ? 'nothing ran' : 'not all passed'}`];
	for (const run of view.runs) lines.push('', formatDrillRun(run));
	if (view.skipped.length > 0) {
		lines.push('', 'Skipped:');
		for (const item of view.skipped) lines.push(`  ${item.scenario.padEnd(26)} ${item.reason}`);
	}
	return lines.join('\n');
}

/** `--target kind:resource[:copy]` and the shorthand flags, as `--all` targets. */
export function drillTargets(input: {
	targets: string[];
	nodes: string[];
	ingressNodes: string[];
	databases: string[];
	projects: string[];
}): Array<{ kind: string; resource: string; drillDatabase?: string }> {
	const out: Array<{ kind: string; resource: string; drillDatabase?: string }> = [];
	const database = (value: string) => {
		const [resource, copy] = value.split(':');
		return { kind: 'database', resource: resource!, ...(copy ? { drillDatabase: copy } : {}) };
	};
	for (const value of input.targets) {
		const [kind, resource, copy] = value.split(':');
		if (!kind || !resource) throw new Error(`--target ${value}: use kind:resource, e.g. database:main or node:a1.`);
		out.push({ kind, resource, ...(copy ? { drillDatabase: copy } : {}) });
	}
	for (const node of input.nodes) out.push({ kind: 'node', resource: node });
	for (const node of input.ingressNodes) out.push({ kind: 'ingress-node', resource: node });
	for (const value of input.databases) out.push(database(value));
	for (const project of input.projects) out.push({ kind: 'project', resource: project });
	return out;
}
