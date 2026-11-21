import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs, requirePositional, type FlagSpec } from '../args.ts';
import { installControlEnrolment, parseSealedControlBundle } from '../control-enrol.ts';
import { UsageError } from '../errors.ts';
import { formatAttachments, formatControlStatus, formatHaStatus, formatMigration, formatNodeCa } from '../ha.ts';
import { formatDrill, formatDrillList, formatMs } from '../drills.ts';
import {
	drillTargets,
	formatCatalogue,
	formatChecks,
	formatDrillAll,
	formatDrillRun,
	formatDrillRuns,
	formatInitApplied,
	formatInitPlan,
	type HaDrillScenarioView,
} from '../ha-checks.ts';
import { promptText } from '../prompt.ts';
import { confirmOrRefuse } from './run-operation.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { failoverCommand } from './db-failover.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	events: { type: 'string' },
	'expect-epoch': { type: 'string' },
	'break-glass': { type: 'boolean' },
	node: { type: 'string', multiple: true },
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
	apply: { type: 'boolean' },
	project: { type: 'string', multiple: true },
	profile: { type: 'string' },
	steering: { type: 'string' },
	certificates: { type: 'string' },
	'standby-region': { type: 'string' },
	yes: { type: 'boolean', short: 'y' },
	resource: { type: 'string' },
	confirm: { type: 'string' },
	'drill-database': { type: 'string' },
	all: { type: 'boolean' },
	target: { type: 'string', multiple: true },
	database: { type: 'string', multiple: true },
	'ingress-node': { type: 'string', multiple: true },
	limit: { type: 'string' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: yoal ha <action> [options]

HA and the control plane (platform admin).

Actions:
  init --profile <ha|ha-dr|single> [--steering <driver>] [--certificates <shared|per-node>]
       [--standby-region <region>] [--yes] [--json]
      Turn HA on (or off with single) as one profile. Shows the plan: the YOAL_FEATURE_* lines to
      put in yoal.env on every control-plane host, the cluster settings it sets, and the preflight.
      Asks the open questions (each has a default) unless --yes or a flag answers it. Refuses with
      every reason while a flag differs or a required check fails; nothing changes until it applies.
      Applying needs a platform admin signed in to the dashboard (an API key gets 403).
  preflight [--profile <ha|ha-dr|single>] [--steering <driver>] [--certificates <source>] [--json]
      Every HA check with what was found and the exact fix. Changes nothing. Without --profile it
      checks the install's own profile, or ha on a single install. Exit status 1 when not ready.
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
  drill node-offline [--node <id|name>] [--confirm <name|random>] [--minutes <n>] [--include-control]
                     [--wait] [--json]
      Disaster drill: take a node off the control plane for a while (default 5 min, 1–30) so the
      failover controller, alerts and steering react as to a real loss. Without --node a random
      eligible node is picked; the control-plane host only with --include-control. The node comes
      back by itself. --wait follows it and prints the report: detection time, recovery time and
      every failover action. Ctrl-C while waiting ends the drill early.
  drill <scenario> --resource <id|name> [--confirm <name>] [--yes] [--minutes <n>]
                [--drill-database <copy>] [--include-control] [--json]
      One catalogue drill on one named resource: it injects the fault, measures RTO and RPO, and
      records the result. A destructive scenario needs the resource's name typed back (--confirm
      <name>, or the prompt). Refused on a resource below the scenario's HA level, and for a
      scenario that runs in the lab only. The node that hosts the control plane also needs
      --include-control. Destructive scenarios need a platform admin signed in to the dashboard.
      \`yoal ha drill catalogue\` lists them.
  drill --all [--node <n>]... [--ingress-node <n>]... [--database <db>[:<copy>]]...
              [--project <slug>]... [--target <kind>:<resource>]... [--yes] [--json]
      Every scenario that is safe on a fleet (not destructive, no typed name) against the resources
      you name, one at a time; each skipped scenario with its reason. --yes adds the scenarios
      that need a confirmation (the database failover drill on the named disposable copy).
  drill catalogue [--json]   Every scenario: where it runs, its confirmation, level and bound.
  drill runs [--limit <n>] [--json]   Recent catalogue drills and what they measured.
  drill list [--json]
      Which nodes may be drilled, the running drill and recent results.
  drill show <id> [--json]   One drill's report (a node drill, or a catalogue drill hdr_…).
  drill cancel <id> [--json] End a running drill; the node is back within about 5 s.

  attachments [--json]
      Every database attachment and how each copy reaches it: through its stable endpoint
      (gateway), a loopback endpoint to another node, directly on the database's node, or not at
      all. Ports and nodes only.
  migrate attachments [--project <slug>]... [--apply] [--json]
      With ENDPOINTS_GATEWAY on, an app moves to its stable endpoint on its own next deploy. This
      lists the apps that still connect directly (a dry run, the default); --apply moves them now,
      which restarts each once (platform admin).
  ca [--json]
      The install CA: the CA that signs, a previous one still trusted after a rotation, and the
      node certificates (how many, due to renew, revoked).
  ca rotate [--json]
      Rotate the install CA (platform admin). The old CA stays trusted until every node renews; a
      second rotation is refused while a node still holds a certificate the previous CA signed.

  db arm|disarm|drill <database> [--json]
      Automatic database failover (W11): arm after the policy and a passed drill, disarm now, or run
      a measured drill. Same path as \`yoal db failover\`.

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
  --project <slug>   Limit the migration to this app (repeatable)
  --apply            Move the listed apps now (without it, a dry run)
  --json             Print the raw response`;

export async function haCommand(argv: string[]): Promise<void> {
	// W11-SPEC §12 names `yoal ha db arm <database>`; it is the same audited path as `yoal db failover`.
	if (argv[0] === 'db') {
		const [verb, ...rest] = argv.slice(1);
		if (verb === 'arm' || verb === 'disarm' || verb === 'drill') return failoverCommand([...rest, `--${verb}`]);
		throw new UsageError('Usage: yoal ha db <arm|disarm|drill> <database> [options]');
	}
	const args = parseArgs(argv, flags);
	if (args.boolean('help') || args.positionals.length === 0) {
		console.log(usage);
		return;
	}
	const action = requirePositional(args, 0, 'action');
	if (action === 'control') return controlCommand(args);
	if (action === 'init') return initCommand(args);
	if (action === 'preflight') return preflightCommand(args);
	if (action === 'drill' && (args.boolean('all') || args.string('resource') !== undefined || isCatalogueAction(args.positionals[1])))
		return catalogueDrillCommand(args);
	if (action === 'drill') return drillCommand(args);
	if (action === 'attachments' || action === 'migrate' || action === 'ca') return attachmentCommand(action, args);

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
	const json = args.boolean('json');
	if (sub === 'node-offline') return nodeOfflineDrill(args, json);
	const client = await authenticatedClient();
	if (sub === 'list') {
		const { view, raw } = await client.listDrills();
		if (json) printJson(raw);
		else console.log(formatDrillList(view));
		return;
	}
	if (sub === 'show' || sub === 'cancel') {
		const id = requirePositional(args, 2, 'drill id');
		if (sub === 'show' && id.startsWith('hdr_')) {
			const run = await client.getHaDrillRun(id);
			if (json) printJson(run);
			else console.log(formatDrillRun(run));
			return;
		}
		const drill = sub === 'show' ? await client.getDrill(id) : await client.cancelDrill(id);
		if (json) printJson(drill);
		else console.log(sub === 'cancel' ? `Ended the drill on ${drill.nodeName}; it is back within about 5 s.` : formatDrill(drill));
		return;
	}
	throw new UsageError(`Unknown drill action "${sub}". Name the resource with --resource, or see yoal ha drill catalogue.\n\n${usage}`);
}

/** `yoal ha drill node-offline` (D235): the server needs the typed confirmation too. */
async function nodeOfflineDrill(args: ReturnType<typeof parseArgs>, json: boolean): Promise<void> {

	const minutesFlag = args.string('minutes');
	const minutes = minutesFlag === undefined ? 5 : Number(minutesFlag);
	if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw new UsageError('--minutes must be a whole number from 1 to 30.');
	const node = args.string('node');
	// The server needs the node's name typed back, or "random" for a random pick (HA-PLAN §10).
	const expected = node ?? 'random';
	let confirm = args.string('confirm');
	if (!confirm) {
		if (!process.stdin.isTTY)
			throw new UsageError(`A node offline drill takes a node dark: pass --confirm ${node ? '<the node\'s name>' : 'random'} to start it.`);
		confirm = await promptText(`This takes ${node ?? 'a random eligible node'} off the control plane. Type ${node ? 'its name' : '"random"'} to confirm: `);
	}
	if (node === undefined && confirm !== expected) throw new UsageError('Not confirmed: type "random" to drill a node picked at random.');
	const client = await authenticatedClient();
	let drill = await client.startDrill({
		confirm,
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

/** `yoal ha attachments`, `yoal ha migrate attachments` and `yoal ha ca` (HA-PLAN H24, §9). */
async function attachmentCommand(action: 'attachments' | 'migrate' | 'ca', args: ReturnType<typeof parseArgs>): Promise<void> {
	const json = args.boolean('json');
	if (action === 'migrate' && args.positionals[1] !== 'attachments')
		throw new UsageError('Usage: yoal ha migrate attachments [--project <slug>]... [--apply] [--json]');
	const sub = action === 'ca' ? args.positionals[1] : undefined;
	if (action === 'ca' && sub !== undefined && sub !== 'rotate') throw new UsageError('Usage: yoal ha ca [rotate] [--json]');
	if (args.positionals.length > 2) throw new UsageError(usage);
	const client = await authenticatedClient();
	if (action === 'attachments') {
		const { view, raw } = await client.getAttachments();
		if (json) printJson(raw);
		else console.log(formatAttachments(view));
		return;
	}
	if (action === 'migrate') {
		const { view, raw } = await client.migrateAttachments({ apply: args.boolean('apply'), projects: args.strings('project') });
		if (json) printJson(raw);
		else console.log(formatMigration(view));
		return;
	}
	const { view, raw } = sub === 'rotate' ? await client.rotateNodeCa() : await client.getNodeCa();
	if (json) printJson(raw);
	else if (!view.inUse && view.authorities.length === 0) console.log('The install CA is not in use: ENDPOINTS_GATEWAY is off.');
	else console.log(`${sub === 'rotate' ? 'Rotated. ' : ''}${formatNodeCa(view)}`);
}

const PROFILES = ['single', 'ha', 'ha-dr'];

/** The answers given as flags; an empty flag is no answer. */
function initAnswers(args: ReturnType<typeof parseArgs>): Record<string, string> {
	const answers: Record<string, string> = {};
	const steering = args.string('steering');
	const certificates = args.string('certificates');
	const standbyRegion = args.string('standby-region');
	if (steering) answers.steering = steering;
	if (certificates) answers.certificates = certificates;
	if (standbyRegion) answers.standbyRegion = standbyRegion;
	return answers;
}

/** `yoal ha init --profile <p>` (HA-PLAN H27, §8 step 3). */
async function initCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
	if (args.positionals.length > 1) throw new UsageError(usage);
	const profile = args.string('profile');
	if (!profile || !PROFILES.includes(profile)) throw new UsageError('Missing --profile: one of ha, ha-dr or single.');
	const json = args.boolean('json');
	const yes = args.boolean('yes');
	const client = await authenticatedClient();
	const answers = initAnswers(args);
	let { view, raw } = await client.planHaInit({ profile, answers });
	// At most the plan's questions, each with its default, and only those no flag answered.
	if (!yes && !json && process.stdin.isTTY) {
		let asked = false;
		for (const question of view.plan.questions) {
			if (answers[question.id] !== undefined) continue;
			const options = question.options.length > 0 ? ` [${question.options.join(', ')}]` : '';
			const answer = await promptText(`${question.prompt}${options} (${question.default ? `default ${question.default}` : 'no default'}): `);
			if (answer) answers[question.id] = answer;
			asked = true;
		}
		if (asked) ({ view, raw } = await client.planHaInit({ profile, answers }));
	}
	if (json && (view.blockers.length > 0 || view.settingsToChange.length === 0 || !yes)) {
		printJson(raw);
		if (view.blockers.length > 0) process.exitCode = 1;
		return;
	}
	if (!json) console.log(formatInitPlan(view));
	if (view.blockers.length > 0) {
		console.error('\nNothing was changed.');
		process.exitCode = 1;
		return;
	}
	if (view.settingsToChange.length === 0) return;
	const confirmed = await confirmOrRefuse(`\nApply the ${profile} profile now? [y/N] `, {
		yes,
		refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before applying the ${profile} profile.`,
	});
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const applied = await client.applyHaInit({ profile, answers });
	if (json) printJson(applied.raw);
	else console.log(`\n${formatInitApplied(applied.view)}`);
}

/** `yoal ha preflight` (HA-PLAN H27). */
async function preflightCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
	if (args.positionals.length > 1) throw new UsageError(usage);
	const profile = args.string('profile');
	if (profile !== undefined && !PROFILES.includes(profile)) throw new UsageError('--profile must be ha, ha-dr or single.');
	const client = await authenticatedClient();
	const query = { profile, steering: args.string('steering'), certificates: args.string('certificates') };
	let { report, raw } = await client.getHaPreflight(query);
	// A single install's own profile always checks out; what an operator wants is what ha lacks.
	if (profile === undefined && report.profile === 'single') ({ report, raw } = await client.getHaPreflight({ ...query, profile: 'ha' }));
	if (args.boolean('json')) printJson(raw);
	else console.log(formatChecks(report));
	if (!report.ok) process.exitCode = 1;
}

function isCatalogueAction(sub: string | undefined): boolean {
	return sub === 'catalogue' || sub === 'runs';
}

/** `yoal ha drill <scenario> --resource <id>`, `--all`, `catalogue` and `runs` (HA-PLAN H27, §10). */
async function catalogueDrillCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
	const json = args.boolean('json');
	const sub = args.positionals[1];
	if (args.boolean('all')) {
		if (sub !== undefined) throw new UsageError('yoal ha drill --all takes no scenario: it runs every safe one against the resources you name.');
		let targets;
		try {
			targets = drillTargets({
				targets: args.strings('target'),
				nodes: args.strings('node'),
				ingressNodes: args.strings('ingress-node'),
				databases: args.strings('database'),
				projects: args.strings('project'),
			});
		} catch (error) {
			throw new UsageError((error as Error).message);
		}
		const client = await authenticatedClient();
		if (targets.length === 0) console.error('No resource named: every scenario will be skipped. Name some with --node, --database, --project or --target.');
		const { view, raw } = await client.runAllHaDrills({ targets, ...(args.boolean('yes') ? { confirm: true as const } : {}) });
		if (json) printJson(raw);
		else console.log(formatDrillAll(view));
		if (!view.passed) process.exitCode = 1;
		return;
	}
	if (sub === 'catalogue') {
		const client = await authenticatedClient();
		const { scenarios, raw } = await client.getDrillCatalogue();
		if (json) printJson(raw);
		else console.log(formatCatalogue(scenarios));
		return;
	}
	if (sub === 'runs') {
		const limit = Number(args.string('limit') ?? 20);
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new UsageError('--limit must be a whole number from 1 to 200.');
		const client = await authenticatedClient();
		const { runs, raw } = await client.listHaDrillRuns(limit);
		if (json) printJson(raw);
		else console.log(formatDrillRuns(runs));
		return;
	}
	const scenarioId = requirePositional(args, 1, 'scenario');
	const resource = args.string('resource');
	if (!resource) throw new UsageError(`Missing --resource: a drill never picks one. yoal ha drill ${scenarioId} --resource <id|name>`);
	const minutes = args.string('minutes');
	const durationSeconds = minutes === undefined ? undefined : Number(minutes) * 60;
	if (durationSeconds !== undefined && (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 1_800))
		throw new UsageError('--minutes must be a whole number from 1 to 30.');
	const client = await authenticatedClient();
	const { scenarios } = await client.getDrillCatalogue();
	const scenario: HaDrillScenarioView | undefined = scenarios.find((entry) => entry.id === scenarioId);
	if (!scenario) throw new UsageError(`Unknown drill scenario "${scenarioId}". yoal ha drill catalogue lists them.`);
	if (scenario.availability === 'lab')
		throw new UsageError(`The ${scenario.id} drill runs in the lab only: ${scenario.fleetUnavailableReason ?? ''}`.trim());
	let confirm: string | true | undefined;
	if (scenario.confirmation === 'typed') {
		confirm = args.string('confirm');
		if (!confirm) {
			if (!process.stdin.isTTY)
				throw new UsageError(`The ${scenario.id} drill is destructive: pass --confirm ${resource} (the resource's name) to run it.`);
			confirm = await promptText(`${scenario.title}. This takes ${resource} down for real. Type its name to confirm: `);
		}
	} else if (scenario.confirmation === 'confirm') {
		const confirmed = await confirmOrRefuse(`${scenario.title} on ${resource}. Run it? [y/N] `, {
			yes: args.boolean('yes'),
			refusal: `Not confirmed: stdin is not a terminal. Re-run with --yes to run the ${scenario.id} drill.`,
		});
		if (!confirmed) {
			console.error('Cancelled. Nothing was changed.');
			process.exitCode = 1;
			return;
		}
		confirm = true;
	}
	const run = await client.runHaDrill({
		scenario: scenario.id,
		resource,
		...(confirm !== undefined ? { confirm } : {}),
		...(durationSeconds !== undefined ? { durationSeconds } : {}),
		...(args.string('drill-database') ? { drillDatabase: args.string('drill-database') } : {}),
		...(args.boolean('include-control') ? { includeControlNode: true } : {}),
	});
	if (json) printJson(run);
	else console.log(formatDrillRun(run));
	if (run.status === 'failed') process.exitCode = 1;
}
