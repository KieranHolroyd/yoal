import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { haDrillRunRequestSchema, haInitRequestSchema } from '@yoal/contracts';
import { migrationPlan } from './ha-fixtures.js';
import { migrationApplyProjects } from './ha-setup.js';

/**
 * The fetch module against lane B's routes: each call goes to the route that exists on main, with
 * the body its schema accepts (`haInitRequestSchema`, `haDrillRunRequestSchema`, the attachment
 * route's own schema), and reads the response shape the handler returns. `fetchJson` is replaced
 * by a recorder; the real one is a thin `fetch` wrapper.
 */

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

interface Call {
	url: string;
	method: string;
	body: unknown;
}

const calls: Call[] = [];
let answer: (call: Call) => unknown = () => ({});

mock.module('$app/env', () => ({ browser: true, dev: false }));
mock.module('#lib/query.js', () => ({
	HttpError,
	fetchJson: async (url: string, init: RequestInit = {}) => {
		const call = {
			url,
			method: init.method ?? 'GET',
			body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
		};
		calls.push(call);
		const value = answer(call);
		if (value instanceof Error) throw value;
		return value;
	}
}));

let api: typeof import('./ha-api.js');
beforeAll(async () => {
	api = await import('./ha-api.js');
});
afterEach(() => {
	calls.length = 0;
	answer = () => ({});
});

/** `POST /api/v1/ha/attachments/migrate`'s body schema, as the route declares it. */
const migrateSchema = z
	.object({
		apply: z.boolean().optional(),
		projects: z.array(z.string().trim().min(1).max(100)).max(500).optional()
	})
	.strict();

describe('ha init and preflight', () => {
	test('the plan and apply post the init request schema to /api/v1/ha/init', async () => {
		await api.planInit('ha', { certificates: 'per-node' });
		await api.applyInit('ha', { certificates: 'per-node' });
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			'POST /api/v1/ha/init',
			'POST /api/v1/ha/init'
		]);
		expect(haInitRequestSchema.parse(calls[0]!.body)).toEqual({
			profile: 'ha',
			answers: { certificates: 'per-node' },
			apply: false
		});
		expect(haInitRequestSchema.parse(calls[1]!.body)).toMatchObject({ apply: true });
	});

	test('the preflight reads the install’s own profile, or the one asked for', async () => {
		await api.loadPreflight();
		await api.loadPreflight('ha-dr');
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			'GET /api/v1/ha/preflight',
			'GET /api/v1/ha/preflight?profile=ha-dr'
		]);
	});

	test('a refused apply shows the server’s message, not "not available"', async () => {
		answer = () => new HttpError(409, 'The ha profile is refused: Zones: yoal nodes update …');
		const error = await api.applyInit('ha', {}).catch((caught) => caught);
		expect(error).not.toBeInstanceOf(api.NotAvailableError);
		expect(error.message).toContain('The ha profile is refused');
	});
});

describe('drills', () => {
	test('catalogue, runs and run go to lane B’s routes', async () => {
		answer = (call) => (call.url.startsWith('/api/v1/ha/drills/runs') ? { runs: [] } : {});
		await api.loadDrillCatalogue();
		expect(await api.listDrillRuns()).toEqual([]);
		await api.runDrill({
			scenario: 'node-offline',
			resource: 'edge-b',
			confirm: 'edge-b',
			durationSeconds: 300,
			includeControlNode: false
		});
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			'GET /api/v1/ha/drills/catalogue',
			'GET /api/v1/ha/drills/runs?limit=20',
			'POST /api/v1/ha/drills/run'
		]);
		// The route reads the body with the strict schema: no extra field slips through.
		expect(haDrillRunRequestSchema.parse(calls[2]!.body)).toEqual({
			scenario: 'node-offline',
			resource: 'edge-b',
			confirm: 'edge-b',
			durationSeconds: 300,
			includeControlNode: false
		});
	});

	test('a 404 for an unknown resource and a 403 for a non-admin show the server’s words', async () => {
		answer = () => new HttpError(404, 'Node not found.');
		const missing = await api
			.runDrill({ scenario: 'node-offline', resource: 'nope', confirm: 'nope' })
			.catch((caught) => caught);
		expect(missing).not.toBeInstanceOf(api.NotAvailableError);
		expect(missing.message).toBe('Node not found.');
		answer = () =>
			new HttpError(
				403,
				'The node-offline drill takes something down: it needs a platform admin signed in to the dashboard.'
			);
		const refused = await api
			.runDrill({ scenario: 'node-offline', resource: 'edge-b', confirm: 'edge-b' })
			.catch((caught) => caught);
		expect(refused.message).toContain('platform admin');
	});

	test('a 501 reads as not available yet; a 404 does only for the regions route', async () => {
		answer = () => new HttpError(501, 'not_built');
		expect(await api.loadDrillCatalogue().catch((caught) => caught)).toBeInstanceOf(
			api.NotAvailableError
		);
		answer = () => new HttpError(404, 'Not Found');
		expect(await api.loadRegions().catch((caught) => caught)).toBeInstanceOf(
			api.NotAvailableError
		);
		expect(await api.listDrillRuns().catch((caught) => caught)).not.toBeInstanceOf(
			api.NotAvailableError
		);
	});
});

describe('admin actions', () => {
	test('CA status and rotation use /api/v1/ha/ca', async () => {
		await api.loadCa();
		await api.rotateCa();
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			'GET /api/v1/ha/ca',
			'POST /api/v1/ha/ca/rotate'
		]);
		expect(calls[1]!.body).toBeUndefined();
	});

	test('apply sends the slugs of the confirmed dry run, and only those', async () => {
		await api.loadMigrationPlan();
		const confirmed = migrationApplyProjects(migrationPlan);
		expect(confirmed).toEqual(['shop']);
		await api.applyMigration(confirmed);
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			'GET /api/v1/ha/attachments/migrate',
			'POST /api/v1/ha/attachments/migrate'
		]);
		expect(migrateSchema.parse(calls[1]!.body)).toEqual({ apply: true, projects: ['shop'] });
	});

	test('apply never sends an empty list, which the server reads as every app', async () => {
		const none = { ...migrationPlan, projects: [] };
		await expect(api.applyMigration(migrationApplyProjects(none))).rejects.toThrow('No app');
		expect(calls).toEqual([]);
	});
});

describe('fixtures stay out of production', () => {
	const dir = import.meta.dir;
	const route = join(dir, '..');

	test('every fixture path in the fetch module is behind import.meta.env.DEV', () => {
		const source = readFileSync(join(dir, 'ha-api.ts'), 'utf8');
		// The one dynamic import sits in a function that refuses outside development.
		expect(source.match(/import\('\.\/ha-fixtures\.js'\)/g)).toHaveLength(1);
		expect(source).toMatch(
			/async function fixtures\(\) \{\n\tif \(!import\.meta\.env\.DEV\) throw[^\n]*\n\treturn import\('\.\/ha-fixtures\.js'\);/
		);
		expect(source).toMatch(/function fixtureMode\(\): string \| null \{\n\tif \(!import\.meta\.env\.DEV/);
		// Each caller checks the flag itself, so a production build drops the call with the branch.
		const callers = source.split('\n').filter((line) => /fixtureMode\(\)/.test(line) && !/function fixtureMode/.test(line));
		expect(callers.length).toBeGreaterThan(0);
		for (const line of callers)
			expect(line.includes('import.meta.env.DEV') || /const mode = fixtureMode\(\)/.test(line)).toBe(true);
		expect(source).toContain('if (import.meta.env.DEV) {\n\t\tconst mode = fixtureMode();');
	});

	test('no page module imports the fixtures; only tests do', () => {
		const files = [
			...readdirSync(route).map((name) => join(route, name)),
			...readdirSync(dir).map((name) => join(dir, name))
		].filter((file) => /\.(svelte|ts)$/.test(file) && !file.endsWith('.test.ts'));
		for (const file of files) {
			if (file.endsWith('ha-api.ts') || file.endsWith('ha-fixtures.ts')) continue;
			expect({ file, imports: readFileSync(file, 'utf8').includes('ha-fixtures') }).toEqual({
				file,
				imports: false
			});
		}
	});

	test('outside development the fetch module never answers from fixtures', async () => {
		// `import.meta.env.DEV` is not true here, as in a production build.
		expect(import.meta.env?.DEV).not.toBe(true);
		await api.loadCa();
		expect(calls).toHaveLength(1);
	});
});
