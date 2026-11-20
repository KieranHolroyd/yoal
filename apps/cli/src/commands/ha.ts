import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { formatControlStatus, formatHaStatus } from '../ha.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	events: { type: 'string' },
	'expect-epoch': { type: 'string' },
	node: { type: 'string' },
	csr: { type: 'string' },
	reason: { type: 'string' },
	out: { type: 'string' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: yoal ha <action> [options]

HA and the control plane (platform admin).

Actions:
  status [--events <n>] [--json]
      Failover controller: lease, lost nodes, ingress, database candidates and recent events.
  control status [--json]
      Every control node: role (joining, standby, standby-behind, promoting, primary, fenced,
      unavailable), epoch, lease holder, canPromote and replica lag.
  control promote [--expect-epoch <n>] [--json]
      Promote this control node. Still a compare-and-swap: a stale epoch is refused (409), and an
      unverifiable master key, config digest or replay keeps canPromote false.
  control enrol --node <id> --csr <file> [--reason <text>] [--out <file>] [--json]
      Sign a standby's CSR (needs a dashboard session that proved a second factor) and return the
      sealed master-key/config bundle plus a one-time activation code. --out writes it 0600.

Options:
  --events <n>       Recent events to list (default 10, at most 50)
  --expect-epoch <n> Refuse the promotion when the lease is not at this epoch
  --node <id>        The standby being enrolled
  --csr <file>       PEM certificate signing request generated on the standby
  --reason <text>    Audit reason for the certificate
  --out <file>       Write the enrolment response to this file (0600)
  --json             Print the raw response`;

export async function haCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help') || args.positionals.length === 0) {
		console.log(usage);
		return;
	}
	const action = requirePositional(args, 0, 'action');
	if (action === 'control') return controlCommand(args);

	if (action !== 'status') throw new UsageError(`Unknown ha action "${action}".\n\n${usage}`);
	if (args.positionals.length > 1) throw new UsageError(usage);
	const events = args.string('events');
	const count = events === undefined ? 10 : Number(events);
	if (!Number.isInteger(count) || count < 0 || count > 50) throw new UsageError('--events must be a whole number from 0 to 50.');
	const client = await authenticatedClient();
	const { status, raw } = await client.getHaStatus();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(formatHaStatus(status, { events: count }));
}

async function controlCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
	const sub = requirePositional(args, 1, 'control action');
	const client = await authenticatedClient();
	if (sub === 'status') {
		if (args.positionals.length > 2) throw new UsageError(usage);
		const { status, raw } = await client.getHaStatus();
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(formatControlStatus(status.controlPlane ?? []));
		return;
	}
	if (sub === 'promote') {
		if (args.positionals.length > 2) throw new UsageError(usage);
		const expected = args.string('expect-epoch');
		const expectedEpoch = expected === undefined ? undefined : Number(expected);
		if (expectedEpoch !== undefined && (!Number.isInteger(expectedEpoch) || expectedEpoch < 1))
			throw new UsageError('--expect-epoch must be a positive whole number.');
		const { raw } = await client.promoteControl(expectedEpoch);
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(`Promotion accepted. ${expectedEpoch === undefined ? '' : `Lease was at epoch ${expectedEpoch}. `}Run \`yoal ha control status\` to confirm every node reports the new epoch.`);
		return;
	}
	if (sub === 'enrol') {
		if (args.positionals.length > 2) throw new UsageError(usage);
		const nodeId = args.string('node');
		const csrPath = args.string('csr');
		if (!nodeId) throw new UsageError('Missing --node.');
		if (!csrPath) throw new UsageError('Missing --csr.');
		const csrPem = await readFile(csrPath, 'utf8').catch(() => {
			throw new UsageError(`Could not read the CSR at ${csrPath}.`);
		});
		const { result, raw } = await client.enrolControl({
			nodeId,
			csrPem,
			...(args.string('reason') ? { reason: args.string('reason') } : {}),
		});
		const out = args.string('out');
		if (out) {
			await mkdir(dirname(out), { recursive: true });
			await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
		}
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(
			[
				`Enrolled ${nodeId}: certificate ${result.certificate.serial} valid until ${result.certificate.notAfter}.`,
				`Activation code (shown once): ${result.activationCode}`,
				out ? `Sealed bundle written to ${out} (0600). Move it to ${nodeId} and open it with the code.` : 'Save the sealed bundle and the code now; they are not stored anywhere.',
				'On the standby: open the bundle, write the master key 0400 and the allowlisted yoal.env, then set YOAL_CONTROL_ROLE=standby and start it.',
			].join('\n'),
		);
		return;
	}
	throw new UsageError(`Unknown control action "${sub}".\n\n${usage}`);
}
