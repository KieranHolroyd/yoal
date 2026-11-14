import { parseArgs, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { formatFleetLinks, formatFleetStatus, formatMoves, formatRelocation } from '../fleet.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	apply: { type: 'boolean' },
	pinned: { type: 'boolean' },
	'with-data': { type: 'boolean' },
	status: { type: 'boolean' },
	cancel: { type: 'boolean' },
	strategy: { type: 'string' },
	from: { type: 'string' },
	to: { type: 'string' },
	seconds: { type: 'string' },
	streams: { type: 'string' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: yoal fleet <action> [options]

How the fleet's capacity is used, and how its nodes are connected (platform admin).

Actions:
  status [--pinned]                      Reserved and live memory per node, and what a rebalance would move
  rebalance [--apply] [--strategy <s>]   Preview the moves; --apply makes them. Strategy: spread or pack
  move <project> [--to <node>]           Move one app to another node (the scheduler picks unless --to)
  move <project> --with-data [--to <node>]
                                         Move an app and its app volumes: it is stopped while they are copied
  move <project> --status | --cancel     Follow a move with data, or stop it before the switch
  links                                  Latency, loss, path and the last throughput test for every pair of nodes
  link-test [--from <node>] [--to <node>] [--seconds <n>] [--streams <n>]
                                         Stress the links: one pair, one node against the rest, or every pair

Options:
  --pinned   Also list the workloads that cannot move, and why
  --json     Print the raw response`;

const wholeNumber = (value: string | undefined, name: string, min: number, max: number): number | undefined => {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`);
	return parsed;
};

export async function fleetCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help') || args.positionals.length === 0) {
		console.log(usage);
		return;
	}
	const action = requirePositional(args, 0, 'action');
	const json = args.boolean('json');
	const client = await authenticatedClient();

	if (action === 'status') {
		const { view, raw } = await client.getFleetStatus();
		if (json) return printJson(raw);
		console.log(formatFleetStatus(view, { pinned: args.boolean('pinned') }));
		return;
	}
	if (action === 'rebalance') {
		const strategy = args.string('strategy');
		if (strategy !== undefined && strategy !== 'spread' && strategy !== 'pack') throw new UsageError('--strategy is spread or pack.');
		const { result, raw } = await client.rebalanceFleet({ apply: args.boolean('apply'), ...(strategy ? { strategy } : {}) });
		if (json) return printJson(raw);
		console.log(result.plan.summary);
		if (result.plan.moves.length > 0) console.log(`\n${formatMoves(result.applied ? result.moved : result.plan.moves)}`);
		for (const skipped of result.skipped) console.log(`Skipped ${skipped.label}: ${skipped.reason}`);
		if (!result.applied && result.plan.moves.length > 0) console.log('\nNothing was moved. Add --apply to make these moves.');
		if (result.applied && result.moved.length > 0) console.log('\nMoves started. `yoal ha status` shows them finishing.');
		return;
	}
	if (action === 'move') {
		const project = requirePositional(args, 1, 'project');
		const to = args.string('to');
		if (args.boolean('status') || args.boolean('cancel') || args.boolean('with-data')) {
			const { result, raw } = args.boolean('cancel')
				? await client.cancelRelocation(project)
				: args.boolean('status')
					? await client.getRelocation(project)
					: await client.relocateProject(project, to ? { node: to } : {});
			if (json) return printJson(raw);
			console.log(result ? formatRelocation(result) : `${project} has never been moved with its data.`);
			return;
		}
		const { result, raw } = await client.rescheduleProject(project, to ? { node: to } : {});
		if (json) return printJson(raw);
		console.log(
			`${result.project}: ${result.from.name} → ${result.to.name} (${
				result.mode === 'surge' ? 'the old copy serves until the new one is up' : 'stops, then starts on the new node'
			}).`,
		);
		return;
	}
	if (action === 'links') {
		const { view, raw } = await client.getFleetLinks();
		if (json) return printJson(raw);
		console.log(formatFleetLinks(view));
		return;
	}
	if (action === 'link-test') {
		const seconds = wholeNumber(args.string('seconds'), 'seconds', 1, 30);
		const streams = wholeNumber(args.string('streams'), 'streams', 1, 8);
		const from = args.string('from');
		const to = args.string('to');
		const { result, raw } = await client.startLinkTest({
			...(from ? { from } : {}),
			...(to ? { to } : {}),
			...(seconds ? { seconds } : {}),
			...(streams ? { streams } : {}),
		});
		if (json) return printJson(raw);
		console.log(`${result.queued.length} link test(s) queued.`);
		for (const skipped of result.skipped) console.log(`Skipped: ${skipped.reason}`);
		if (result.queued.length > 0) console.log('Results appear in `yoal fleet links` as each test finishes.');
		return;
	}
	throw new UsageError(`Unknown fleet action "${action}".\n\n${usage}`);
}
