import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	cloudShellIdPattern,
	cloudShellLimits,
	containerConsoleActivationSchema,
	containerConsoleHost,
	DEFAULT_FEATURES,
	desiredStateSchema,
} from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-cloud-shell-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-22T10:00:00Z');
const features = { ...DEFAULT_FEATURES, CLOUD_SHELL: true, CONTAINER_CONSOLE: false };
const GIB = 1024 ** 3;

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
		now: () => clock,
		features,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'deployer' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_1', role: 'viewer' });
const apiKey = buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', granted: ['cloudShell:use'] });

let edgeToken = '';
let edgeId = '';

function heartbeat(capabilities: string[], extra: Record<string, unknown> = {}) {
	core.nodes.heartbeat(edgeToken, {
		nodeId: edgeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		capabilities,
		stats: {
			cpuPercent: 5,
			memoryBytes: GIB,
			memoryTotalBytes: 8 * GIB,
			diskUsedBytes: 10 * GIB,
			diskTotalBytes: 100 * GIB,
			diskFreeBytes: 90 * GIB,
		},
		releases: [],
		...extra,
	} as never);
}

function failure(fn: () => unknown): { status: number; message: string } {
	try {
		fn();
	} catch (error) {
		return error as { status: number; message: string };
	}
	throw new Error('expected the call to throw');
}

async function desired() {
	return desiredStateSchema.parse(await core.nodes.desiredState(edgeToken));
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
	edgeToken = joined.token;
	edgeId = joined.nodeId;
	heartbeat(['node-tasks']);
});

describe('cloud shell', () => {
	test('needs cloudShell:use and a signed-in person', () => {
		expect(core.cloudShells.state(owner)).toMatchObject({ enabled: true, shell: null, limits: { diskMb: 1024 } });
		expect(failure(() => core.cloudShells.state(viewer)).message).toMatch(/cloudShell:use/);
		expect(failure(() => core.cloudShells.start(apiKey)).status).toBe(403);
	});

	test('refuses to start before a node can run one', () => {
		expect(failure(() => core.cloudShells.start(owner)).message).toMatch(/advertises "cloud-shell"/);
	});

	test('starts on a capable node with the CLI signed in, and the node gets the workload', async () => {
		heartbeat(['node-tasks', 'container-console', 'cloud-shell']);
		const shell = core.cloudShells.start(owner);
		expect(shell).toMatchObject({ status: 'starting', node: { id: edgeId, name: 'edge' }, diskMb: 1024, home: '/home/yoal', cliSignedIn: true });
		expect(shell.id).toMatch(cloudShellIdPattern);
		expect(shell.image).toBe('ghcr.io/kieranholroyd/yoal-cloud-shell:0.1.0');

		const state = await desired();
		const workload = state.workloads.find((item) => item.id === shell.id)!;
		expect(workload).toMatchObject({
			runtime: 'container',
			image: 'ghcr.io/kieranholroyd/yoal-cloud-shell:0.1.0',
			ingress: 'none',
			memoryMb: cloudShellLimits.memoryMb,
			cloudShell: { diskMb: 1024 },
			secrets: [],
			env: {},
		});
		// The key travels only in the activation, never in desired state.
		expect(JSON.stringify(state)).not.toContain('yoal_');
		// The console front opens for the shell even with the container console switched off.
		expect(state.containerConsole).toEqual({ port: 8084 });
		expect(state.databaseGateway.routes).toContainEqual({ host: containerConsoleHost(edgeId), upstream: '127.0.0.1:8084' });

		const activation = await core.workloads.activationFor(edgeId, shell.id);
		expect(activation.activationVersion).toBe(workload.activationVersion);
		expect(activation.env).toMatchObject({ YOAL_URL: 'https://control.test', YOAL_CONTENT_DOMAIN: 'sites.test', YOAL_CLOUD_SHELL: '1' });
		const verified = core.ctx.accessKeys.verify(activation.env.YOAL_TOKEN!);
		expect(verified).toMatchObject({ orgId: 'org_1', principalType: 'user', principalId: 'user_1' });
		expect(failure(() => core.cloudShells.activation('node_other', shell.id)).status).toBe(403);
	});

	test('a running report moves it to running; starting again is a no-op', () => {
		const id = core.cloudShells.state(owner).shell!.id;
		heartbeat(['node-tasks', 'container-console', 'cloud-shell'], { workloads: [{ id, status: 'running', restarts: 0 }] });
		expect(core.cloudShells.state(owner).shell!.status).toBe('running');
		expect(core.cloudShells.start(owner)).toMatchObject({ id, status: 'running' });
	});

	test('console tokens name the person’s own shell and nobody else’s', () => {
		const endpoint = core.containerConsole.cloudShellEndpoint(owner);
		expect(endpoint.host).toBe(containerConsoleHost(edgeId));
		const activation = containerConsoleActivationSchema.parse(core.containerConsole.activation(edgeId, endpoint.token));
		expect(activation).toMatchObject({ workloadId: endpoint.desiredId, userId: 'user_1', scopes: ['inspect', 'files', 'exec'] });
		expect(endpoint.desiredId).toMatch(cloudShellIdPattern);
		// Someone else has no running shell to reach; a key never reaches one.
		expect(failure(() => core.containerConsole.cloudShellEndpoint(deployer)).message).toMatch(/not running/);
		expect(failure(() => core.containerConsole.cloudShellEndpoint(apiKey)).status).toBe(403);
	});

	test('a role that cannot create access keys gets a shell without a signed-in CLI', async () => {
		const shell = core.cloudShells.start(deployer);
		expect(shell.cliSignedIn).toBe(false);
		const activation = await core.workloads.activationFor(edgeId, shell.id);
		expect(activation.env.YOAL_TOKEN).toBeUndefined();
		core.cloudShells.stop(deployer);
	});

	test('the sweep stops an idle shell and revokes its key; the disk stays for the next start', async () => {
		const before = core.cloudShells.state(owner).shell!;
		const first = await core.workloads.activationFor(edgeId, before.id);
		const key = first.env.YOAL_TOKEN!;
		clock += cloudShellLimits.idleMs - 60_000;
		expect(core.cloudShells.sweep()).toEqual({ stopped: 0 });
		// Typing in the console counts as activity.
		core.containerConsole.cloudShellEndpoint(owner);
		clock += cloudShellLimits.idleMs - 60_000;
		expect(core.cloudShells.sweep()).toEqual({ stopped: 0 });
		clock += 2 * 60_000;
		expect(core.cloudShells.sweep()).toEqual({ stopped: 1 });

		expect(core.cloudShells.state(owner).shell).toMatchObject({ id: before.id, status: 'stopped', cliSignedIn: false });
		expect(core.ctx.accessKeys.verify(key)).toBeUndefined();
		const state = await desired();
		expect(state.workloads.some((item) => item.id === before.id)).toBe(false);
		expect(state.cloudShellPurges).toBeUndefined();
		expect(failure(() => core.containerConsole.cloudShellEndpoint(owner)).message).toMatch(/not running/);

		const again = core.cloudShells.start(owner);
		expect(again.id).toBe(before.id);
		// A new generation and key: the node re-applies the unit, so the container starts fresh.
		const workload = (await desired()).workloads.find((item) => item.id === before.id)!;
		expect(workload.activationVersion).not.toBe(first.activationVersion);
		expect((await core.workloads.activationFor(edgeId, before.id)).env.YOAL_TOKEN).not.toBe(key);
	});

	test('a shell is stopped after the session limit even while in use', () => {
		const started = clock;
		while (clock - started < cloudShellLimits.maxSessionMs) {
			clock += 10 * 60_000;
			core.cloudShells.touch(owner);
			core.cloudShells.sweep();
		}
		expect(core.cloudShells.state(owner).shell!.status).toBe('stopped');
	});

	test('reset hands the disk to the node and forgets the shell once it is gone', async () => {
		const id = core.cloudShells.start(owner).id;
		expect(core.cloudShells.reset(owner)).toEqual({ reset: true });
		expect(core.cloudShells.state(owner).shell).toBeNull();
		const state = await desired();
		expect(state.workloads.some((item) => item.id === id)).toBe(false);
		expect(state.cloudShellPurges).toEqual([id]);

		heartbeat(['node-tasks', 'container-console', 'cloud-shell'], { purgedCloudShells: [id] });
		expect((await desired()).cloudShellPurges).toBeUndefined();
		// The next start is a new shell with an empty disk.
		const fresh = core.cloudShells.start(owner);
		expect(fresh.id).not.toBe(id);
		core.cloudShells.stop(owner);
	});

	test('switching the feature off stops every shell', async () => {
		const id = core.cloudShells.start(owner).id;
		features.CLOUD_SHELL = false;
		try {
			expect(core.cloudShells.sweep()).toEqual({ stopped: 1 });
			expect((await desired()).workloads.some((item) => item.id === id)).toBe(false);
			expect(failure(() => core.cloudShells.start(owner)).status).toBe(409);
		} finally {
			features.CLOUD_SHELL = true;
		}
	});
});
