import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { printJson, renderTable } from '../output.ts';
import type { ScalingStatusView } from '../scaling.ts';
import { formatScaling } from '../scaling.ts';
import { authenticatedClient } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	auto: { type: 'boolean' },
	off: { type: 'boolean' },
	resume: { type: 'boolean' },
	min: { type: 'string' },
	max: { type: 'string' },
	cpu: { type: 'string' },
	memory: { type: 'string' },
	rps: { type: 'string' },
	'scale-down': { type: 'string' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: yoal scale <project> [copies] [options]

Run more or fewer copies of an app. Takes effect at once, with no deploy; running copies are not
restarted. An HTTP app runs one copy per node; a worker spreads across nodes and then shares them.

  yoal scale shop                 Show the copies, where they run, their usage and the autoscaler
  yoal scale shop 3               Run three copies
  yoal scale shop --auto --min 2 --max 6 --cpu 60
                                  Keep CPU near 60% of each copy's limit with 2 to 6 copies
  yoal scale shop --off           Turn autoscaling off (the app keeps the copies it has)
  yoal scale shop --resume        Carry on with a paused rollout

Autoscaling options (with --auto):
  --min <n> --max <n>   Bounds on the number of copies (default 1 and 3)
  --cpu <percent>       Target CPU, as a share of each copy's limit (10-95; the default signal, at 70)
  --memory <percent>    Target memory instead
  --rps <n>             Target requests per second per copy instead (needs telemetry)
  --scale-down <min>    Minutes the load must stay low before a copy is removed (default 5)

  --json                Print the raw response`;

const number = (value: string | undefined, name: string): number | undefined => {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`--${name} must be a positive number.`);
	return parsed;
};

export async function scaleCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help') || args.positionals.length === 0) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 2, usage);
	const project = requirePositional(args, 0, 'project slug');
	const copies = args.positionals[1];
	const json = args.boolean('json');
	const client = await authenticatedClient();
	const show = (view: ScalingStatusView, raw: unknown) => (json ? printJson(raw) : console.log(formatScaling(view)));

	if (args.boolean('resume')) {
		const { view, raw } = await client.resumeRollout(project);
		return show(view, raw);
	}
	if (args.boolean('off')) {
		const { view: current } = await client.getScaling(project);
		const { view, raw } = await client.setScalingPolicy(project, { ...current.policy, enabled: false });
		return show(view, raw);
	}
	if (args.boolean('auto')) {
		const signals = [args.string('cpu'), args.string('memory'), args.string('rps')].filter((value) => value !== undefined);
		if (signals.length > 1) throw new UsageError('Pick one signal: --cpu, --memory or --rps.');
		const { view: current } = await client.getScaling(project);
		const metric = args.string('rps') !== undefined ? 'requests' : args.string('memory') !== undefined ? 'memory' : args.string('cpu') !== undefined ? 'cpu' : current.policy.metric;
		const target = number(args.string('rps'), 'rps') ?? number(args.string('memory'), 'memory') ?? number(args.string('cpu'), 'cpu');
		const { view, raw } = await client.setScalingPolicy(project, {
			enabled: true,
			min: number(args.string('min'), 'min') ?? current.policy.min,
			max: number(args.string('max'), 'max') ?? current.policy.max,
			metric,
			// Switching signal without a number takes that signal's usual target, not the old one's.
			target: target ?? (metric === current.policy.metric ? current.policy.target : metric === 'requests' ? 50 : 70),
			scaleDownMinutes: number(args.string('scale-down'), 'scale-down') ?? current.policy.scaleDownMinutes,
		});
		return show(view, raw);
	}
	if (copies !== undefined) {
		const replicas = Number(copies);
		if (!Number.isInteger(replicas) || replicas < 1) throw new UsageError('The number of copies is a whole number, 1 or more.');
		const { result, raw } = await client.scaleProject(project, replicas);
		if (json) return printJson(raw);
		if (result.from === result.to) {
			console.log(`${result.project} already runs ${result.to} ${result.to === 1 ? 'copy' : 'copies'}.`);
			return;
		}
		console.log(`${result.project}: ${result.from} → ${result.to} ${result.to === 1 ? 'copy' : 'copies'}.`);
		const rows = [
			...result.added.map((copy) => [`r${copy.index}`, copy.nodeName, 'starting']),
			...result.removed.map((copy) => [`r${copy.index}`, copy.nodeName, 'stopping']),
		];
		if (rows.length > 0) console.log(`\n${renderTable(['COPY', 'NODE', ''], rows)}`);
		return;
	}
	const { view, raw } = await client.getScaling(project);
	show(view, raw);
}
