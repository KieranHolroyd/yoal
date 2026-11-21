import { parseArgs, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { formatChecks } from '../ha-checks.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

export const doctorUsage = `Usage: yoal doctor [--json]

Check the running install (platform operator or admin): the preflight checks for its own HA
profile, then each node's heartbeat, applied Caddy config, desired-state drift, agent version and
data disk. Every problem comes with the exact fix. Changes nothing. Exit status 1 when anything
fails.

Options:
  --json   Print the raw report`;

/** `yoal doctor` (HA-PLAN H27, W14). */
export async function doctorCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(doctorUsage);
		return;
	}
	if (args.positionals.length > 0) throw new UsageError(doctorUsage);
	const client = await authenticatedClient();
	const { report, raw } = await client.getHaDoctor();
	if (args.boolean('json')) printJson(raw);
	else console.log(formatChecks(report));
	if (!report.ok) process.exitCode = 1;
}
