/**
 * Fleet node updates (docs/CLUSTERING.md §3.11, D217): wire types and the text `yoal nodes`
 * prints. Types mirror packages/contracts/src/node-rollout.ts; the CLI bundle stays free of
 * runtime dependencies (D40), so keep them in sync.
 */
import { UsageError } from './errors.ts';
import { formatTime, plural, renderTable } from './output.ts';

export const ROLLOUT_STRATEGIES = ['availability', 'rolling', 'parallel'] as const;
export type RolloutStrategy = (typeof ROLLOUT_STRATEGIES)[number];
export type RolloutStatus = 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type RolloutPhase = 'starting' | 'blocked' | 'draining' | 'updating' | 'soaking' | 'paused' | 'done';
export type RolloutNodeState = 'pending' | 'draining' | 'updating' | 'verifying' | 'done' | 'failed' | 'skipped';

/** `nodeRolloutLimits` in the contracts. */
export const ROLLOUT_LIMITS = { maxBatchSize: 50, maxSoakSeconds: 3_600, maxFailures: 50 } as const;

export interface RolloutOptions {
	strategy: RolloutStrategy;
	batchSize: number;
	canary: boolean;
	drain: boolean;
	soakSeconds: number;
	maxFailures: number;
}

/** `POST /nodes/rollouts` and `/nodes/rollouts/plan`. */
export interface RolloutCreateInput {
	strategy?: RolloutStrategy;
	batchSize?: number;
	canary?: boolean;
	drain?: boolean;
	soakSeconds?: number;
	maxFailures?: number;
	nodeIds?: string[];
}

export interface RolloutPlanNode {
	id: string;
	name: string;
	zone: string | null;
	roles: string[];
	agentVersion: string | null;
	guarded: boolean;
	groups: string[];
	singleCopies: number;
}

export interface RolloutPlanView {
	targetVersion: string;
	strategy: RolloutStrategy;
	options: RolloutOptions;
	waves: Array<{ index: number; nodes: RolloutPlanNode[]; reason: string }>;
	skipped: Array<{ nodeId: string; name: string; reason: string }>;
	current: number;
	warnings: string[];
}

export interface RolloutNodeView {
	nodeId: string;
	name: string;
	wave: number;
	state: RolloutNodeState;
	fromVersion: string | null;
	version: string | null;
	guarded: boolean;
	attempts: number;
	error: string | null;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface RolloutView {
	id: string;
	flowId: string | null;
	status: RolloutStatus;
	phase: RolloutPhase | null;
	detail: string | null;
	targetVersion: string;
	options: RolloutOptions;
	currentWave: number;
	waves: number;
	nodes: RolloutNodeView[];
	counts: Record<RolloutNodeState, number>;
	failures: number;
	error: string | null;
	trigger: 'manual' | 'auto';
	createdBy: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
}

/** The fields of `GET /nodes` the CLI uses. */
export interface NodeSummary {
	id: string;
	name: string;
	agentVersion?: string | null;
	status?: string;
	/** Failure domain and its region (HA-PLAN H26); older control planes omit `region`. */
	zone?: string;
	region?: string;
	roles?: string[];
}

export function rolloutActive(status: RolloutStatus): boolean {
	return status === 'running' || status === 'paused';
}

/** `--wait` exits 0 only when every node made it. */
export function rolloutExitCode(view: RolloutView): number {
	return view.status === 'succeeded' ? 0 : 1;
}

/** A node by id, or by name when exactly one node has it. */
export function resolveNode(nodes: NodeSummary[], ref: string): NodeSummary {
	const byId = nodes.find((node) => node.id === ref);
	if (byId) return byId;
	const byName = nodes.filter((node) => node.name === ref);
	if (byName.length === 1) return byName[0]!;
	if (byName.length > 1)
		throw new UsageError(`${byName.length} nodes are named "${ref}"; use the node id (${byName.map((node) => node.id).join(', ')}).`);
	const known = nodes.map((node) => node.name).join(', ');
	throw new UsageError(`No node "${ref}".${known ? ` Nodes: ${known}.` : ''}`);
}

export function describeOptions(options: RolloutOptions): string {
	return [
		options.strategy === 'rolling' ? `rolling, ${options.batchSize} at a time` : options.strategy,
		options.canary ? 'canary first' : 'no canary',
		options.drain ? 'drain each wave' : 'no drain',
		`soak ${options.soakSeconds}s`,
		options.maxFailures === 0 ? 'pause on the first failure' : `pause after ${plural(options.maxFailures, 'failure')}`,
	].join(' · ');
}

function planNotes(node: RolloutPlanNode): string {
	const notes: string[] = [];
	if (!node.guarded) notes.push('no rollback guard');
	if (node.singleCopies > 0) notes.push(`${plural(node.singleCopies, 'single-copy workload')}`);
	return notes.join(', ');
}

export function formatRolloutPlan(plan: RolloutPlanView): string {
	const count = plan.waves.reduce((sum, wave) => sum + wave.nodes.length, 0);
	const lines = [`Target ${plan.targetVersion} · ${describeOptions(plan.options)}`];
	lines.push(
		count === 0
			? `Nothing to update.${plan.current ? ` ${plural(plan.current, 'node')} already on ${plan.targetVersion}.` : ''}`
			: `${plural(count, 'node')} in ${plural(plan.waves.length, 'wave')}${plan.current ? `; ${plan.current} already on ${plan.targetVersion}` : ''}.`,
	);
	if (count > 0) {
		const rows: string[][] = [];
		for (const wave of plan.waves) {
			wave.nodes.forEach((node, i) =>
				rows.push([
					i === 0 ? String(wave.index + 1) : '',
					i === 0 ? wave.reason : '',
					node.name,
					node.zone ?? '-',
					node.roles.join(',') || '-',
					node.groups.join(', ') || '-',
					node.agentVersion ?? '-',
					planNotes(node),
				]),
			);
		}
		lines.push('', renderTable(['WAVE', 'WHY', 'NODE', 'ZONE', 'ROLES', 'GROUPS', 'VERSION', 'NOTES'], rows));
	}
	if (plan.skipped.length > 0) {
		lines.push('', 'Not updated:');
		for (const skipped of plan.skipped) lines.push(`  ${skipped.name}: ${skipped.reason}`);
	}
	if (plan.warnings.length > 0) {
		lines.push('', 'Warnings:');
		for (const warning of plan.warnings) lines.push(`  ! ${warning}`);
	}
	return lines.join('\n');
}

function statusLine(view: RolloutView): string {
	const phase = view.status === 'running' && view.phase ? ` (${view.phase})` : '';
	return `${view.status}${phase}`;
}

export function formatRollout(view: RolloutView): string {
	const wave = Math.min(view.currentWave + 1, view.waves);
	const lines = [
		`Rollout ${view.id}  ${statusLine(view)}  → ${view.targetVersion}`,
		`${describeOptions(view.options)} · ${view.trigger === 'auto' ? 'automatic' : 'manual'} · started ${formatTime(view.createdAt)}${
			view.finishedAt ? ` · finished ${formatTime(view.finishedAt)}` : ''
		}`,
	];
	if (view.detail) lines.push(view.detail);
	if (view.error) lines.push(`Error: ${view.error}`);
	lines.push(
		`Wave ${wave} of ${view.waves} · ${view.counts.done} done · ${view.counts.failed} failed · ${view.counts.skipped} skipped · ${plural(view.nodes.length, 'node')}`,
	);
	const rows = [...view.nodes]
		.sort((a, b) => a.wave - b.wave || a.name.localeCompare(b.name))
		.map((node) => [
			String(node.wave + 1),
			node.name,
			node.state,
			node.fromVersion && node.version && node.fromVersion !== node.version
				? `${node.fromVersion} → ${node.version}`
				: (node.version ?? node.fromVersion ?? '-'),
			String(node.attempts),
			[node.error ?? '', node.guarded ? '' : 'no rollback guard'].filter(Boolean).join('; '),
		]);
	lines.push('', renderTable(['WAVE', 'NODE', 'STATE', 'VERSION', 'TRIES', 'NOTES'], rows));
	if (view.status === 'paused')
		lines.push(
			'',
			`Paused. \`yoal nodes rollout resume ${view.id}\` retries the failed nodes and continues; add --skip-failed to leave them. \`yoal nodes rollout cancel ${view.id}\` stops here.`,
		);
	return lines.join('\n');
}

export function formatRolloutList(views: RolloutView[]): string {
	if (views.length === 0) return 'No fleet updates yet.';
	return renderTable(
		['ID', 'STATUS', 'TARGET', 'STRATEGY', 'TRIGGER', 'STARTED', 'DONE', 'FAILED'],
		views.map((view) => [
			view.id,
			statusLine(view),
			view.targetVersion,
			view.options.strategy,
			view.trigger,
			formatTime(view.createdAt),
			`${view.counts.done}/${view.nodes.length}`,
			String(view.counts.failed),
		]),
	);
}

/** What changed between two polls, one line each, for `--wait`. */
export function rolloutChanges(previous: RolloutView | null, next: RolloutView): string[] {
	const lines: string[] = [];
	if (!previous || previous.currentWave !== next.currentWave) {
		if (next.currentWave < next.waves) {
			const names = next.nodes.filter((node) => node.wave === next.currentWave).map((node) => node.name);
			lines.push(`Wave ${next.currentWave + 1}/${next.waves}: ${names.join(', ')}`);
		}
	}
	const before = new Map((previous?.nodes ?? []).map((node) => [node.nodeId, node]));
	for (const node of next.nodes) {
		const old = before.get(node.nodeId);
		if (old && old.state === node.state && old.attempts === node.attempts) continue;
		if (!old && node.state === 'pending') continue;
		if (node.state === 'failed') lines.push(`  ${node.name}: failed${node.error ? `: ${node.error}` : ''}`);
		else if (node.state === 'done') lines.push(`  ${node.name}: done${node.version ? ` (${node.version})` : ''}`);
		else lines.push(`  ${node.name}: ${node.state}`);
	}
	if (!previous || previous.status !== next.status || previous.phase !== next.phase || previous.detail !== next.detail)
		lines.push(next.detail ? `${statusLine(next)}: ${next.detail}` : statusLine(next));
	return lines;
}

/** Parse a whole-number flag within limits; undefined when not given. */
export function wholeFlag(value: string | undefined, name: string, min: number, max: number): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max)
		throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`);
	return parsed;
}
