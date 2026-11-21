import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Automatic database failover (HA-PLAN W11, docs/build-plan/W11-SPEC.md §3/§12).
 *
 * `arm` is a destructive policy change: it makes a replica able to promote itself. Every gate is
 * the server's, and the CLI shows each refusal verbatim. `disarm` is immediate and never fences a
 * healthy primary. `drill` is the same promotion path with a measured time to writable.
 */

export const failoverUsage = `Usage:
  yoal db failover <name>                     Show the policy, evidence and every refusal
  yoal db failover <name> --arm               Arm automatic failover (asks; --yes to skip)
      --accept-data-loss                      Async only: accept that a promotion may lose commits
      --drill-id <id>                         Arm on this passed drill (default: the latest)
  yoal db failover <name> --disarm            Turn automatic failover off now (no confirmation)
  yoal db failover <name> --drill --target <disposable>
                                                Run a measured drill on a disposable database
      --note <text>                           Record a note with the drill
      --json                                  JSON output
  -h, --help                                  Show this help

\`auto\` needs DB_AUTO_PROMOTE with at least three data nodes in two zones, a db-member agent on
every member, a replica on another online node, no open switchover or sync change, and a passed
drill within 30 days that measured a time to writable within 30 s and proved the arbiter. A sync
drill must also record no lost commits; an async database needs --accept-data-loss.`;

const flags: FlagSpec = {
	json: { type: 'boolean' },
	arm: { type: 'boolean' },
	disarm: { type: 'boolean' },
	drill: { type: 'boolean' },
	'accept-data-loss': { type: 'boolean' },
	'drill-id': { type: 'string' },
	target: { type: 'string' },
	note: { type: 'string' },
	yes: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

export async function failoverCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(failoverUsage);
		return;
	}
	rejectExtraPositionals(args, 1, `Usage: yoal db failover <name> [--arm|--disarm|--drill]`);
	const name = requirePositional(args, 0, `database name.\n\n${failoverUsage}`);
	const verbs = [args.boolean('arm'), args.boolean('disarm'), args.boolean('drill')].filter(Boolean).length;
	if (verbs > 1) throw new UsageError('Choose one of --arm, --disarm or --drill.');
	const client = await authenticatedClient();
	if (args.boolean('disarm')) {
		const { failover } = await client.disarmDatabaseFailover(name);
		if (args.boolean('json')) return printJson(failover);
		console.log(`Automatic failover is off for "${name}". The primary keeps serving; nothing was fenced.`);
		return;
	}
	if (args.boolean('drill')) {
		const target = args.string('target');
		if (!target) throw new UsageError('A drill needs a disposable target: pass --target <database> (never the production database).');
		const note = args.string('note');
		const { drill } = await client.drillDatabaseFailover(name, target, note);
		if (args.boolean('json')) return printJson(drill);
		console.log(`Drill ${drill.id} started: generation ${drill.generation}, ${drill.fromNodeId ?? '?'} → ${drill.toNodeId ?? '?'}.`);
		console.log('It records the measured time to writable when the promotion completes; check `yoal db failover` for the result.');
		return;
	}
	if (!args.boolean('arm')) {
		const { failover, raw } = await client.databaseFailover(name);
		if (args.boolean('json')) return printJson(raw);
		const rows: Array<[string, string]> = [
			['mode', failover.failoverMode],
			['active', failover.active ? 'yes' : 'no'],
			['controller enabled', failover.controllerEnabled ? 'yes' : 'no'],
			['controller handler', failover.controllerInstalled ? 'installed' : 'not installed'],
			['member self-fencing', failover.selfFencing ? 'advertised' : 'missing'],
			['accept data loss', failover.acceptDataLoss ? 'yes' : 'no'],
			['armed at', failover.autoArmedAt ?? '—'],
			['last drill', failover.lastDrill ? `${failover.lastDrill.status} (${failover.lastDrill.timeToWritableMs ?? '?'} ms)` : '—'],
			['last passed drill', failover.lastFailoverDrillAt ?? '—'],
		];
		console.log(renderTable(['FIELD', 'VALUE'], rows));
		if (failover.refusals.length > 0) {
			console.log('\nRefusals:');
			for (const refusal of failover.refusals) console.log(`  - ${refusal.message}`);
		}
		return;
	}
	const acceptDataLoss = args.boolean('accept-data-loss');
	const confirmed = await confirmOrRefuse(
		`Arm automatic failover for "${name}"? A replica will be able to promote itself when the primary's lease expires. ` +
			`${acceptDataLoss ? 'It may lose recent commits (async). ' : ''}Type ${name} to confirm: `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => answer === name,
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before arming automatic failover for ${name}.`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const drillId = args.string('drill-id');
	const { failover } = await client.armDatabaseFailover(name, {
		acceptDataLoss,
		...(drillId ? { drillId } : {}),
	});
	if (args.boolean('json')) return printJson(failover);
	console.log(`Automatic failover is armed for "${name}" (generation evidence recorded at ${failover.autoArmedAt}).`);
}
