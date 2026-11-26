import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** `yoal logs` against a fake control plane (docs/LOGS.md §6, §11 L7). */

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

interface Seen {
	method: string;
	path: string;
	body: any;
	lastEventId: string | null;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'yoal-cli-logs-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

const capabilities = {
	engine: 'sqlite',
	scopes: [
		{ kind: 'project', id: 'prj_1', name: 'api', parent: null },
		{ kind: 'project', id: 'prj_2', name: 'patterns', parent: null },
		{ kind: 'database', id: 'db_1', name: 'main', parent: null },
	],
};

const record = (id: string, body: string, severity = 'error') => ({
	id,
	ts: Date.parse('2026-11-26T11:59:01.204Z'),
	scope: { kind: 'project', id: 'prj_1' },
	scopeName: 'api',
	stream: null,
	source: 'runtime',
	severity,
	body,
});

type Route = unknown | ((request: Request, seen: Seen) => Response | Promise<Response>);

function serve(routes: Record<string, Route>): Seen[] {
	const seen: Seen[] = [];
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = request.method === 'GET' ? '' : await request.text();
			const entry: Seen = {
				method: request.method,
				path: `${url.pathname}${url.search}`,
				body: text ? JSON.parse(text) : undefined,
				lastEventId: request.headers.get('last-event-id'),
			};
			seen.push(entry);
			const route = routes[`${request.method} ${url.pathname}`];
			if (route === undefined) return Response.json({ error: 'not_found', message: 'no route' }, { status: 404 });
			if (typeof route === 'function') return route(request, entry);
			return route instanceof Response ? route : Response.json(route);
		},
	});
	return seen;
}

function spawn(...args: string[]) {
	return Bun.spawn([process.execPath, 'src/main.ts', 'logs', ...args], {
		cwd: join(import.meta.dir, '../..'),
		env: {
			...process.env,
			YOAL_CONFIG_DIR: dir,
			YOAL_URL: `http://127.0.0.1:${server!.port}`,
			YOAL_TOKEN: 'yoal_test',
			YOAL_CONTENT_DOMAIN: '',
			YOAL_PROFILE: '',
			NO_COLOR: '1',
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
}

async function cli(...args: string[]) {
	const child = spawn(...args);
	const code = await child.exited;
	return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

describe('yoal logs', () => {
	test('scope shorthand resolves names to ids and searches the newest lines, printed oldest first', async () => {
		const seen = serve({
			'GET /api/v1/logs/capabilities': capabilities,
			'POST /api/v1/logs/search': {
				records: [record('le:2', 'second'), record('le:1', 'first', 'warn')],
				cursor: { older: null, newer: 'p.x' },
				engine: 'sqlite',
				warnings: [],
			},
		});
		const result = await cli('api', 'db:main', '-q', 'level:warn "timeout"', '--since', '2h', '-n', '50');
		expect(result.stderr).toBe('');
		expect(result.code).toBe(0);
		expect(result.stdout.trim().split('\n')).toEqual([
			'2026-11-26 11:59:01.204 WRN api  first',
			'2026-11-26 11:59:01.204 ERR api  second',
		]);
		const search = seen.find((entry) => entry.path === '/api/v1/logs/search')!;
		expect(search.body).toMatchObject({
			q: 'level:warn "timeout"',
			scopes: [
				{ kind: 'project', id: 'prj_1' },
				{ kind: 'database', id: 'db_1' },
			],
			limit: 50,
			order: 'desc',
		});
		expect(search.body.to - search.body.from).toBe(7_200_000);
	});

	test('one scope hides the scope column; --json prints the API result', async () => {
		serve({
			'GET /api/v1/logs/capabilities': capabilities,
			'POST /api/v1/logs/search': { records: [record('le:1', 'only')], cursor: { older: null, newer: null }, engine: 'sqlite', warnings: [] },
		});
		expect((await cli('api')).stdout.trim()).toBe('2026-11-26 11:59:01.204 ERR  only');
		const json = JSON.parse((await cli('api', '--json')).stdout);
		expect(json.records[0].id).toBe('le:1');
	});

	test('the legacy `--lines` flag still works', async () => {
		const seen = serve({
			'POST /api/v1/logs/search': { records: [], cursor: { older: null, newer: null }, engine: 'sqlite', warnings: [] },
		});
		const result = await cli('--lines', '30');
		expect(result.code).toBe(0);
		expect(seen.find((entry) => entry.path === '/api/v1/logs/search')!.body).toMatchObject({ scopes: [], limit: 30 });
		expect(result.stderr).toContain('No logs match');
	});

	test('more than one page follows the cursor', async () => {
		let calls = 0;
		const seen = serve({
			'POST /api/v1/logs/search': () => {
				calls += 1;
				const records = Array.from({ length: calls === 1 ? 1000 : 500 }, (_, index) => record(`le:${calls}${index}`, 'x'));
				return Response.json({ records, cursor: { older: calls === 1 ? 'p.next' : null, newer: null }, engine: 'sqlite', warnings: [] });
			},
		});
		const result = await cli('--limit', '1500');
		expect(result.code).toBe(0);
		expect(result.stdout.trim().split('\n')).toHaveLength(1500);
		const bodies = seen.filter((entry) => entry.path === '/api/v1/logs/search').map((entry) => entry.body);
		expect(bodies.map((body) => [body.limit, body.cursor])).toEqual([
			[1000, undefined],
			[500, 'p.next'],
		]);
	});

	test('an invalid query fails before any request, with a caret under the problem', async () => {
		const seen = serve({});
		const result = await cli('-q', 'level:error | nonsense');
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('Invalid log query');
		expect(result.stderr).toContain('^');
		expect(seen).toHaveLength(0);
	});

	test('a scope the caller cannot read is an error, not "everything"', async () => {
		const seen = serve({ 'GET /api/v1/logs/capabilities': capabilities });
		const result = await cli('db:other');
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('No database "other" that you can read logs in. Yours: db:main.');
		expect(seen.some((entry) => entry.path.startsWith('/api/v1/logs/search'))).toBe(false);
	});

	test('a pipe query goes to the table endpoint and prints a table', async () => {
		const seen = serve({
			'POST /api/v1/logs/table': {
				columns: [
					{ name: 'level', type: 'string' },
					{ name: 'count', type: 'number' },
				],
				rows: [['error', 7]],
				engine: 'clickhouse',
				warnings: [],
			},
		});
		const result = await cli('-q', 'level:warn | stats count() by level');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('error  7');
		const body = seen.find((entry) => entry.path === '/api/v1/logs/table')!.body;
		expect(body.to - body.from).toBe(3_600_000);
	});

	test('a project called `patterns` is reachable as project:patterns; `patterns` is the subcommand', async () => {
		const seen = serve({
			'GET /api/v1/logs/capabilities': capabilities,
			'POST /api/v1/logs/table': {
				columns: [
					{ name: 'pattern', type: 'string' },
					{ name: 'template', type: 'string' },
					{ name: 'count', type: 'number' },
				],
				rows: [['ab12', 'GET <*> 200', 42]],
				engine: 'clickhouse',
				warnings: [],
			},
		});
		const result = await cli('patterns', 'project:patterns', '-q', 'level:info', '-n', '10');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('GET <*> 200');
		expect(seen.find((entry) => entry.path === '/api/v1/logs/table')!.body).toMatchObject({
			q: 'level:info | patterns | limit 10',
			scopes: [{ kind: 'project', id: 'prj_2' }],
		});
	});

	test('a lite-mode 422 surfaces the server message', async () => {
		serve({
			'POST /api/v1/logs/table': Response.json(
				{ error: 'needs_clickhouse', message: 'Patterns need the ClickHouse log index.' },
				{ status: 422 },
			),
		});
		const result = await cli('patterns');
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('Patterns need the ClickHouse log index.');
	});

	test('context prints the lines around a record with the anchor marked', async () => {
		const seen = serve({
			'GET /api/v1/logs/context': {
				anchor: record('le:5', 'anchor'),
				before: [record('le:4', 'before', 'info')],
				after: [record('le:6', 'after', 'info')],
				engine: 'sqlite',
			},
		});
		const result = await cli('context', 'le:5', '--before', '1', '--after', '1');
		expect(result.code).toBe(0);
		expect(result.stdout.split('\n').slice(0, 3)).toEqual([
			'  2026-11-26 11:59:01.204 INF  before',
			'> 2026-11-26 11:59:01.204 ERR  anchor',
			'  2026-11-26 11:59:01.204 INF  after',
		]);
		expect(seen[0]!.path).toBe('/api/v1/logs/context?id=le%3A5&before=1&after=1');
	});

	test('compare posts the baseline in the contract shape', async () => {
		const seen = serve({
			'GET /api/v1/logs/capabilities': capabilities,
			'POST /api/v1/logs/compare': {
				current: { from: 0, to: 1, total: 3 },
				baseline: { from: 0, to: 1, total: 0 },
				rows: [{ patternId: 'p1', template: 'boom <*>', current: 3, baseline: 0, change: 'new', ratio: null, sampleId: null }],
				engine: 'clickhouse',
				warnings: [],
			},
		});
		const result = await cli('compare', 'api', '--baseline', 'deploy:dep_7');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('NEW (1)');
		expect(seen.find((entry) => entry.path === '/api/v1/logs/compare')!.body).toMatchObject({
			q: '',
			scopes: [{ kind: 'project', id: 'prj_1' }],
			baseline: { kind: 'deploy', deploymentId: 'dep_7' },
			limit: 100,
		});
		const missing = await cli('compare', 'api');
		expect(missing.stderr).toContain('compare needs --baseline');
	});

	test('-f follows the SSE tail and resumes with Last-Event-ID after a drop', async () => {
		let connections = 0;
		const encoder = new TextEncoder();
		const seen = serve({
			'GET /api/v1/logs/capabilities': capabilities,
			'GET /api/v1/logs/stream': () => {
				connections += 1;
				const first = connections === 1;
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						const send = (text: string) => controller.enqueue(encoder.encode(text));
						if (first) {
							send(`id: t.0\nevent: ready\ndata: ${JSON.stringify({ cursor: 't.0', engine: 'sqlite' })}\n\n`);
							send(`id: t.1\nevent: records\ndata: ${JSON.stringify({ records: [record('le:1', 'one')], cursor: 't.1' })}\n\n`);
							controller.close(); // the connection drops
						} else {
							send(`id: t.9\nevent: ready\ndata: ${JSON.stringify({ cursor: 't.9', engine: 'sqlite' })}\n\n`);
							send(`event: sampled\ndata: ${JSON.stringify({ dropped: 3 })}\n\n`);
							send(`id: t.2\nevent: records\ndata: ${JSON.stringify({ records: [record('le:2', 'two')], cursor: 't.2' })}\n\n`);
						}
					},
				});
				return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
			},
		});
		const child = spawn('api', '-f', '-q', 'level:error');
		const decoder = new TextDecoder();
		let stdout = '';
		const reader = child.stdout.getReader();
		const deadline = Date.now() + 10_000;
		while (!stdout.includes('two') && Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			stdout += decoder.decode(value);
		}
		child.kill('SIGINT');
		const code = await child.exited;
		const stderr = await new Response(child.stderr).text();
		expect(code).toBe(0);
		expect(stdout).toContain('one');
		expect(stdout).toContain('two');
		expect(stderr).toContain('3 lines skipped');
		const streams = seen.filter((entry) => entry.path.startsWith('/api/v1/logs/stream'));
		expect(streams[0]!.path).toBe('/api/v1/logs/stream?q=level%3Aerror&scope=project%3Aprj_1&backfill=20');
		expect(streams[0]!.lastEventId).toBeNull();
		// The resume carries the last records id and asks for no backfill.
		expect(streams[1]!.lastEventId).toBe('t.1');
		expect(streams[1]!.path).toBe('/api/v1/logs/stream?q=level%3Aerror&scope=project%3Aprj_1');
	});

	test('-f refuses a pipe query', async () => {
		serve({});
		const result = await cli('-f', '-q', '| stats count()');
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('cannot be followed');
	});
});
