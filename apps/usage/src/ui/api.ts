/** Types and fetch helpers for the dashboard's own API (`src/dashboard-api.ts`). */

export interface SessionUser {
	id: string;
	email: string;
	name: string;
	role: string;
	twoFactorEnabled: boolean;
}

export interface SessionState {
	setupRequired: boolean;
	user: SessionUser | null;
	secondFactor: boolean;
}

export interface Named {
	name: string;
	installs: number;
}

export interface UsageStats {
	days: number;
	generatedAt: string;
	installs: { total: number; active7d: number; active30d: number };
	pings: { total: number; inWindow: number; last24h: number };
	versions: Named[];
	os: Named[];
	arch: Named[];
	metrics: Record<string, { installs: number; total: number; average: number }>;
	features: Named[];
	capabilities: Named[];
}

export interface UsageDay {
	day: string;
	activeInstalls: number;
	newInstalls: number;
	pings: number;
}

export interface Overview {
	stats: UsageStats;
	daily: UsageDay[];
}

export interface InstallRow {
	id: string;
	firstSeenAt: string;
	lastSeenAt: string;
	firstVersion: string;
	lastVersion: string;
	os: string;
	arch: string;
	pings: number;
	nodes: number | null;
	projects: number | null;
	users: number | null;
	features: number | null;
}

export interface InstallPage {
	total: number;
	rows: InstallRow[];
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string
	) {
		super(code);
	}
}

export async function getJson<T>(path: string): Promise<T> {
	const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
	const body = (await response.json().catch(() => ({}))) as { error?: string };
	if (!response.ok) throw new ApiError(response.status, body.error ?? 'request_failed');
	return body as T;
}

export async function postJson<T>(path: string, data: unknown): Promise<T> {
	const response = await fetch(path, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(data)
	});
	const body = (await response.json().catch(() => ({}))) as { error?: string };
	if (!response.ok) throw new ApiError(response.status, body.error ?? 'request_failed');
	return body as T;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en');

/** 1,284 / 12.9K: full under 10,000, compact above. */
export function formatCount(value: number): string {
	return Math.abs(value) < 10_000 ? full.format(value) : compact.format(value);
}

export function formatPercent(part: number, whole: number): string {
	if (whole <= 0) return '0%';
	const value = (part / whole) * 100;
	return `${value < 10 && value > 0 ? value.toFixed(1) : Math.round(value)}%`;
}

const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function formatDateTime(iso: string): string {
	return dateTime.format(new Date(iso));
}

export function formatDay(day: string): string {
	return dateOnly.format(new Date(`${day}T00:00:00Z`));
}

export function relativeTime(iso: string, now = Date.now()): string {
	const seconds = Math.round((now - Date.parse(iso)) / 1000);
	if (seconds < 60) return 'just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} days ago`;
}

/** Names whose words are acronyms or brands, spelled as people write them. */
const LABELS: Record<string, string> = {
	sso: 'SSO',
	ssoProviders: 'SSO providers',
	githubApp: 'GitHub App',
	pitr: 'Point-in-time recovery',
	deployments30d: 'Deployments, last 30 days',
	dbAutoPromote: 'Database auto-promote',
	mcp: 'MCP',
	orgs: 'Organisations',
	orgNetworks: 'Organisation networks'
};

const ACRONYMS: Record<string, string> = { db: 'DB', sso: 'SSO', mcp: 'MCP', api: 'API', s3: 'S3', oidc: 'OIDC', ip: 'IP', tls: 'TLS', smtp: 'SMTP', iam: 'IAM' };

/** camelCase metric and feature names as words: `nodesOnline` → "Nodes online". */
export function humanize(name: string): string {
	const known = LABELS[name] ?? LABELS[name.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
	if (known) return known;
	const spaced = name
		.replace(/_/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(' ')
		.map((word) => ACRONYMS[word] ?? word)
		.join(' ');
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
