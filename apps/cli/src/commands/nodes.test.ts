import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RolloutPlanView, RolloutView } from '../node-rollouts.ts';
import { followRollout } from './nodes.ts';

/** `yoal nodes update` and `yoal nodes rollout` against a fake control plane (CLUSTERING §3.11). */

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

interface Seen {
	method: string;
	path: string;
	body: unknown;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'yoal-cli-nodes-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

/** `routes` maps `METHOD /path` to a JSON body, or to a function returning a Response. */
function serve(routes: Record<string, unknown>): Seen[] {
	const seen: Seen[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.text();
			const entry: Seen = { method: request.method, path: `${url.pathname}${url.search}`, body: text ? JSON.parse(text) : undefined };
			seen.push(entry);
			const route = routes[`${request.method} ${url.pathname}`];
			if (route === undefined) return Response.json({ error: 'not_found', message: 'no route' }, { status: 404 });
			return typeof route === 'function' ? (route as () => Response)() : Response.json(route);
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

const options = { strategy: 'rolling' as const, batchSize: 2, canary: true, drain: true, soakSeconds: 30, maxFailures: 0 };
const nodes = { nodes: [{ id: 'nod_edge', name: 'edge' }, { id: 'nod_w1', name: 'worker-1', agentVersion: '0.8.0' }] };
const plan: RolloutPlanView = {
	targetVersion: '0.9.0',
	strategy: 'rolling',
	options,
	waves: [{ index: 0, reason: 'canary', nodes: [{ id: 'nod_w1', name: 'worker-1', zone: 'hel1', roles: ['compute'], agentVersion: '0.8.0', guarded: true, groups: [], singleCopies: 0 }] }],
	skipped: [],
	current: 1,
	warnings: [],
};

function view(overrides: Partial<RolloutView> = {}): RolloutView {
	return {
		id: 'nro_1',
		flowId: null,
		status: 'running',
		phase: 'starting',
		detail: null,
		targetVersion: '0.9.0',
		options,
		currentWave: 0,
		waves: 1,
		nodes: [{ nodeId: 'nod_w1', name: 'worker-1', wave: 0, state: 'pending', fromVersion: '0.8.0', version: '0.8.0', guarded: true, attempts: 0, error: null, startedAt: null, finishedAt: null }],
		counts: { pending: 1, draining: 0, updating: 0, verifying: 0, done: 0, failed: 0, skipped: 0 },
		failures: 0,
		error: null,
		trigger: 'manual',
		createdBy: null,
		createdAt: '2026-11-14T10:00:00.000Z',
		updatedAt: '2026-11-14T10:00:00.000Z',
		finishedAt: null,
		...overrides,
	};
}

describe('yoal nodes', () => {
	test('update resolves a node name to its id', async () => {
		const seen = serve({
			'GET /api/v1/nodes': nodes,
			'POST /api/v1/nodes/nod_w1/update': { id: 'nod_w1', name: 'worker-1', update: { version: '0.9.0', status: 'pending' } },
		});
		const result = await cli('nodes', 'update', 'worker-1');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('worker-1 will install 0.9.0 on its next check.');
		expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual(['GET /api/v1/nodes', 'POST /api/v1/nodes/nod_w1/update']);
	});

	test('rollout plan fills unset options from the cluster defaults and flags win', async () => {
		const seen = serve({
			'GET /api/v1/nodes': nodes,
			'GET /api/v1/cluster/config': { config: { updates: { ...options, autoRollout: true } } },
			'POST /api/v1/nodes/rollouts/plan': plan,
		});
		const result = await cli('nodes', 'rollout', 'plan', '--no-canary', '--soak', '90', '--node', 'worker-1');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('1 node in 1 wave; 1 already on 0.9.0.');
		expect(seen.find((entry) => entry.path === '/api/v1/nodes/rollouts/plan')?.body).toEqual({
			strategy: 'rolling',
			batchSize: 2,
			canary: false,
			drain: true,
			soakSeconds: 90,
			maxFailures: 0,
			nodeIds: ['nod_w1'],
		});
	});

	test('rollout start refuses without a terminal or --yes, and starts with --yes', async () => {
		const seen = serve({
			'GET /api/v1/cluster/config': () => Response.json({ error: 'forbidden' }, { status: 403 }),
			'POST /api/v1/nodes/rollouts/plan': plan,
			'POST /api/v1/nodes/rollouts': view(),
		});
		const refused = await cli('nodes', 'rollout', 'start', '--strategy', 'parallel');
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('Refusing to start a fleet update without confirmation.');
		expect(seen.some((entry) => entry.method === 'POST' && entry.path === '/api/v1/nodes/rollouts')).toBe(false);

		const started = await cli('nodes', 'rollout', 'start', '--strategy', 'parallel', '--yes');
		expect(started.code).toBe(0);
		expect(started.stdout).toContain('Started rollout nro_1.');
		expect(seen.filter((entry) => entry.path === '/api/v1/nodes/rollouts').at(-1)?.body).toEqual({ strategy: 'parallel' });
	});

	test('bad flags are usage errors that send nothing', async () => {
		const seen = serve({});
		expect((await cli('nodes', 'rollout', 'plan', '--strategy', 'yolo')).stderr).toContain('--strategy is one of');
		expect((await cli('nodes', 'rollout', 'plan', '--soak', '-1')).stderr).toContain('--soak must be a whole number from 0 to 3600.');
		expect((await cli('nodes', 'rollout', 'plan', '--strategy', 'parallel', '--batch', '3')).stderr).toContain('--batch only applies');
		expect(seen).toHaveLength(0);
	});

	test('resume sends retryFailed; --skip-failed turns it off', async () => {
		const seen = serve({ 'POST /api/v1/nodes/rollouts/nro_1/resume': view() });
		expect((await cli('nodes', 'rollout', 'resume', 'nro_1')).stdout).toContain('tried again first');
		expect((await cli('nodes', 'rollout', 'resume', 'nro_1', '--skip-failed')).stdout).toContain('left as they are');
		expect(seen.map((entry) => entry.body)).toEqual([{ retryFailed: true }, { retryFailed: false }]);
	});
});

describe('followRollout', () => {
	test('polls until the rollout stops running and logs each change', async () => {
		const states: RolloutView[] = [
			view({ phase: 'updating', nodes: [{ ...view().nodes[0]!, state: 'updating' }] }),
			view({
				status: 'succeeded',
				phase: 'done',
				currentWave: 1,
				finishedAt: '2026-11-14T10:05:00.000Z',
				nodes: [{ ...view().nodes[0]!, state: 'done', version: '0.9.0' }],
			}),
		];
		const lines: string[] = [];
		let polls = 0;
		const last = await followRollout(
			{ getNodeRollout: async () => ({ rollout: states[polls++]!, raw: null }) },
			view(),
			{ log: (line) => lines.push(line), sleep: async () => undefined },
		);
		expect(polls).toBe(2);
		expect(last.status).toBe('succeeded');
		expect(lines).toEqual(['Wave 1/1: worker-1', 'running (starting)', '  worker-1: updating', 'running (updating)', '  worker-1: done (0.9.0)', 'succeeded']);
	});
});
