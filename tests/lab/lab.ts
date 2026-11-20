#!/usr/bin/env bun
/**
 * The HA lab, nested-container form (docs/HA-PLAN.md W1, docs/CLUSTERING.md §19.3). See README.md.
 *
 *   bun tests/lab/lab.ts up [--only lab-a] [--upgrade]
 *                                           build the image, start s3lab and four nodes (or the
 *                                           --only subset), install Yoal from this checkout, join
 *                                           one fleet over the overlay
 *   bun tests/lab/lab.ts down [--keep-image] remove every yoal-w0-* container, volume, network, image
 *   bun tests/lab/lab.ts status [--json]
 *   bun tests/lab/lab.ts fault <node|all> <verb|list|revert <id>|clear-all> [--flags]
 *   bun tests/lab/lab.ts s3 <rules|add <json>|clear|log>
 *   bun tests/lab/lab.ts kill|stop|start <node>   power off (docker kill), stop or start a node
 *   bun tests/lab/lab.ts exec <node> -- <argv…>
 *   bun tests/lab/lab.ts logs <node> [unit]
 *
 * Lab only: it never talks to anything outside the `yoal-w0-net` network and 127.0.0.1.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { CONTROL, LAB, WORKERS, containerName, labNode, type LabNode } from './lab.config.ts';
import { checkoutTar, containerState, docker, exec, imageExists, labContainers, labVolumes, run, stream } from './lib/docker.ts';
import { Observer, PLATFORM_HOST, PUBLIC_BASE, api, fleetNodes, helperCall, type FleetNode } from './lib/api.ts';

const HERE = import.meta.dir;
const REPO = resolve(HERE, '../..');
const STATE_DIR = join(HERE, '.state');
const OUT_DIR = join(HERE, '.out');
const BUN = '/opt/yoal/runtime/bin/bun';

const say = (message: string) => console.log(`\x1b[1m==> ${message}\x1b[0m`);
const note = (message: string) => console.log(`    ${message}`);

interface LabState {
	createdAt: string;
	image: string;
	/** True when `lab up` pulled the MinIO image itself, so `down` may remove it. */
	pulledMinio: boolean;
	s3Secret: string;
}

function readState(): LabState | null {
	try {
		return JSON.parse(readFileSync(join(STATE_DIR, 'lab.json'), 'utf8')) as LabState;
	} catch {
		return null;
	}
}

function writeState(state: LabState): void {
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(join(STATE_DIR, 'lab.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

// --- image ------------------------------------------------------------------------------------

function imageTag(): string {
	const hash = createHash('sha256');
	hash.update(readFileSync(join(HERE, 'node.Dockerfile')));
	hash.update(`${LAB.image.debianTag} ${LAB.image.bunVersion}`);
	return `${LAB.image.node}:${hash.digest('hex').slice(0, 12)}`;
}

function ensureImage(): string {
	const tag = imageTag();
	if (imageExists(tag)) return tag;
	say(`building ${tag}`);
	run([
		'docker', 'build', '-q', '-f', join(HERE, 'node.Dockerfile'),
		'--label', LAB.label,
		'--build-arg', `DEBIAN_TAG=${LAB.image.debianTag}`,
		'--build-arg', `BUN_VERSION=${LAB.image.bunVersion}`,
		'-t', tag, HERE,
	]);
	return tag;
}

// --- network and s3lab -----------------------------------------------------------------------

function ensureNetwork(): void {
	if (docker(['network', 'inspect', LAB.network.name], { allowFailure: true }).code === 0) return;
	say(`network ${LAB.network.name} (${LAB.network.subnet})`);
	docker(['network', 'create', '--label', LAB.label, '--subnet', LAB.network.subnet, LAB.network.name]);
}

async function ensureS3lab(image: string, state: LabState): Promise<void> {
	const s3 = LAB.s3lab;
	const minio = `${LAB.prefix}-s3lab-minio`;
	const proxy = `${LAB.prefix}-s3lab`;
	if (containerState(minio) === 'missing') {
		if (!imageExists(s3.minioImage)) {
			say(`pulling MinIO ${s3.minioVersion}`);
			docker(['pull', '-q', s3.minioImage]);
			state.pulledMinio = true;
		}
		say(`s3lab: MinIO ${s3.minioVersion} at ${s3.minioIp}`);
		ensureVolume(`${LAB.prefix}-s3lab-data`);
		docker([
			'run', '-d', '--name', minio, '--label', LAB.label, '--network', LAB.network.name, '--ip', s3.minioIp,
			'--memory', '512m', '-e', `MINIO_ROOT_USER=${s3.accessKey}`, '-e', `MINIO_ROOT_PASSWORD=${state.s3Secret}`,
			'-v', `${LAB.prefix}-s3lab-data:/data`, s3.minioImage, 'server', '/data', '--address', `:${s3.s3Port}`,
		]);
	} else if (containerState(minio) !== 'running') docker(['start', minio]);
	if (containerState(proxy) === 'missing') {
		say(`s3lab: fault proxy at ${s3.proxyIp}:${s3.s3Port} (control 127.0.0.1:${s3.hostControlPort})`);
		docker([
			'run', '-d', '--name', proxy, '--label', LAB.label, '--network', LAB.network.name, '--ip', s3.proxyIp, '--memory', '256m',
			'-p', `127.0.0.1:${s3.hostS3Port}:${s3.s3Port}`, '-p', `127.0.0.1:${s3.hostControlPort}:${s3.controlPort}`,
			'-e', `S3LAB_UPSTREAM=http://${s3.minioIp}:${s3.s3Port}`, '-v', `${join(HERE, 's3lab')}:/s3lab:ro`,
			'--entrypoint', BUN, image, '/s3lab/proxy.ts',
		]);
	} else if (containerState(proxy) !== 'running') docker(['start', proxy]);
	// The arbiter bucket, created through the proxy (which also proves the proxy forwards signed requests).
	const client = new AwsClient({ accessKeyId: s3.accessKey, secretAccessKey: state.s3Secret, service: 's3', region: 'us-east-1' });
	for (let attempt = 0; ; attempt++) {
		const response = await client.fetch(`http://127.0.0.1:${s3.hostS3Port}/${s3.bucket}`, { method: 'PUT' }).catch(() => null);
		if (response && (response.status === 200 || response.status === 409)) break;
		if (attempt > 30) throw new Error(`s3lab did not come up (last status ${response?.status ?? 'none'})`);
		await Bun.sleep(1000);
	}
	note(`bucket ${s3.bucket} ready; S3 at http://${s3.proxyIp}:${s3.s3Port} (lab) and http://127.0.0.1:${s3.hostS3Port} (host)`);
}

// --- nodes -----------------------------------------------------------------------------------

function ensureNodeContainer(node: LabNode, image: string): void {
	const name = containerName(node.name);
	const state = containerState(name);
	if (state === 'running') return;
	if (state !== 'missing') {
		docker(['start', name]);
		return;
	}
	note(`starting ${name} (${node.ip}, ${node.zone}, ${node.memory}, ${node.cpus} CPU)`);
	for (const volume of [`${LAB.prefix}-${node.name}-containers`, `${LAB.prefix}-bun-cache`]) ensureVolume(volume);
	docker([
		'run', '-d', '--name', name, '--hostname', node.name, '--label', LAB.label,
		// systemd as PID 1 with its own cgroup v2 namespace; privileged for nftables, tc, WireGuard,
		// loop devices and nested Podman. Never --network host.
		'--privileged', '--cgroupns=private',
		'--network', LAB.network.name, '--ip', node.ip,
		'--memory', node.memory, '--cpus', String(node.cpus),
		'-p', `127.0.0.1:${node.hostHttpPort}:80`,
		'-v', `${LAB.prefix}-${node.name}-containers:/var/lib/containers`,
		'-v', `${LAB.prefix}-bun-cache:/root/.bun/install/cache`,
		image,
	]);
}

/** Labelled up front (`docker run -v` would create an unlabelled one), so `down` finds it. */
function ensureVolume(volume: string): void {
	if (docker(['volume', 'inspect', volume], { allowFailure: true }).code === 0) return;
	docker(['volume', 'create', '--label', LAB.label, volume]);
}

async function waitForSystemd(node: LabNode): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt++) {
		const state = exec(containerName(node.name), ['systemctl', 'is-system-running'], { allowFailure: true }).stdout.trim();
		if (state === 'running' || state === 'degraded') return;
		await Bun.sleep(1000);
	}
	throw new Error(`${node.name}: systemd did not finish booting`);
}

function shipCheckout(node: LabNode, tar: Uint8Array): void {
	const name = containerName(node.name);
	exec(name, ['rm', '-rf', LAB.sourceDir]);
	exec(name, ['mkdir', '-p', LAB.sourceDir]);
	exec(name, ['tar', '-x', '--no-same-owner', '-C', LAB.sourceDir], { stdin: tar });
}

function installed(node: LabNode): boolean {
	const marker = node.role === 'control' ? '/etc/yoal/yoal.env' : '/etc/yoal/agent.env';
	return exec(containerName(node.name), ['test', '-f', marker], { allowFailure: true }).code === 0;
}

async function installControl(node: LabNode, upgrade: boolean): Promise<void> {
	const log = join(OUT_DIR, `install-${node.name}.log`);
	say(`${node.name}: ${upgrade ? 'upgrading' : 'installing'} Yoal from this checkout (log: ${log})`);
	const argv = [
		'docker', 'exec', '-e', `YOAL_SOURCE_DIR=${LAB.sourceDir}`, '-w', LAB.sourceDir, containerName(node.name),
		BUN, 'scripts/install/main.ts', ...LAB.installFlags, ...LAB.controlInstallFlags,
		...(upgrade ? ['--upgrade'] : ['--public-address', node.ip]),
	];
	const code = await stream(argv, log, node.name);
	if (code !== 0) throw new Error(`${node.name}: the installer exited ${code}; see ${log}`);
}

async function joinWorker(node: LabNode, token: string): Promise<void> {
	const log = join(OUT_DIR, `install-${node.name}.log`);
	note(`${node.name}: install --join (log: ${log})`);
	const argv = [
		'docker', 'exec', '-e', `YOAL_SOURCE_DIR=${LAB.sourceDir}`, '-e', 'NODE_EXTRA_CA_CERTS=/etc/yoal-lab/ca.crt',
		'-e', `YOAL_JOIN_TOKEN=${token}`, '-w', LAB.sourceDir, containerName(node.name),
		BUN, 'scripts/install/main.ts', ...LAB.installFlags,
		'--join', `https://${CONTROL.ip}:${LAB.joinTlsPort}`, '--name', node.name, '--endpoint', node.ip,
	];
	const code = await stream(argv, log, node.name);
	if (code !== 0) throw new Error(`${node.name}: install --join exited ${code}; see ${log}`);
}

function bootstrap(args: string[]): { origin: string; joinTokens: Record<string, string>; nodes: FleetNode[] } {
	const result = exec(containerName(CONTROL.name), [BUN, `${LAB.sourceDir}/tests/lab/node/bootstrap.ts`, ...args]);
	for (const line of result.stderr.trim().split('\n').filter(Boolean)) note(line);
	return JSON.parse(result.stdout);
}

/** Build the fault-injection helper once on the control node and install it everywhere. */
function installFaultHelper(nodes: LabNode[]): void {
	say('installing the fault-injection test build of the helper (apps/helper/src/main-faults.ts)');
	const control = containerName(CONTROL.name);
	// The installed release's repo has node_modules; the shipped checkout does not.
	const helperDir = '/opt/yoal/current/repo/apps/helper';
	exec(control, [BUN, 'run', '--cwd', helperDir, 'build:faults']);
	const local = join(STATE_DIR, 'yoal-helper-faults');
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	docker(['cp', `${control}:${helperDir}/dist/yoal-helper-faults`, local]);
	const dropIn = ['# HA lab only (tests/lab): the fault-injection test build of the helper.', '[Service]', 'ExecStart=', 'ExecStart=/opt/yoal-lab/bin/yoal-helper-faults', ''].join('\n');
	for (const node of nodes) {
		const name = containerName(node.name);
		exec(name, ['mkdir', '-p', '/opt/yoal-lab/bin', '/etc/systemd/system/yoal-helper.service.d']);
		docker(['cp', local, `${name}:/opt/yoal-lab/bin/yoal-helper-faults`]);
		exec(name, ['tee', '/etc/systemd/system/yoal-helper.service.d/90-yoal-lab-faults.conf'], { stdin: dropIn });
		exec(name, ['systemctl', 'daemon-reload']);
		exec(name, ['systemctl', 'restart', 'yoal-helper.service']);
	}
	rmSync(local, { force: true });
}

async function waitForFleet(expected: string[], timeoutMs = 180_000): Promise<FleetNode[]> {
	const deadline = Date.now() + timeoutMs;
	let nodes: FleetNode[] = [];
	while (Date.now() < deadline) {
		nodes = fleetNodes();
		const online = expected.every((name) => nodes.find((node) => node.name === name)?.status === 'online');
		const handshakes = expected
			.filter((name) => name !== CONTROL.name)
			.every((name) => Number(exec(containerName(name), ['sh', '-c', "wg show all latest-handshakes | awk '{print $3}' | sort -n | tail -1"], { allowFailure: true }).stdout.trim() || 0) > 0);
		if (online && handshakes) return nodes;
		await Bun.sleep(3000);
	}
	throw new Error(`fleet not ready: ${nodes.map((node) => `${node.name}=${node.status}`).join(', ')}`);
}

/**
 * `--only lab-a[,lab-b]`: bring up that subset (it must include the control node). `--only lab-a` is
 * a plain single-node install: no overlay adoption and no cluster settings, so the single-node gate
 * runs on what a one-machine operator has. A later full `lab up` joins the rest and turns the
 * cluster settings on, as an operator adding machines would.
 */
function selectedNodes(args: string[]): LabNode[] {
	const only = flagArg(args, '--only');
	if (!only) return [...LAB.nodes];
	const names = only.split(',').map((name) => labNode(name.trim()).name);
	if (!names.includes(CONTROL.name)) throw new Error(`--only must include the control node ${CONTROL.name}`);
	return LAB.nodes.filter((node) => names.includes(node.name));
}

function flagArg(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

async function up(flags: Set<string>, args: string[]): Promise<void> {
	const started = Date.now();
	const phases: Record<string, number> = {};
	let phaseStart = Date.now();
	const phase = (name: string) => {
		phases[name] = Math.round((Date.now() - phaseStart) / 1000);
		phaseStart = Date.now();
	};
	mkdirSync(OUT_DIR, { recursive: true });
	const nodes = selectedNodes(args);
	const single = nodes.length === 1;
	const workers = WORKERS.filter((node) => nodes.includes(node));
	const state: LabState = readState() ?? {
		createdAt: new Date().toISOString(),
		image: '',
		pulledMinio: false,
		s3Secret: createHash('sha256').update(crypto.getRandomValues(new Uint8Array(16))).digest('hex').slice(0, 24),
	};
	state.image = ensureImage();
	writeState(state);
	phase('image');
	ensureNetwork();
	await ensureS3lab(state.image, state);
	writeState(state);
	phase('s3lab');

	say(`nodes${single ? ` (single node: ${CONTROL.name} only)` : ''}`);
	for (const node of nodes) ensureNodeContainer(node, state.image);
	await Promise.all(nodes.map(waitForSystemd));
	phase('containers');
	const tar = checkoutTar(REPO);
	note(`shipping the checkout (${(tar.length / 1e6).toFixed(1)} MB) to ${nodes.length} node${nodes.length === 1 ? '' : 's'}`);
	for (const node of nodes) shipCheckout(node, tar);
	phase('ship');

	const upgrade = flags.has('--upgrade');
	if (!installed(CONTROL)) await installControl(CONTROL, false);
	else if (upgrade) await installControl(CONTROL, true);
	else note(`${CONTROL.name}: already installed (pass --upgrade to rebuild from the checkout)`);
	phase('control');

	const pending = workers.filter((node) => !installed(node));
	say(`${CONTROL.name}: bootstrap (owner, API key${single ? ', no cluster settings: single node' : `, failover ${LAB.cluster.failover ? 'on' : 'off'}`}${pending.length ? `, join tokens for ${pending.map((n) => n.name).join(', ')}` : ''})`);
	const boot = bootstrap([
		...(single ? [] : ['--failover', LAB.cluster.failover ? 'on' : 'off', '--edge-endpoint', CONTROL.ip]),
		'--nodes', `${CONTROL.name}=${CONTROL.zone}`,
		...(pending.length ? ['--join', pending.map((node) => node.name).join(','), '--remove', pending.map((node) => node.name).join(',')] : []),
	]);

	if (pending.length) {
		say(`joining ${pending.map((node) => node.name).join(', ')} through a lab TLS front on ${CONTROL.name}:${LAB.joinTlsPort}`);
		const control = containerName(CONTROL.name);
		exec(control, [BUN, `${LAB.sourceDir}/tests/lab/node/tls-front.ts`, '--address', CONTROL.ip, '--certs-only']);
		exec(control, ['systemctl', 'stop', 'yoal-lab-tls-front.service'], { allowFailure: true });
		exec(control, ['systemd-run', '--unit', 'yoal-lab-tls-front', '--collect', BUN, `${LAB.sourceDir}/tests/lab/node/tls-front.ts`, '--address', CONTROL.ip, '--port', String(LAB.joinTlsPort)]);
		const ca = exec(control, ['cat', '/etc/yoal-lab/tls/ca.crt']).stdout;
		for (const node of pending) {
			exec(containerName(node.name), ['mkdir', '-p', '/etc/yoal-lab']);
			exec(containerName(node.name), ['tee', '/etc/yoal-lab/ca.crt'], { stdin: ca });
		}
		try {
			// Joins run in parallel: each builds the agent and helper from the checkout (shared Bun cache).
			await Promise.all(pending.map((node) => joinWorker(node, boot.joinTokens[node.name]!)));
		} finally {
			exec(control, ['systemctl', 'stop', 'yoal-lab-tls-front.service'], { allowFailure: true });
		}
	}
	phase('workers');

	if (!flags.has('--no-faults')) installFaultHelper(nodes);
	phase('faultHelper');

	say('waiting for every node to heartbeat and every overlay tunnel to handshake');
	await waitForFleet(nodes.map((node) => node.name));
	bootstrap(['--nodes-only', '--nodes', nodes.map((node) => `${node.name}=${node.zone}`).join(','), '--slice-mb', String(LAB.cluster.sliceMb)]);
	phase('fleet');
	await status(false);
	const total = Math.round((Date.now() - started) / 1000);
	writeFileSync(join(OUT_DIR, 'up-timings.json'), `${JSON.stringify({ at: new Date().toISOString(), nodes: nodes.map((node) => node.name), upgrade, totalS: total, phasesS: phases }, null, 2)}\n`);
	say(`lab up in ${total} s (${Object.entries(phases).map(([name, secs]) => `${name} ${secs}`).join(', ')})`);
}

// --- down ------------------------------------------------------------------------------------

/**
 * Revert every fault on every running node before its container goes: a fault the helper still
 * holds (a scratch loop disk above all) must be undone by the helper, not torn down with the node.
 */
function clearAllFaults(): string[] {
	const problems: string[] = [];
	for (const node of LAB.nodes) {
		if (containerState(containerName(node.name)) !== 'running') continue;
		let result: { status: number; body: any };
		try {
			result = helperCall(node.name, 'POST', '/v1/faults/clear-all', {});
		} catch (error) {
			problems.push(`${node.name}: clear-all did not run (${(error as Error).message.split('\n')[0]})`);
			continue;
		}
		if (result.status === 404) continue; // a --no-faults helper: nothing to clear
		if (result.status !== 200) {
			problems.push(`${node.name}: clear-all ${result.status}: ${JSON.stringify(result.body?.failed ?? result.body)}`);
			continue;
		}
		const done = [...(result.body?.reverted ?? []), ...(result.body?.swept ?? [])];
		note(`${node.name}: faults cleared${done.length ? ` (${done.join(', ')})` : ''}`);
	}
	return problems;
}

/**
 * Loop devices on the Docker host (the VM every lab node shares a kernel with) whose backing file is
 * a lab fault disk. Read from a throwaway privileged container of the lab image, which sees the
 * host's loop devices; null when there is no image to run it from.
 */
export function leakedLoopDevices(image: string | null): string[] | null {
	if (!image || !imageExists(image)) return null;
	const result = docker(
		['run', '--rm', '--privileged', '--network', 'none', '--label', LAB.label, '--name', `${LAB.prefix}-loopcheck`, '--entrypoint', 'losetup', image, '--list', '--noheadings', '--raw', '--output', 'NAME,BACK-FILE'],
		{ allowFailure: true },
	);
	if (result.code !== 0) return null;
	return result.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => /^\/dev\/loop\d+\s/.test(line) && /yoal-fault/.test(line));
}

function down(flags: Set<string>): void {
	const state = readState();
	const problems = clearAllFaults();
	const containers = labContainers();
	if (containers.length) {
		say(`removing ${containers.join(', ')}`);
		docker(['rm', '-f', ...containers]);
	}
	const fixed = [...LAB.nodes.map((node) => `${LAB.prefix}-${node.name}-containers`), `${LAB.prefix}-bun-cache`, `${LAB.prefix}-s3lab-data`];
	const volumes = [...new Set([...labVolumes(), ...fixed])].filter(
		(volume) => volume.startsWith(`${LAB.prefix}-`) && docker(['volume', 'inspect', volume], { allowFailure: true }).code === 0,
	);
	if (volumes.length) {
		say(`removing volumes ${volumes.join(', ')}`);
		docker(['volume', 'rm', '-f', ...volumes]);
	}
	if (docker(['network', 'inspect', LAB.network.name], { allowFailure: true }).code === 0) {
		say(`removing network ${LAB.network.name}`);
		docker(['network', 'rm', LAB.network.name]);
	}
	// Before the image goes: the check runs from it.
	const leaked = leakedLoopDevices(state?.image || imageTag());
	// No image and nothing removed: an earlier `down` already ran the check, and nothing ran since.
	if (leaked === null && containers.length === 0) note('nothing was running: loop-device check skipped (no lab image to run losetup from)');
	else if (leaked === null) problems.push('could not check the Docker host for leaked loop devices (no lab image to run losetup from)');
	else if (leaked.length) problems.push(`loop devices backed by lab fault disks are still attached on the Docker host: ${leaked.join('; ')} (detach with \`losetup -d\` on the host)`);
	else note('no loop devices backed by lab files on the Docker host');
	if (!flags.has('--keep-image')) {
		// The node image and every other image the lab built (the checker app's, for container
		// scenarios): labelled and named yoal-w0-*.
		const images = docker(['images', '--filter', `label=${LAB.label}`, '--format', '{{.Repository}}:{{.Tag}}'])
			.stdout.split('\n')
			.filter((ref) => ref.startsWith(`${LAB.prefix}-`));
		if (images.length) {
			say(`removing images ${images.join(', ')}`);
			docker(['rmi', '-f', ...images]);
		}
		if (state?.pulledMinio && imageExists(LAB.s3lab.minioImage)) docker(['rmi', LAB.s3lab.minioImage], { allowFailure: true });
	}
	rmSync(STATE_DIR, { recursive: true, force: true });
	const left = [
		...labContainers(),
		...labVolumes(),
		...(flags.has('--keep-image') ? [] : docker(['images', '--filter', `label=${LAB.label}`, '--format', '{{.Repository}}:{{.Tag}}']).stdout.split('\n').filter((ref) => ref.startsWith(`${LAB.prefix}-`))),
		...(docker(['network', 'inspect', LAB.network.name], { allowFailure: true }).code === 0 ? [LAB.network.name] : []),
	];
	if (left.length) problems.push(`left behind: ${left.join(', ')}`);
	if (problems.length) throw new Error(`lab down finished with problems:\n  ${problems.join('\n  ')}`);
	say('lab down: nothing left');
}

// --- status ----------------------------------------------------------------------------------

async function status(asJson: boolean): Promise<void> {
	const containers = Object.fromEntries([...LAB.nodes.map((node) => containerName(node.name)), `${LAB.prefix}-s3lab`, `${LAB.prefix}-s3lab-minio`].map((name) => [name, containerState(name)]));
	let fleet: FleetNode[] = [];
	try {
		if (containers[containerName(CONTROL.name)] === 'running') fleet = fleetNodes();
	} catch (error) {
		if (!asJson) note(`fleet: ${(error as Error).message.split('\n')[0]}`);
	}
	const tunnels: Record<string, string> = {};
	for (const node of LAB.nodes) {
		if (containers[containerName(node.name)] !== 'running') continue;
		tunnels[node.name] = exec(containerName(node.name), ['sh', '-c', 'wg show all latest-handshakes 2>/dev/null | wc -l; ip -4 -o addr show wg0 2>/dev/null | awk "{print \\$4}"'], { allowFailure: true }).stdout.trim().replace('\n', ' peers, ');
	}
	const s3 = await fetch(`http://127.0.0.1:${LAB.s3lab.hostControlPort}/healthz`).then((r) => r.json()).catch(() => null);
	const report = { containers, fleet, tunnels, s3lab: s3, publicBase: PUBLIC_BASE, platformHost: PLATFORM_HOST };
	if (asJson) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	say('lab status');
	for (const [name, state] of Object.entries(containers)) note(`${name.padEnd(22)} ${state}`);
	for (const node of fleet) note(`node ${node.name.padEnd(8)} ${String(node.status).padEnd(8)} zone=${node.zone ?? '-'} overlay=${node.privateAddress ?? '-'}${node.draining ? ' draining' : ''}`);
	for (const [name, tunnel] of Object.entries(tunnels)) note(`wg ${name.padEnd(8)} ${tunnel || 'no tunnel'}`);
	note(`s3lab ${s3 ? `up, ${s3.rules} rules` : 'down'}; platform ${PUBLIC_BASE} (Host: ${PLATFORM_HOST})`);
}

// --- faults ----------------------------------------------------------------------------------

/** Lab node names to the CIDRs a fault verb takes: the node's underlay and overlay addresses. */
function peerCidrs(names: string, fleet: () => FleetNode[]): string[] {
	const out: string[] = [];
	let cached: FleetNode[] | null = null;
	for (const name of names.split(',').filter(Boolean)) {
		if (name === 's3lab') {
			out.push(LAB.s3lab.proxyIp, LAB.s3lab.minioIp);
			continue;
		}
		if (/^\d/.test(name)) {
			out.push(name);
			continue;
		}
		const node = labNode(name);
		out.push(node.ip);
		cached ??= fleet();
		const overlay = cached.find((candidate) => candidate.name === name)?.privateAddress;
		if (overlay) out.push(overlay);
	}
	return out;
}

function flagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

/** CLI flags → the verb's structured body. The helper validates again; this only maps names. */
export function faultBody(verb: string, args: string[], fleet: () => FleetNode[] = fleetNodes): Record<string, unknown> {
	const num = (flag: string) => (flagValue(args, flag) === undefined ? undefined : Number(flagValue(args, flag)));
	const body: Record<string, unknown> = {};
	const duration = num('--duration');
	if (duration !== undefined) body.durationS = duration;
	switch (verb) {
		case 'partition':
			body.peers = peerCidrs(flagValue(args, '--peers') ?? '', fleet);
			if (flagValue(args, '--direction')) body.direction = flagValue(args, '--direction');
			break;
		case 'netem':
			body.device = flagValue(args, '--device') ?? 'eth0';
			if (num('--delay') !== undefined) body.delayMs = num('--delay');
			if (num('--jitter') !== undefined) body.jitterMs = num('--jitter');
			if (num('--loss') !== undefined) body.lossPct = num('--loss');
			if (flagValue(args, '--peers')) body.peers = peerCidrs(flagValue(args, '--peers')!, fleet);
			break;
		case 'clock-skew':
			body.unit = flagValue(args, '--unit') ?? 'yoal-agent.service';
			body.offsetS = num('--offset');
			break;
		case 'freeze':
			body.unit = flagValue(args, '--unit') ?? 'yoal-agent.service';
			break;
		case 'kill-unit':
			body.unit = flagValue(args, '--unit');
			if (flagValue(args, '--signal')) body.signal = flagValue(args, '--signal');
			if (flagValue(args, '--mode')) body.mode = flagValue(args, '--mode');
			break;
		case 'fill-disk':
			if (flagValue(args, '--path')) body.path = flagValue(args, '--path');
			if (num('--size') !== undefined) body.sizeMb = num('--size');
			if (num('--leave-kb') !== undefined) body.leaveKb = num('--leave-kb');
			break;
		case 'block-arbiter':
			body.endpoints = [{ cidr: LAB.s3lab.proxyIp, port: LAB.s3lab.s3Port }];
			if (flagValue(args, '--action')) body.action = flagValue(args, '--action');
			break;
		case 'pause-heartbeat': {
			// By default the helper derives the agent's real control-plane address and port from the
			// agent's own config; `--endpoint <ip>:<port>` overrides it.
			const endpoint = flagValue(args, '--endpoint');
			if (endpoint) {
				const [cidr, port] = endpoint.split(':');
				body.endpoints = [{ cidr, port: Number(port) }];
			}
			break;
		}
		default:
			throw new Error(`unknown fault verb ${verb}`);
	}
	return body;
}

function fault(args: string[]): void {
	const [target, verb, ...rest] = args;
	if (!target || !verb) throw new Error('usage: lab fault <node|all> <verb|list|revert <id>|clear-all> [--flags]');
	const observe = new Observer(flagValue(rest, '--observe') ?? null);
	const nodes = target === 'all' ? LAB.nodes.map((node) => node.name) : [labNode(target).name];
	for (const node of nodes) {
		let result: { status: number; body: any };
		if (verb === 'list') result = helperCall(node, 'GET', '/v1/faults');
		else if (verb === 'clear-all') result = helperCall(node, 'POST', '/v1/faults/clear-all', {});
		else if (verb === 'revert') result = helperCall(node, 'POST', '/v1/faults/revert', { id: rest[0] });
		else result = helperCall(node, 'POST', `/v1/faults/${verb}`, faultBody(verb, rest));
		observe.note('fault', node, { verb, status: result.status, fault: result.body?.fault?.id ?? null, params: result.body?.fault?.params ?? null });
		console.log(JSON.stringify({ node, status: result.status, ...(typeof result.body === 'object' ? result.body : { body: result.body }) }, null, 2));
		if (result.status >= 400) process.exitCode = 1;
	}
}

async function s3(args: string[]): Promise<void> {
	const base = `http://127.0.0.1:${LAB.s3lab.hostControlPort}`;
	const [command, json] = args;
	const response =
		command === 'add'
			? await fetch(`${base}/rules`, { method: 'POST', body: json ?? '{}' })
			: command === 'clear'
				? await fetch(`${base}/clear`, { method: 'POST' })
				: command === 'log'
					? await fetch(`${base}/log?limit=${json ?? 50}`)
					: await fetch(`${base}/rules`);
	console.log(JSON.stringify(await response.json(), null, 2));
	if (!response.ok) process.exitCode = 1;
}

// --- main ------------------------------------------------------------------------------------

const [command = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
try {
	switch (command) {
		case 'up':
			await up(flags, rest);
			break;
		case 'down':
			down(flags);
			break;
		case 'status':
			await status(flags.has('--json'));
			break;
		case 'fault':
			fault(rest);
			break;
		case 's3':
			await s3(rest);
			break;
		case 'kill':
		case 'stop':
		case 'start': {
			const node = labNode(rest[0] ?? '');
			docker([command, containerName(node.name)]);
			say(`${node.name}: ${command === 'kill' ? 'powered off' : command === 'stop' ? 'stopped' : 'started'}`);
			break;
		}
		case 'exec': {
			const node = labNode(rest[0] ?? '');
			const argv = rest.slice(rest.indexOf('--') + 1);
			const child = Bun.spawnSync(['docker', 'exec', containerName(node.name), ...argv], { stdout: 'inherit', stderr: 'inherit' });
			process.exitCode = child.exitCode ?? 1;
			break;
		}
		case 'logs': {
			const node = labNode(rest[0] ?? '');
			const unit = rest[1] && !rest[1].startsWith('--') ? rest[1] : 'yoal-*';
			const child = Bun.spawnSync(['docker', 'exec', containerName(node.name), 'journalctl', '--no-pager', '-n', '200', '-u', unit], { stdout: 'inherit', stderr: 'inherit' });
			process.exitCode = child.exitCode ?? 1;
			break;
		}
		case 'api': {
			const [method = 'GET', path = '/api/v1/projects', body] = rest;
			console.log(JSON.stringify((await api(method, path, body ? JSON.parse(body) : undefined, { allowStatus: [400, 404, 409] })).body, null, 2));
			break;
		}
		default:
			console.log(readFileSync(import.meta.path, 'utf8').split('*/')[0]!.replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
	}
} catch (error) {
	console.error(`\x1b[31mlab: ${(error as Error).message}\x1b[0m`);
	process.exitCode = 1;
}
