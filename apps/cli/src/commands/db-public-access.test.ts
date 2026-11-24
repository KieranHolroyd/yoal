import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enableInput, parseAllowRule, parseExpires, publicAccessDetails, type DatabasePublicAccessView } from './db-public-access.ts';

const NOW = Date.parse('2026-11-24T10:00:00Z');

describe('public access flags', () => {
	test('--allow takes a CIDR and an optional label', () => {
		expect(parseAllowRule('203.0.113.0/24=office')).toEqual({ cidr: '203.0.113.0/24', label: 'office' });
		expect(parseAllowRule('2a01:4f8::/32')).toEqual({ cidr: '2a01:4f8::/32', label: '' });
		expect(parseAllowRule(' 8.8.8.8 = ci = eu ')).toEqual({ cidr: '8.8.8.8', label: 'ci = eu' });
		expect(() => parseAllowRule('=office')).toThrow(/needs a CIDR/);
	});

	test('--expires takes durations, ISO times and never', () => {
		expect(parseExpires('12h', NOW)).toBe('2026-11-24T22:00:00.000Z');
		expect(parseExpires('30d', NOW)).toBe('2026-12-24T10:00:00.000Z');
		expect(parseExpires('2026-12-31T00:00:00Z', NOW)).toBe('2026-12-31T00:00:00.000Z');
		expect(parseExpires('never', NOW)).toBeNull();
		expect(() => parseExpires('0d', NOW)).toThrow(/future/);
		expect(() => parseExpires('soon', NOW)).toThrow(/12h/);
	});

	test('enable needs a source and builds the whole configuration', () => {
		expect(() => enableInput({ allow: [], anywhere: false, credentials: [] })).toThrow(/--allow/);
		expect(
			enableInput({ allow: ['203.0.113.0/24=office'], anywhere: false, credentials: ['app', ' dbc_1 '], expires: '7d', maxConnections: '5' }, NOW),
		).toEqual({
			rules: [{ cidr: '203.0.113.0/24', label: 'office' }],
			allowAnywhere: false,
			credentials: ['app', 'dbc_1'],
			expiresAt: '2026-12-01T10:00:00.000Z',
			maxConnections: 5,
		});
		expect(enableInput({ allow: [], anywhere: true, credentials: [] }, NOW)).toEqual({
			rules: [],
			allowAnywhere: true,
			credentials: [],
			expiresAt: null,
		});
		expect(() => enableInput({ allow: ['8.8.8.8'], anywhere: false, credentials: [], maxConnections: '501' })).toThrow(/between 1 and 500/);
	});
});

const view = (overrides: Partial<DatabasePublicAccessView> = {}): DatabasePublicAccessView => ({
	enabled: true,
	status: 'active',
	statusDetail: null,
	protocol: 'postgres',
	host: 'main-org1.db.example.com',
	port: 24_000,
	rules: [{ cidr: '203.0.113.0/24', label: 'office' }],
	allowAnywhere: false,
	anywhereAvailable: false,
	credentials: [{ id: 'dbc_1', role: 'app', username: 'yoal_app_1', usable: true }],
	maxConnections: 20,
	expiresAt: null,
	enabledAt: '2026-11-24T10:00:00.000Z',
	enabledBy: 'user_1',
	updatedAt: '2026-11-24T10:00:00.000Z',
	updatedBy: 'user_1',
	disabledAt: null,
	disabledReason: null,
	connectionTemplate: 'postgres://<user>:<password>@main-org1.db.example.com:24000/main?sslmode=require',
	nodes: [{ nodeId: 'nod_1', nodeName: 'edge', state: 'listening', error: null, open: 1, accepted: 4, refused: 2, authFailures: 0, banned: 0, reportedAt: null }],
	events: [{ at: '2026-11-24T10:00:00.000Z', nodeId: 'nod_1', source: '198.51.100.4', reason: 'source', detail: null }],
	...overrides,
});

describe('public access output', () => {
	test('shows the address, rules, roles, nodes and refusals', () => {
		const text = publicAccessDetails(view());
		expect(text).toContain('main-org1.db.example.com:24000');
		expect(text).toContain('203.0.113.0/24  office');
		expect(text).toContain('yoal_app_1 (app)');
		expect(text).toContain('listening');
		expect(text).toContain('198.51.100.4');
	});

	test('an unsupported engine shows only the reason', () => {
		const text = publicAccessDetails(view({ status: 'unsupported', statusDetail: 'MySQL is not supported', enabled: false, host: null, port: null, rules: [], connectionTemplate: null }));
		expect(text).toBe('Status:       unsupported — MySQL is not supported');
	});
});

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'yoal-cli-public-access-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

function serve(routes: Record<string, unknown>) {
	const seen: Array<{ method: string; path: string; body: unknown }> = [];
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.text();
			seen.push({ method: request.method, path: url.pathname, body: text ? JSON.parse(text) : undefined });
			const route = routes[`${request.method} ${url.pathname}`];
			if (route === undefined) return Response.json({ error: 'not_found', message: 'no route' }, { status: 404 });
			return Response.json(route);
		},
	});
	return seen;
}

async function cli(...args: string[]) {
	const child = Bun.spawn([process.execPath, 'src/main.ts', ...args], {
		cwd: join(import.meta.dir, '../..'),
		env: {
			...process.env,
			YOAL_CONFIG_DIR: dir,
			YOAL_URL: `http://127.0.0.1:${server!.port}`,
			YOAL_TOKEN: 'yoal_test',
			YOAL_CONTENT_DOMAIN: '',
			YOAL_PROFILE: '',
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const code = await child.exited;
	return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

describe('yoal db public-access', () => {
	test('show, enable and disable call the REST route', async () => {
		const seen = serve({
			'GET /api/v1/databases/main/public-access': { publicAccess: view() },
			'PUT /api/v1/databases/main/public-access': { publicAccess: view() },
			'DELETE /api/v1/databases/main/public-access': { publicAccess: view({ enabled: false, status: 'disabled' }) },
		});
		const shown = await cli('db', 'public-access', 'main');
		expect(shown.code).toBe(0);
		expect(shown.stdout).toContain('main-org1.db.example.com:24000');
		const enabled = await cli('db', 'public-access', 'enable', 'main', '--allow', '203.0.113.0/24=office', '--credential', 'app');
		expect(enabled.code).toBe(0);
		expect(enabled.stdout).toContain('is on');
		expect(seen.find((entry) => entry.method === 'PUT')?.body).toEqual({
			rules: [{ cidr: '203.0.113.0/24', label: 'office' }],
			allowAnywhere: false,
			credentials: ['app'],
			expiresAt: null,
		});
		const disabled = await cli('db', 'public-access', 'disable', 'main');
		expect(disabled.code).toBe(0);
		expect(disabled.stdout).toContain('is off');
		const misplaced = await cli('db', 'public-access', 'main', '--allow', '8.8.8.8');
		expect(misplaced.code).not.toBe(0);
		expect(misplaced.stderr).toContain('enable');
	});
});
