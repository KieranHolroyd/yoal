/**
 * Golden fixtures for `NodeService.desiredState()` (HA-PLAN §6.1, Wave 1 split).
 *
 * Builds a few fixture fleets and prints every node's desired state as one JSON document on
 * stdout. `golden.test.ts` runs this in its own process and compares the output byte for byte
 * with `desired-state.golden.json`; `bun packages/core/src/desired-state/golden/fixtures.ts
 * --write` rewrites the snapshot.
 *
 * It runs out of process because it replaces every random source (node:crypto, Web Crypto,
 * Math.random) with a seeded one, and `mock.module` would leak that into every other test file
 * in a shared `bun test` process. Seeded IDs keep the output stable, including any ordering that
 * falls back to an ID.
 */
import { mock } from 'bun:test';
import * as realCrypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Unit-test mode: no registry lookups, and nothing here may reach the network.
process.env.NODE_ENV = 'test';
globalThis.fetch = (async (input: unknown) => {
	throw new Error(`golden fixtures are offline: ${String(input)}`);
}) as unknown as typeof fetch;

// ---- deterministic randomness --------------------------------------------------------------
let counter = 0;
function seededBytes(size: number): Buffer {
	const chunks: Buffer[] = [];
	let length = 0;
	while (length < size) {
		const chunk = realCrypto.createHash('sha256').update(`yoal-golden:${counter++}`).digest();
		chunks.push(chunk);
		length += chunk.length;
	}
	return Buffer.concat(chunks).subarray(0, size);
}
function seededUuid(): `${string}-${string}-${string}-${string}-${string}` {
	const bytes = seededBytes(16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function seededRandomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void): Buffer | undefined {
	const bytes = seededBytes(size);
	if (callback) {
		callback(null, bytes);
		return undefined;
	}
	return bytes;
}
mock.module('node:crypto', () => ({
	...realCrypto,
	default: { ...realCrypto, randomUUID: seededUuid, randomBytes: seededRandomBytes },
	randomUUID: seededUuid,
	randomBytes: seededRandomBytes,
}));
globalThis.crypto.randomUUID = seededUuid;
globalThis.crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
	if (array) {
		const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
		view.set(seededBytes(view.length));
	}
	return array;
}) as typeof globalThis.crypto.getRandomValues;
Math.random = () => seededBytes(4).readUInt32BE(0) / 0x1_0000_0000;

// A fixed clock for anything that reads the wall clock instead of `ctx.now()`.
const EPOCH = Date.UTC(2026, 10, 20, 12, 0, 0);
const clock = { now: EPOCH };
Date.now = () => clock.now;

// ---- fleets --------------------------------------------------------------------------------
const { createDb } = await import('@yoal/db');
const { DEFAULT_FEATURES, nodeCapabilities, workloadReplicaId } = await import('@yoal/contracts');
type Heartbeat = import('@yoal/contracts').Heartbeat;
const { buildPrincipal } = await import('../../orgs.ts');
const { createCore } = await import('../../index.ts');
const { LocalObjectStore } = await import('../../object-store.ts');

type FeatureFlags = typeof DEFAULT_FEATURES;
type Core = ReturnType<typeof createCore>;

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
const tick = (ms = 1_000) => {
	clock.now += ms;
};

interface Fleet {
	core: Core;
	sqlite: ReturnType<typeof createDb>['sqlite'];
	node: Record<string, { id: string; token: string }>;
	names: string[];
	dir: string;
}

function fleet(names: string[], features: FeatureFlags, overlay: boolean): Fleet {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-golden-'));
	const opened = createDb({ path: ':memory:' });
	const core = createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '0.1.0',
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
			now: () => clock.now,
			features,
		},
	});
	const node: Fleet['node'] = {};
	for (const [index, name] of names.entries()) {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
		node[name] = { id: joined.nodeId, token: joined.token };
		core.nodes.update(principal, joined.nodeId, { sliceMemoryMb: 8192 });
		opened.sqlite.run('UPDATE nodes SET public_address = ? WHERE id = ?', [`${name}.internal:8080`, joined.nodeId]);
		if (overlay)
			opened.sqlite.run(
				`UPDATE nodes SET private_address = ?, network_mode = 'yoal', wg_public_key = ?, wg_endpoint = ?, wg_listen_port = 51820 WHERE id = ?`,
				[
					`10.47.1.${index + 2}`,
					realCrypto.createHash('sha256').update(`wg:${name}`).digest('base64'),
					`${name}.internal:51820`,
					joined.nodeId,
				],
			);
	}
	const f: Fleet = { core, sqlite: opened.sqlite, node, names, dir };
	for (const name of names) beat(f, name);
	return f;
}

function fingerprint(id: string): string {
	return realCrypto.createHash('sha256').update(`fingerprint:${id}`).digest('hex');
}

type WorkloadReport = { id: string; status: 'running' | 'starting'; restarts: number };

function beat(f: Fleet, name: string, workloads: WorkloadReport[] = [], extra: Partial<Heartbeat> = {}): void {
	const { id, token } = f.node[name]!;
	f.core.nodes.heartbeat(token, {
		nodeId: id,
		agentVersion: '0.1.0',
		actualStateVersion: f.core.nodes.stateVersion(),
		status: 'online',
		caddyOk: true,
		capabilities: [...nodeCapabilities],
		stats: { diskUsedBytes: 1, diskTotalBytes: 100_000_000_000, diskFreeBytes: 90_000_000_000, uptimeSeconds: 1, load1: 0, certs: [] },
		releases: [],
		workloads,
		nodeCertificate: { certPem: 'pem', fingerprint: fingerprint(id), expiresAt: new Date(clock.now + 86_400_000).toISOString() },
		...extra,
	});
}

/**
 * Every node reports each copy it should run as up, having converged to the current state; a copy
 * whose id is in `starting` reports as still starting instead.
 */
async function settle(f: Fleet, slug?: string, starting: string[] = []): Promise<void> {
	for (const name of f.names) {
		const desired = (await f.core.nodes.desiredState(f.node[name]!.token)).workloads.filter(
			(entry) => slug === undefined || entry.projectSlug === slug,
		);
		beat(
			f,
			name,
			desired.map((entry) => ({ id: entry.id, status: starting.includes(entry.id) ? ('starting' as const) : ('running' as const), restarts: 0 })),
		);
	}
}

const project = (f: Fleet, slug: string) => f.core.projects.requireRow(principal, slug);

async function create(
	f: Fleet,
	slug: string,
	runtime: 'static' | 'process' | 'container' | 'compose' | 'function',
	placement = 'auto',
	access: { productionAccess?: 'public' | 'platform'; previewAccess?: 'public' | 'platform' } = {},
) {
	tick();
	await f.core.projects.create(principal, {
		name: slug,
		slug,
		runtime,
		placement,
		productionAccess: access.productionAccess ?? 'public',
		previewAccess: access.previewAccess ?? 'platform',
	});
}

async function processApp(f: Fleet, slug: string, spec: Record<string, unknown> = {}, placement = 'auto') {
	await create(f, slug, 'process', placement);
	f.core.workloads.setSpec(principal, project(f, slug), {
		runtime: 'process',
		command: ['bun', 'run', 'start'],
		port: 3000,
		memoryMb: 256,
		cpus: 1,
		healthPath: '/healthz',
		socketActivation: true,
		env: { NODE_ENV: 'production' },
		secrets: [],
		...spec,
	} as never);
}

async function deploy(f: Fleet, slug: string, content: string, options: { promote?: boolean; environment?: string } = {}) {
	tick();
	return f.core.uploads.deployInline(principal, project(f, slug), [file('index.js', content)], { promote: true, ...options });
}

async function deploySite(f: Fleet, slug: string, content: string, options: { promote?: boolean; environment?: string } = {}) {
	tick();
	return f.core.uploads.deployInline(
		principal,
		project(f, slug),
		[
			file('index.html', `<h1>${content}</h1>`),
			file('yoal.json', JSON.stringify({ spa: true })),
			file('_redirects', '/old /new 301\n/docs/* /guide/:splat 302\n'),
			file('_headers', '/*\n  X-Frame-Options: DENY\n'),
		],
		{ promote: true, ...options },
	);
}

const FUNCTION_SOURCE = 'export default { async fetch() { return new Response("ok"); } };';

/** A function manifest, its module and one static asset. */
function functionBundle() {
	return [
		file(
			'yoal-function.json',
			JSON.stringify({
				version: 1,
				main: 'index.js',
				modules: [{ name: 'index.js', type: 'esm', sha256: realCrypto.createHash('sha256').update(FUNCTION_SOURCE).digest('hex') }],
				compatibilityDate: '2026-10-01',
				compatibilityFlags: ['nodejs_compat'],
				bindings: [],
				triggers: { crons: [], queues: [] },
				assets: { directory: 'public', runWorkerFirst: ['/api/*'] },
			}),
		),
		file('index.js', FUNCTION_SOURCE),
		file('public/index.html', '<!doctype html><title>function</title>'),
	];
}

const COMPOSE = `
services:
  web:
    image: nginx:1.27
    ports: ["3000"]
    depends_on: [api]
  api:
    image: node:22-alpine
    expose: ["8080"]
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "0.5"
  admin:
    image: node:22-alpine
    expose: ["9000"]
x-yoal:
  routes:
    - service: web
      port: 3000
      primary: true
    - service: api
      port: 8080
      host: shop-api.sites.test
    - service: admin
      port: 9000
      host: stack-admin.sites.test
`;

async function verifiedDomain(f: Fleet, slug: string, hostname: string, redirectWww: boolean) {
	tick();
	const view = await f.core.domains.create(principal, { project: slug, hostname, redirectWww });
	f.sqlite.run(`UPDATE domains SET status = 'verified', verified_at = ? WHERE id = ?`, [clock.now, view.id]);
}

async function states(f: Fleet): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const name of f.names) out[name] = await f.core.nodes.desiredState(f.node[name]!.token);
	return out;
}

function close(f: Fleet): void {
	f.sqlite.close();
	rmSync(f.dir, { recursive: true, force: true });
}

/** One node, every flag at its default: the single-node gate. */
async function singleNode(): Promise<Record<string, unknown>> {
	const f = fleet(['solo'], DEFAULT_FEATURES, false);
	const { core } = f;
	// A PITR repository, so a database can turn PITR on (the flag is on by default).
	(core.ctx.config as { pitrRepository?: unknown }).pitrRepository = {
		kind: 's3',
		endpoint: 'https://s3.example.test',
		bucket: 'yoal-pitr',
		region: 'us-east-1',
		pathPrefix: 'yoal/pitr',
		forcePathStyle: true,
		accessKeyId: 'access-key',
		secretAccessKey: 'golden-secret-key',
	};

	// A static site with a preview, a staging environment, a custom domain and a renamed slug.
	await create(f, 'blog', 'static', 'edge');
	await deploySite(f, 'blog', 'First');
	await deploySite(f, 'blog', 'Preview only', { promote: false });
	tick();
	core.environments.create(principal, project(f, 'blog'), { name: 'Staging', access: 'public' });
	await deploySite(f, 'blog', 'Staging', { environment: 'staging' });
	await verifiedDomain(f, 'blog', 'blog.example.com', true);
	tick();
	await core.projects.update(principal, 'blog', { slug: 'journal' });
	tick();
	const link = await core.access.createShareLink(principal, project(f, 'journal'), { maxRedemptions: 2, sessionTtlSeconds: 600, note: 'review' });
	await core.access.revokeShareLink(principal, project(f, 'journal'), link.id);

	// Never deployed: a placeholder page.
	await create(f, 'fresh', 'static', 'edge');

	// A process app attached to a database, with the studio open.
	await processApp(f, 'backend');
	tick();
	core.databases.create(principal, { name: 'main', placement: f.node.solo!.id });
	core.databases.attach(principal, project(f, 'backend'), { database: 'main', envPrefix: 'DATABASE' });
	await deploy(f, 'backend', 'console.log(1)');
	await settle(f, 'backend');
	await settle(f);
	tick();
	core.databaseStudio.open(principal, 'main');

	// A worker (no route) and a container app.
	await processApp(f, 'queue', { ingress: 'none', memoryMb: 128 });
	const firstQueueDeploy = await deploy(f, 'queue', 'console.log("queue")');
	await create(f, 'shop', 'container');
	tick();
	await core.deployments.deployImage(principal, project(f, 'shop'), { image: 'ghcr.io/acme/shop:1', promote: true });

	// A compose stack with a second exposed service.
	await create(f, 'stack', 'compose', 'edge');
	tick();
	await core.deployments.deployCompose(principal, project(f, 'stack'), { document: COMPOSE, promote: true });
	// A stored host from before deploys checked it (two labels under the content domain) falls back
	// to `<slug>--<service>`.
	f.sqlite.run(
		`UPDATE deployments SET workload_json = replace(workload_json, 'stack-admin.sites.test', 'admin.stack.sites.test') WHERE project_id = ?`,
		[project(f, 'stack').id],
	);

	// Object storage.
	tick();
	core.storage.create(principal, { name: 'media', buckets: ['uploads'] });

	// A function with static assets served from its release.
	await create(f, 'edge-fn', 'function');
	tick();
	await core.uploads.deployInline(principal, project(f, 'edge-fn'), functionBundle(), { promote: true });
	// The same function with two stateless copies: one socket each, balanced by this node's Caddy.
	tick();
	core.workloads.setSpec(principal, project(f, 'edge-fn'), { ...core.workloads.projectSpec(project(f, 'edge-fn'))!, replicas: 2 });
	await core.uploads.deployInline(principal, project(f, 'edge-fn'), functionBundle(), { promote: true });

	// Yoal Access on the blog's production host and on the backend's previews, with a service token.
	tick();
	const policy = core.accessPolicies.create(principal, {
		name: 'Staff',
		scope: { type: 'org' },
		rules: [{ idx: 0, action: 'allow', matcher: { type: 'emailDomain', domain: 'example.com' } }],
	});
	core.accessPolicies.createServiceToken(principal, policy.id, { name: 'Deploy hook', header: 'X-Deploy-Token' });
	core.accessPolicies.assign(principal, project(f, 'journal'), { scope: 'production', policyId: policy.id });
	core.accessPolicies.assign(principal, project(f, 'backend'), { scope: 'previews', policyId: policy.id });

	// A second container app dialled on the first one's loopback port, as a row from before the
	// admission check could be: only the older app is routed there (D225), the other is unavailable.
	await create(f, 'shop-clash', 'container');
	tick();
	core.workloads.setSpec(principal, project(f, 'shop-clash'), { runtime: 'container', image: 'ghcr.io/acme/shop:1', port: 3001 } as never);
	await core.deployments.deployImage(principal, project(f, 'shop-clash'), { image: 'ghcr.io/acme/shop:1', promote: true });
	f.sqlite.run(`UPDATE workloads SET upstream = '127.0.0.1:3000' WHERE project_id = ?`, [project(f, 'shop-clash').id]);

	// A project from before the environments table: it serves from the project pointer alone.
	await create(f, 'legacy', 'static', 'edge');
	await deploySite(f, 'legacy', 'Legacy');
	f.sqlite.run(`DELETE FROM environments WHERE project_id = ?`, [project(f, 'legacy').id]);

	// A production pointer whose deployment is gone is a fault, not a new project: no default page,
	// even with no environment row to say so.
	await create(f, 'broken', 'static', 'edge');
	await deploySite(f, 'broken', 'Broken');
	f.sqlite.run(`UPDATE deployments SET status = 'failed' WHERE project_id = ?`, [project(f, 'broken').id]);
	f.sqlite.run(`DELETE FROM environments WHERE project_id = ?`, [project(f, 'broken').id]);

	// Databases purged from the trash are removed on their node, in id order.
	for (const name of ['old-a', 'old-b', 'old-c', 'old-d']) {
		tick();
		core.databases.create(principal, { name, placement: f.node.solo!.id });
		core.databases.delete(principal, name);
		core.databases.purgeNow(principal, name);
	}

	// Non-default site config: clean URLs, an enforced trailing slash and a custom 404 page.
	await create(f, 'handbook', 'static', 'edge');
	tick();
	await core.uploads.deployInline(
		principal,
		project(f, 'handbook'),
		[
			file('index.html', '<h1>Handbook</h1>'),
			file('404.html', '<h1>Not here</h1>'),
			file('yoal.json', JSON.stringify({ cleanUrls: true, trailingSlash: 'always', notFound: '/404.html' })),
		],
		{ promote: true },
	);

	// Yoal Access on a non-production environment: the staging host carries its own policy.
	tick();
	core.accessPolicies.assign(principal, project(f, 'journal'), {
		scope: 'environment',
		environmentId: core.environments.requireRow(project(f, 'journal'), 'staging').id,
		policyId: policy.id,
	});

	// A deployed project in the trash: it keeps its pointer but serves nothing.
	await create(f, 'retired', 'static', 'edge');
	await deploySite(f, 'retired', 'Retired');
	tick();
	await core.projects.softDelete(principal, 'retired');

	// The worker deploys again and its first deployment is marked failed (its release is kept, where
	// a deleted deployment's release is collected): only the active deployment's release is shipped.
	await deploy(f, 'queue', 'console.log("queue v2")');
	f.sqlite.run(`UPDATE deployments SET status = 'failed' WHERE id = ?`, [firstQueueDeploy.id]);

	// A second non-production environment with no policy of its own: its own access mode applies.
	tick();
	core.environments.create(principal, project(f, 'journal'), { name: 'QA', access: 'public' });
	await deploySite(f, 'journal', 'QA', { environment: 'qa' });

	// An app dialled on a port the platform reserves (the studio's), as an old row could be: unavailable.
	await create(f, 'shop-reserved', 'container');
	tick();
	core.workloads.setSpec(principal, project(f, 'shop-reserved'), { runtime: 'container', image: 'ghcr.io/acme/shop:1', port: 3002 } as never);
	await core.deployments.deployImage(principal, project(f, 'shop-reserved'), { image: 'ghcr.io/acme/shop:1', promote: true });
	f.sqlite.run(`UPDATE workloads SET upstream = '127.0.0.1:8083' WHERE project_id = ?`, [project(f, 'shop-reserved').id]);

	// Database tasks, one of each kind: a backup, a PITR base backup, a rotation and a named credential.
	tick();
	core.databases.createBackup(principal, 'main');
	tick();
	core.databases.create(principal, { name: 'pitr-db', version: '18', placement: f.node.solo!.id });
	core.databases.setPitrPolicy(principal, 'pitr-db', { enabled: true });
	tick();
	core.databases.rotateCredentials(principal, 'main', { role: 'owner' });
	tick();
	core.databases.createCredential(principal, 'main', { role: 'app', purpose: 'web app' });

	// Network shares: one mounting, one mounted and now unmounting.
	tick();
	core.shares.create(principal, { name: 'media-nfs', protocol: 'nfs', server: '10.0.0.5', exportPath: '/mnt/media' });
	core.shares.mount(principal, 'media-nfs', { node: 'solo' });
	tick();
	core.shares.create(principal, { name: 'archive', protocol: 'nfs', server: '10.0.0.6', exportPath: '/mnt/archive' });
	const archiveMount = core.shares.mount(principal, 'archive', { node: 'solo' }).mounts[0]!.id;
	beat(f, 'solo', [], { shareMounts: [{ id: archiveMount, mounted: true, error: null }] });
	tick();
	core.shares.unmount(principal, 'archive', f.node.solo!.id);

	const result = await states(f);
	close(f);
	return result;
}

/** An edge plus two workers on the overlay, with service endpoints and spread copies. */
async function edgeAndWorkers(): Promise<Record<string, unknown>> {
	const f = fleet(['edge', 'worker-a', 'worker-b'], DEFAULT_FEATURES, true);
	const { core } = f;

	// A static site placed on a worker: the edge proxies it.
	await create(f, 'docs', 'static', f.node['worker-a']!.id);
	await deploySite(f, 'docs', 'Docs');
	await verifiedDomain(f, 'docs', 'docs.example.com', false);

	// A database on worker-b with a read replica on worker-a.
	tick();
	core.databases.create(principal, { name: 'orders', placement: f.node['worker-b']!.id });
	tick();
	core.databaseReplicas.add(principal, 'orders', { node: f.node['worker-a']!.id });

	// A process app spread over three copies, attached to the remote database.
	await processApp(f, 'web');
	core.databases.attach(principal, project(f, 'web'), { database: 'orders', envPrefix: 'DATABASE' });
	await deploy(f, 'web', 'console.log("web")');
	await settle(f, 'web');
	tick();
	core.scaling.scale(principal, project(f, 'web'), { replicas: 3 });
	await settle(f, 'web');
	await deploy(f, 'web', 'console.log("web preview")', { promote: false });

	// A container app spread over three copies: two up, one still starting, so the edge lists only
	// the two that are up.
	await create(f, 'shop', 'container');
	tick();
	await core.deployments.deployImage(principal, project(f, 'shop'), { image: 'ghcr.io/acme/shop:2', promote: true });
	await settle(f, 'shop');
	tick();
	core.scaling.scale(principal, project(f, 'shop'), { replicas: 3 });
	const shopWorkload = f.sqlite.query<{ id: string }, [string]>('SELECT id FROM workloads WHERE project_id = ?').get(project(f, 'shop').id)!;
	const lastShopCopy = workloadReplicaId(shopWorkload.id, 2);

	// A process app scaled out with no copy reported yet: every copy is listed and health checks
	// decide. Copy 2 shares copy 1's node (placement spreads them; a row can still say so): a node
	// holding two copies is listed once.
	await processApp(f, 'fresh-copies', { healthPath: '/ready', memoryMb: 128 });
	await deploy(f, 'fresh-copies', 'console.log("fresh")');
	tick();
	core.scaling.scale(principal, project(f, 'fresh-copies'), { replicas: 3 });
	f.sqlite.run(
		`UPDATE workload_replicas SET node_id = (SELECT node_id FROM workload_replicas WHERE project_id = ?1 AND replica_index = 1)
		 WHERE project_id = ?1 AND replica_index = 2`,
		[project(f, 'fresh-copies').id],
	);

	// Never deployed and placed on a worker: only the edge shows its default page.
	await create(f, 'draft', 'static', f.node['worker-a']!.id);

	// A single-copy process app, moved with a surge at the end.
	await processApp(f, 'mover');
	await deploy(f, 'mover', 'console.log("mover")');

	// Object storage on a worker, and a database studio session (gateway routes on the edge).
	tick();
	core.storage.create(principal, { name: 'assets', buckets: ['public'], placement: f.node['worker-b']!.id } as never);
	await settle(f);
	tick();
	core.databaseStudio.open(principal, 'orders');
	await settle(f, 'shop', [lastShopCopy]);

	// A rollout is restarting web's copy 1: it leaves the upstream list while still reporting running.
	f.sqlite.run(
		`UPDATE workload_replicas SET applied_version = ? WHERE project_id = ? AND replica_index = 1`,
		[core.projects.stateVersion(), project(f, 'web').id],
	);

	// Surge move: the old node keeps serving and the new one already has the release.
	const moverFrom = f.sqlite.query<{ nodeId: string }, [string]>('SELECT node_id AS nodeId FROM workloads WHERE project_id = ?').get(project(f, 'mover').id)!.nodeId;
	const moverTo = moverFrom === f.node['worker-a']!.id ? 'worker-b' : 'worker-a';
	tick();
	const moved = core.scheduling.move(principal, 'mover', { node: moverTo });
	if (moved.mode !== 'surge') throw new Error(`expected a surge move, got ${moved.mode}`);

	// A database moved from worker-a to worker-b: dumped, restored, and now purging the old copy.
	tick();
	const ledger = core.databases.create(principal, { name: 'ledger', placement: f.node['worker-a']!.id });
	beat(f, 'worker-a', [{ id: ledger.id, status: 'running', restarts: 0 }]);
	tick();
	core.moves.moveDatabase(principal, 'ledger', { node: f.node['worker-b']!.id });
	beat(f, 'worker-a', [{ id: ledger.id, status: 'running', restarts: 0 }]);
	const moveRow = () =>
		f.sqlite
			.query<{ phase: string; backupId: string | null }, [string]>(
				'SELECT phase, backup_id AS backupId FROM database_moves WHERE database_id = ? ORDER BY created_at DESC LIMIT 1',
			)
			.get(ledger.id)!;
	const { backupId } = moveRow();
	tick();
	beat(f, 'worker-a', [], {
		databaseBackupResults: [{ taskId: backupId!, action: 'backup', databaseId: ledger.id, backupId: null, status: 'ok', sizeBytes: 1234 }],
	});
	tick();
	beat(f, 'worker-b', [], {
		databaseBackupResults: [{ taskId: `restore:${ledger.id}`, action: 'restore', databaseId: ledger.id, backupId, status: 'ok' }],
	});
	if (moveRow().phase !== 'purging') throw new Error(`expected the ledger move to be purging, got ${moveRow().phase}`);

	// A worker-placed site renamed: the redirect goes only to nodes that serve the project.
	tick();
	await core.projects.update(principal, 'docs', { slug: 'manual' });

	const result = await states(f);
	close(f);
	return result;
}

/**
 * `edgeNodeId` configured to a node whose mode is not `edge`: both that node and the `edge`-mode
 * node act as the edge (`isEdge` is either test), and `auto` placement resolves to the configured one.
 */
async function configuredEdge(): Promise<Record<string, unknown>> {
	const f = fleet(['first', 'second'], DEFAULT_FEATURES, false);
	(f.core.ctx.config as { edgeNodeId?: string }).edgeNodeId = f.node.second!.id;
	await create(f, 'site', 'static', 'auto');
	await deploySite(f, 'site', 'Configured edge');
	await create(f, 'pending', 'static', 'auto');
	const result = await states(f);
	close(f);
	return result;
}

const fixtures = {
	'single-node': await singleNode(),
	'edge-and-two-workers': await edgeAndWorkers(),
	'configured-edge': await configuredEdge(),
};
const output = `${JSON.stringify(fixtures, null, '\t')}\n`;
if (process.argv.includes('--write')) writeFileSync(new URL('./desired-state.golden.json', import.meta.url), output);
else process.stdout.write(output);
