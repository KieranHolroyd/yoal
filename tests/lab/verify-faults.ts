#!/usr/bin/env bun
/**
 * Apply every fault verb to one lab node, check its effect while it is active, let it auto-revert,
 * and check that the effect is gone. Then the same for `clear-all`. Writes the evidence as JSON.
 * Exit code 1 when any check fails.
 *
 *   bun tests/lab/verify-faults.ts [--node lab-c] [--peer lab-a] [--out tests/lab/.out/faults.json]
 *
 * The node must not be lab-a (the control node) because pause-heartbeat blocks the agent's path to
 * it; lab-c is the default because the kill-node-b scenario leaves it alone.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { CONTROL, LAB, containerName, labNode } from './lab.config.ts';
import { exec } from './lib/docker.ts';
import { fleetNodes, helperCall } from './lib/api.ts';

const { values: flags } = parseArgs({
	options: {
		node: { type: 'string', default: 'lab-c' },
		peer: { type: 'string', default: CONTROL.name },
		out: { type: 'string', default: join(import.meta.dir, '.out', 'faults.json') },
	},
});
const node = labNode(flags.node!);
const peer = labNode(flags.peer!);
if (node.name === CONTROL.name) throw new Error('pick a worker node: pause-heartbeat cuts the agent off from the control node');
const box = containerName(node.name);
const fleet = fleetNodes();
const peerOverlay = fleet.find((row) => row.name === peer.name)?.privateAddress ?? null;
const controlOverlay = fleet.find((row) => row.name === CONTROL.name)?.privateAddress ?? null;

interface Check {
	verb: string;
	pass: boolean;
	applied: unknown;
	during: string;
	after: string;
	notes: string[];
}
const results: Check[] = [];
const say = (message: string) => console.log(`\x1b[1m==> ${message}\x1b[0m`);

function sh(script: string): { code: number; out: string } {
	const result = exec(box, ['sh', '-c', script], { allowFailure: true });
	return { code: result.code, out: `${result.stdout}${result.stderr}`.trim() };
}

function apply(verb: string, body: Record<string, unknown>): { id: string | null; status: number; body: any } {
	const result = helperCall(node.name, 'POST', `/v1/faults/${verb}`, body);
	return { id: result.body?.fault?.id ?? null, status: result.status, body: result.body };
}

function active(): string[] {
	return (helperCall(node.name, 'GET', '/v1/faults').body?.faults ?? []).map((fault: { id: string }) => fault.id);
}

/** Apply, check during, wait past the expiry, check after; the auto-revert does the cleanup. */
async function verify(verb: string, body: Record<string, unknown>, during: () => { ok: boolean; detail: string }, after: () => { ok: boolean; detail: string }, notes: string[] = []): Promise<void> {
	say(`${verb} on ${node.name}`);
	const applied = apply(verb, body);
	if (applied.status !== 200) {
		results.push({ verb, pass: false, applied: applied.body, during: 'not applied', after: '', notes });
		console.log(`    FAIL apply: ${JSON.stringify(applied.body)}`);
		return;
	}
	const duringCheck = during();
	console.log(`    during: ${duringCheck.ok ? 'ok' : 'FAIL'} — ${duringCheck.detail}`);
	const durationS = Number(body.durationS ?? 1);
	await Bun.sleep(durationS * 1000 + 2500);
	const stillActive = applied.id ? active().includes(applied.id) : false;
	const afterCheck = after();
	console.log(`    after auto-revert: ${afterCheck.ok && !stillActive ? 'ok' : 'FAIL'} — ${afterCheck.detail}${stillActive ? ' (still listed as active)' : ''}`);
	results.push({
		verb,
		pass: duringCheck.ok && afterCheck.ok && !stillActive,
		applied: { id: applied.id, params: applied.body.fault.params, evidence: applied.body.fault.evidence },
		during: duringCheck.detail,
		after: afterCheck.detail,
		notes,
	});
}

const ping = (address: string) => sh(`ping -c 2 -W 1 -i 0.3 ${address}`);
const rtt = (address: string) => {
	const result = ping(address);
	return Number(/= [\d.]+\/([\d.]+)\//.exec(result.out)?.[1] ?? Number.NaN);
};
const unitState = (unit: string) => sh(`pid=$(systemctl show -p MainPID --value ${unit}); echo "pid=$pid $(systemctl is-active ${unit}) $(grep '^State:' /proc/$pid/status 2>/dev/null | tr -s '\\t ' ' ')"`).out;

helperCall(node.name, 'POST', '/v1/faults/clear-all', {});

// 1. partition: the node cannot reach the peer (underlay and overlay), then can again.
const peerAddresses = [peer.ip, ...(peerOverlay ? [peerOverlay] : [])];
await verify(
	'partition',
	{ peers: peerAddresses, direction: 'both', durationS: 6 },
	() => {
		const results = peerAddresses.map((address) => ping(address).code);
		return { ok: results.every((code) => code !== 0), detail: `ping ${peerAddresses.join(', ')} exit ${results.join(', ')} (non-zero = blocked)` };
	},
	() => {
		const results = peerAddresses.map((address) => ping(address).code);
		return { ok: results.every((code) => code === 0), detail: `ping ${peerAddresses.join(', ')} exit ${results.join(', ')}` };
	},
);

// 2. netem: 200 ms added towards the peer only.
const baseline = rtt(peer.ip);
await verify(
	'netem',
	{ device: 'eth0', delayMs: 200, jitterMs: 10, peers: [peer.ip], durationS: 6 },
	() => {
		const value = rtt(peer.ip);
		return { ok: value > 150, detail: `rtt to ${peer.name} ${value.toFixed(1)} ms (baseline ${baseline.toFixed(1)} ms)` };
	},
	() => {
		const value = rtt(peer.ip);
		const qdisc = sh('tc qdisc show dev eth0').out.replace(/\n/g, '; ');
		return { ok: value < 100 && !qdisc.includes('fa17:'), detail: `rtt ${value.toFixed(1)} ms; qdisc: ${qdisc}` };
	},
);

// 3. clock-skew: the agent restarts under libfaketime; its own log clock runs +3600 s ahead.
const skewProbe = () => {
	const pid = sh('systemctl show -p MainPID --value yoal-agent.service').out;
	const environ = sh(`tr '\\0' '\\n' < /proc/${pid}/environ | grep -E '^(LD_PRELOAD|FAKETIME_TIMESTAMP_FILE)='`).out.replace(/\n/g, ' ');
	const offset = sh('cat /run/yoal-faults/clock-yoal-agent.service 2>/dev/null').out;
	// The agent's first log line after a start carries its own idea of the time; journald's is real.
	const line = sh("journalctl -u yoal-agent.service -o short-unix --no-pager -n 40 | grep 'INFO Agent ' | tail -1").out;
	const journal = Number(line.split(' ')[0]);
	const own = Date.parse(/\[yoal-agent ([^\]]+)\]/.exec(line)?.[1] ?? '') / 1000;
	return { pid, environ, offset, skewS: Math.round(own - journal) };
};
await verify(
	'clock-skew',
	{ unit: 'yoal-agent.service', offsetS: 3600, durationS: 8 },
	() => {
		const probe = skewProbe();
		return { ok: probe.environ.includes('libfaketime') && probe.skewS >= 3590 && probe.skewS <= 3610, detail: `agent pid ${probe.pid}: ${probe.environ}; offset file ${probe.offset}; agent clock − journal clock = ${probe.skewS} s` };
	},
	() => {
		const probe = skewProbe();
		const dropIn = sh('ls /run/systemd/system/yoal-agent.service.d/ 2>/dev/null').out;
		return { ok: probe.offset === '+0' && !dropIn.includes('yoal-fault-clock'), detail: `offset file ${probe.offset}; drop-in ${dropIn || 'removed'} (the running agent re-reads the offset within 1 s; it is not restarted)` };
	},
	['libfaketime via LD_PRELOAD on one unit; the system clock is never touched (it is the host VM kernel’s).'],
);
// The revert does not restart the agent; restart it so later checks see a clean process.
sh('systemctl restart yoal-agent.service');

// 4. freeze: every process of the unit stopped (State T), then continued.
await verify(
	'freeze',
	{ unit: 'yoal-agent.service', durationS: 6 },
	() => {
		const state = unitState('yoal-agent.service');
		return { ok: /State: T/.test(state), detail: state };
	},
	() => {
		const state = unitState('yoal-agent.service');
		return { ok: /active/.test(state) && !/State: T/.test(state), detail: state };
	},
);

// 5. kill-unit: SIGKILL (systemd restarts it with a new PID), and stop with a timed start.
say(`kill-unit (signal) on ${node.name}`);
const beforeKill = sh('systemctl show -p MainPID --value caddy.service').out;
const killed = apply('kill-unit', { unit: 'caddy.service', signal: 'KILL' });
await Bun.sleep(4000);
const afterKill = sh('systemctl show -p MainPID --value caddy.service; systemctl is-active caddy.service; systemctl show -p NRestarts --value caddy.service').out.replace(/\n/g, ' ');
results.push({
	verb: 'kill-unit (signal)',
	pass: killed.status === 200 && !afterKill.startsWith(`${beforeKill} `) && afterKill.includes('active'),
	applied: { evidence: killed.body?.fault?.evidence },
	during: `MainPID before ${beforeKill}`,
	after: `MainPID, state, NRestarts after: ${afterKill}`,
	notes: ['Nothing to revert: systemd restarts the unit (Restart=).'],
});
console.log(`    ${results.at(-1)!.pass ? 'ok' : 'FAIL'} — before ${beforeKill}, after ${afterKill}`);
await verify(
	'kill-unit (stop)',
	{ unit: 'caddy.service', mode: 'stop', durationS: 5 },
	() => ({ ok: sh('systemctl is-active caddy.service').out !== 'active', detail: `caddy ${sh('systemctl is-active caddy.service').out}` }),
	() => ({ ok: sh('systemctl is-active caddy.service').out === 'active', detail: `caddy ${sh('systemctl is-active caddy.service').out}` }),
);

// 6. fill-disk: a loopback ext4 scratch filesystem filled to zero free blocks, then removed.
let scratch = '';
await verify(
	'fill-disk',
	{ sizeMb: 32, durationS: 6 },
	() => {
		const fault = helperCall(node.name, 'GET', '/v1/faults').body.faults.find((entry: any) => entry.verb === 'fill-disk');
		scratch = fault?.state?.mountPoint ?? '';
		const df = sh(`df -k --output=source,size,avail ${scratch} | tail -1`).out;
		const write = sh(`dd if=/dev/zero of=${scratch}/probe bs=64k count=4 2>&1 | tail -1`).out;
		return { ok: /\/dev\/loop\d+\s+\d+\s+0$/.test(df.trim()) && /No space left/.test(write), detail: `df: ${df.trim()}; write: ${write}` };
	},
	() => {
		const gone = sh(`test -e ${scratch} && echo present || echo gone; losetup -a | grep -c yoal-faults || true`).out.replace(/\n/g, ' ');
		return { ok: gone.startsWith('gone') && gone.endsWith('0'), detail: `scratch ${gone.split(' ')[0]}; loop devices for yoal-faults: ${gone.split(' ')[1]}` };
	},
	['Refuses any filesystem that is not loopback-backed, so a fill never reaches the host disk.'],
);

// 7. block-arbiter: s3lab unreachable from this node only.
const s3 = `http://${LAB.s3lab.proxyIp}:${LAB.s3lab.s3Port}/minio/health/live`;
await verify(
	'block-arbiter',
	{ endpoints: [{ cidr: LAB.s3lab.proxyIp, port: LAB.s3lab.s3Port }], action: 'reject', durationS: 6 },
	() => {
		const result = sh(`curl -s -o /dev/null -w '%{http_code}' --max-time 3 ${s3}`);
		return { ok: result.code !== 0, detail: `curl s3lab exit ${result.code} (${result.out || 'no answer'})` };
	},
	() => {
		const result = sh(`curl -s -o /dev/null -w '%{http_code}' --max-time 3 ${s3}`);
		return { ok: result.code === 0, detail: `curl s3lab exit ${result.code}, HTTP ${result.out}` };
	},
);

// 8. pause-heartbeat: the agent's user cannot reach the control plane; root (and Caddy) still can.
const control = `http://${CONTROL.ip}/api/setup/status`;
await verify(
	'pause-heartbeat',
	{ endpoints: [{ cidr: CONTROL.ip, port: 80 }, ...(controlOverlay ? [{ cidr: controlOverlay, port: 80 }] : [])], durationS: 6 },
	() => {
		const asAgent = sh(`runuser -u yoal -- curl -s -o /dev/null --max-time 3 ${control}`).code;
		const asRoot = sh(`curl -s -o /dev/null --max-time 3 ${control}`).code;
		return { ok: asAgent !== 0 && asRoot === 0, detail: `as yoal (agent) exit ${asAgent}; as root exit ${asRoot}` };
	},
	() => {
		const asAgent = sh(`runuser -u yoal -- curl -s -o /dev/null --max-time 3 ${control}`).code;
		return { ok: asAgent === 0, detail: `as yoal exit ${asAgent}` };
	},
);

// 9. clear-all: two long faults reverted at once.
say(`clear-all on ${node.name}`);
apply('partition', { peers: [peer.ip], durationS: 600 });
apply('freeze', { unit: 'yoal-agent.service', durationS: 600 });
const beforeClear = active().length;
const cleared = helperCall(node.name, 'POST', '/v1/faults/clear-all', {});
const afterClear = active().length;
const reachable = ping(peer.ip).code === 0;
const thawed = !/State: T/.test(unitState('yoal-agent.service'));
results.push({
	verb: 'clear-all',
	pass: beforeClear === 2 && afterClear === 0 && reachable && thawed,
	applied: cleared.body,
	during: `${beforeClear} active faults`,
	after: `${afterClear} active; peer reachable ${reachable}; agent thawed ${thawed}`,
	notes: [],
});
console.log(`    ${results.at(-1)!.pass ? 'ok' : 'FAIL'} — ${results.at(-1)!.during} → ${results.at(-1)!.after}`);

mkdirSync(dirname(flags.out!), { recursive: true });
writeFileSync(flags.out!, `${JSON.stringify({ node: node.name, peer: peer.name, at: new Date().toISOString(), results }, null, 2)}\n`);
const failed = results.filter((result) => !result.pass);
say(`${results.length - failed.length}/${results.length} fault checks passed; evidence in ${flags.out}`);
if (failed.length) process.exitCode = 1;
