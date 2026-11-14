import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, workloads } from '@yoal/db';
import { DEFAULT_FEATURES, UNAVAILABLE_UPSTREAM } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

/**
 * The host-port ledger and the route guard (D225), replaying the incident that motivated them:
 * a new process app was given port 3000 on the node where a container already published
 * 127.0.0.1:3000, so the new app's public host served the container's site.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-host-ports-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features: DEFAULT_FEATURES,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
let edgeToken = '';

const container = (port: number) =>
	({ runtime: 'container', image: 'localhost/app:1', port, memoryMb: 64, cpus: 1, healthPath: '/', env: {}, secrets: [] }) as never;
const processApp = (port: number, socketActivation = false) =>
	({ runtime: 'process', command: ['bun', 'server.js'], port, memoryMb: 64, cpus: 1, healthPath: '/', socketActivation, env: {}, secrets: [] }) as never;

function failure(fn: () => unknown): { status: number; message: string } {
	try {
		fn();
	} catch (error) {
		return error as { status: number; message: string };
	}
	throw new Error('expected the call to throw');
}

async function deploy(slug: string) {
	return core.uploads.deployInline(owner, core.projects.requireRow(owner, slug), [file('server.js', `// ${Math.random()}`)], {
		promote: true,
	});
}

async function deployFailure(slug: string): Promise<{ status: number; message: string }> {
	try {
		await deploy(slug);
	} catch (error) {
		return error as { status: number; message: string };
	}
	throw new Error('expected the deploy to fail');
}

async function route(slug: string) {
	const state = await core.nodes.desiredState(edgeToken);
	return state.routes.find((entry) => entry.host === `${slug}.sites.test`);
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeAll(async () => {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
	edgeToken = joined.token;
	for (const [slug, runtime] of [
		['shifts', 'container'],
		['analytics', 'process'],
		['console-squatter', 'container'],
		['sock-a', 'process'],
		['sock-b', 'process'],
	] as const)
		await core.projects.create(owner, {
			name: slug,
			slug,
			runtime,
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
});

describe('host-port ledger (D225)', () => {
	test('the first app on a port deploys and is routed to it', async () => {
		core.workloads.setSpec(owner, core.projects.requireRow(owner, 'shifts'), container(3000));
		await deploy('shifts');
		expect((await route('shifts'))?.upstream).toBe('127.0.0.1:3000');
		expect((await route('shifts'))?.unavailable).toBeUndefined();
	});

	test('a second app on the same node and port is refused, naming the holder and a free port', async () => {
		core.workloads.setSpec(owner, core.projects.requireRow(owner, 'analytics'), processApp(3000));
		const refused = await deployFailure('analytics');
		expect([409, 422]).toContain(refused.status);
		expect(refused.message).toContain('Port 3000 on node "edge" is already used by "shifts"');
		expect(refused.message).toMatch(/port \d+ is free there/);
	});

	test('the same app on a free port deploys', async () => {
		core.workloads.setSpec(owner, core.projects.requireRow(owner, 'analytics'), processApp(8790));
		await deploy('analytics');
		expect((await route('analytics'))?.upstream).toBe('127.0.0.1:8790');
	});

	test('changing a placed app onto a taken port is refused when saved, not at the next deploy', () => {
		const refused = failure(() => core.workloads.setSpec(owner, core.projects.requireRow(owner, 'analytics'), processApp(3000)));
		expect(refused.status).toBe(409);
		expect(refused.message).toContain('already used by "shifts"');
	});

	test('a redeploy never conflicts with its own port', async () => {
		await deploy('shifts');
		expect((await route('shifts'))?.upstream).toBe('127.0.0.1:3000');
	});

	test('platform ports are never an app port', () => {
		for (const [port, owner_] of [
			[8084, 'the container console'],
			[8083, 'the database studio'],
			[8086, 'the workload identity endpoint'],
			[15432, 'managed databases'],
			[80, 'privileged ports'],
		] as const) {
			const refused = failure(() => core.workloads.setSpec(owner, core.projects.requireRow(owner, 'console-squatter'), container(port)));
			expect(refused.status).toBe(422);
			expect(refused.message).toContain(owner_);
		}
	});

	test('socket-activated apps hold no TCP port, so they never conflict', async () => {
		core.workloads.setSpec(owner, core.projects.requireRow(owner, 'sock-a'), processApp(3000, true));
		core.workloads.setSpec(owner, core.projects.requireRow(owner, 'sock-b'), processApp(3000, true));
		await deploy('sock-a');
		await deploy('sock-b');
		expect((await route('sock-a'))?.upstream).toMatch(/^unix\/\//);
		expect((await route('sock-b'))?.unavailable).toBeUndefined();
	});
});

describe('route guard (D225)', () => {
	const workloadOf = (slug: string) =>
		opened.db
			.select()
			.from(workloads)
			.where(eq(workloads.projectId, core.projects.requireRow(owner, slug).id))
			.get()!;

	test('rows that bypassed admission still never route one app to another app\'s port', async () => {
		// Simulate a row written before D225 (or by a buggy path): analytics claims 3000 too.
		const row = workloadOf('analytics');
		const spec = { ...JSON.parse(row.specJson), port: 3000 };
		opened.db
			.update(workloads)
			.set({ specJson: JSON.stringify(spec), upstream: '127.0.0.1:3000' })
			.where(eq(workloads.id, row.id))
			.run();
		const blocked = await route('analytics');
		expect(blocked?.unavailable).toContain('belongs to another app');
		expect(blocked?.upstream).toBe(UNAVAILABLE_UPSTREAM);
		// The first holder keeps its route.
		expect((await route('shifts'))?.upstream).toBe('127.0.0.1:3000');
		expect((await route('shifts'))?.unavailable).toBeUndefined();
	});

	test('a route to a platform port is never emitted', async () => {
		const row = workloadOf('analytics');
		opened.db.update(workloads).set({ upstream: '127.0.0.1:8084' }).where(eq(workloads.id, row.id)).run();
		const blocked = await route('analytics');
		expect(blocked?.unavailable).toContain('the container console');
		expect(blocked?.upstream).toBe(UNAVAILABLE_UPSTREAM);
	});

	test('an app on its own port keeps its route whatever its status says', async () => {
		const row = workloadOf('analytics');
		const spec = { ...JSON.parse(row.specJson), port: 8790 };
		opened.db
			.update(workloads)
			.set({ specJson: JSON.stringify(spec), upstream: '127.0.0.1:8790', status: 'failed' })
			.where(eq(workloads.id, row.id))
			.run();
		// `failed` also marks an app that is serving again after a restart loop.
		expect((await route('analytics'))?.upstream).toBe('127.0.0.1:8790');
		expect((await route('analytics'))?.unavailable).toBeUndefined();
		opened.db.update(workloads).set({ status: 'running' }).where(eq(workloads.id, row.id)).run();
	});

	test('an app with no workload never has its release served as static files', async () => {
		const row = workloadOf('analytics');
		opened.db.update(workloads).set({ upstream: null }).where(eq(workloads.id, row.id)).run();
		const blocked = await route('analytics');
		expect(blocked?.upstream).toBe(UNAVAILABLE_UPSTREAM);
		expect(blocked?.unavailable).toContain('no running workload');
	});
});
