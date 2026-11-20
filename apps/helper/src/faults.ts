/**
 * Fault verbs for the HA lab (docs/HA-PLAN.md W1, docs/CLUSTERING.md §19.3).
 *
 * TEST BUILDS ONLY. This module is reachable only behind the build-time define
 * `YOAL_FAULT_INJECTION` (see `apps/helper/package.json`): the release build defines it `false`, so
 * the bundler drops the `import('./faults.ts')` in `main.ts` and the route branch in `server.ts`,
 * and a release helper has no fault endpoint to call (HA-PLAN §10). `faults-release.test.ts` builds
 * the release helper and asserts that none of this survives.
 *
 * Same rules as every other helper verb: fixed verbs, validated structured fields (CIDRs, device
 * names that exist, unit names from an allowlist, bounded numbers), argv only, never a shell
 * string. Every verb that changes state has a timed auto-revert, `clear-all` reverts everything,
 * and a helper that starts sweeps whatever an earlier process left behind (by naming convention,
 * so it works even when the in-memory timers died with that process).
 *
 * Clock skew uses libfaketime on one systemd unit (LD_PRELOAD through a runtime drop-in, offset read
 * from a file every second), never the system clock: in a nested-container lab the kernel clock is
 * the host VM's, and a time namespace offsets only CLOCK_MONOTONIC/BOOTTIME, not wall time.
 */
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { CommandRunner, RunResult } from './systemd.ts';
import { ValidationError } from './validate.ts';

declare global {
	/** Build-time define: `true` only in `build:faults`; `false` in the release build; absent under `bun test`. */
	const YOAL_FAULT_INJECTION: boolean | undefined;
}

export const FAULT_VERBS = [
	'partition',
	'netem',
	'clock-skew',
	'freeze',
	'kill-unit',
	'fill-disk',
	'block-arbiter',
	'pause-heartbeat',
] as const;
export type FaultVerb = (typeof FAULT_VERBS)[number];

/** Units a fault may touch. Never the helper itself: freezing it would also freeze every revert. */
export const FAULT_FIXED_UNITS = [
	'yoal-agent.service',
	'yoal-control-plane.service',
	'yoal-control-plane-standby.service',
	'yoal-builder.service',
	'yoal-caddy.service',
	'caddy.service',
] as const;
const WORKLOAD_UNIT = /^yoal-workload-[A-Za-z0-9_-]{1,80}\.service$/;

const MAX_DURATION_S = 3600;
const MAX_PEERS = 32;
const MAX_ENDPOINTS = 8;
const MAX_BODY_BYTES = 64 * 1024;
const NFT_TABLE_PREFIX = 'yoal_fault_';
/** Root qdisc handle every netem fault uses, so a sweep never removes a qdisc it did not add. */
const TC_HANDLE = 'fa17:';
const TC_NETEM_HANDLE = 'fa18:';
const CLOCK_DROP_IN = '90-yoal-fault-clock.conf';
const AGENT_USER = 'yoal';
const LIBFAKETIME = [
	'/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1',
	'/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1',
	'/usr/lib/faketime/libfaketime.so.1',
	'/usr/local/lib/faketime/libfaketime.so.1',
];

export interface CidrEndpoint {
	cidr: string;
	port: number;
}

export type FaultParams =
	| { verb: 'partition'; peers: string[]; direction: 'in' | 'out' | 'both'; durationS: number }
	| { verb: 'netem'; device: string; delayMs: number; jitterMs: number; lossPct: number; peers: string[]; durationS: number }
	| { verb: 'clock-skew'; unit: string; offsetS: number; durationS: number }
	| { verb: 'freeze'; unit: string; durationS: number }
	| { verb: 'kill-unit'; unit: string; signal: 'KILL' | 'TERM'; mode: 'signal' | 'stop'; durationS: number }
	| { verb: 'fill-disk'; path: string | null; sizeMb: number; leaveKb: number; durationS: number }
	| { verb: 'block-arbiter'; endpoints: CidrEndpoint[]; action: 'drop' | 'reject'; durationS: number }
	| { verb: 'pause-heartbeat'; endpoints: CidrEndpoint[]; durationS: number };

export interface ActiveFault {
	id: string;
	verb: FaultVerb;
	params: FaultParams;
	appliedAt: string;
	/** Null when the verb has nothing to revert (`kill-unit` with `mode: signal`). */
	expiresAt: string | null;
	/** Revert-time facts recorded at apply time (loop device, mount point, fill file). */
	state: Record<string, string>;
	evidence: string[];
}

export class FaultError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FaultError';
	}
}

// --- validation -------------------------------------------------------------------------------

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function onlyKeys(body: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new ValidationError(`unknown field ${key}`);
}

function int(value: unknown, label: string, min: number, max: number, fallback?: number): number {
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
		throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
	return value;
}

function oneOf<T extends string>(value: unknown, label: string, allowed: readonly T[], fallback?: T): T {
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
		throw new ValidationError(`${label} must be one of ${allowed.join(', ')}`);
	return value as T;
}

/** IPv4 address or CIDR, normalized to `a.b.c.d/n` with the host bits cleared. Prefixes /8–/32. */
export function parseCidr(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length > 18) throw new ValidationError(`${label} must be an IPv4 CIDR`);
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(value);
	if (!match) throw new ValidationError(`${label} must be an IPv4 CIDR`);
	const octets = match.slice(1, 5).map(Number);
	if (octets.some((octet) => octet > 255)) throw new ValidationError(`${label} must be an IPv4 CIDR`);
	const prefix = match[5] === undefined ? 32 : Number(match[5]);
	if (prefix < 8 || prefix > 32) throw new ValidationError(`${label} prefix must be between /8 and /32`);
	const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	const network = (address & mask) >>> 0;
	if (network >>> 24 === 127) throw new ValidationError(`${label} must not be loopback`);
	return `${network >>> 24}.${(network >>> 16) & 255}.${(network >>> 8) & 255}.${network & 255}/${prefix}`;
}

function cidrList(value: unknown, label: string, min: number): string[] {
	if (value === undefined && min === 0) return [];
	if (!Array.isArray(value) || value.length < min || value.length > MAX_PEERS)
		throw new ValidationError(`${label} must be an array of ${min}–${MAX_PEERS} IPv4 CIDRs`);
	return [...new Set(value.map((entry, index) => parseCidr(entry, `${label}[${index}]`)))];
}

function endpointList(value: unknown, label: string): CidrEndpoint[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ENDPOINTS)
		throw new ValidationError(`${label} must be an array of 1–${MAX_ENDPOINTS} endpoints`);
	return value.map((entry, index) => {
		const item = record(entry, `${label}[${index}]`);
		onlyKeys(item, ['cidr', 'port']);
		return { cidr: parseCidr(item.cidr, `${label}[${index}].cidr`), port: int(item.port, `${label}[${index}].port`, 1, 65535) };
	});
}

export function assertFaultUnit(value: unknown, label = 'unit'): string {
	if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
	if ((FAULT_FIXED_UNITS as readonly string[]).includes(value) || WORKLOAD_UNIT.test(value)) return value;
	throw new ValidationError(`${label} must be one of ${FAULT_FIXED_UNITS.join(', ')} or yoal-workload-<id>.service`);
}

function deviceName(value: unknown, label: string): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,15}$/.test(value) || value === 'lo' || value === '.' || value === '..')
		throw new ValidationError(`${label} must be a network interface name`);
	return value;
}

/** Absolute, normalized, under a fixed set of data roots; the filesystem itself is checked at apply. */
function fillPath(value: unknown, label: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string' || value.length > 200 || !value.startsWith('/') || value.split('/').some((part) => part === '..' || part === '.'))
		throw new ValidationError(`${label} must be an absolute, normalized path`);
	if (!/^\/(var\/lib\/yoal|var\/lib\/containers|var\/lib\/yoal-faults|srv\/yoal)(\/[A-Za-z0-9_.-]+)*\/?$/.test(value))
		throw new ValidationError(`${label} must be under /var/lib/yoal, /var/lib/containers, /var/lib/yoal-faults or /srv/yoal`);
	return value.replace(/\/+$/, '') || '/';
}

/** Parse one verb's body. Unknown fields are refused, every field is bounded. */
export function parseFaultRequest(verb: string, input: unknown): FaultParams {
	if (!(FAULT_VERBS as readonly string[]).includes(verb)) throw new ValidationError(`unknown fault verb ${verb}`);
	const body = record(input, 'request');
	const durationS = (fallback?: number) => int(body.durationS, 'durationS', 1, MAX_DURATION_S, fallback);
	switch (verb as FaultVerb) {
		case 'partition':
			onlyKeys(body, ['peers', 'direction', 'durationS']);
			return { verb: 'partition', peers: cidrList(body.peers, 'peers', 1), direction: oneOf(body.direction, 'direction', ['in', 'out', 'both'] as const, 'both'), durationS: durationS() };
		case 'netem': {
			onlyKeys(body, ['device', 'delayMs', 'jitterMs', 'lossPct', 'peers', 'durationS']);
			const delayMs = int(body.delayMs, 'delayMs', 0, 10_000, 0);
			const jitterMs = int(body.jitterMs, 'jitterMs', 0, 5_000, 0);
			const lossPct = int(body.lossPct, 'lossPct', 0, 100, 0);
			if (delayMs === 0 && lossPct === 0) throw new ValidationError('netem needs delayMs or lossPct');
			if (jitterMs > 0 && delayMs === 0) throw new ValidationError('jitterMs needs delayMs');
			return { verb: 'netem', device: deviceName(body.device ?? 'eth0', 'device'), delayMs, jitterMs, lossPct, peers: cidrList(body.peers, 'peers', 0), durationS: durationS() };
		}
		case 'clock-skew': {
			onlyKeys(body, ['unit', 'offsetS', 'durationS']);
			const offsetS = int(body.offsetS, 'offsetS', -86_400, 86_400);
			if (offsetS === 0) throw new ValidationError('offsetS must not be 0');
			return { verb: 'clock-skew', unit: assertFaultUnit(body.unit), offsetS, durationS: durationS() };
		}
		case 'freeze':
			onlyKeys(body, ['unit', 'durationS']);
			return { verb: 'freeze', unit: assertFaultUnit(body.unit), durationS: durationS() };
		case 'kill-unit': {
			onlyKeys(body, ['unit', 'signal', 'mode', 'durationS']);
			const mode = oneOf(body.mode, 'mode', ['signal', 'stop'] as const, 'signal');
			return {
				verb: 'kill-unit',
				unit: assertFaultUnit(body.unit),
				signal: oneOf(body.signal, 'signal', ['KILL', 'TERM'] as const, 'KILL'),
				mode,
				// A signal has nothing to revert (systemd restarts the unit); a stop restarts it after durationS.
				durationS: mode === 'stop' ? durationS() : durationS(1),
			};
		}
		case 'fill-disk':
			onlyKeys(body, ['path', 'sizeMb', 'leaveKb', 'durationS']);
			return { verb: 'fill-disk', path: fillPath(body.path, 'path'), sizeMb: int(body.sizeMb, 'sizeMb', 16, 1024, 64), leaveKb: int(body.leaveKb, 'leaveKb', 0, 1_048_576, 0), durationS: durationS() };
		case 'block-arbiter':
			onlyKeys(body, ['endpoints', 'action', 'durationS']);
			return { verb: 'block-arbiter', endpoints: endpointList(body.endpoints, 'endpoints'), action: oneOf(body.action, 'action', ['drop', 'reject'] as const, 'drop'), durationS: durationS() };
		case 'pause-heartbeat':
			onlyKeys(body, ['endpoints', 'durationS']);
			return { verb: 'pause-heartbeat', endpoints: endpointList(body.endpoints, 'endpoints'), durationS: durationS() };
	}
}

// --- rendering (pure; tested) ------------------------------------------------------------------

export function nftTableName(id: string): string {
	return `${NFT_TABLE_PREFIX}${id}`;
}

function set(values: string[]): string {
	return `{ ${values.join(', ')} }`;
}

/** The nftables ruleset for a network fault: one table per fault, so revert is one atomic delete. */
export function renderNftRuleset(id: string, params: FaultParams): string {
	const lines: { input: string[]; output: string[]; forward: string[] } = { input: [], output: [], forward: [] };
	if (params.verb === 'partition') {
		const peers = set(params.peers);
		if (params.direction !== 'out') {
			lines.input.push(`ip saddr ${peers} drop`);
			lines.forward.push(`ip saddr ${peers} drop`);
		}
		if (params.direction !== 'in') {
			lines.output.push(`ip daddr ${peers} drop`);
			lines.forward.push(`ip daddr ${peers} drop`);
		}
	} else if (params.verb === 'block-arbiter') {
		const verdict = params.action === 'reject' ? 'reject with tcp reset' : 'drop';
		for (const endpoint of params.endpoints) {
			lines.output.push(`ip daddr ${endpoint.cidr} tcp dport ${endpoint.port} ${verdict}`);
			lines.forward.push(`ip daddr ${endpoint.cidr} tcp dport ${endpoint.port} ${verdict}`);
		}
	} else if (params.verb === 'pause-heartbeat') {
		// Only the agent's own sockets: Caddy, workloads and the forwarder keep serving.
		for (const endpoint of params.endpoints)
			lines.output.push(`meta skuid "${AGENT_USER}" ip daddr ${endpoint.cidr} tcp dport ${endpoint.port} drop`);
	} else throw new FaultError(`${params.verb} is not an nftables fault`);
	const chain = (name: 'input' | 'output' | 'forward') =>
		lines[name].length === 0
			? []
			: [`\tchain ${name} {`, `\t\ttype filter hook ${name} priority -50; policy accept;`, ...lines[name].map((line) => `\t\t${line}`), '\t}'];
	return [`table inet ${nftTableName(id)} {`, ...chain('input'), ...chain('output'), ...chain('forward'), '}', ''].join('\n');
}

/** `tc` argv lists for a netem fault: root netem, or a prio qdisc steering only `peers` to netem. */
export function renderNetemCommands(params: Extract<FaultParams, { verb: 'netem' }>): string[][] {
	const netem = ['netem'];
	if (params.delayMs > 0) netem.push('delay', `${params.delayMs}ms`, ...(params.jitterMs > 0 ? [`${params.jitterMs}ms`] : []));
	if (params.lossPct > 0) netem.push('loss', `${params.lossPct}%`);
	if (params.peers.length === 0) return [['tc', 'qdisc', 'add', 'dev', params.device, 'root', 'handle', TC_HANDLE, ...netem]];
	return [
		['tc', 'qdisc', 'add', 'dev', params.device, 'root', 'handle', TC_HANDLE, 'prio', 'bands', '4', 'priomap', ...Array(16).fill('0')],
		['tc', 'qdisc', 'add', 'dev', params.device, 'parent', `${TC_HANDLE}4`, 'handle', TC_NETEM_HANDLE, ...netem],
		...params.peers.map((cidr) => ['tc', 'filter', 'add', 'dev', params.device, 'parent', TC_HANDLE, 'protocol', 'ip', 'prio', '1', 'u32', 'match', 'ip', 'dst', cidr, 'flowid', `${TC_HANDLE}4`]),
	];
}

/** libfaketime offset syntax: signed seconds. */
export function faketimeOffset(offsetS: number): string {
	return offsetS >= 0 ? `+${offsetS}` : `${offsetS}`;
}

export function renderClockDropIn(library: string, offsetFile: string): string {
	return [
		'# Written by a yoal-helper TEST BUILD fault verb (clock-skew). Removed on revert.',
		'[Service]',
		`Environment=LD_PRELOAD=${library}`,
		`Environment=FAKETIME_TIMESTAMP_FILE=${offsetFile}`,
		'Environment=FAKETIME_CACHE_DURATION=1',
		'Environment=FAKETIME_DONT_FAKE_MONOTONIC=1',
		'Environment=FAKETIME_DONT_RESET=1',
		'',
	].join('\n');
}

// --- the injector --------------------------------------------------------------------------------

export interface FaultInjectorOptions {
	runner: CommandRunner;
	systemctlPath?: string;
	/** Runtime state: active faults, clock offset files (default `/run/yoal-faults`). */
	runDir?: string;
	/** Loopback images and scratch mounts (default `/var/lib/yoal-faults`). */
	dataDir?: string;
	/** Runtime unit drop-ins (default `/run/systemd/system`). */
	dropInRoot?: string;
	/** `/sys/class/net` (tests point it elsewhere). */
	netDir?: string;
	mountInfoPath?: string;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class FaultInjector {
	private readonly runner: CommandRunner;
	private readonly systemctl: string;
	private readonly runDir: string;
	private readonly dataDir: string;
	private readonly dropInRoot: string;
	private readonly netDir: string;
	private readonly mountInfoPath: string;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
	private readonly active = new Map<string, ActiveFault>();
	private readonly timers = new Map<string, unknown>();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: FaultInjectorOptions) {
		this.runner = options.runner;
		this.systemctl = options.systemctlPath ?? 'systemctl';
		this.runDir = options.runDir ?? '/run/yoal-faults';
		this.dataDir = options.dataDir ?? '/var/lib/yoal-faults';
		this.dropInRoot = options.dropInRoot ?? '/run/systemd/system';
		this.netDir = options.netDir ?? '/sys/class/net';
		this.mountInfoPath = options.mountInfoPath ?? '/proc/self/mountinfo';
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.log = options.log ?? (() => undefined);
	}

	list(): ActiveFault[] {
		return [...this.active.values()];
	}

	/** One operation at a time: two faults on one device or unit must not interleave their commands. */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.catch(() => undefined);
		return next;
	}

	apply(params: FaultParams): Promise<ActiveFault> {
		return this.serial(() => this.applyNow(params));
	}

	revert(id: string): Promise<{ id: string; reverted: boolean; evidence: string[] }> {
		return this.serial(() => this.revertNow(id));
	}

	/** Revert every fault this process knows, then sweep leftovers by naming convention. */
	clearAll(reason = 'clear-all'): Promise<{ reverted: string[]; swept: string[] }> {
		return this.serial(async () => {
			const reverted: string[] = [];
			for (const id of [...this.active.keys()]) {
				const result = await this.revertNow(id).catch((error: unknown) => {
					this.log('warn', `fault ${id}: revert failed during ${reason}: ${message(error)}`);
					return null;
				});
				if (result?.reverted) reverted.push(id);
			}
			const swept = await this.sweep();
			if (reverted.length || swept.length) this.log('info', `${reason}: reverted ${reverted.join(', ') || 'none'}; swept ${swept.join(', ') || 'none'}`);
			return { reverted, swept };
		});
	}

	private async applyNow(params: FaultParams): Promise<ActiveFault> {
		const id = randomBytes(4).toString('hex');
		const fault: ActiveFault = {
			id,
			verb: params.verb,
			params,
			appliedAt: new Date(this.now()).toISOString(),
			expiresAt: null,
			state: {},
			evidence: [],
		};
		for (const other of this.active.values()) {
			if (params.verb === 'netem' && other.params.verb === 'netem' && other.params.device === params.device)
				throw new FaultError(`a netem fault (${other.id}) is already active on ${params.device}`);
			if ('unit' in params && 'unit' in other.params && other.params.unit === params.unit && other.verb === params.verb)
				throw new FaultError(`a ${params.verb} fault (${other.id}) is already active on ${params.unit}`);
		}
		const revertible = await this.applyVerb(fault);
		if (revertible) {
			fault.expiresAt = new Date(this.now() + params.durationS * 1000).toISOString();
			this.active.set(id, fault);
			this.timers.set(
				id,
				this.setTimer(() => {
					void this.revert(id).catch((error: unknown) => this.log('error', `fault ${id}: auto-revert failed: ${message(error)}`));
				}, params.durationS * 1000),
			);
			await this.persist();
		}
		this.log('warn', `fault ${id} applied: ${describe(params)}${fault.expiresAt ? ` until ${fault.expiresAt}` : ''}`);
		return fault;
	}

	/** Apply one verb; returns whether it left state that must be reverted. */
	private async applyVerb(fault: ActiveFault): Promise<boolean> {
		const params = fault.params;
		switch (params.verb) {
			case 'partition':
			case 'block-arbiter':
			case 'pause-heartbeat': {
				await this.must(['nft', '-f', '-'], renderNftRuleset(fault.id, params));
				fault.evidence.push((await this.must(['nft', 'list', 'table', 'inet', nftTableName(fault.id)])).stdout.trim());
				return true;
			}
			case 'netem': {
				await this.assertDevice(params.device);
				const existing = (await this.must(['tc', 'qdisc', 'show', 'dev', params.device])).stdout;
				if (existing.includes(` ${TC_HANDLE} `)) throw new FaultError(`${params.device} already has a fault qdisc; revert it or clear-all first`);
				try {
					for (const argv of renderNetemCommands(params)) await this.must(argv);
				} catch (error) {
					await this.runner.run(['tc', 'qdisc', 'del', 'dev', params.device, 'root', 'handle', TC_HANDLE]);
					throw error;
				}
				fault.evidence.push((await this.must(['tc', 'qdisc', 'show', 'dev', params.device])).stdout.trim());
				return true;
			}
			case 'clock-skew': {
				const library = await firstExisting(LIBFAKETIME);
				if (!library) throw new FaultError('libfaketime is not installed (apt install faketime)');
				await fs.mkdir(this.runDir, { recursive: true, mode: 0o755 });
				const offsetFile = join(this.runDir, `clock-${params.unit}`);
				await fs.writeFile(offsetFile, `${faketimeOffset(params.offsetS)}\n`, { mode: 0o644 });
				const dir = join(this.dropInRoot, `${params.unit}.d`);
				await fs.mkdir(dir, { recursive: true, mode: 0o755 });
				await fs.writeFile(join(dir, CLOCK_DROP_IN), renderClockDropIn(library, offsetFile), { mode: 0o644 });
				fault.state.offsetFile = offsetFile;
				await this.must([this.systemctl, 'daemon-reload']);
				await this.must([this.systemctl, 'restart', params.unit]);
				fault.evidence.push(`${params.unit} restarted under libfaketime, offset ${faketimeOffset(params.offsetS)}s`);
				fault.evidence.push((await this.must([this.systemctl, 'show', params.unit, '-p', 'Environment', '-p', 'MainPID'])).stdout.trim());
				return true;
			}
			case 'freeze': {
				await this.must([this.systemctl, 'kill', '--kill-whom=all', '--signal=SIGSTOP', params.unit]);
				fault.evidence.push(await this.unitEvidence(params.unit));
				return true;
			}
			case 'kill-unit': {
				if (params.mode === 'stop') {
					await this.must([this.systemctl, 'stop', params.unit]);
					fault.evidence.push(await this.unitEvidence(params.unit));
					return true;
				}
				await this.must([this.systemctl, 'kill', '--kill-whom=all', `--signal=SIG${params.signal}`, params.unit]);
				fault.evidence.push(await this.unitEvidence(params.unit));
				return false;
			}
			case 'fill-disk':
				await this.fillDisk(fault, params);
				return true;
		}
	}

	private async revertNow(id: string): Promise<{ id: string; reverted: boolean; evidence: string[] }> {
		const fault = this.active.get(id);
		if (!fault) return { id, reverted: false, evidence: [] };
		const timer = this.timers.get(id);
		if (timer !== undefined) this.clearTimer(timer);
		this.timers.delete(id);
		const evidence: string[] = [];
		const params = fault.params;
		switch (params.verb) {
			case 'partition':
			case 'block-arbiter':
			case 'pause-heartbeat':
				await this.runner.run(['nft', 'delete', 'table', 'inet', nftTableName(id)]);
				evidence.push(`nft tables: ${(await this.runner.run(['nft', 'list', 'tables'])).stdout.trim().replace(/\n/g, '; ') || '(none)'}`);
				break;
			case 'netem':
				await this.runner.run(['tc', 'qdisc', 'del', 'dev', params.device, 'root', 'handle', TC_HANDLE]);
				evidence.push((await this.runner.run(['tc', 'qdisc', 'show', 'dev', params.device])).stdout.trim());
				break;
			case 'clock-skew':
				// Offset back to zero at once (the running process re-reads it within a second), then
				// drop the preload so the next start is clean. No restart: a revert is not a new fault.
				await fs.writeFile(fault.state.offsetFile ?? join(this.runDir, `clock-${params.unit}`), '+0\n').catch(() => undefined);
				await fs.rm(join(this.dropInRoot, `${params.unit}.d`, CLOCK_DROP_IN), { force: true });
				await this.runner.run([this.systemctl, 'daemon-reload']);
				evidence.push(`${params.unit} offset reset to +0; drop-in removed`);
				break;
			case 'freeze':
				await this.must([this.systemctl, 'kill', '--kill-whom=all', '--signal=SIGCONT', params.unit]);
				evidence.push(await this.unitEvidence(params.unit));
				break;
			case 'kill-unit':
				if (params.mode === 'stop') await this.must([this.systemctl, 'start', params.unit]);
				evidence.push(await this.unitEvidence(params.unit));
				break;
			case 'fill-disk':
				evidence.push(...(await this.unfillDisk(fault)));
				break;
		}
		this.active.delete(id);
		await this.persist();
		this.log('warn', `fault ${id} reverted (${params.verb})`);
		return { id, reverted: true, evidence };
	}

	/** Leftovers from a process that died with faults active: nft tables, qdiscs, drop-ins, scratch disks, persisted state. */
	private async sweep(): Promise<string[]> {
		const swept: string[] = [];
		const persisted = await this.readPersisted();
		for (const fault of persisted) {
			if (this.active.has(fault.id)) continue;
			const params = fault.params;
			if (params.verb === 'freeze') await this.runner.run([this.systemctl, 'kill', '--kill-whom=all', '--signal=SIGCONT', params.unit]);
			if (params.verb === 'kill-unit' && params.mode === 'stop') await this.runner.run([this.systemctl, 'start', params.unit]);
			if (params.verb === 'fill-disk') await this.unfillDisk(fault).catch(() => undefined);
			swept.push(`${fault.verb}:${fault.id}`);
		}
		const tables = (await this.runner.run(['nft', 'list', 'tables'])).stdout;
		for (const match of tables.matchAll(new RegExp(`table inet (${NFT_TABLE_PREFIX}[0-9a-f]+)`, 'g'))) {
			await this.runner.run(['nft', 'delete', 'table', 'inet', match[1]!]);
			swept.push(`nft:${match[1]}`);
		}
		for (const device of await fs.readdir(this.netDir).catch(() => [] as string[])) {
			if (!/^[A-Za-z0-9_.-]{1,15}$/.test(device)) continue;
			const qdiscs = (await this.runner.run(['tc', 'qdisc', 'show', 'dev', device])).stdout;
			if (qdiscs.includes(` ${TC_HANDLE} `)) {
				await this.runner.run(['tc', 'qdisc', 'del', 'dev', device, 'root', 'handle', TC_HANDLE]);
				swept.push(`tc:${device}`);
			}
		}
		let reload = false;
		for (const dir of await fs.readdir(this.dropInRoot).catch(() => [] as string[])) {
			if (!dir.endsWith('.service.d')) continue;
			const path = join(this.dropInRoot, dir, CLOCK_DROP_IN);
			if (!(await exists(path))) continue;
			const unit = dir.slice(0, -2);
			await fs.writeFile(join(this.runDir, `clock-${unit}`), '+0\n').catch(() => undefined);
			await fs.rm(path, { force: true });
			reload = true;
			swept.push(`clock:${unit}`);
		}
		if (reload) await this.runner.run([this.systemctl, 'daemon-reload']);
		for (const entry of await fs.readdir(this.dataDir).catch(() => [] as string[])) {
			if (!/^scratch-[0-9a-f]+$/.test(entry)) continue;
			await this.unfillScratch(join(this.dataDir, entry)).catch(() => undefined);
			swept.push(`disk:${entry}`);
		}
		await this.persist();
		return swept;
	}

	// --- disk ----------------------------------------------------------------------------------

	private async fillDisk(fault: ActiveFault, params: Extract<FaultParams, { verb: 'fill-disk' }>): Promise<void> {
		let mountPoint: string;
		if (params.path === null) {
			// A fresh loopback ext4, so a fill can never reach the host's (or the lab VM's) real disk.
			const dir = join(this.dataDir, `scratch-${fault.id}`);
			const image = join(dir, 'disk.img');
			mountPoint = join(dir, 'mnt');
			await fs.mkdir(mountPoint, { recursive: true, mode: 0o700 });
			const handle = await fs.open(image, 'w', 0o600);
			await handle.truncate(params.sizeMb * 1024 * 1024);
			await handle.close();
			const device = (await this.must(['losetup', '--find', '--show', image])).stdout.trim();
			if (!/^\/dev\/loop\d+$/.test(device)) throw new FaultError(`losetup returned an unexpected device ${device}`);
			fault.state.scratch = dir;
			fault.state.device = device;
			await this.must(['mkfs.ext4', '-q', '-F', '-m', '0', device]);
			await this.must(['mount', device, mountPoint]);
		} else {
			const mount = await this.mountOf(params.path);
			if (!mount || !/^\/dev\/loop\d+$/.test(mount.source))
				throw new FaultError(`refusing to fill ${params.path}: its filesystem is not loopback-backed`);
			mountPoint = mount.mountPoint;
		}
		const before = await availableKb(mountPoint);
		const fillFile = join(mountPoint, `.yoal-fault-fill-${fault.id}`);
		fault.state.fillFile = fillFile;
		fault.state.mountPoint = mountPoint;
		const bytes = Math.max(0, (before - params.leaveKb) * 1024);
		if (bytes > 0) {
			const result = await this.runner.run(['fallocate', '-l', String(bytes), fillFile]);
			// Some filesystems refuse a single allocation of the last free extent: write what fits.
			if (result.code !== 0) await this.runner.run(['dd', 'if=/dev/zero', `of=${fillFile}`, 'bs=1M', 'status=none']);
		}
		const after = await availableKb(mountPoint);
		fault.evidence.push(`${mountPoint}: available ${before} KiB before, ${after} KiB after${fault.state.device ? ` (${fault.state.device}, ${params.sizeMb} MiB)` : ''}`);
	}

	private async unfillDisk(fault: ActiveFault): Promise<string[]> {
		const evidence: string[] = [];
		if (fault.state.fillFile) await fs.rm(fault.state.fillFile, { force: true });
		if (fault.state.mountPoint) evidence.push(`${fault.state.mountPoint}: available ${await availableKb(fault.state.mountPoint).catch(() => -1)} KiB after revert`);
		if (fault.state.scratch) {
			await this.unfillScratch(fault.state.scratch);
			evidence.push(`scratch ${fault.state.scratch} unmounted and removed`);
		}
		return evidence;
	}

	private async unfillScratch(dir: string): Promise<void> {
		const mountPoint = join(dir, 'mnt');
		const image = join(dir, 'disk.img');
		await this.runner.run(['umount', mountPoint]);
		const attached = (await this.runner.run(['losetup', '-j', image])).stdout;
		for (const line of attached.split('\n')) {
			const device = /^(\/dev\/loop\d+):/.exec(line)?.[1];
			if (device) await this.runner.run(['losetup', '-d', device]);
		}
		await fs.rm(dir, { recursive: true, force: true });
	}

	private async mountOf(path: string): Promise<{ mountPoint: string; source: string } | null> {
		const text = await fs.readFile(this.mountInfoPath, 'utf8');
		let best: { mountPoint: string; source: string } | null = null;
		for (const line of text.split('\n')) {
			const [left, right] = line.split(' - ');
			if (!left || !right) continue;
			const mountPoint = unescapeMount(left.split(' ')[4] ?? '');
			const source = right.split(' ')[1] ?? '';
			const inside = mountPoint === '/' || path === mountPoint || path.startsWith(`${mountPoint}/`);
			if (inside && (!best || mountPoint.length >= best.mountPoint.length)) best = { mountPoint, source };
		}
		return best;
	}

	// --- helpers -------------------------------------------------------------------------------

	private async assertDevice(device: string): Promise<void> {
		if (!(await exists(join(this.netDir, device)))) throw new ValidationError(`device ${device} does not exist on this node`);
	}

	private async unitEvidence(unit: string): Promise<string> {
		const show = await this.runner.run([this.systemctl, 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID']);
		const fields = show.stdout.trim().replace(/\n/g, ' ');
		const pid = /MainPID=(\d+)/.exec(show.stdout)?.[1];
		if (!pid || pid === '0') return `${unit}: ${fields}`;
		const status = await fs.readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
		const state = /^State:\s+(.+)$/m.exec(status)?.[1] ?? 'unknown';
		return `${unit}: ${fields} State=${state}`;
	}

	private async must(argv: string[], stdin?: string): Promise<RunResult> {
		const result = await this.runner.run(argv, stdin === undefined ? {} : { stdin });
		if (result.code !== 0) throw new FaultError(`${argv[0]} ${argv[1] ?? ''} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
		return result;
	}

	private async persist(): Promise<void> {
		try {
			await fs.mkdir(this.runDir, { recursive: true, mode: 0o755 });
			await fs.writeFile(join(this.runDir, 'active.json'), `${JSON.stringify([...this.active.values()])}\n`, { mode: 0o600 });
		} catch (error) {
			this.log('warn', `could not record active faults: ${message(error)}`);
		}
	}

	private async readPersisted(): Promise<ActiveFault[]> {
		try {
			const parsed = JSON.parse(await fs.readFile(join(this.runDir, 'active.json'), 'utf8')) as unknown;
			return Array.isArray(parsed) ? (parsed as ActiveFault[]).filter((fault) => fault && typeof fault.id === 'string' && fault.params) : [];
		} catch {
			return [];
		}
	}

	// --- HTTP ----------------------------------------------------------------------------------

	/**
	 * `GET /v1/faults`, `POST /v1/faults/<verb>`, `POST /v1/faults/revert {id}`,
	 * `POST /v1/faults/clear-all`. Null for any other path, so the caller falls through.
	 */
	async handle(request: Request, url: URL): Promise<Response | null> {
		const path = url.pathname;
		if (path !== '/v1/faults' && !path.startsWith('/v1/faults/')) return null;
		if (url.search) throw new ValidationError('fault verbs take no query parameters');
		if (path === '/v1/faults') {
			if (request.method !== 'GET') return methodNotAllowed('GET');
			return json({ ok: true, faults: this.list() });
		}
		if (request.method !== 'POST') return methodNotAllowed('POST');
		const name = path.slice('/v1/faults/'.length);
		if (name === 'clear-all') {
			await readBody(request, true);
			return json({ ok: true, ...(await this.clearAll()) });
		}
		if (name === 'revert') {
			const body = record(await readBody(request, false), 'request');
			onlyKeys(body, ['id']);
			if (typeof body.id !== 'string' || !/^[0-9a-f]{8}$/.test(body.id)) throw new ValidationError('id must be a fault id');
			const result = await this.revert(body.id);
			return json({ ok: true, ...result }, result.reverted ? 200 : 404);
		}
		const params = parseFaultRequest(name, await readBody(request, false));
		try {
			return json({ ok: true, fault: await this.apply(params) });
		} catch (error) {
			if (error instanceof FaultError) return json({ error: error.message }, 409);
			throw error;
		}
	}
}

function describe(params: FaultParams): string {
	const { verb, durationS, ...rest } = params;
	return `${verb} ${JSON.stringify(rest)} for ${durationS}s`;
}

async function readBody(request: Request, allowEmpty: boolean): Promise<unknown> {
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new ValidationError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
	const text = await request.text();
	if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new ValidationError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
	if (!text.trim()) {
		if (allowEmpty) return {};
		throw new ValidationError('request body is required');
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ValidationError('request body must be valid JSON');
	}
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function methodNotAllowed(allow: string): Response {
	return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { allow, 'cache-control': 'no-store' } });
}

async function exists(path: string): Promise<boolean> {
	return fs.access(path).then(
		() => true,
		() => false,
	);
}

async function firstExisting(paths: string[]): Promise<string | null> {
	for (const path of paths) if (await exists(path)) return path;
	return null;
}

async function availableKb(path: string): Promise<number> {
	const stats = await fs.statfs(path);
	return Math.floor((Number(stats.bavail) * Number(stats.bsize)) / 1024);
}

function unescapeMount(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
