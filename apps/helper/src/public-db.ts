import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { ValidationError } from './validate.ts';
import { defaultRunner, type CommandRunner } from './wireguard.ts';

/**
 * Public database access on an ingress (docs/DATABASES.md §19.4, D241): two fixed verbs.
 *
 * - `firewall`: one nftables table, `inet yoal-public-db`, that admits each public port only from
 *   its database's CIDRs and drops the rest of 24000–24999. With ufw or firewalld active the range
 *   is also opened in the host manager (the Yoal table only drops), and closed again when empty.
 * - `tls`: copy `*.db.<domain>` / `<label>.db.<domain>` certificates out of Caddy's storage for the
 *   agent's proxy. No other name is accepted: a compromised agent must not be able to pull the
 *   content wildcard's key this way (the same rule as the mail copy).
 *
 * The helper does not depend on `@yoal/contracts` (D61), so every port and CIDR is validated here.
 */

export const PUBLIC_DB_PORT_MIN = 24_000;
export const PUBLIC_DB_PORT_MAX = 24_999;
const MAX_PORTS = 1_000;
const MAX_CIDRS_PER_PORT = 52;
const MAX_TLS_NAMES = 64;
const TABLE = 'yoal-public-db';
const RANGE_UFW = `${PUBLIC_DB_PORT_MIN}:${PUBLIC_DB_PORT_MAX}/tcp`;
const RANGE_FIREWALLD = `${PUBLIC_DB_PORT_MIN}-${PUBLIC_DB_PORT_MAX}/tcp`;

export interface PublicDbPortRule {
	port: number;
	/** Canonical CIDRs, host bits zero. */
	v4: string[];
	v6: string[];
}

// ------------------------------------------------------------------------------- validation

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ValidationError(`${label} has an unknown field "${key}"`);
}

function ipv4Bits(text: string): bigint | null {
	const parts = text.split('.');
	if (parts.length !== 4) return null;
	let out = 0n;
	for (const part of parts) {
		if (!/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) return null;
		out = (out << 8n) | BigInt(part);
	}
	return out;
}

function ipv6Bits(text: string): bigint | null {
	if (text.length > 39 || !/^[0-9a-f:]+$/i.test(text)) return null;
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(':') : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	if (halves.length === 1 && left.length !== 8) return null;
	if (halves.length === 2 && left.length + right.length > 7) return null;
	let out = 0n;
	for (const group of [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
		out = (out << 16n) | BigInt(parseInt(group, 16));
	}
	return out;
}

function formatV6(bits: bigint): string {
	const groups: string[] = [];
	for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(((bits >> shift) & 0xffffn).toString(16));
	let bestStart = -1;
	let bestLength = 1;
	for (let index = 0; index < 8; ) {
		if (groups[index] !== '0') {
			index += 1;
			continue;
		}
		let end = index;
		while (end < 8 && groups[end] === '0') end += 1;
		if (end - index > bestLength) {
			bestStart = index;
			bestLength = end - index;
		}
		index = end;
	}
	if (bestStart === -1) return groups.join(':');
	return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
}

/** A canonical IPv4 or IPv6 CIDR with host bits clear. Anything else is refused, never normalised. */
export function parsePublicCidr(value: unknown, label: string): { family: 4 | 6; cidr: string } {
	if (typeof value !== 'string' || value.length > 64) throw new ValidationError(`${label} must be a CIDR`);
	const match = /^([^/]+)\/(\d{1,3})$/.exec(value);
	if (!match) throw new ValidationError(`${label} must be a CIDR`);
	const prefix = Number(match[2]);
	const v4 = ipv4Bits(match[1]!);
	if (v4 !== null) {
		if (prefix > 32) throw new ValidationError(`${label} prefix must be at most /32`);
		const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(32 - prefix);
		if ((v4 & mask) !== v4) throw new ValidationError(`${label} has host bits set`);
		return { family: 4, cidr: value };
	}
	const v6 = ipv6Bits(match[1]!);
	if (v6 === null) throw new ValidationError(`${label} must be a CIDR`);
	if (prefix > 128) throw new ValidationError(`${label} prefix must be at most /128`);
	const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
	if ((v6 & mask) !== v6) throw new ValidationError(`${label} has host bits set`);
	return { family: 6, cidr: `${formatV6(v6)}/${prefix}` };
}

/** `{ ports: [{ port, allow }] }`: ports in 24000–24999, each once, 0–52 CIDRs each. */
export function parsePublicDbFirewall(body: unknown): PublicDbPortRule[] {
	const input = record(body, 'request');
	onlyKeys(input, ['ports'], 'request');
	if (!Array.isArray(input.ports) || input.ports.length > MAX_PORTS)
		throw new ValidationError(`ports must be an array of at most ${MAX_PORTS} entries`);
	const seen = new Set<number>();
	return input.ports.map((entry, index) => {
		const item = record(entry, `ports[${index}]`);
		onlyKeys(item, ['port', 'allow'], `ports[${index}]`);
		const port = item.port;
		if (typeof port !== 'number' || !Number.isInteger(port) || port < PUBLIC_DB_PORT_MIN || port > PUBLIC_DB_PORT_MAX)
			throw new ValidationError(`ports[${index}].port must be an integer in ${PUBLIC_DB_PORT_MIN}–${PUBLIC_DB_PORT_MAX}`);
		if (seen.has(port)) throw new ValidationError(`ports[${index}].port ${port} is listed twice`);
		seen.add(port);
		if (!Array.isArray(item.allow) || item.allow.length > MAX_CIDRS_PER_PORT)
			throw new ValidationError(`ports[${index}].allow must be an array of at most ${MAX_CIDRS_PER_PORT} CIDRs`);
		const v4 = new Set<string>();
		const v6 = new Set<string>();
		item.allow.forEach((cidr, cidrIndex) => {
			const parsed = parsePublicCidr(cidr, `ports[${index}].allow[${cidrIndex}]`);
			(parsed.family === 4 ? v4 : v6).add(parsed.cidr);
		});
		return { port, v4: [...v4], v6: [...v6] };
	});
}

const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const TLS_NAME = new RegExp(`^(\\*|${LABEL})\\.db(\\.${LABEL})+$`);

/** `*.db.<domain>` or `<label>.db.<domain>`, lower-case. */
export function assertPublicDbTlsName(value: unknown, label = 'name'): string {
	if (typeof value !== 'string' || value.length > 253 || !TLS_NAME.test(value))
		throw new ValidationError(`${label} must be *.db.<domain> or <label>.db.<domain>`);
	return value;
}

export function parsePublicDbTls(body: unknown): string[] {
	const input = record(body, 'request');
	onlyKeys(input, ['names'], 'request');
	if (!Array.isArray(input.names) || input.names.length > MAX_TLS_NAMES)
		throw new ValidationError(`names must be an array of at most ${MAX_TLS_NAMES} names`);
	return [...new Set(input.names.map((name, index) => assertPublicDbTlsName(name, `names[${index}]`)))];
}

/** Caddy's storage key for a name: `*.db.x` is kept under `wildcard_.db.x`. */
export function caddyStorageName(name: string): string {
	return name.replace(/^\*\./, 'wildcard_.');
}

// ------------------------------------------------------------------------------- manager

export interface PublicDbPaths {
	nftPath: string;
	ufwPath: string;
	firewallCmdPath: string;
	/** The rendered ruleset, kept for review. */
	configPath: string;
	/** Caddy's data dir; certificates live under `<dir>/certificates/<issuer>/<name>/`. */
	caddyDataDir: string;
	/** Where the agent reads `<name>/cert.pem` + `key.pem` (`YOAL_PUBLIC_DB_TLS_DIR`). */
	tlsDir: string;
	/** A path owned by the agent's user; the copies get its uid/gid. */
	ownerFrom: string;
}

export const DEFAULT_PUBLIC_DB_PATHS: PublicDbPaths = {
	nftPath: 'nft',
	ufwPath: 'ufw',
	firewallCmdPath: 'firewall-cmd',
	configPath: '/etc/yoal/network/yoal-public-db.nft',
	caddyDataDir: process.env.YOAL_CADDY_DATA_DIR ?? '/var/lib/caddy/.local/share/caddy',
	tlsDir: process.env.YOAL_PUBLIC_DB_TLS_DIR ?? '/run/yoal/public-db-tls',
	ownerFrom: process.env.YOAL_MAIL_OWNER_PATH ?? '/var/lib/yoal',
};

export interface PublicDbFirewallResult {
	table: string;
	ports: number;
	hostManager: 'ufw' | 'firewalld' | 'none';
}

export interface PublicDbTlsResult {
	name: string;
	found: boolean;
	changed: boolean;
	certPath: string | null;
	keyPath: string | null;
}

export class PublicDbManager {
	private readonly paths: PublicDbPaths;
	private readonly runner: CommandRunner;
	private readonly chown: (path: string, uid: number, gid: number) => Promise<void>;

	constructor(
		options: {
			paths?: Partial<PublicDbPaths>;
			runner?: CommandRunner;
			chown?: (path: string, uid: number, gid: number) => Promise<void>;
		} = {},
	) {
		this.paths = { ...DEFAULT_PUBLIC_DB_PATHS, ...options.paths };
		this.runner = options.runner ?? defaultRunner;
		const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
		this.chown = options.chown ?? (isRoot ? (path, uid, gid) => fs.chown(path, uid, gid) : async () => undefined);
	}

	/** Replace the table in one transaction (`nft -c` first), then open or close the host manager. */
	async applyFirewall(rules: PublicDbPortRule[]): Promise<PublicDbFirewallResult> {
		const path = this.paths.configPath;
		await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 });
		await fs.writeFile(path, renderPublicDbFirewall(rules), { mode: 0o644 });
		const check = await this.runner([this.paths.nftPath, '-c', '-f', path]);
		if (check.code !== 0) throw new Error(`nftables check failed: ${check.stderr.trim()}`);
		const apply = await this.runner([this.paths.nftPath, '-f', path]);
		if (apply.code !== 0) throw new Error(`nftables apply failed: ${apply.stderr.trim() || apply.stdout.trim()}`);
		const open = rules.length > 0;
		let hostManager: PublicDbFirewallResult['hostManager'] = 'none';
		const ufw = await this.runner([this.paths.ufwPath, 'status']);
		if (ufw.code === 0 && /Status:\s*active/i.test(ufw.stdout)) {
			hostManager = 'ufw';
			if (open) await this.expect([this.paths.ufwPath, 'allow', RANGE_UFW], 'ufw allow public database ports');
			// Removing a rule that is not there is not an error worth failing the verb for.
			else await this.runner([this.paths.ufwPath, 'delete', 'allow', RANGE_UFW]);
		} else {
			const firewalld = await this.runner([this.paths.firewallCmdPath, '--state']);
			if (firewalld.code === 0 && /^running\s*$/i.test(firewalld.stdout.trim())) {
				hostManager = 'firewalld';
				const flag = open ? `--add-port=${RANGE_FIREWALLD}` : `--remove-port=${RANGE_FIREWALLD}`;
				// ALREADY_ENABLED / NOT_ENABLED are warnings with exit 0; other failures surface on open.
				for (const argv of [[this.paths.firewallCmdPath, flag], [this.paths.firewallCmdPath, '--permanent', flag]]) {
					if (open) await this.expect(argv, 'firewalld public database ports');
					else await this.runner(argv);
				}
			}
		}
		return { table: `inet ${TABLE}`, ports: rules.length, hostManager };
	}

	/**
	 * Copy each name's newest certificate into `<tlsDir>/<storage name>/`, owned by the agent's user,
	 * 0600, and remove directories for names no longer asked for.
	 */
	async copyTls(names: string[]): Promise<PublicDbTlsResult[]> {
		for (const name of names) assertPublicDbTlsName(name);
		const owner = await fs.stat(this.paths.ownerFrom);
		await fs.mkdir(this.paths.tlsDir, { recursive: true, mode: 0o700 });
		await this.chown(this.paths.tlsDir, owner.uid, owner.gid);
		const wanted = new Set(names.map(caddyStorageName));
		for (const entry of await fs.readdir(this.paths.tlsDir).catch(() => [] as string[]))
			if (!wanted.has(entry)) await fs.rm(join(this.paths.tlsDir, entry), { recursive: true, force: true });
		const results: PublicDbTlsResult[] = [];
		for (const name of names) {
			const storage = caddyStorageName(name);
			const source = await this.findCertificate(storage);
			if (!source) {
				results.push({ name, found: false, changed: false, certPath: null, keyPath: null });
				continue;
			}
			const [cert, key] = await Promise.all([fs.readFile(source.cert), fs.readFile(source.key)]);
			const dir = join(this.paths.tlsDir, storage);
			const certPath = join(dir, 'cert.pem');
			const keyPath = join(dir, 'key.pem');
			const current = await Promise.all([fs.readFile(certPath).catch(() => null), fs.readFile(keyPath).catch(() => null)]);
			let changed = false;
			if (!current[0]?.equals(cert) || !current[1]?.equals(key)) {
				await fs.mkdir(dir, { recursive: true, mode: 0o700 });
				await this.chown(dir, owner.uid, owner.gid);
				for (const [path, data] of [
					[certPath, cert],
					[keyPath, key],
				] as const) {
					const temp = `${path}.tmp`;
					await fs.writeFile(temp, data, { mode: 0o600 });
					await this.chown(temp, owner.uid, owner.gid);
					await fs.rename(temp, path);
				}
				changed = true;
			}
			results.push({ name, found: true, changed, certPath, keyPath });
		}
		return results;
	}

	private async findCertificate(storage: string): Promise<{ cert: string; key: string } | null> {
		const root = join(this.paths.caddyDataDir, 'certificates');
		let issuers: string[];
		try {
			issuers = await fs.readdir(root);
		} catch {
			return null;
		}
		let best: { cert: string; key: string; mtime: number } | null = null;
		for (const issuer of issuers) {
			const cert = join(root, issuer, storage, `${storage}.crt`);
			const key = join(root, issuer, storage, `${storage}.key`);
			try {
				const [stat] = await Promise.all([fs.stat(cert), fs.stat(key)]);
				if (!best || stat.mtimeMs > best.mtime) best = { cert, key, mtime: stat.mtimeMs };
			} catch {
				// Not issued by this issuer.
			}
		}
		return best ? { cert: best.cert, key: best.key } : null;
	}

	private async expect(argv: string[], label: string): Promise<void> {
		const result = await this.runner(argv);
		if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim()}`);
	}
}

/**
 * The ruleset. Declare, delete, recreate in one `nft -f` so a re-apply never appends. Each port is
 * accepted from its own CIDRs (a `/0` becomes a family match), then the whole range is dropped.
 * The chain hooks input on every interface, loopback included: the proxy has no local clients.
 */
export function renderPublicDbFirewall(rules: PublicDbPortRule[]): string {
	const lines: string[] = [];
	for (const rule of [...rules].sort((a, b) => a.port - b.port)) {
		for (const [family, cidrs] of [
			['ip', rule.v4],
			['ip6', rule.v6],
		] as const) {
			if (cidrs.length === 0) continue;
			if (cidrs.some((cidr) => cidr.endsWith('/0')))
				lines.push(`\t\tmeta nfproto ${family === 'ip' ? 'ipv4' : 'ipv6'} tcp dport ${rule.port} accept`);
			else lines.push(`\t\ttcp dport ${rule.port} ${family} saddr { ${cidrs.join(', ')} } accept`);
		}
	}
	lines.push(`\t\ttcp dport ${PUBLIC_DB_PORT_MIN}-${PUBLIC_DB_PORT_MAX} drop`);
	return `table inet ${TABLE}
delete table inet ${TABLE}
table inet ${TABLE} {
\tchain input {
\t\ttype filter hook input priority -20; policy accept;
${lines.join('\n')}
\t}
}
`;
}
