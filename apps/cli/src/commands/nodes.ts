import type { ApiClient } from '../api.ts';
import { parseArgs, requirePositional, type FlagSpec, type ParsedArgs } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import {
	ROLLOUT_LIMITS,
	ROLLOUT_STRATEGIES,
	formatRollout,
	formatRolloutList,
	formatRolloutPlan,
	resolveNode,
	rolloutChanges,
	rolloutExitCode,
	wholeFlag,
	type RolloutCreateInput,
	type RolloutStrategy,
	type RolloutView,
} from '../node-rollouts.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	yes: { type: 'boolean', short: 'y' },
	wait: { type: 'boolean' },
	strategy: { type: 'string' },
	batch: { type: 'string' },
	drain: { type: 'boolean' },
	canary: { type: 'boolean' },
	soak: { type: 'string' },
	'max-failures': { type: 'string' },
	node: { type: 'string', multiple: true },
	'skip-failed': { type: 'boolean' },
	limit: { type: 'string' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: yoal nodes <action> [options]

Update worker nodes to the control plane's version (platform admin). Starting, resuming and
cancelling need a dashboard session: an API key can plan and read, and gets 403 for the rest.

Actions:
  update <node>                      Install the control plane's release on one node (id or name)
  rollout plan [options]             Show the waves a fleet update would run now
  rollout start [options] [--yes] [--wait]
                                     Show the plan, confirm, start; --wait follows it to the end
  rollout status [id]                The running or paused rollout (or the given one)
  rollout list [--limit <n>]         Recent rollouts, newest first
  rollout resume <id> [--skip-failed] [--wait]
                                     Continue a paused rollout: retry its failed nodes, or leave them
  rollout cancel <id>                Stop further waves; nodes already installing finish on their own

Rollout options (unset ones come from Settings → Clustering → Node updates):
  --strategy <s>       availability (default: canary, then waves that keep every redundant group up),
                       rolling (--batch nodes at a time) or parallel (every node at once)
  --batch <n>          Nodes per wave for rolling (1-${ROLLOUT_LIMITS.maxBatchSize})
  --drain              Cordon each wave and move what can move off it first
  --canary, --no-canary  Update one node on its own first (default on, except parallel)
  --soak <s>           Seconds each wave must stay healthy before the next (0-${ROLLOUT_LIMITS.maxSoakSeconds})
  --max-failures <n>   Failed nodes allowed before the rollout pauses (default 0)
  --node <node>        Only this node (id or name); repeat for more

Options:
  --yes, -y   Start without asking
  --wait      Follow progress; exit 1 unless every node is updated
  --json      Print the raw response`;

/** Milliseconds between polls while following a rollout. */
const POLL_MS = 3_000;

export async function nodesCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help') || args.positionals.length === 0) {
		console.log(usage);
		return;
	}
	const action = requirePositional(args, 0, 'action');
	const client = await authenticatedClient();
	if (action === 'update') return updateOne(client, args);
	if (action === 'rollout' || action === 'rollouts') return rollout(client, args);
	throw new UsageError(`Unknown nodes action "${action}".\n\n${usage}`);
}

async function updateOne(client: ApiClient, args: ParsedArgs): Promise<void> {
	const ref = requirePositional(args, 1, 'node');
	const { nodes } = await client.listNodes();
	const node = resolveNode(nodes, ref);
	const { node: updated, raw } = await client.requestNodeUpdate(node.id);
	if (args.boolean('json')) return printJson(raw);
	console.log(
		`${updated.name ?? node.name} will install ${updated.update?.version ?? 'the new release'} on its next check. Its agent restarts when it is done.`,
	);
}

async function rollout(client: ApiClient, args: ParsedArgs): Promise<void> {
	const sub = args.positionals[1] ?? 'status';
	const json = args.boolean('json');

	if (sub === 'plan') {
		const input = await rolloutInput(client, args);
		const { plan, raw } = await client.planNodeRollout(input);
		if (json) return printJson(raw);
		console.log(formatRolloutPlan(plan));
		return;
	}

	if (sub === 'start') {
		const input = await rolloutInput(client, args);
		const { plan, raw: planRaw } = await client.planNodeRollout(input);
		if (!json) console.log(`${formatRolloutPlan(plan)}\n`);
		if (plan.waves.length === 0)
			throw new CliError(`No node can be updated to ${plan.targetVersion} now.`, { code: 'nothing_to_do', details: planRaw });
		const count = plan.waves.reduce((sum, wave) => sum + wave.nodes.length, 0);
		const confirmed = await confirmOrRefuse(`Update ${count} node${count === 1 ? '' : 's'} to ${plan.targetVersion}? [y/N] `, {
			yes: args.boolean('yes'),
			refusal: 'Refusing to start a fleet update without confirmation.',
		});
		if (!confirmed) {
			console.error('Nothing started.');
			process.exitCode = 1;
			return;
		}
		const { rollout: started, raw } = await client.startNodeRollout(input);
		if (args.boolean('wait')) return finish(client, started, json);
		if (json) return printJson(raw);
		console.log(`Started rollout ${started.id}. Follow it with \`yoal nodes rollout status\` or on the Nodes page.`);
		return;
	}

	if (sub === 'status') {
		const id = args.positionals[2];
		if (id) {
			const { rollout: view, raw } = await client.getNodeRollout(id);
			if (json) return printJson(raw);
			console.log(formatRollout(view));
			return;
		}
		const { active, rollouts } = await client.listNodeRollouts(1);
		if (json) return printJson(active);
		if (active) {
			console.log(formatRollout(active));
			return;
		}
		console.log('No fleet update is running.');
		if (rollouts[0]) console.log(`\nThe last one:\n${formatRollout(rollouts[0])}`);
		return;
	}

	if (sub === 'list') {
		const limit = wholeFlag(args.string('limit'), 'limit', 1, 100);
		const { rollouts, raw } = await client.listNodeRollouts(limit);
		if (json) return printJson(raw);
		console.log(formatRolloutList(rollouts));
		return;
	}

	if (sub === 'resume') {
		const id = requirePositional(args, 2, 'rollout id');
		const retryFailed = !args.boolean('skip-failed');
		const { rollout: view, raw } = await client.resumeNodeRollout(id, { retryFailed });
		if (args.boolean('wait')) return finish(client, view, json);
		if (json) return printJson(raw);
		console.log(
			retryFailed
				? `Rollout ${view.id} resumed: its failed nodes are tried again first.`
				: `Rollout ${view.id} resumed: its failed nodes are left as they are.`,
		);
		return;
	}

	if (sub === 'cancel') {
		const id = requirePositional(args, 2, 'rollout id');
		const { rollout: view, raw } = await client.cancelNodeRollout(id);
		if (json) return printJson(raw);
		console.log(
			`Rollout ${view.id} ${view.status}. No further waves start; a node already installing finishes on its own.`,
		);
		return;
	}

	throw new UsageError(`Unknown rollout action "${sub}".\n\n${usage}`);
}

/**
 * The request body from the flags. Unset options take the `updates` defaults from the cluster
 * configuration when it is readable, so the CLI starts what the dashboard dialog would.
 */
async function rolloutInput(client: ApiClient, args: ParsedArgs): Promise<RolloutCreateInput> {
	const strategy = args.string('strategy');
	if (strategy !== undefined && !ROLLOUT_STRATEGIES.includes(strategy as RolloutStrategy))
		throw new UsageError(`--strategy is one of ${ROLLOUT_STRATEGIES.join(', ')}.`);
	const given: RolloutCreateInput = {};
	if (strategy) given.strategy = strategy as RolloutStrategy;
	const batchSize = wholeFlag(args.string('batch'), 'batch', 1, ROLLOUT_LIMITS.maxBatchSize);
	if (batchSize !== undefined) given.batchSize = batchSize;
	const soakSeconds = wholeFlag(args.string('soak'), 'soak', 0, ROLLOUT_LIMITS.maxSoakSeconds);
	if (soakSeconds !== undefined) given.soakSeconds = soakSeconds;
	const maxFailures = wholeFlag(args.string('max-failures'), 'max-failures', 0, ROLLOUT_LIMITS.maxFailures);
	if (maxFailures !== undefined) given.maxFailures = maxFailures;
	if (args.has('drain')) given.drain = args.boolean('drain');
	if (args.has('canary')) given.canary = args.boolean('canary');
	if (batchSize !== undefined && strategy !== undefined && strategy !== 'rolling')
		throw new UsageError('--batch only applies to --strategy rolling.');

	const refs = args.strings('node');
	if (refs.length > 0) {
		const { nodes } = await client.listNodes();
		given.nodeIds = [...new Set(refs.map((ref) => resolveNode(nodes, ref).id))];
	}

	const defaults = await client.getRolloutDefaults().catch(() => null);
	const input: RolloutCreateInput = {};
	for (const key of ['strategy', 'batchSize', 'canary', 'drain', 'soakSeconds', 'maxFailures'] as const) {
		const value = given[key] ?? defaults?.[key];
		if (value !== undefined) (input as Record<string, unknown>)[key] = value;
	}
	if (given.nodeIds) input.nodeIds = given.nodeIds;
	return input;
}

async function finish(client: ApiClient, view: RolloutView, json: boolean): Promise<void> {
	const last = await followRollout(client, view, { log: json ? () => undefined : (line) => console.log(line) });
	if (json) printJson(last);
	else {
		console.log('');
		console.log(formatRollout(last));
	}
	process.exitCode = rolloutExitCode(last);
}

/**
 * Poll a rollout until it stops running (finished, or paused for an operator), printing each
 * wave, node and phase change once. Returns the last view.
 */
export async function followRollout(
	client: Pick<ApiClient, 'getNodeRollout'>,
	start: RolloutView,
	options: { log: (line: string) => void; sleep?: (ms: number) => Promise<void>; intervalMs?: number },
): Promise<RolloutView> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let previous: RolloutView | null = null;
	let current = start;
	for (;;) {
		for (const line of rolloutChanges(previous, current)) options.log(line);
		if (current.status !== 'running') return current;
		previous = current;
		await sleep(options.intervalMs ?? POLL_MS);
		current = (await client.getNodeRollout(start.id)).rollout;
	}
}
