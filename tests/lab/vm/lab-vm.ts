#!/usr/bin/env bun
/**
 * The HA lab, real-VM form (tests/lab/README.md "The VM form"; HA-PLAN W1 "real VMs for the nightly
 * run"). The same definition as the container form (`../lab.config.ts`: node names, roles, zones,
 * memory and CPUs, the installer flags, the bootstrap and join flow, the fault-injection helper),
 * with Lima VMs instead of containers. What differs: each node has its own kernel, clock, WireGuard
 * and nftables; addresses come from Lima's `user-v2` network, not 172.30.147.0/24; and losing a node
 * is a real VM stop (`limactl stop -f`).
 *
 *   bun tests/lab/vm/lab-vm.ts up [--only lab-a,lab-b]   create, install, join (default: all four)
 *   bun tests/lab/vm/lab-vm.ts status [--json]
 *   bun tests/lab/vm/lab-vm.ts fault <node> partition --peers lab-a[,lab-b] [--duration 60]
 *   bun tests/lab/vm/lab-vm.ts fault <node> freeze [--unit yoal-agent.service] [--duration 60]
 *   bun tests/lab/vm/lab-vm.ts fault <node> list | clear-all
 *   bun tests/lab/vm/lab-vm.ts kill|start <node>          kill = `limactl stop -f` (power off)
 *   bun tests/lab/vm/lab-vm.ts exec <node> -- <argv…>
 *   bun tests/lab/vm/lab-vm.ts down                       clear faults, delete every yoal-w1-lab-* VM
 *
 * VMs are named `yoal-w1-lab-<node>`; the driver refuses any other name, so it never touches a VM it
 * did not create. Every guest port forward is disabled (lab-node.lima.yaml), so nothing binds on the
 * host. There is no s3lab in this form yet (block-arbiter has no target).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONTROL, LAB, WORKERS, labNode, type LabNode } from '../lab.config.ts';
import { checkoutTar, run, stream } from '../lib/docker.ts';
import { cidrComplement } from '../lib/net.ts';

const HERE = import.meta.dir;
const REPO = resolve(HERE, '../../..');
const OUT_DIR = join(HERE, '..', '.out');
const TEMPLATE = join(HERE, 'lab-node.lima.yaml');
const BUN = '/opt/yoal/runtime/bin/bun';
export const VM_PREFIX = 'yoal-w1-lab';
const OVERLAY = '10.47.0.0/22';

const say = (message: string) => console.log(`\x1b[1m==> ${message}\x1b[0m`);
const note = (message: string) => console.log(`    ${message}`);

export function vmName(node: string): string {
	return `${VM_PREFIX}-${labNode(node).name.replace(/^lab-/, '')}`;
}

function assertVm(name: string): string {
	if (!name.startsWith(`${VM_PREFIX}-`) || !/^[a-z0-9-]+$/.test(name)) throw new Error(`refusing to touch VM "${name}": not a ${VM_PREFIX}-* VM`);
	return name;
}

interface LimaInstance {
	name: string;
	status: string;
}

function instances(): LimaInstance[] {
	const out = run(['limactl', 'list', '--json'], { allowFailure: true }).stdout;
	return out
		.split('\n')
		.filter((line) => line.trim().startsWith('{'))
		.map((line) => JSON.parse(line) as LimaInstance)
		.filter((item) => item.name.startsWith(`${VM_PREFIX}-`));
}

function vmStatus(node: string): string {
	return instances().find((item) => item.name === vmName(node))?.status ?? 'missing';
}

/** Run argv as root in the VM. Lima quotes each argument for the guest shell. */
function vmExec(node: string, argv: string[], options: { stdin?: string | Uint8Array; allowFailure?: boolean; env?: Record<string, string> } = {}) {
	const env = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);
	return run(['limactl', 'shell', '--workdir', '/', assertVm(vmName(node)), 'sudo', ...(env.length ? ['env', ...env] : []), ...argv], { stdin: options.stdin, allowFailure: options.allowFailure });
}

/** The VM's address on Lima's user-v2 network (the underlay the overlay runs over). */
function vmAddress(node: string): string {
	const out = vmExec(node, ['ip', '-4', '-o', 'addr', 'show']).stdout;
	const match = /inet (192\.168\.104\.\d+)\//.exec(out) ?? /inet ((?!127\.)[\d.]+)\/\d+ .*scope global/.exec(out);
	if (!match) throw new Error(`${node}: no user-v2 address in:\n${out}`);
	return match[1]!;
}

function selected(args: string[]): LabNode[] {
	const index = args.indexOf('--only');
	if (index < 0) return [...LAB.nodes];
	const names = args[index + 1]!.split(',').map((name) => labNode(name.trim()).name);
	if (!names.includes(CONTROL.name)) throw new Error(`--only must include ${CONTROL.name}`);
	return LAB.nodes.filter((node) => names.includes(node.name));
}

function flagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

// --- up --------------------------------------------------------------------------------------

async function createVm(node: LabNode): Promise<void> {
	const name = vmName(node.name);
	const status = vmStatus(node.name);
	if (status === 'Running') return;
	if (status === 'missing') {
		note(`${name}: creating (${node.cpus} CPU, ${node.memory})`);
		const memory = `${Number.parseInt(node.memory, 10)}GiB`;
		const code = await stream(['limactl', 'create', '--tty=false', '--name', name, '--set', `.cpus=${node.cpus} | .memory="${memory}"`, TEMPLATE], join(OUT_DIR, `vm-create-${node.name}.log`), node.name);
		if (code !== 0) throw new Error(`${name}: limactl create exited ${code}`);
	}
	const code = await stream(['limactl', 'start', '--tty=false', name], join(OUT_DIR, `vm-start-${node.name}.log`), node.name);
	if (code !== 0) throw new Error(`${name}: limactl start exited ${code}`);
}

function installed(node: LabNode): boolean {
	return vmExec(node.name, ['test', '-f', node.role === 'control' ? '/etc/yoal/yoal.env' : '/etc/yoal/agent.env'], { allowFailure: true }).code === 0;
}

function shipCheckout(node: LabNode, tar: Uint8Array): void {
	vmExec(node.name, ['rm', '-rf', LAB.sourceDir]);
	vmExec(node.name, ['mkdir', '-p', LAB.sourceDir]);
	vmExec(node.name, ['tar', '-x', '--no-same-owner', '-C', LAB.sourceDir], { stdin: tar });
}

async function installer(node: LabNode, extra: string[], env: Record<string, string>): Promise<void> {
	const log = join(OUT_DIR, `vm-install-${node.name}.log`);
	note(`${node.name}: installer ${extra.join(' ')} (log: ${log})`);
	const envArgs = Object.entries({ YOAL_SOURCE_DIR: LAB.sourceDir, ...env }).map(([key, value]) => `${key}=${value}`);
	const argv = ['limactl', 'shell', '--workdir', LAB.sourceDir, assertVm(vmName(node.name)), 'sudo', 'env', ...envArgs, BUN, 'scripts/install/main.ts', ...LAB.installFlags, ...extra];
	const code = await stream(argv, log, node.name);
	if (code !== 0) throw new Error(`${node.name}: the installer exited ${code}; see ${log}`);
}

function bootstrap(args: string[]): { origin: string; joinTokens: Record<string, string>; nodes: Array<{ name: string; status: string; privateAddress?: string | null; zone?: string }> } {
	const result = vmExec(CONTROL.name, [BUN, `${LAB.sourceDir}/tests/lab/node/bootstrap.ts`, ...args]);
	for (const line of result.stderr.trim().split('\n').filter(Boolean)) if (line.startsWith('bootstrap:')) note(line);
	return JSON.parse(result.stdout);
}

function installFaultHelper(nodes: LabNode[]): void {
	say('installing the fault-injection test build of the helper');
	const helperDir = '/opt/yoal/current/repo/apps/helper';
	vmExec(CONTROL.name, [BUN, 'run', '--cwd', helperDir, 'build:faults']);
	const binary = run(['limactl', 'shell', assertVm(vmName(CONTROL.name)), 'sudo', 'cat', `${helperDir}/dist/yoal-helper-faults`], { binary: true }).bytes!;
	const dropIn = ['# HA lab only (tests/lab): the fault-injection test build of the helper.', '[Service]', 'ExecStart=', 'ExecStart=/opt/yoal-lab/bin/yoal-helper-faults', ''].join('\n');
	for (const node of nodes) {
		vmExec(node.name, ['mkdir', '-p', '/opt/yoal-lab/bin', '/etc/systemd/system/yoal-helper.service.d']);
		vmExec(node.name, ['tee', '/opt/yoal-lab/bin/yoal-helper-faults'], { stdin: binary });
		vmExec(node.name, ['chmod', '0755', '/opt/yoal-lab/bin/yoal-helper-faults']);
		vmExec(node.name, ['tee', '/etc/systemd/system/yoal-helper.service.d/90-yoal-lab-faults.conf'], { stdin: dropIn });
		vmExec(node.name, ['systemctl', 'daemon-reload']);
		vmExec(node.name, ['systemctl', 'restart', 'yoal-helper.service']);
	}
}

async function up(args: string[]): Promise<void> {
	const started = Date.now();
	const phases: Record<string, number> = {};
	let mark = Date.now();
	const phase = (name: string) => {
		phases[name] = Math.round((Date.now() - mark) / 1000);
		mark = Date.now();
	};
	mkdirSync(OUT_DIR, { recursive: true });
	const nodes = selected(args);
	say(`VMs: ${nodes.map((node) => vmName(node.name)).join(', ')}`);
	await Promise.all(nodes.map(createVm));
	phase('vms');
	const addresses = Object.fromEntries(nodes.map((node) => [node.name, vmAddress(node.name)]));
	note(`addresses: ${JSON.stringify(addresses)}`);
	const tar = checkoutTar(REPO);
	for (const node of nodes) shipCheckout(node, tar);
	phase('ship');
	const control = CONTROL;
	if (!installed(control)) await installer(control, [...LAB.controlInstallFlags, '--public-address', addresses[control.name]!], {});
	else if (args.includes('--upgrade')) await installer(control, [...LAB.controlInstallFlags, '--upgrade'], {});
	phase('control');
	const workers = WORKERS.filter((node) => nodes.includes(node));
	const pending = workers.filter((node) => !installed(node));
	const single = nodes.length === 1;
	const boot = bootstrap([
		...(single ? [] : ['--failover', LAB.cluster.failover ? 'on' : 'off', '--edge-endpoint', addresses[control.name]!]),
		'--nodes', `${control.name}=${control.zone}`,
		...(pending.length ? ['--join', pending.map((node) => node.name).join(','), '--remove', pending.map((node) => node.name).join(',')] : []),
	]);
	if (pending.length) {
		say(`joining ${pending.map((node) => node.name).join(', ')} through a lab TLS front on ${control.name}:${LAB.joinTlsPort}`);
		vmExec(control.name, [BUN, `${LAB.sourceDir}/tests/lab/node/tls-front.ts`, '--address', addresses[control.name]!, '--certs-only']);
		vmExec(control.name, ['systemctl', 'stop', 'yoal-lab-tls-front.service'], { allowFailure: true });
		vmExec(control.name, ['systemd-run', '--unit', 'yoal-lab-tls-front', '--collect', BUN, `${LAB.sourceDir}/tests/lab/node/tls-front.ts`, '--address', addresses[control.name]!, '--port', String(LAB.joinTlsPort)]);
		const ca = vmExec(control.name, ['cat', '/etc/yoal-lab/tls/ca.crt']).stdout;
		for (const node of pending) {
			vmExec(node.name, ['mkdir', '-p', '/etc/yoal-lab']);
			vmExec(node.name, ['tee', '/etc/yoal-lab/ca.crt'], { stdin: ca });
		}
		try {
			await Promise.all(
				pending.map((node) =>
					installer(node, ['--join', `https://${addresses[control.name]}:${LAB.joinTlsPort}`, '--name', node.name, '--endpoint', addresses[node.name]!], {
						NODE_EXTRA_CA_CERTS: '/etc/yoal-lab/ca.crt',
						YOAL_JOIN_TOKEN: boot.joinTokens[node.name]!,
					}),
				),
			);
		} finally {
			vmExec(control.name, ['systemctl', 'stop', 'yoal-lab-tls-front.service'], { allowFailure: true });
		}
	}
	phase('workers');
	if (!args.includes('--no-faults')) installFaultHelper(nodes);
	phase('faultHelper');
	say('waiting for every node to heartbeat');
	const deadline = Date.now() + 240_000;
	let fleet = bootstrap(['--nodes-only']).nodes;
	while (!nodes.every((node) => fleet.find((row) => row.name === node.name)?.status === 'online')) {
		if (Date.now() > deadline) throw new Error(`fleet not ready: ${fleet.map((row) => `${row.name}=${row.status}`).join(', ')}`);
		await Bun.sleep(3000);
		fleet = bootstrap(['--nodes-only']).nodes;
	}
	bootstrap(['--nodes-only', '--nodes', nodes.map((node) => `${node.name}=${node.zone}`).join(','), '--slice-mb', String(LAB.cluster.sliceMb)]);
	phase('fleet');
	const total = Math.round((Date.now() - started) / 1000);
	writeFileSync(join(OUT_DIR, 'vm-up-timings.json'), `${JSON.stringify({ at: new Date().toISOString(), nodes: nodes.map((node) => node.name), totalS: total, phasesS: phases }, null, 2)}\n`);
	await status(false);
	say(`VM lab up in ${total} s (${Object.entries(phases).map(([name, secs]) => `${name} ${secs}`).join(', ')})`);
}

// --- status, faults, down ----------------------------------------------------------------------

async function status(asJson: boolean): Promise<void> {
	const vms = Object.fromEntries(LAB.nodes.map((node) => [vmName(node.name), vmStatus(node.name)]));
	let fleet: Array<{ name: string; status: string; privateAddress?: string | null; zone?: string }> = [];
	if (vms[vmName(CONTROL.name)] === 'Running') {
		try {
			fleet = bootstrap(['--nodes-only']).nodes;
		} catch (error) {
			if (!asJson) note(`fleet: ${(error as Error).message.split('\n')[0]}`);
		}
	}
	const tunnels: Record<string, string> = {};
	for (const node of LAB.nodes)
		if (vms[vmName(node.name)] === 'Running') tunnels[node.name] = vmExec(node.name, ['sh', '-c', 'wg show all latest-handshakes 2>/dev/null | wc -l'], { allowFailure: true }).stdout.trim();
	if (asJson) {
		console.log(JSON.stringify({ vms, fleet, tunnels }, null, 2));
		return;
	}
	say('VM lab status');
	for (const [name, state] of Object.entries(vms)) note(`${name.padEnd(20)} ${state}`);
	for (const node of fleet) note(`node ${node.name.padEnd(8)} ${String(node.status).padEnd(8)} zone=${node.zone ?? '-'} overlay=${node.privateAddress ?? '-'}`);
	for (const [name, peers] of Object.entries(tunnels)) note(`wg ${name.padEnd(8)} ${peers} peers`);
}

function helperCall(node: string, method: 'GET' | 'POST', path: string, body?: unknown): { status: number; body: any } {
	const argv = ['curl', '-sS', '-w', '\n%{http_code}', '--unix-socket', LAB.helperSocket, '-X', method];
	if (body !== undefined) argv.push('-H', 'content-type: application/json', '--data-binary', '@-');
	argv.push(`http://helper${path}`);
	const result = vmExec(node, argv, body === undefined ? {} : { stdin: JSON.stringify(body) });
	const lines = result.stdout.trimEnd().split('\n');
	const code = Number(lines.pop());
	try {
		return { status: code, body: JSON.parse(lines.join('\n')) };
	} catch {
		return { status: code, body: lines.join('\n') };
	}
}

function fault(args: string[]): void {
	const [target, verb, ...rest] = args;
	if (!target || !verb) throw new Error('usage: lab-vm fault <node> <partition|freeze|list|clear-all> [flags]');
	const node = labNode(target).name;
	const durationS = Number(flagValue(rest, '--duration') ?? 60);
	let result: { status: number; body: any };
	if (verb === 'list') result = helperCall(node, 'GET', '/v1/faults');
	else if (verb === 'clear-all') result = helperCall(node, 'POST', '/v1/faults/clear-all', {});
	else if (verb === 'freeze') result = helperCall(node, 'POST', '/v1/faults/freeze', { unit: flagValue(rest, '--unit') ?? 'yoal-agent.service', durationS });
	else if (verb === 'partition') {
		const fleet = bootstrap(['--nodes-only']).nodes;
		const peers = (flagValue(rest, '--peers') ?? '')
			.split(',')
			.filter(Boolean)
			.flatMap((name) => {
				if (name === 'all') {
					const own = [vmAddress(node)];
					const overlay = fleet.find((row) => row.name === node)?.privateAddress;
					return [...cidrComplement('192.168.104.0/24', own), ...cidrComplement(OVERLAY, overlay ? [overlay] : [])];
				}
				const peer = labNode(name).name;
				return [vmAddress(peer), fleet.find((row) => row.name === peer)?.privateAddress].filter((value): value is string => Boolean(value));
			});
		result = helperCall(node, 'POST', '/v1/faults/partition', { peers, direction: flagValue(rest, '--direction') ?? 'both', durationS });
		if (result.status === 200) {
			// Proof from inside the VM: every named peer's underlay address stops answering.
			const reach = Object.fromEntries(
				peers
					.filter((peer) => /^192\.168\.104\.\d+$/.test(peer))
					.map((peer) => [peer, vmExec(node, ['ping', '-c', '2', '-W', '1', peer], { allowFailure: true }).code === 0]),
			);
			result.body = { ...result.body, reachableDuring: reach };
			if (Object.values(reach).some(Boolean)) {
				console.error(`partition left ${node} able to reach ${JSON.stringify(reach)}`);
				process.exitCode = 1;
			}
		}
	} else throw new Error(`the VM form supports partition, freeze, list and clear-all (got ${verb})`);
	console.log(JSON.stringify({ node, status: result.status, ...(typeof result.body === 'object' ? result.body : { body: result.body }) }, null, 2));
	if (result.status >= 400) process.exitCode = 1;
}

function down(): void {
	const vms = instances();
	for (const vm of vms) {
		const node = LAB.nodes.find((item) => vmName(item.name) === vm.name);
		if (!node || vm.status !== 'Running') continue;
		const cleared = helperCall(node.name, 'POST', '/v1/faults/clear-all', {});
		note(`${node.name}: faults cleared (${cleared.status})`);
	}
	for (const vm of vms) {
		say(`deleting ${vm.name}`);
		run(['limactl', 'delete', '-f', assertVm(vm.name)]);
	}
	const left = instances();
	if (left.length) throw new Error(`left behind: ${left.map((item) => item.name).join(', ')}`);
	say('VM lab down: nothing left');
}

// --- main --------------------------------------------------------------------------------------

const [command = 'help', ...rest] = process.argv.slice(2);
try {
	switch (command) {
		case 'up':
			await up(rest);
			break;
		case 'status':
			await status(rest.includes('--json'));
			break;
		case 'fault':
			fault(rest);
			break;
		case 'kill':
			run(['limactl', 'stop', '-f', assertVm(vmName(rest[0] ?? ''))]);
			say(`${rest[0]}: powered off (limactl stop -f)`);
			break;
		case 'start':
			run(['limactl', 'start', '--tty=false', assertVm(vmName(rest[0] ?? ''))]);
			say(`${rest[0]}: started`);
			break;
		case 'exec': {
			const argv = rest.slice(rest.indexOf('--') + 1);
			const result = vmExec(labNode(rest[0] ?? '').name, argv, { allowFailure: true });
			process.stdout.write(result.stdout);
			process.stderr.write(result.stderr);
			process.exitCode = result.code;
			break;
		}
		case 'down':
			down();
			break;
		default:
			console.log((await Bun.file(import.meta.path).text()).split('*/')[0]!.replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
	}
} catch (error) {
	console.error(`\x1b[31mlab-vm: ${(error as Error).message}\x1b[0m`);
	process.exitCode = 1;
}

