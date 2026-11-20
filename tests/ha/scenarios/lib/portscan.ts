/**
 * A TCP connect scan from outside the overlay: a throwaway container on the lab bridge
 * (`yoal-w0-net`), not a lab node and not on the WireGuard overlay, so it sees what any host on the
 * nodes' own network would see. It runs the lab node image's Bun, removes itself (`--rm`), and
 * carries the lab label, so `lab down` would remove it too if it were ever left behind.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAB } from '../../../lab/lab.config.ts';
import { docker } from '../../../lab/lib/docker.ts';

const SCRIPT = `
const [targets, ranges, timeoutMs, concurrency] = JSON.parse(process.argv[process.argv.length - 1]);
const jobs = [];
for (const ip of targets) for (const [from, to] of ranges) for (let port = from; port <= to; port++) jobs.push([ip, port]);
const open = [];
let next = 0;
async function probe(ip, port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value, socket) => { if (done) return; done = true; try { socket?.end(); } catch {} resolve(value); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Bun.connect({ hostname: ip, port, socket: { open(socket) { clearTimeout(timer); finish(true, socket); }, error() { clearTimeout(timer); finish(false); }, connectError() { clearTimeout(timer); finish(false); }, data() {} } }).catch(() => { clearTimeout(timer); finish(false); });
  });
}
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < jobs.length) { const [ip, port] = jobs[next++]; if (await probe(ip, port)) open.push(ip + ':' + port); }
}));
console.log(JSON.stringify({ probed: jobs.length, open }));
`;

export interface ScanResult {
	probed: number;
	open: string[];
	durationMs: number;
}

/** The lab node image `lab up` built (tests/lab/.state/lab.json). */
export function labImage(): string {
	const state = JSON.parse(readFileSync(join(import.meta.dir, '../../../lab/.state/lab.json'), 'utf8')) as { image: string };
	return state.image;
}

export function scanFromBridge(targets: string[], ranges: Array<[number, number]>, options: { timeoutMs?: number; concurrency?: number } = {}): ScanResult {
	const started = Date.now();
	const args = JSON.stringify([targets, ranges, options.timeoutMs ?? 500, options.concurrency ?? 256]);
	const out = docker([
		'run', '--rm', '--name', `${LAB.prefix}-portscan`, '--label', LAB.label, '--network', LAB.network.name,
		'--entrypoint', '/opt/yoal/runtime/bin/bun', labImage(), '-e', SCRIPT, args,
	]).stdout.trim().split('\n').pop()!;
	const parsed = JSON.parse(out) as { probed: number; open: string[] };
	return { ...parsed, durationMs: Date.now() - started };
}
