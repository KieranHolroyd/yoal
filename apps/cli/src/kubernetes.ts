/**
 * Managed Kubernetes (docs/KUBERNETES.md): the wire types the CLI reads, pure formatting for
 * `yoal k8s`, the kubectl exec-credential output, and the per-cluster token cache. Types mirror
 * `packages/contracts/src/kubernetes.ts`; the CLI bundle stays free of runtime dependencies (D40),
 * so keep them in sync.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageError } from './errors.ts';
import { formatBytes, formatTime, plural, renderTable } from './output.ts';

/** Mirrors the contracts enums. Keep in sync; the server validates. */
export const KUBERNETES_TIERS = ['userns', 'trusted'] as const;
export const KUBERNETES_API_ACCESS = ['public', 'private'] as const;
export const KUBERNETES_ACCESS_ROLES = ['view', 'edit', 'admin'] as const;
export const KUBERNETES_MAX_AGENTS = 8;
export const KUBERNETES_MIN_MEMORY_MB = 2048;

export type KubernetesStatus = 'pending' | 'starting' | 'running' | 'degraded' | 'failed' | 'stopped';

export interface KubernetesMachineView {
	id: string;
	role: 'server' | 'agent';
	ordinal: number;
	nodeId: string;
	nodeName: string | null;
	status: KubernetesStatus;
	restarts: number;
	memoryMb: number;
	cpus: number;
	/** Absent from servers before K5. */
	release?: string;
	overlayIp?: string | null;
}

export interface KubernetesRouteView {
	id: string;
	host: string;
	createdAt: string;
}

export interface KubernetesAttachmentView {
	id: string;
	kind: 'database' | 'broker';
	name: string;
	namespace: string;
	secret: string;
	createdAt: string;
}

export interface KubernetesAccessKeyView {
	id: string;
	name: string;
	role: 'view' | 'edit' | 'admin';
	createdBy: string;
	createdAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
}

export interface KubernetesAccessKeySecret extends KubernetesAccessKeyView {
	kubeconfig: string;
}

export interface KubernetesClusterView {
	id: string;
	name: string;
	minor: string;
	release: string;
	displayVersion: string;
	upgradeTo: string | null;
	endOfSupport: string | null;
	tier: 'userns' | 'trusted';
	purpose: 'lab' | 'production';
	status: KubernetesStatus;
	message: string | null;
	nodeId: string;
	nodeName: string | null;
	memoryMb: number;
	cpus: number;
	agents: number;
	apiAccess: 'public' | 'private';
	allowCidrs: string[];
	apiUrl: string | null;
	window: { hour: number; hours: number };
	autoPatch: boolean;
	traefik: boolean;
	/** K5/K6 fields; absent from older servers. */
	servers?: number;
	datastore?: 'sqlite' | 'etcd';
	multiNode?: boolean;
	backup?: { hours: number; retentionDays: number; nextAt: string | null; lastAt: string | null; lastStatus: string | null };
	upgrade?: { from: string; to: string; startedAt: string; message: string | null } | null;
	deprecatedApis?: string[];
	shipper?: boolean;
	logRetentionDays?: number;
	restoring?: boolean;
	machines: KubernetesMachineView[];
	routes: KubernetesRouteView[];
	attachments: KubernetesAttachmentView[];
	nodesReady: number | null;
	nodesTotal: number | null;
	statsAt: string | null;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	purgeAt: string | null;
}

export interface KubernetesToken {
	token: string;
	expiresAt: string;
	audience: string;
	groups: string[];
}

export interface KubernetesCreateInput {
	name: string;
	version?: string;
	placement?: string;
	tier?: string;
	memoryMb?: number;
	cpus?: number;
	agents?: number;
	apiAccess?: string;
	allowCidrs?: string[];
	/** `system`, `fast`, `bulk` or a disk name (docs/STORAGE.md). */
	storage?: string;
	purpose?: 'lab' | 'production';
	servers?: 1 | 3;
	nodes?: string[];
	backupHours?: number;
	backupRetentionDays?: number;
	shipper?: boolean;
}

export interface KubernetesUpdateInput {
	version?: string;
	memoryMb?: number;
	cpus?: number;
	agents?: number;
	apiAccess?: string;
	allowCidrs?: string[];
	autoPatch?: boolean;
	purpose?: 'lab' | 'production';
	servers?: 3;
	backupHours?: number;
	backupRetentionDays?: number;
	shipper?: boolean;
	logRetentionDays?: number;
}

export interface KubernetesBackupView {
	id: string;
	clusterName: string;
	kind: 'scheduled' | 'manual' | 'pre-upgrade';
	datastore: 'sqlite' | 'etcd';
	status: 'pending' | 'running' | 'ok' | 'failed';
	error: string | null;
	sizeBytes: number | null;
	minor: string;
	release: string;
	location: string;
	createdAt: string;
	finishedAt: string | null;
	expiresAt: string;
}

export interface KubernetesPodLogLine {
	seq: number;
	namespace: string;
	pod: string;
	container: string;
	stream: string;
	message: string;
	at: string;
}

export interface KubernetesLogEvent {
	seq: number;
	ts: number;
	level: string;
	stream?: string;
	source?: string;
	message: string;
}

// ---------------------------------------------------------------- parsing

export function parseAgents(value: string): number {
	const agents = Number(value);
	if (!Number.isInteger(agents) || agents < 0 || agents > KUBERNETES_MAX_AGENTS)
		throw new UsageError(`--agents must be a whole number from 0 to ${KUBERNETES_MAX_AGENTS}.`);
	return agents;
}

export function parseChoice<T extends string>(value: string, choices: readonly T[], flag: string): T {
	if (!(choices as readonly string[]).includes(value))
		throw new UsageError(`${flag} must be one of ${choices.join(', ')}.`);
	return value as T;
}

/** `--allow 203.0.113.0/24 --allow 10.0.0.0/8,192.168.0.0/16`; `--allow none` clears the list. */
export function parseCidrs(values: string[]): string[] {
	const cidrs = values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter(Boolean);
	if (cidrs.length === 1 && cidrs[0] === 'none') return [];
	for (const cidr of cidrs)
		if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(cidr))
			throw new UsageError(`"${cidr}" is not a CIDR. Use e.g. 203.0.113.0/24 (or --allow none to clear).`);
	return [...new Set(cidrs)];
}

// ---------------------------------------------------------------- formatting

export function clusterTable(clusters: KubernetesClusterView[]): string {
	const rows = clusters.map((cluster) => [
		cluster.name,
		cluster.deletedAt ? 'deleted' : cluster.restoring ? 'restoring' : cluster.upgrade ? `upgrading → ${cluster.upgrade.to}` : cluster.status,
		cluster.displayVersion + (cluster.upgradeTo ? ` (→ ${cluster.upgradeTo})` : ''),
		cluster.nodeName ?? cluster.nodeId,
		`${(cluster.servers ?? 1) + cluster.agents} × ${cluster.memoryMb} MB`,
		cluster.tier,
		cluster.apiUrl ?? 'private',
	]);
	return renderTable(['NAME', 'STATUS', 'VERSION', 'NODE', 'MACHINES', 'TIER', 'API'], rows);
}

export function clusterDetails(cluster: KubernetesClusterView): string {
	const lines = [
		`Name         ${cluster.name}`,
		`Status       ${cluster.deletedAt ? 'deleted' : cluster.status}${cluster.message ? ` (${cluster.message})` : ''}`,
		`Version      ${cluster.displayVersion} (${cluster.minor})${cluster.endOfSupport ? `, supported until ${cluster.endOfSupport}` : ''}`,
		`Upgrade to   ${cluster.upgradeTo ?? 'none (newest)'}`,
		`Node         ${cluster.nodeName ?? cluster.nodeId}`,
		`Tier         ${cluster.tier}${cluster.tier === 'trusted' ? ' (cluster admins can become root on this node)' : ''}`,
		`Machines     ${plural(cluster.servers ?? 1, 'server')} + ${plural(cluster.agents, 'agent')}, ${cluster.memoryMb} MB · ${cluster.cpus} vCPU each`,
		`Datastore    ${cluster.datastore ?? 'sqlite'}${(cluster.servers ?? 1) >= 3 ? ' (highly available)' : ''}${cluster.multiNode ? ', spread across nodes' : ''}`,
		`Purpose      ${cluster.purpose}`,
		`Nodes ready  ${cluster.nodesReady === null ? '-' : `${cluster.nodesReady}/${cluster.nodesTotal ?? '?'}`}`,
		`API          ${cluster.apiUrl ?? 'private (no public endpoint)'}`,
		`Allowlist    ${cluster.allowCidrs.length ? cluster.allowCidrs.join(', ') : 'any address'}`,
		`Window       ${String(cluster.window.hour).padStart(2, '0')}:00 for ${plural(cluster.window.hours, 'hour')}; auto-patch ${cluster.autoPatch ? 'on' : 'off'}`,
		`Ingress      ${cluster.traefik ? 'Traefik (bundled)' : 'off'}`,
		...(cluster.backup
			? [
					`Backups      every ${plural(cluster.backup.hours, 'hour')}, kept ${plural(cluster.backup.retentionDays, 'day')}; last ${
						cluster.backup.lastAt ? `${formatTime(cluster.backup.lastAt)} (${cluster.backup.lastStatus ?? '-'})` : 'never'
					}, next ${formatTime(cluster.backup.nextAt ?? undefined)}`,
				]
			: []),
		...(cluster.shipper !== undefined
			? [`Pod logs     ${cluster.shipper ? `shipped, kept ${plural(cluster.logRetentionDays ?? 0, 'day')}` : 'off'}`]
			: []),
		`Created      ${formatTime(cluster.createdAt)}`,
	];
	if (cluster.restoring) lines.push('', 'Restoring from a backup: the machines start once the datastore is in place.');
	if (cluster.upgrade)
		lines.push(
			'',
			`Rollout in progress: ${cluster.upgrade.from} → ${cluster.upgrade.to} since ${formatTime(cluster.upgrade.startedAt)}${cluster.upgrade.message ? ` (${cluster.upgrade.message})` : ''}`,
		);
	if (cluster.deprecatedApis && cluster.deprecatedApis.length > 0)
		lines.push('', `Deprecated APIs still in use: ${cluster.deprecatedApis.join(', ')}`);
	if (cluster.deletedAt) lines.push(`Deleted      ${formatTime(cluster.deletedAt)}; purged after ${formatTime(cluster.purgeAt ?? undefined)}`);
	if (cluster.machines.length > 0) {
		lines.push('', 'Machines:');
		lines.push(
			renderTable(
				['ROLE', 'STATUS', 'NODE', 'OVERLAY IP', 'RESTARTS', 'SIZE'],
				cluster.machines.map((machine) => [
					machine.role === 'server' ? `server-${machine.ordinal}` : `agent-${machine.ordinal}`,
					machine.status,
					machine.nodeName ?? machine.nodeId,
					machine.overlayIp ?? '-',
					String(machine.restarts),
					`${machine.memoryMb} MB · ${machine.cpus} vCPU`,
				]),
			),
		);
	}
	if (cluster.routes.length > 0) lines.push('', `Routes: ${cluster.routes.map((route) => route.host).join(', ')}`);
	if (cluster.attachments.length > 0)
		lines.push(
			'',
			`Attachments: ${cluster.attachments.map((item) => `${item.kind} ${item.name} → ${item.namespace}/${item.secret}`).join(', ')}`,
		);
	return lines.join('\n');
}

export function backupTable(backups: KubernetesBackupView[]): string {
	return renderTable(
		['ID', 'KIND', 'STATUS', 'VERSION', 'SIZE', 'CREATED', 'EXPIRES'],
		backups.map((backup) => [
			backup.id,
			backup.kind,
			backup.status + (backup.error ? ` (${backup.error})` : ''),
			`${backup.minor} ${backup.datastore}`,
			backup.sizeBytes === null ? '-' : formatBytes(backup.sizeBytes),
			formatTime(backup.createdAt),
			formatTime(backup.expiresAt),
		]),
	);
}

export function formatPodLogLine(line: KubernetesPodLogLine): string {
	return `${line.at} ${line.namespace}/${line.pod}${line.container ? `[${line.container}]` : ''} ${line.message}`;
}

/** `--servers 1|3`. */
export function parseServers(value: string): 1 | 3 {
	if (value === '1') return 1;
	if (value === '3') return 3;
	throw new UsageError('--servers must be 1 or 3.');
}

/** `--nodes a,b,c` (repeatable), deduplicated. */
export function parseNodeList(values: string[]): string[] {
	const nodes = [...new Set(values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean))];
	if (values.length > 0 && nodes.length === 0) throw new UsageError('--nodes needs at least one node id.');
	return nodes;
}

export function parseWholeNumber(value: string, flag: string, min: number, max: number): number {
	const number = Number(value);
	if (!Number.isInteger(number) || number < min || number > max)
		throw new UsageError(`${flag} must be a whole number from ${min} to ${max}.`);
	return number;
}

export function accessKeyTable(keys: KubernetesAccessKeyView[]): string {
	return renderTable(
		['NAME', 'ROLE', 'CREATED', 'EXPIRES', 'STATE'],
		keys.map((key) => [
			key.name,
			key.role,
			formatTime(key.createdAt),
			key.expiresAt ? formatTime(key.expiresAt) : 'never',
			key.revokedAt ? `revoked ${formatTime(key.revokedAt)}` : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? 'expired' : 'active',
		]),
	);
}

export function formatLogLine(event: KubernetesLogEvent): string {
	const time = Number.isFinite(event.ts) ? new Date(event.ts).toISOString() : '-';
	return `${time} ${event.level.toUpperCase().padEnd(5)} ${event.message}`;
}

// ---------------------------------------------------------------- kubectl exec credential (K8)

/**
 * The exact `client.authentication.k8s.io/v1` ExecCredential kubectl reads from the plugin's
 * stdout. Nothing else may be printed to stdout when this is.
 */
export function execCredential(token: Pick<KubernetesToken, 'token' | 'expiresAt'>): string {
	return JSON.stringify({
		apiVersion: 'client.authentication.k8s.io/v1',
		kind: 'ExecCredential',
		status: { token: token.token, expirationTimestamp: token.expiresAt },
	});
}

/** Reuse a cached token until this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Cache file for one cluster under one identity. The name carries the profile and cluster for
 * readability and a hash of the platform URL and API key, so switching keys or platforms never
 * reuses another identity's token.
 */
export function tokenCachePath(
	configDir: string,
	input: { url: string; credential: string; cluster: string; profile?: string },
): string {
	const identity = createHash('sha256').update(`${input.url}\n${input.credential}`).digest('hex').slice(0, 16);
	const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_');
	return join(configDir, 'k8s-tokens', `${safe(input.profile ?? 'env')}--${safe(input.cluster)}--${identity}.json`);
}

/** A cached token still good for at least `TOKEN_REFRESH_MARGIN_MS`, or null. */
export function usableCachedToken(raw: unknown, now = Date.now()): KubernetesToken | null {
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Record<string, unknown>;
	if (typeof record.token !== 'string' || typeof record.expiresAt !== 'string') return null;
	const expires = Date.parse(record.expiresAt);
	if (!Number.isFinite(expires) || expires - TOKEN_REFRESH_MARGIN_MS <= now) return null;
	return {
		token: record.token,
		expiresAt: record.expiresAt,
		audience: typeof record.audience === 'string' ? record.audience : '',
		groups: Array.isArray(record.groups) ? record.groups.filter((item): item is string => typeof item === 'string') : [],
	};
}

export async function readCachedToken(path: string, now = Date.now()): Promise<KubernetesToken | null> {
	try {
		return usableCachedToken(JSON.parse(await readFile(path, 'utf8')), now);
	} catch {
		return null;
	}
}

/** Write the token with mode 0600 in a 0700 directory; a failure to cache is not fatal. */
export async function writeCachedToken(path: string, token: KubernetesToken): Promise<void> {
	try {
		const dir = join(path, '..');
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(dir, 0o700).catch(() => undefined);
		const temp = `${path}.${process.pid}.tmp`;
		await writeFile(temp, JSON.stringify(token), { mode: 0o600 });
		await chmod(temp, 0o600).catch(() => undefined);
		await rename(temp, path);
	} catch {
		// The next call mints a fresh token instead.
	}
}
