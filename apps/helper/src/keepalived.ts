import { isIP } from 'node:net';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * keepalived/VRRP for the `vip` steering driver (HA-PLAN H18, W8).
 *
 * The helper is the only privileged process: it validates every field, renders one fixed
 * `vrrp_instance` and drives the distribution's `keepalived.service` through argv arrays. There
 * is no shell, no script hook, no notify hook and no command parameter. The VRRP password is
 * written into a 0600 file and is never included in a response or a log line.
 *
 * The control plane decides which ingress holds the floating address by changing priorities
 * through `configure()`; keepalived itself moves the address in 3–5 s when the holder fails.
 */

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

export interface KeepalivedPaths {
	configPath: string;
	service: string;
	systemctlPath: string;
	ipPath: string;
}

export interface KeepalivedState {
	/** Fixed VRRP instance name. One per install. */
	instance: string;
	/** The node's intended VRRP role. Priority still decides when a peer is alive. */
	state: 'MASTER' | 'BACKUP';
	interface: string;
	virtualRouterId: number;
	priority: number;
	advertInterval: number;
	/** This node's address on the shared segment, used for unicast VRRP. */
	localAddress: string;
	/** The other ingress addresses on the segment. */
	unicastPeers: string[];
	/** The one floating address that moves between ingress nodes. */
	virtualAddress: string;
	/** VRRP authentication (keepalived PASS, at most eight printable characters). */
	authPass: string;
}

export interface KeepalivedStatus {
	service: string;
	running: boolean;
	interface: string | null;
	virtualAddress: string | null;
	addressPresent: boolean;
}

export class KeepalivedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'KeepalivedError';
	}
}

export const DEFAULT_KEEPALIVED_PATHS: KeepalivedPaths = {
	configPath: '/etc/keepalived/keepalived.conf',
	service: 'keepalived.service',
	systemctlPath: '/usr/bin/systemctl',
	ipPath: '/usr/sbin/ip',
};

const INSTANCE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
/** Linux interface names are at most 15 bytes; no whitespace, quotes or VRRP config syntax. */
const INTERFACE_PATTERN = /^[A-Za-z0-9_.:-]{1,15}$/;
/** keepalived's auth_pass is at most eight characters and cannot contain whitespace. */
const AUTH_PATTERN = /^[A-Za-z0-9._-]{1,8}$/;

export class KeepalivedManager {
	readonly paths: KeepalivedPaths;
	private readonly runner: CommandRunner;
	#last: KeepalivedState | null = null;

	constructor(options: { paths?: Partial<KeepalivedPaths>; runner?: CommandRunner } = {}) {
		this.paths = { ...DEFAULT_KEEPALIVED_PATHS, ...options.paths };
		this.runner = options.runner ?? defaultRunner;
	}

	/** Validate, write the config 0600 and enable the vendor unit. Does not start it. */
	async install(raw: unknown): Promise<{ changed: boolean; service: string }> {
		const state = parseKeepalivedState(raw);
		const changed = await this.write(state);
		const enabled = await this.run(['enable', this.paths.service]);
		if (enabled.code !== 0) throw new KeepalivedError(`could not enable ${this.paths.service}: ${enabled.stderr.trim()}`);
		this.#last = state;
		return { changed, service: this.paths.service };
	}

	/** Validate and write the config; reload only when keepalived is already running. */
	async configure(raw: unknown): Promise<{ changed: boolean; service: string }> {
		const state = parseKeepalivedState(raw);
		const changed = await this.write(state);
		this.#last = state;
		if (!changed) return { changed: false, service: this.paths.service };
		if (await this.isActive()) {
			const reloaded = await this.run(['reload', this.paths.service]);
			if (reloaded.code !== 0) throw new KeepalivedError(`could not reload ${this.paths.service}: ${reloaded.stderr.trim()}`);
		}
		return { changed: true, service: this.paths.service };
	}

	async start(): Promise<{ service: string }> {
		const started = await this.run(['start', this.paths.service]);
		if (started.code !== 0) throw new KeepalivedError(`could not start ${this.paths.service}: ${started.stderr.trim()}`);
		return { service: this.paths.service };
	}

	async stop(): Promise<{ service: string }> {
		const stopped = await this.run(['stop', this.paths.service]);
		if (stopped.code !== 0) throw new KeepalivedError(`could not stop ${this.paths.service}: ${stopped.stderr.trim()}`);
		return { service: this.paths.service };
	}

	/** `systemctl is-active` plus whether the floating address is on the interface right now. */
	async status(): Promise<KeepalivedStatus> {
		const active = await this.run(['is-active', this.paths.service]);
		const running = active.code === 0 && active.stdout.trim() === 'active';
		const state = this.#last ?? (await this.readLast());
		if (!state) return { service: this.paths.service, running, interface: null, virtualAddress: null, addressPresent: false };
		const address = await this.runner([this.paths.ipPath, '-o', 'addr', 'show', 'dev', state.interface]);
		const addressPresent =
			address.code === 0 &&
			// Exact address, not a substring: 10.0.0.1 must not match 10.0.0.10.
			(address.stdout.match(/\binet6?\s+([0-9a-fA-F:.]+)\/\d{1,3}/g) ?? []).some(
				(entry) => entry.replace(/^.*\s/, '').split('/')[0] === state.virtualAddress,
			);
		return {
			service: this.paths.service,
			running,
			interface: state.interface,
			virtualAddress: state.virtualAddress,
			addressPresent,
		};
	}

	private async write(state: KeepalivedState): Promise<boolean> {
		const content = renderKeepalivedConfig(state);
		const current = await fs.readFile(this.paths.configPath, 'utf8').catch(() => null);
		if (current === content) return false;
		const directory = dirname(this.paths.configPath);
		await fs.mkdir(directory, { recursive: true, mode: 0o755 });
		const temporary = `${this.paths.configPath}.${process.pid}.${Date.now()}.tmp`;
		await fs.writeFile(temporary, content, { mode: 0o600 });
		await fs.chmod(temporary, 0o600);
		await fs.rename(temporary, this.paths.configPath);
		await fs.chmod(this.paths.configPath, 0o600);
		return true;
	}

	/** Read back the last rendered config so status still answers after a helper restart. */
	private async readLast(): Promise<KeepalivedState | null> {
		const text = await fs.readFile(this.paths.configPath, 'utf8').catch(() => '');
		if (!text) return null;
		const interfaceName = /^\s*interface\s+(\S+)\s*$/m.exec(text)?.[1] ?? null;
		const virtualAddress = /^\s*([0-9a-fA-F:.]+(?:\/\d{1,3})?)\s+dev\s+\S+\s*$/m.exec(text)?.[1]?.split('/')[0] ?? null;
		if (!interfaceName || !virtualAddress) return null;
		this.#last = {
			instance: 'YOAL',
			state: 'BACKUP',
			interface: interfaceName,
			virtualRouterId: 1,
			priority: 100,
			advertInterval: 1,
			localAddress: '',
			unicastPeers: [],
			virtualAddress,
			authPass: '',
		};
		return this.#last;
	}

	private async isActive(): Promise<boolean> {
		const active = await this.run(['is-active', this.paths.service]);
		return active.code === 0 && active.stdout.trim() === 'active';
	}

	private run(args: string[]): Promise<CommandResult> {
		return this.runner([this.paths.systemctlPath, ...args]);
	}
}

/** Render exactly one VRRP instance. Every value was validated by `parseKeepalivedState`. */
export function renderKeepalivedConfig(state: KeepalivedState): string {
	const lines = [
		'# Generated by Yoal. Do not edit: the control plane renders this file.',
		'global_defs {',
		'    enable_script_security',
		'}',
		'',
		`vrrp_instance ${state.instance} {`,
		`    state ${state.state}`,
		`    interface ${state.interface}`,
		`    virtual_router_id ${state.virtualRouterId}`,
		`    priority ${state.priority}`,
		`    advert_int ${state.advertInterval}`,
	];
	if (state.localAddress) lines.push(`    unicast_src_ip ${state.localAddress}`);
	if (state.unicastPeers.length > 0) {
		lines.push('    unicast_peer {');
		for (const peer of state.unicastPeers) lines.push(`        ${peer}`);
		lines.push('    }');
	}
	lines.push(
		'    authentication {',
		'        auth_type PASS',
		`        auth_pass ${state.authPass}`,
		'    }',
		'    virtual_ipaddress {',
		`        ${state.virtualAddress}/${isIP(state.virtualAddress) === 6 ? 128 : 32} dev ${state.interface}`,
		'    }',
		'}',
		'',
	);
	return lines.join('\n');
}

/** Strict local validation. The helper never trusts the control plane's wire shape. */
export function parseKeepalivedState(raw: unknown): KeepalivedState {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new KeepalivedError('state must be an object');
	const record = raw as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!['instance', 'state', 'interface', 'virtualRouterId', 'priority', 'advertInterval', 'localAddress', 'unicastPeers', 'virtualAddress', 'authPass'].includes(key))
			throw new KeepalivedError(`state.${key} is not supported`);
	}
	const instance = record.instance;
	if (typeof instance !== 'string' || !INSTANCE_PATTERN.test(instance)) throw new KeepalivedError('invalid VRRP instance name');
	const role = record.state;
	if (role !== 'MASTER' && role !== 'BACKUP') throw new KeepalivedError('state must be MASTER or BACKUP');
	const interfaceName = record.interface;
	if (typeof interfaceName !== 'string' || !INTERFACE_PATTERN.test(interfaceName)) throw new KeepalivedError('invalid interface name');
	const virtualRouterId = Number(record.virtualRouterId);
	if (!Number.isInteger(virtualRouterId) || virtualRouterId < 1 || virtualRouterId > 255)
		throw new KeepalivedError('virtualRouterId must be an integer between 1 and 255');
	const priority = Number(record.priority);
	if (!Number.isInteger(priority) || priority < 1 || priority > 254) throw new KeepalivedError('priority must be an integer between 1 and 254');
	const advertInterval = record.advertInterval === undefined ? 1 : Number(record.advertInterval);
	if (!Number.isInteger(advertInterval) || advertInterval < 1 || advertInterval > 10)
		throw new KeepalivedError('advertInterval must be an integer between 1 and 10');
	const localAddress = parseAddress(record.localAddress, 'localAddress', true);
	const virtualAddress = parseAddress(record.virtualAddress, 'virtualAddress', false);
	const peersRaw = record.unicastPeers === undefined ? [] : record.unicastPeers;
	if (!Array.isArray(peersRaw) || peersRaw.length > 32) throw new KeepalivedError('unicastPeers must be an array of at most 32 addresses');
	const unicastPeers = peersRaw.map((value, index) => parseAddress(value, `unicastPeers[${index}]`, true));
	if (new Set(unicastPeers).size !== unicastPeers.length) throw new KeepalivedError('unicastPeers contains a duplicate');
	if (unicastPeers.length > 0 && !localAddress) throw new KeepalivedError('localAddress is required when unicastPeers is set');
	if (unicastPeers.includes(localAddress)) throw new KeepalivedError('unicastPeers must not include localAddress');
	if (localAddress && unicastPeers.some((peer) => isIP(peer) !== isIP(localAddress)))
		throw new KeepalivedError('unicastPeers must be the same address family as localAddress');
	const authPass = record.authPass;
	if (typeof authPass !== 'string' || !AUTH_PATTERN.test(authPass)) throw new KeepalivedError('authPass must be 1 to 8 letters, digits, dots, dashes or underscores');
	return { instance, state: role, interface: interfaceName, virtualRouterId, priority, advertInterval, localAddress, unicastPeers, virtualAddress, authPass };
}

function parseAddress(value: unknown, label: string, allowEmpty: boolean): string {
	if (value === undefined || value === null) {
		if (allowEmpty) return '';
		throw new KeepalivedError(`${label} is required`);
	}
	if (typeof value !== 'string' || isIP(value) === 0) throw new KeepalivedError(`${label} must be an IP address`);
	return value;
}

export const defaultRunner: CommandRunner = async (argv) => {
	if (!Bun.which(argv[0]!)) return { code: 127, stdout: '', stderr: `${argv[0]}: command not found` };
	const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, stdout, stderr };
};
