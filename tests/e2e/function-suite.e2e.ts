#!/usr/bin/env bun
/**
 * Function-suite end to end on a real node (examples/function-suite, docs/TESTING.md).
 *
 * Installs Yoal from this checkout — uncommitted changes included — on a disposable Linux
 * machine with the real installer, so the control plane, agent, helper, Caddy, Podman, workerd and
 * the managed Postgres/RustFS/NATS/ClickHouse are the ones a customer runs. It then claims the
 * instance through the setup wizard, provisions and deploys the function-suite example with the
 * real CLI, and runs its black-box suite: every binding, Durable Objects, queues, storage events,
 * cron, static assets, egress policy, app errors, load, control-plane tools and scale to zero.
 *
 *   bun tests/e2e/function-suite.e2e.ts                       # Lima VM `yoal-fn-e2e` (created if missing)
 *   bun tests/e2e/function-suite.e2e.ts --target lima:my-vm --fresh
 *   bun tests/e2e/function-suite.e2e.ts --target ssh:root@10.0.0.5
 *   sudo -E bun tests/e2e/function-suite.e2e.ts --target local   # CI: this machine IS the node
 *   bun tests/e2e/function-suite.e2e.ts -- --skip egress       # args after -- go to suite.ts
 *
 * The node side is tests/e2e/function-suite/node.sh. A second run against the same VM upgrades
 * the install from the checkout and re-runs; --fresh deletes and recreates a Lima VM first.
 * Diagnostics (suite report, journals, workload units, containers) land in --out
 * (default tests/e2e/.out/function-suite) whatever the result.
 *
 * Never point --target at a machine you care about: Yoal is installed system-wide.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const dashdash = process.argv.indexOf('--');
const ownArgs = dashdash === -1 ? process.argv.slice(2) : process.argv.slice(2, dashdash);
const suiteArgs = dashdash === -1 ? [] : process.argv.slice(dashdash + 1);

const { values: flags } = parseArgs({
	args: ownArgs,
	options: {
		target: { type: 'string', default: process.env.E2E_TARGET ?? 'lima:yoal-fn-e2e' },
		fresh: { type: 'boolean', default: false },
		'no-cold-start': { type: 'boolean', default: false },
		'no-clickhouse': { type: 'boolean', default: false },
		out: { type: 'string' },
		help: { type: 'boolean', short: 'h', default: false },
	},
});

if (flags.help) {
	console.log(`Usage: bun tests/e2e/function-suite.e2e.ts [options] [-- suite.ts args]

  --target lima:<name>   Lima VM (Debian 13; created if missing). Default lima:yoal-fn-e2e
  --target ssh:<dest>    A disposable machine reachable with ssh as root (or passwordless sudo)
  --target local         This machine (run as root; what CI does)
  --fresh                Lima only: delete and recreate the VM first
  --no-cold-start        Skip the scale-to-zero check (saves ~2 minutes)
  --no-clickhouse        Install without ClickHouse
  --out <dir>            Where diagnostics go (default tests/e2e/.out/function-suite)`);
	process.exit(0);
}

const REPO = resolve(import.meta.dir, '../..');
const OUT = resolve(flags.out ?? join(REPO, 'tests/e2e/.out/function-suite'));
const REMOTE_SRC = '/opt/yoal-e2e-src';
const REMOTE_OUT = '/var/tmp/yoal-e2e';
const target = flags.target!;
const args = [...(flags['no-cold-start'] ? [] : ['--cold-start']), ...suiteArgs];
const nodeEnv = [
	`E2E_OUT=${REMOTE_OUT}`,
	...(flags['no-clickhouse'] ? ['E2E_NO_CLICKHOUSE=1'] : []),
	...(process.env.E2E_INSTALL_FLAGS ? [`E2E_INSTALL_FLAGS=${shellQuote(process.env.E2E_INSTALL_FLAGS)}`] : []),
];

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function say(message: string): void {
	console.log(`\x1b[1m==> ${message}\x1b[0m`);
}

function run(argv: string[], options: { stdin?: Uint8Array; capture?: boolean; allowFailure?: boolean } = {}): { code: number; stdout: Uint8Array } {
	const result = Bun.spawnSync(argv, {
		stdin: options.stdin ?? 'inherit',
		stdout: options.capture ? 'pipe' : 'inherit',
		stderr: 'inherit',
	});
	if (result.exitCode !== 0 && !options.allowFailure) throw new Error(`${argv.slice(0, 3).join(' ')} … exited ${result.exitCode}`);
	return { code: result.exitCode ?? 1, stdout: result.stdout ?? new Uint8Array() };
}

/** The checkout as a tarball: tracked and untracked files, minus ignored ones and deletions. */
function checkoutTar(): Uint8Array {
	const list = Bun.spawnSync(['git', '-C', REPO, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { stdout: 'pipe' });
	if (list.exitCode !== 0) throw new Error('git ls-files failed');
	const files = list.stdout
		.toString()
		.split('\0')
		.filter((file) => file && existsSync(join(REPO, file)));
	const tar = Bun.spawnSync(['tar', '--no-xattrs', '-C', REPO, '-cf', '-', '--null', '-T', '-'], {
		stdin: new TextEncoder().encode(files.join('\0')),
		stdout: 'pipe',
		stderr: 'inherit',
		env: { ...process.env, COPYFILE_DISABLE: '1' },
	});
	if (tar.exitCode !== 0) throw new Error('tar of the checkout failed');
	return tar.stdout;
}

interface Remote {
	/** argv that runs a shell script as root on the node. */
	shell(script: string): string[];
}

function limaRemote(name: string): Remote {
	const list = Bun.spawnSync(['limactl', 'list', '--format', '{{.Name}} {{.Status}}'], { stdout: 'pipe', stderr: 'pipe' });
	const status = list.stdout
		.toString()
		.split('\n')
		.map((line) => line.split(' '))
		.find(([vm]) => vm === name)?.[1];
	if (status && flags.fresh) {
		say(`deleting Lima VM ${name}`);
		run(['limactl', 'delete', '--force', name]);
	}
	if (!status || flags.fresh) {
		say(`creating Lima VM ${name} (Debian 13)`);
		run(['limactl', 'create', '--name', name, '--cpus', '4', '--memory', '8', '--disk', '40', '--mount-none', '--tty=false', 'template:debian-13']);
	}
	if (status !== 'Running' || flags.fresh) run(['limactl', 'start', name]);
	return { shell: (script) => ['limactl', 'shell', name, '--', 'sudo', 'sh', '-c', script] };
}

function sshRemote(dest: string): Remote {
	return { shell: (script) => ['ssh', '-o', 'BatchMode=yes', dest, `sudo sh -c ${shellQuote(script)}`] };
}

async function main(): Promise<number> {
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });

	if (target === 'local') {
		if (process.getuid?.() !== 0) throw new Error('--target local installs Yoal on this machine: run it as root (sudo -E)');
		if (process.platform !== 'linux') throw new Error('--target local needs Linux');
		say('running on this machine');
		const result = Bun.spawnSync(['sh', join(REPO, 'tests/e2e/function-suite/node.sh'), REPO, ...args], {
			stdio: ['inherit', 'inherit', 'inherit'],
			env: { ...process.env, E2E_OUT: OUT, ...(flags['no-clickhouse'] ? { E2E_NO_CLICKHOUSE: '1' } : {}) },
		});
		return result.exitCode ?? 1;
	}

	let remote: Remote;
	if (target.startsWith('lima:')) remote = limaRemote(target.slice('lima:'.length));
	else if (target.startsWith('ssh:')) remote = sshRemote(target.slice('ssh:'.length));
	else throw new Error(`unknown --target ${target} (lima:<name>, ssh:<dest> or local)`);

	say(`shipping the checkout to ${REMOTE_SRC}`);
	// Keep the remote node_modules between runs; everything else is replaced.
	run(
		remote.shell(
			`set -e; mkdir -p ${REMOTE_SRC}; find ${REMOTE_SRC} -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +; tar -xf - -C ${REMOTE_SRC}`,
		),
		{ stdin: checkoutTar() },
	);

	say(`running the node side on ${target}`);
	const quoted = args.map(shellQuote).join(' ');
	const result = run(remote.shell(`${nodeEnv.join(' ')} sh ${REMOTE_SRC}/tests/e2e/function-suite/node.sh ${REMOTE_SRC} ${quoted}`), {
		allowFailure: true,
	});

	say(`copying diagnostics to ${OUT}`);
	const tar = run(remote.shell(`tar -C ${REMOTE_OUT} -cf - .`), { capture: true, allowFailure: true });
	if (tar.code === 0) run(['tar', '-xf', '-', '-C', OUT], { stdin: tar.stdout, allowFailure: true });
	return result.code;
}

const code = await main().catch((error: Error) => {
	console.error(`\x1b[31m${error.message}\x1b[0m`);
	return 1;
});
console.log(code === 0 ? '\x1b[32mfunction-suite e2e passed\x1b[0m' : `\x1b[31mfunction-suite e2e failed (exit ${code}); see ${OUT}\x1b[0m`);
process.exit(code);
