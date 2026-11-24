import * as z from 'zod';
import type { DatabaseEngine } from './database.ts';

/**
 * Public database access (docs/DATABASES.md §19, D241).
 *
 * A database with public access gets one install-wide port and the host
 * `<name>-<org8>.db.<contentDomain>`. Every ingress node running an agent with `public-db` listens
 * on that port behind a per-port kernel allowlist, terminates TLS and forwards to the database's
 * loopback port (or a C2 service endpoint when the database lives on another node).
 */

export const PUBLIC_DATABASE_PORT_MIN = 24_000;
export const PUBLIC_DATABASE_PORT_MAX = 24_999;
export const publicDatabasePortRange = { min: PUBLIC_DATABASE_PORT_MIN, max: PUBLIC_DATABASE_PORT_MAX } as const;

/** The sub-zone of the content domain public database hosts live in (`*.db.<contentDomain>`). */
export const PUBLIC_DATABASE_ZONE = 'db';

/** The agent capability: public listeners, the `inet yoal-public-db` firewall and the TLS copy verb. */
export const PUBLIC_DB_CAPABILITY = 'public-db';

export const PUBLIC_ACCESS_MAX_RULES = 50;
export const PUBLIC_ACCESS_MAX_CREDENTIALS = 20;
export const PUBLIC_ACCESS_MAX_CONNECTIONS = 500;
export const PUBLIC_ACCESS_DEFAULT_CONNECTIONS = 20;
/** Longest expiry a person may set, from now. */
export const PUBLIC_ACCESS_MAX_EXPIRY_MS = 366 * 24 * 3_600_000;
/** Recent events kept per database on the control plane. */
export const PUBLIC_ACCESS_EVENTS_KEPT = 200;
/** Events one heartbeat may carry. */
export const PUBLIC_ACCESS_EVENTS_PER_HEARTBEAT = 50;

/** Proxy limits the agent applies (§19.2). Exported so tests and docs agree. */
export const PUBLIC_ACCESS_LIMITS = {
	/** New connections per minute per source address. */
	connectsPerMinute: 60,
	/** Failed logins (Postgres) before a ban. */
	authFailures: 10,
	/** Failed handshakes (other engines, or a client that never finished TLS) before a ban. */
	handshakeFailures: 30,
	failureWindowMs: 10 * 60_000,
	banMs: 15 * 60_000,
	/** TLS handshake plus startup message must finish within this. */
	handshakeTimeoutMs: 10_000,
} as const;

/**
 * How the proxy talks to a client. `postgres`: `SSLRequest` or direct TLS, then the startup
 * message (role allowlist). `tls`: TLS from the first byte (Valkey/Redis `rediss://`, MongoDB
 * `tls=true`, ClickHouse HTTPS).
 */
export const publicAccessProtocols = ['postgres', 'tls'] as const;
export type PublicAccessProtocol = (typeof publicAccessProtocols)[number];

/** The proxy protocol for an engine, or null when the engine cannot be exposed (MySQL, MariaDB). */
export function publicAccessProtocol(engine: DatabaseEngine): PublicAccessProtocol | null {
	switch (engine) {
		case 'postgres':
			return 'postgres';
		case 'valkey':
		case 'redis':
		case 'mongodb':
		case 'clickhouse':
			return 'tls';
		default:
			return null;
	}
}

/** Why an engine cannot be exposed, for the refusal and the dashboard. */
export function publicAccessUnsupportedReason(engine: DatabaseEngine): string | null {
	if (publicAccessProtocol(engine)) return null;
	return `${engine === 'mysql' ? 'MySQL' : engine === 'mariadb' ? 'MariaDB' : engine} negotiates TLS inside its own handshake, which the public proxy does not support yet. Use a tunnel or an app on Yoal.`;
}

/** `<name>-<org8>.db.<contentDomain>`; names are unique per org, so the host carries the org suffix. */
export function publicDatabaseHost(name: string, orgId: string, contentDomain: string): string {
	const org = orgId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-8);
	return `${name}-${org}.${PUBLIC_DATABASE_ZONE}.${contentDomain.toLowerCase()}`;
}

/** The wildcard certificate name for public database hosts. */
export function publicDatabaseWildcard(contentDomain: string): string {
	return `*.${PUBLIC_DATABASE_ZONE}.${contentDomain.toLowerCase()}`;
}

// ---------------------------------------------------------------------------------------------
// Addresses and CIDRs (IPv4 and IPv6). Pure, shared by core (validation) and the agent (matching).
// ---------------------------------------------------------------------------------------------

export interface ParsedCidr {
	family: 4 | 6;
	/** Network address, host bits cleared. */
	network: bigint;
	prefix: number;
}

function parseIpv4Bits(value: string): bigint | null {
	const parts = value.split('.');
	if (parts.length !== 4) return null;
	let out = 0n;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		out = (out << 8n) | BigInt(octet);
	}
	return out;
}

function parseIpv6Bits(value: string): bigint | null {
	if (value.length > 45 || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
	let head = value;
	let tailV4: bigint | null = null;
	// An embedded IPv4 tail (`::ffff:1.2.3.4`) is two groups.
	const lastColon = value.lastIndexOf(':');
	if (value.includes('.')) {
		tailV4 = parseIpv4Bits(value.slice(lastColon + 1));
		if (tailV4 === null) return null;
		head = `${value.slice(0, lastColon + 1)}0:0`;
	}
	const halves = head.split('::');
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(':') : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	if (halves.length === 1 && left.length !== 8) return null;
	if (halves.length === 2 && left.length + right.length > 7) return null;
	const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
	let out = 0n;
	for (const group of groups) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
		out = (out << 16n) | BigInt(parseInt(group, 16));
	}
	if (tailV4 !== null) out = (out & ~0xffffffffn) | tailV4;
	return out;
}

/** An address as `{ family, bits }`; IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is returned as IPv4. */
export function parseIpAddress(value: string): { family: 4 | 6; bits: bigint } | null {
	const trimmed = value.trim();
	const v4 = parseIpv4Bits(trimmed);
	if (v4 !== null) return { family: 4, bits: v4 };
	const v6 = parseIpv6Bits(trimmed.replace(/%.*$/, ''));
	if (v6 === null) return null;
	if (v6 >> 32n === 0xffffn) return { family: 4, bits: v6 & 0xffffffffn };
	return { family: 6, bits: v6 };
}

/** Parse `a.b.c.d/n` or `x::/n`. Host bits must be zero (`exact`) or are cleared. */
export function parseCidr(value: string, options: { exact?: boolean } = {}): ParsedCidr | null {
	const slash = value.indexOf('/');
	const addressPart = slash === -1 ? value : value.slice(0, slash);
	const address = parseIpAddress(addressPart);
	if (!address) return null;
	// `::ffff:1.2.3.4/120` would silently become IPv4; refuse mapped CIDRs.
	if (address.family === 4 && addressPart.includes(':')) return null;
	const width = address.family === 4 ? 32 : 128;
	const prefixText = slash === -1 ? String(width) : value.slice(slash + 1);
	if (!/^\d{1,3}$/.test(prefixText)) return null;
	const prefix = Number(prefixText);
	if (prefix > width) return null;
	const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix);
	const network = address.bits & mask;
	if (options.exact && network !== address.bits) return null;
	return { family: address.family, network, prefix };
}

export function formatCidr(cidr: ParsedCidr): string {
	if (cidr.family === 4) {
		const n = cidr.network;
		return `${(n >> 24n) & 255n}.${(n >> 16n) & 255n}.${(n >> 8n) & 255n}.${n & 255n}/${cidr.prefix}`;
	}
	const groups: string[] = [];
	for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(((cidr.network >> shift) & 0xffffn).toString(16));
	// Compress the longest run of zero groups (RFC 5952).
	let bestStart = -1;
	let bestLength = 0;
	for (let index = 0; index < 8; ) {
		if (groups[index] !== '0') {
			index += 1;
			continue;
		}
		let end = index;
		while (end < 8 && groups[end] === '0') end += 1;
		if (end - index > bestLength && end - index > 1) {
			bestStart = index;
			bestLength = end - index;
		}
		index = end;
	}
	const text =
		bestStart === -1
			? groups.join(':')
			: `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
	return `${text}/${cidr.prefix}`;
}

export function cidrContains(cidr: ParsedCidr, address: { family: 4 | 6; bits: bigint }): boolean {
	if (cidr.family !== address.family) return false;
	const width = cidr.family === 4 ? 32 : 128;
	if (cidr.prefix === 0) return true;
	const mask = ((1n << BigInt(cidr.prefix)) - 1n) << BigInt(width - cidr.prefix);
	return (address.bits & mask) === cidr.network;
}

function overlaps(a: ParsedCidr, b: ParsedCidr): boolean {
	if (a.family !== b.family) return false;
	const shorter = a.prefix <= b.prefix ? a : b;
	const longer = shorter === a ? b : a;
	return cidrContains(shorter, { family: longer.family, bits: longer.network });
}

/** Ranges a public allowlist may not contain or overlap: none of them is reachable from the internet. */
const BLOCKED_RANGES: ReadonlyArray<{ cidr: string; why: string }> = [
	{ cidr: '0.0.0.0/8', why: 'unspecified' },
	{ cidr: '10.0.0.0/8', why: 'private (RFC 1918)' },
	{ cidr: '100.64.0.0/10', why: 'carrier-grade NAT' },
	{ cidr: '127.0.0.0/8', why: 'loopback' },
	{ cidr: '169.254.0.0/16', why: 'link-local' },
	{ cidr: '172.16.0.0/12', why: 'private (RFC 1918)' },
	{ cidr: '192.0.0.0/24', why: 'reserved' },
	{ cidr: '192.168.0.0/16', why: 'private (RFC 1918)' },
	{ cidr: '198.18.0.0/15', why: 'benchmarking' },
	{ cidr: '224.0.0.0/4', why: 'multicast' },
	{ cidr: '240.0.0.0/4', why: 'reserved' },
	{ cidr: '::/128', why: 'unspecified' },
	{ cidr: '::1/128', why: 'loopback' },
	{ cidr: '64:ff9b::/96', why: 'NAT64' },
	{ cidr: '100::/64', why: 'discard' },
	{ cidr: 'fc00::/7', why: 'unique local' },
	{ cidr: 'fe80::/10', why: 'link-local' },
	{ cidr: 'ff00::/8', why: 'multicast' },
];
const BLOCKED = BLOCKED_RANGES.map((entry) => ({ parsed: parseCidr(entry.cidr)!, why: entry.why }));

/** IPv4 prefixes shorter than this, and IPv6 shorter than the next, need `allowAnywhere`. */
export const PUBLIC_ACCESS_MIN_PREFIX = { 4: 8, 6: 32 } as const;

/**
 * Validate one allowlist entry. Returns the canonical CIDR (a bare address becomes /32 or /128) or
 * the reason it is refused. Documentation ranges (TEST-NETs, 2001:db8::/32) are accepted so docs and
 * tests can use them; nothing routes them anyway.
 */
export function checkPublicCidr(raw: string): { ok: true; cidr: string } | { ok: false; reason: string } {
	const value = raw.trim();
	const parsed = parseCidr(value);
	if (!parsed) return { ok: false, reason: `"${value}" is not an IPv4 or IPv6 address or CIDR.` };
	const exact = parseCidr(value, { exact: true });
	if (!exact)
		return { ok: false, reason: `"${value}" has host bits set; did you mean ${formatCidr(parsed)}?` };
	if (parsed.prefix < PUBLIC_ACCESS_MIN_PREFIX[parsed.family])
		return {
			ok: false,
			reason: `"${value}" is broader than /${PUBLIC_ACCESS_MIN_PREFIX[parsed.family]}; list narrower ranges, or allow any address explicitly.`,
		};
	for (const blocked of BLOCKED)
		if (overlaps(blocked.parsed, parsed))
			return {
				ok: false,
				reason: `"${value}" is ${blocked.why} (${formatCidr(blocked.parsed)}): it is never reachable from the internet. Apps on Yoal attach the database instead.`,
			};
	return { ok: true, cidr: formatCidr(parsed) };
}

/** The allowlist an `allowAnywhere` configuration renders. */
export const PUBLIC_ACCESS_ANYWHERE = ['0.0.0.0/0', '::/0'] as const;

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

export const publicAccessRuleSchema = z.object({
	cidr: z.string().trim().min(1).max(64),
	label: z.string().trim().max(80).default(''),
});
export type PublicAccessRule = z.infer<typeof publicAccessRuleSchema>;

/** `PUT /databases/:name/public-access`: enables, or replaces the whole configuration. */
export const databasePublicAccessInputSchema = z
	.object({
		rules: z.array(publicAccessRuleSchema).max(PUBLIC_ACCESS_MAX_RULES).default([]),
		/** Admit any address. Needs `YOAL_FEATURE_DB_PUBLIC_ANYWHERE`; TLS, roles and bans still apply. */
		allowAnywhere: z.boolean().default(false),
		/**
		 * Postgres: the credentials (`dbc_…`, or `owner`/`app`/`readonly`/`backup` when exactly one
		 * ready credential has that role) whose roles may log in through the proxy. 1–20.
		 */
		credentials: z.array(z.string().trim().min(1).max(64)).max(PUBLIC_ACCESS_MAX_CREDENTIALS).default([]),
		/** ISO time the access ends by itself, or null for none (≤ 1 year ahead). */
		expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
		maxConnections: z.number().int().min(1).max(PUBLIC_ACCESS_MAX_CONNECTIONS).default(PUBLIC_ACCESS_DEFAULT_CONNECTIONS),
	})
	.strict();
export type DatabasePublicAccessInput = z.input<typeof databasePublicAccessInputSchema>;
export type DatabasePublicAccessParsed = z.output<typeof databasePublicAccessInputSchema>;

export const publicAccessStatuses = ['disabled', 'pending', 'active', 'degraded', 'unsupported'] as const;
export type PublicAccessStatus = (typeof publicAccessStatuses)[number];

/** Listener state an ingress reports for one database. */
export const publicListenerStates = [
	/** Listening and serving. */
	'listening',
	/** Waiting for the helper's firewall to take the current rules; nothing is bound. */
	'firewall-pending',
	/** No certificate for the host yet; connections are closed. */
	'no-certificate',
	/** The bind failed (port held by something else). */
	'bind-failed',
	/** The database is on another node and its service endpoint is missing. */
	'unreachable',
	/** Past `expiresAt`; closed by the agent itself. */
	'expired',
	/** The helper on this node has no public-db verbs. */
	'helper-outdated',
] as const;
export type PublicListenerState = (typeof publicListenerStates)[number];

export const publicRefusalReasons = [
	'source',
	'tls-required',
	'handshake',
	'role',
	'rate-limit',
	'banned',
	'capacity',
	'auth-failed',
	'expired',
	'no-certificate',
	'upstream',
] as const;
export type PublicRefusalReason = (typeof publicRefusalReasons)[number];

export interface PublicAccessNodeView {
	nodeId: string;
	nodeName: string;
	state: PublicListenerState | 'unknown';
	error: string | null;
	open: number;
	accepted: number;
	refused: number;
	authFailures: number;
	banned: number;
	reportedAt: string | null;
}

export interface PublicAccessEventView {
	at: string;
	nodeId: string;
	source: string;
	reason: PublicRefusalReason;
	detail: string | null;
}

export interface PublicAccessCredentialView {
	id: string;
	role: string;
	username: string;
	/** False once the credential was revoked or failed; it no longer logs in through the proxy. */
	usable: boolean;
}

/** `GET /databases/:name/public-access`. No secrets: the connection string has a placeholder. */
export interface DatabasePublicAccessView {
	enabled: boolean;
	status: PublicAccessStatus;
	/** Why the status is not `active`, for people. */
	statusDetail: string | null;
	protocol: PublicAccessProtocol | null;
	host: string | null;
	port: number | null;
	rules: PublicAccessRule[];
	allowAnywhere: boolean;
	/** Whether the install allows `allowAnywhere` (`DB_PUBLIC_ANYWHERE`). */
	anywhereAvailable: boolean;
	credentials: PublicAccessCredentialView[];
	maxConnections: number;
	expiresAt: string | null;
	enabledAt: string | null;
	enabledBy: string | null;
	updatedAt: string | null;
	updatedBy: string | null;
	disabledAt: string | null;
	disabledReason: 'manual' | 'expired' | null;
	/** e.g. `postgres://<user>:<password>@host:24001/app?sslmode=verify-full`. */
	connectionTemplate: string | null;
	nodes: PublicAccessNodeView[];
	events: PublicAccessEventView[];
}

/** The summary `DatabaseView.publicAccess` carries. */
export interface DatabasePublicAccessSummary {
	enabled: boolean;
	status: PublicAccessStatus;
	host: string | null;
	port: number | null;
	expiresAt: string | null;
}

// ---------------------------------------------------------------------------------------------
// Desired state and heartbeat
// ---------------------------------------------------------------------------------------------

const wireCidrSchema = z
	.string()
	.max(64)
	.refine((value) => parseCidr(value, { exact: true }) !== null, 'invalid CIDR');

/** One public listener on an ingress node (`DesiredState.publicDatabases`). */
export const publicDatabaseListenerSchema = z.object({
	/** The database id (`db_…`). */
	id: z.string().min(1).max(64),
	port: z.number().int().min(PUBLIC_DATABASE_PORT_MIN).max(PUBLIC_DATABASE_PORT_MAX),
	protocol: z.enum(publicAccessProtocols),
	host: z.string().min(1).max(253),
	/** Certificate names to look for, in order: the exact host, then the wildcard. */
	certificateNames: z.array(z.string().min(1).max(253)).max(4),
	allow: z.array(wireCidrSchema).max(PUBLIC_ACCESS_MAX_RULES + 2),
	/**
	 * Postgres roles allowed to log in. For `postgres` an empty list refuses every role (all listed
	 * credentials were revoked or expired: fail closed). Ignored for `tls` engines, which send [].
	 */
	users: z.array(z.string().min(1).max(63)).max(PUBLIC_ACCESS_MAX_CREDENTIALS + 1),
	/** Loopback port to dial: the database's own, or this node's service endpoint for it. Null: unreachable. */
	upstreamPort: z.number().int().min(1).max(65_535).nullable(),
	maxConnections: z.number().int().min(1).max(PUBLIC_ACCESS_MAX_CONNECTIONS),
	expiresAt: z.string().nullable(),
	/** Bumped on every configuration change. */
	version: z.number().int().min(0),
});
export type PublicDatabaseListener = z.infer<typeof publicDatabaseListenerSchema>;

export const publicDatabaseStatusSchema = z.object({
	id: z.string().min(1).max(64),
	state: z.enum(publicListenerStates),
	error: z.string().max(500).nullable().default(null),
	open: z.number().int().min(0),
	accepted: z.number().int().min(0),
	refused: z.number().int().min(0),
	authFailures: z.number().int().min(0),
	banned: z.number().int().min(0),
	version: z.number().int().min(0),
});
export type PublicDatabaseStatus = z.infer<typeof publicDatabaseStatusSchema>;

export const publicDatabaseEventSchema = z.object({
	id: z.string().min(1).max(64),
	at: z.string().max(40),
	source: z.string().max(64),
	reason: z.enum(publicRefusalReasons),
	detail: z.string().max(200).nullable().default(null),
});
export type PublicDatabaseEvent = z.infer<typeof publicDatabaseEventSchema>;

/**
 * The connection URL an outside client uses. TLS is always on: `sslmode=require` for Postgres (the
 * most compatible setting; the certificate is publicly trusted, so `verify-full` with the system
 * roots works too), `rediss://`, MongoDB `tls=true`, ClickHouse `https://`.
 */
export function publicDatabaseUrl(options: {
	engine: DatabaseEngine;
	user: string;
	pass: string;
	host: string;
	port: number;
	database: string;
}): string | null {
	const user = encodeURIComponent(options.user);
	const pass = encodeURIComponent(options.pass);
	const database = encodeURIComponent(options.database);
	const authority = `${user}:${pass}@${options.host}:${options.port}`;
	switch (options.engine) {
		case 'postgres':
			return `postgres://${authority}/${database}?sslmode=require`;
		case 'mongodb':
			return `mongodb://${authority}/${database}?authSource=admin&tls=true&directConnection=true`;
		case 'valkey':
		case 'redis':
			return `rediss://${authority}/${database}`;
		case 'clickhouse':
			return `https://${authority}/${database}`;
		default:
			return null;
	}
}
