import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Durability and planned switchover (HA-PLAN H23/W10, docs/CLUSTERING.md §9). The server decides
 * every refusal: two replicas in different zones (or `on_sync_loss: block`), a fresh replay
 * position, an open sync change, and a non-zero WAL gap at switchover.
 */

export const durabilityUsage = `Usage:
  yoal db durability <name>                     Show the requested policy and what is in force
  yoal db durability <name> --sync              Make a replica synchronous (three-step change)
      --async                                   Return to async (closes any open change)
      --timeout <seconds>                       How long to wait before on_sync_loss (default 30)
      --on-sync-loss downgrade|block            Lose the standby: go async, or block writes
  yoal db switchover <name> <replica-id>        Planned switchover: checkpoint, stop writes, wait
                                                for LSN equality, promote, re-point (asks; --yes)
      --json                                    JSON output
  -h, --help                                    Show this help

\`sync\` needs two replicas in different zones unless --on-sync-loss block. It is entered through a
non-promotable transition: the lease opens \`changing\`, the primary's node sets the standby and
writes a barrier, and only an acknowledged barrier closes it. A switchover is refused when the
replica has not replayed the primary's last LSN; writes are resumed and nothing is promoted.`;

const base: FlagSpec = {
	json: { type: 'boolean' },
	sync: { type: 'boolean' },
	async: { type: 'boolean' },
	timeout: { type: 'string' },
	'on-sync-loss': { type: 'string' },
	yes: { type: 'boolean', short: 'y' },
	help: { type: 'boolean', short: 'h' },
};

export async function durabilityCommand(argv: string[]): Promise<void> {
	const [verb, ...rest] = argv;
	if (!verb || verb === '-h' || verb === '--help' || verb === 'help') {
		console.log(durabilityUsage);
		return;
	}
	if (verb === 'switchover') return switchover(rest);
	return durability(verb, rest);
}

async function durability(name: string, argv: string[]): Promise<void> {
	const args = parseArgs(argv, base);
	if (args.boolean('help')) {
		console.log(durabilityUsage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal db durability <name> [--sync|--async]');
	const client = await authenticatedClient();
	if (args.boolean('sync') && args.boolean('async'))
		throw new UsageError('Choose one of --sync or --async.');
	const timeout = args.string('timeout');
	const onSyncLoss = args.string('on-sync-loss');
	const desired = args.boolean('sync') ? 'sync' : args.boolean('async') ? 'async' : undefined;
	if (onSyncLoss !== undefined && onSyncLoss !== 'downgrade' && onSyncLoss !== 'block')
		throw new UsageError('--on-sync-loss must be downgrade or block.');
	if (timeout !== undefined && (!Number.isInteger(Number(timeout)) || Number(timeout) < 0 || Number(timeout) > 300))
		throw new UsageError('--timeout must be a whole number of seconds from 0 to 300.');
	const changed = desired !== undefined || timeout !== undefined || onSyncLoss !== undefined;
	const { durability, raw } = changed
		? await client.setDatabaseDurability(name, {
				...(desired ? { durability: desired } : {}),
				...(timeout !== undefined ? { syncTimeoutSeconds: Number(timeout) } : {}),
				...(onSyncLoss !== undefined ? { onSyncLoss } : {}),
			})
		: await client.databaseDurability(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		renderTable(
			['FIELD', 'VALUE'],
			[
				['configured', durability.durability],
				['effective', durability.durabilityEffective],
				['sync state', durability.syncState],
				['sync set', durability.sync.length > 0 ? durability.sync.join(', ') : '—'],
				['sync timeout', `${durability.syncTimeoutSeconds} s`],
				['on sync loss', durability.onSyncLoss],
				['since', durability.syncSetAt ?? '—'],
			],
		),
	);
	if (durability.transition) console.log(`\nChange open: ${durability.transition.phase} → ${durability.transition.target ?? '?'} until ${durability.transition.deadline}`);
	if (durability.note) console.log(`\n${durability.note}`);
	if (desired === 'sync' && durability.syncState === 'changing')
		console.log('\nThe change is open; the primary\'s node is applying the setting and the barrier. Check again with `yoal db durability`.');
}

async function switchover(argv: string[]): Promise<void> {
	const args = parseArgs(argv, base);
	if (args.boolean('help')) {
		console.log(durabilityUsage);
		return;
	}
	rejectExtraPositionals(args, 2, 'Usage: yoal db switchover <name> <replica-id>');
	const name = requirePositional(args, 0, `database name.\n\n${durabilityUsage}`);
	const replicaId = requirePositional(args, 1, `replica id.\n\n${durabilityUsage}`);
	const client = await authenticatedClient();
	const current = await client.databaseReplicas(name);
	const replica = current.replicas.find((item) => item.id === replicaId);
	const confirmed = await confirmOrRefuse(
		`Switch "${name}" over to replica ${replicaId}${replica ? ` on ${replica.nodeName ?? replica.nodeId}` : ''}? ` +
			'Writes stop briefly; a replica that has not replayed the primary is refused and nothing is promoted. ' +
			`Type ${name} to confirm: `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => answer === name,
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before switching over ${name}.`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const { switchover: result, raw } = await client.switchoverDatabase(name, replicaId);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Switchover ${result.databaseId} → ${result.toNodeId} (generation ${result.generation}): ${result.step}. ` +
			`The old primary stops writes, the replica must reach LSN equality, then it is promoted. ` +
			'Follow it with `yoal db replica list`.',
	);
}
