import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs, requirePositional, type FlagSpec } from '../args.ts';
import { installControlEnrolment, parseSealedControlBundle } from '../control-enrol.ts';
import { UsageError } from '../errors.ts';
import { formatControlStatus, formatHaStatus } from '../ha.ts';
import { formatDrill, formatDrillList, formatMs } from '../drills.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	events: { type: 'string' },
	'expect-epoch': { type: 'string' },
	'break-glass': { type: 'boolean' },
	node: { type: 'string' },
	csr: { type: 'string' },
	reason: { type: 'string' },
	out: { type: 'string' },
	open: { type: 'string' },
	code: { type: 'string' },
	'data-dir': { type: 'string' },
	'master-key': { type: 'string' },
	env: { type: 'string' },
	minutes: { type: 'string' },
	'include-control': { type: 'boolean' },
	wait: { type: 'boolean' },
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
  control promote [--expect-epoch <n>] [--break-glass] [--json]
      Promote this control node. Still a compare-and-swap: a stale epoch is refused (409), an
      unverifiable master key, config digest or replay keeps canPromote false, and the lease must be
      released or expired for 40 s. --break-glass skips expiry only after the old primary is stopped.
  control enrol --node <id> --csr <file> [--reason <text>] [--out <file>] [--json]
      On the primary: sign a standby's CSR (needs a dashboard session that proved a second factor)
      and return the sealed bundle, certificate and a one-time activation code. --out writes the
      bundle and certificate 0600; the code is never written to it.
  control enrol --open <bundle.json> --code <activation-code> [--data-dir <dir>]
                [--master-key <path>] [--env <path>]
      On the standby: unseal the bundle, verify the master-key fingerprint and config digest, write
      master.key 0400 and the allowlisted yoal.env 0600, and write the enrolment record 0600.
      Promotion is refused on a host without that record.
  drill node-offline [--node <id|name>] [--minutes <n>] [--include-control] [--wait] [--json]
      Disaster drill: take a node off the control plane for a while (default 5 min, 1–30) so the
      failover controller, alerts and steering react as to a real loss. Without --node a random
      eligible node is picked; the control-plane host only with --include-control. The node comes
      back by itself. --wait follows it and prints the report: detection time, recovery time and
      every failover action. Ctrl-C while waiting ends the drill early.
  drill list [--json]
      Which nodes may be drilled, the running drill and recent results.
  drill show <id> [--json]   One drill's report.
  drill cancel <id> [--json] End a running drill; the node is back within about 5 s.

Options:
  --events <n>       Recent events to list (default 10, at most 50)
  --expect-epoch <n> Refuse the promotion when the lease is not at this epoch
  --break-glass      Promote without waiting for expiry/quiet window (old primary stopped)
  --node <id>        The standby being enrolled
  --csr <file>       PEM certificate signing request generated on the standby
  --reason <text>    Audit reason for the certificate
  --out <file>       Write the enrolment response (bundle and certificate) to this file (0600)
  --open <file>      The sealed bundle received from the primary (standby side)
  --code <value>     The one-time activation code (or YOAL_ACTIVATION_CODE)
  --data-dir <dir>   Standby data directory for the enrolment record (default /var/lib/yoal/data)
  --master-key <f>   Master key path (default /etc/yoal/master.key)
  --env <file>       Allowlisted env file to merge (default /etc/yoal/yoal.env)
  --json             Print the raw response`;

export async function haCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help') || args.positionals.length === 0) {
		console.log(usage);
		return;
	}
	const action = requirePositional(args, 0, 'action');
	if (action === 'control') return controlCommand(args);
	if (action === 'drill') return drillCommand(args);

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
		const { raw } = await client.promoteControl(expectedEpoch, args.boolean('break-glass'));
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(`Promotion accepted. ${expectedEpoch === undefined ? '' : `Lease was at epoch ${expectedEpoch}. `}Run \`yoal ha control status\` to confirm every node reports the new epoch.`);
		return;
	}
	if (sub === 'enrol') {
		if (args.positionals.length > 2) throw new UsageError(usage);
		const open = args.string('open');
		if (open) return standbyEnrolCommand(args, open);
		const nodeId = args.string('node');
		const csrPath = args.string('csr');
		if (!nodeId) throw new UsageError('Missing --node (or use --open on the standby).');
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
			// The activation code is shown once on stdout; it must never sit next to the sealed bundle.
			const material = { bundle: result.bundle, certificate: result.certificate };
			await writeFile(out, `${JSON.stringify(material, null, 2)}\n`, { mode: 0o600 });
			// `mode` only applies to a new file; tighten an existing one too.
			await chmod(out, 0o600).catch(() => undefined);
		}
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(
			[
				`Enrolled ${nodeId}: certificate ${result.certificate.serial} valid until ${result.certificate.notAfter}.`,
				`Activation code (shown once, never written to --out): ${result.activationCode}`,
				out ? `Sealed bundle and certificate written to ${out} (0600). Move it to ${nodeId} and open it with the code.` : 'Save the sealed bundle and the code now; they are not stored anywhere.',
				`On the standby: yoal ha control enrol --open ${out ?? '<bundle.json>'} --code <activation-code>`,
			].join('\n'),
		);
		return;
	}
	throw new UsageError(`Unknown control action "${sub}".\n\n${usage}`);
}

async function standbyEnrolCommand(args: ReturnType<typeof parseArgs>, openPath: string): Promise<void> {
	const code = args.string('code') ?? process.env.YOAL_ACTIVATION_CODE?.trim();
	if (!code) throw new UsageError('Missing --code (or YOAL_ACTIVATION_CODE): the one-time activation code.');
	const dataDir = args.string('data-dir') ?? process.env.YOAL_DATA_DIR ?? '/var/lib/yoal/data';
	const masterKeyPath = args.string('master-key') ?? process.env.YOAL_MASTER_KEY_PATH ?? '/etc/yoal/master.key';
	const envPath = args.string('env') ?? '/etc/yoal/yoal.env';
	const text = await readFile(openPath, 'utf8').catch(() => {
		throw new UsageError(`Could not read the sealed bundle at ${openPath}.`);
	});
	let installed;
	try {
		installed = await installControlEnrolment({
			bundle: parseSealedControlBundle(text),
			activationCode: code,
			dataDir,
			masterKeyPath,
			envPath,
		});
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	if (args.boolean('json')) {
		printJson(installed);
		return;
	}
	console.log(
		[
			`Enrolled ${installed.nodeId} (primary ${installed.primaryNodeId}).`,
			`Master key written to ${installed.masterKeyPath} (0400); fingerprint ${installed.masterKeyFingerprint}.`,
			`Allowlisted config merged into ${installed.envPath} (0600); digest ${installed.configDigest}.`,
			`Enrolment record written to ${installed.recordPath} (0600); replica ${installed.replica.restored ? `restored, ${installed.replica.lagSeconds ?? '?'} s behind` : 'not restored yet'}.`,
			`Next: set YOAL_CONTROL_ROLE=standby and YOAL_FEATURE_CONTROL_STANDBY=1, then start yoal-control-plane. Promotion is refused until ${join(dataDir, 'ha-control-enrolment.json')} exists.`,
		].join('\n'),
	);
}

/** `yoal ha drill` (D235): node offline drills. */
async function drillCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
	const sub = requirePositional(args, 1, 'drill action');
	const client = await authenticatedClient();
	const json = args.boolean('json');
	if (sub === 'list') {
		const { view, raw } = await client.listDrills();
		if (json) printJson(raw);
		else console.log(formatDrillList(view));
		return;
	}
	if (sub === 'show' || sub === 'cancel') {
		const id = requirePositional(args, 2, 'drill id');
		const drill = sub === 'show' ? await client.getDrill(id) : await client.cancelDrill(id);
		if (json) printJson(drill);
		else console.log(sub === 'cancel' ? `Ended the drill on ${drill.nodeName}; it is back within about 5 s.` : formatDrill(drill));
		return;
	}
	if (sub !== 'node-offline') throw new UsageError(`Unknown drill action "${sub}".\n\n${usage}`);

	const minutesFlag = args.string('minutes');
	const minutes = minutesFlag === undefined ? 5 : Number(minutesFlag);
	if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw new UsageError('--minutes must be a whole number from 1 to 30.');
	const node = args.string('node');
	let drill = await client.startDrill({
		...(node ? { node } : {}),
		durationSeconds: minutes * 60,
		includeControlNode: args.boolean('include-control'),
	});
	if (!args.boolean('wait')) {
		if (json) printJson(drill);
		else
			console.log(
				`Drill ${drill.id}: ${drill.nodeName}${drill.random ? ' (picked at random)' : ''} is offline until ${new Date(drill.endsAt).toISOString()}.\nFollow it with \`yoal ha drill show ${drill.id}\` or Settings → High availability; end it early with \`yoal ha drill cancel ${drill.id}\`.`,
			);
		return;
	}

	console.error(`Drill ${drill.id}: ${drill.nodeName}${drill.random ? ' (picked at random)' : ''} is going offline for ${minutes} min. Ctrl-C ends it early.`);
	let interrupted = false;
	const onInterrupt = () => {
		if (interrupted) process.exit(130);
		interrupted = true;
		console.error('\nEnding the drill…');
		void client.cancelDrill(drill.id).catch(() => undefined);
	};
	// Bun's process typings only augment `memoryPressure`; the Node signal overloads work at runtime.
	const signals = process as unknown as { on(event: 'SIGINT', listener: () => void): void; off(event: 'SIGINT', listener: () => void): void };
	signals.on('SIGINT', onInterrupt);
	try {
		let marked = false;
		// The report is final once the node is back, or the drill failed without it.
		while (drill.status === 'running' || (drill.restoredAt === null && drill.finishedAt === null)) {
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			drill = await client.getDrill(drill.id);
			if (!marked && drill.offlineAt !== null) {
				marked = true;
				console.error(`  marked offline ${formatMs(drill.offlineAt - drill.startedAt)} after the start`);
			}
		}
	} finally {
		signals.off('SIGINT', onInterrupt);
	}
	if (json) printJson(drill);
	else console.log(formatDrill(drill));
	if (drill.status === 'failed') process.exitCode = 1;
}
