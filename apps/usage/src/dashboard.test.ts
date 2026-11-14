import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { USAGE_ANALYTICS_VERSION, usageMetricKeys, type UsagePing } from '@yoal/contracts';
import { createUsageAuth, type UsageAuth } from './auth.ts';
import { loadUsageConfig } from './config.ts';
import { handleDashboardRequest, sessionUser, type DashboardContext } from './dashboard-api.ts';
import { RateLimiter, handleUsageRequest } from './http.ts';
import { UsageStore } from './store.ts';

const ORIGIN = 'https://ae.test';
const TOKEN = 'setup-token-for-tests-0123456789';
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-14T12:00:00.000Z');

const dir = mkdtempSync(join(tmpdir(), 'yoal-usage-dashboard-'));
let db: Database;
let store: UsageStore;
let usageAuth: UsageAuth;
let setupToken: string | null = TOKEN;
let ctx: DashboardContext;

function base32(input: string): Buffer {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const char of input.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
	const bytes: number[] = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
	return Buffer.from(bytes);
}

function totp(secret: string): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
	const hmac = createHmac('sha1', base32(secret)).update(counter).digest();
	const offset = hmac[hmac.length - 1]! & 0xf;
	return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	if (init.cookie) headers.set('cookie', init.cookie);
	if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', ORIGIN);
	if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
	const request = new Request(`${ORIGIN}${path}`, { ...init, headers });
	return (await handleDashboardRequest(request, ctx)) ?? new Response(null, { status: 404 });
}

/** Sign in and return the session cookie header. */
async function signIn(email: string, password: string): Promise<string> {
	const response = await call('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email, password }) });
	expect(response.status).toBe(200);
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(';')[0])
		.join('; ');
}

function ping(installId: string, overrides: Partial<UsagePing> = {}): UsagePing {
	return {
		v: USAGE_ANALYTICS_VERSION,
		id: `ping_${Math.random().toString(36).slice(2).padEnd(16, '0')}`,
		installId,
		sentAt: new Date(NOW).toISOString(),
		version: '0.6.1',
		os: 'linux',
		arch: 'x64',
		metrics: Object.fromEntries(usageMetricKeys.map((key) => [key, 2])) as UsagePing['metrics'],
		features: [],
		capabilities: [],
		...overrides
	};
}

beforeAll(async () => {
	db = new Database(':memory:');
	store = new UsageStore(db, 400);
	const config = loadUsageConfig({ YOAL_USAGE_DATA_DIR: dir, YOAL_USAGE_PUBLIC_URL: ORIGIN, YOAL_USAGE_AUTH_SECRET: 'x'.repeat(40) });
	usageAuth = await createUsageAuth(db, config);
	ctx = {
		store,
		usageAuth,
		publicUrl: ORIGIN,
		setupToken: () => setupToken,
		onSetupComplete: () => {
			setupToken = null;
		},
		trustProxy: false,
		limiter: new RateLimiter(1_000, 60_000),
		now: () => NOW
	};
});

afterAll(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

const admin = { name: 'Admin', email: 'admin@example.test', password: 'a long admin password' };

describe('setup', () => {
	test('the session says setup is needed before any account exists', async () => {
		const response = await call('/api/v1/session');
		expect(await response.json()).toEqual({ setupRequired: true, user: null, secondFactor: false });
	});

	test('refuses a wrong token, a cross-origin post and a short password', async () => {
		expect((await call('/api/v1/setup', { method: 'POST', body: JSON.stringify({ ...admin, token: 'nope' }) })).status).toBe(403);
		expect(
			(await call('/api/v1/setup', { method: 'POST', headers: { origin: 'https://evil.test' }, body: JSON.stringify({ ...admin, token: TOKEN }) })).status
		).toBe(403);
		expect((await call('/api/v1/setup', { method: 'POST', body: JSON.stringify({ ...admin, password: 'short', token: TOKEN }) })).status).toBe(400);
		expect(usageAuth.userCount()).toBe(0);
	});

	test('creates the first admin once, then closes', async () => {
		const created = await call('/api/v1/setup', { method: 'POST', body: JSON.stringify({ ...admin, token: TOKEN }) });
		expect(created.status).toBe(201);
		expect(setupToken).toBeNull();
		const again = await call('/api/v1/setup', { method: 'POST', body: JSON.stringify({ ...admin, email: 'second@example.test', token: TOKEN }) });
		expect(again.status).toBe(409);
		expect(usageAuth.userCount()).toBe(1);
	});

	test('public sign-up stays closed', async () => {
		const response = await call('/api/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ name: 'X', email: 'x@example.test', password: 'a long enough password' }) });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(usageAuth.userCount()).toBe(1);
	});
});

describe('second factor gate', () => {
	let cookie = '';

	test('data needs a session', async () => {
		expect((await call('/api/v1/overview')).status).toBe(401);
		expect((await call('/api/v1/installs')).status).toBe(401);
	});

	test('a password-only session sees no data and cannot manage accounts', async () => {
		cookie = await signIn(admin.email, admin.password);
		const session = (await (await call('/api/v1/session', { cookie })).json()) as { user: { role: string }; secondFactor: boolean };
		expect(session.user.role).toBe('admin');
		expect(session.secondFactor).toBe(false);
		const overview = await call('/api/v1/overview', { cookie });
		expect(overview.status).toBe(403);
		expect(await overview.json()).toEqual({ error: 'second_factor_required' });
		expect((await call('/api/auth/admin/list-users', { cookie })).status).toBe(403);
	});

	test('after enrolling an authenticator app, data and admin routes open', async () => {
		const enabled = await call('/api/auth/two-factor/enable', { method: 'POST', cookie, body: JSON.stringify({ password: admin.password }) });
		expect(enabled.status).toBe(200);
		const { totpURI } = (await enabled.json()) as { totpURI: string };
		const secret = new URL(totpURI).searchParams.get('secret')!;
		const verified = await call('/api/auth/two-factor/verify-totp', { method: 'POST', cookie, body: JSON.stringify({ code: totp(secret) }) });
		expect(verified.status).toBe(200);
		// Verifying may rotate the session cookie.
		const rotated = verified.headers.getSetCookie().map((value) => value.split(';')[0]).filter((value) => value && !value.endsWith('='));
		if (rotated.length) cookie = rotated.join('; ');

		const session = (await (await call('/api/v1/session', { cookie })).json()) as { secondFactor: boolean };
		expect(session.secondFactor).toBe(true);
		store.record(ping('a'.repeat(32)), NOW - DAY);
		const overview = await call('/api/v1/overview?days=7', { cookie });
		expect(overview.status).toBe(200);
		const body = (await overview.json()) as { stats: { days: number }; daily: unknown[] };
		expect(body.stats.days).toBe(7);
		expect(body.daily).toHaveLength(7);
		expect((await call('/api/auth/admin/list-users', { cookie })).status).toBe(200);
	});

	test('a viewer with a second factor reads data but cannot manage accounts', async () => {
		await usageAuth.auth.api.createUser({ body: { name: 'Viewer', email: 'viewer@example.test', password: 'a long viewer password', role: 'user' } });
		const viewerCookie = await signIn('viewer@example.test', 'a long viewer password');
		const viewer = await sessionUser(usageAuth, new Request(ORIGIN, { headers: { cookie: viewerCookie } }));
		db.query("INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, transports, createdAt) VALUES ('pk1', 'test', 'x', ?, 'cred', 0, 'singleDevice', 0, '', ?)").run(
			viewer!.user.id,
			new Date().toISOString()
		);
		expect((await call('/api/v1/installs', { cookie: viewerCookie })).status).toBe(200);
		const listed = await call('/api/auth/admin/list-users', { cookie: viewerCookie });
		expect(listed.status).toBe(403);
	});

	test('the stats route accepts a dashboard session as well as the bearer token', async () => {
		const sessionAllowed = async (request: Request) => (await sessionUser(usageAuth, request))?.secondFactor ?? false;
		const viaSession = await handleUsageRequest(new Request(`${ORIGIN}/api/v1/stats`, { headers: { cookie } }), { store, sessionAllowed, now: () => NOW });
		expect(viaSession.status).toBe(200);
		const anonymous = await handleUsageRequest(new Request(`${ORIGIN}/api/v1/stats`), { store, sessionAllowed, now: () => NOW });
		expect(anonymous.status).toBe(401);
	});
});

describe('store views', () => {
	test('daily counts active and new installs per UTC day, oldest first, with empty days filled', () => {
		const local = new UsageStore(new Database(':memory:'), 400);
		local.record(ping('b'.repeat(32)), NOW - 2 * DAY);
		local.record(ping('b'.repeat(32)), NOW - DAY);
		local.record(ping('c'.repeat(32)), NOW - DAY);
		const days = local.daily(NOW, 4);
		expect(days.map((day) => day.day)).toEqual(['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
		expect(days.map((day) => day.activeInstalls)).toEqual([0, 1, 2, 0]);
		expect(days.map((day) => day.newInstalls)).toEqual([0, 1, 1, 0]);
	});

	test('installs list newest first with a short id and the latest headline counts', () => {
		const local = new UsageStore(new Database(':memory:'), 400);
		local.record(ping('d'.repeat(32), { version: '0.5.0' }), NOW - 3 * DAY);
		local.record(ping('e'.repeat(32)), NOW - DAY);
		const page = local.installs({ limit: 10 });
		expect(page.total).toBe(2);
		expect(page.rows[0]!.id).toBe('e'.repeat(12));
		expect(page.rows[0]!.nodes).toBe(2);
		expect(local.installs({ version: '0.5.0' }).rows.map((row) => row.lastVersion)).toEqual(['0.5.0']);
	});
});
