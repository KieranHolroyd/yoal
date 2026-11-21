import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	DATABASE_REPLICAS_CAPABILITY,
	DEFAULT_FEATURES,
	ENDPOINTS_GATEWAY_CAPABILITY,
	databaseAlias,
	nodeCapabilities,
	type DatabaseReplicationSlotStatus,
	type FeatureFlags,
	type Heartbeat,
} from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * Review debt 2, part 2 (HA-PLAN §9, H24): with `ENDPOINTS_GATEWAY` on, an attached app moves to
 * its stable endpoint on its own next deploy, or all at once with `yoal ha migrate attachments`,
 * never because a neighbour deployed or a replica came or went. The read endpoint exists from the
 * first deploy, so replicas changing restart nobody; attaching to a running copy renders its URL.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-attach-migration-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-21T10:00:00Z');
const features: Partial<FeatureFlags> = { ENDPOINTS_GATEWAY: true, SERVICE_ENDPOINTS: true, MULTI_NODE_REPLICAS: true };
const core: Core = createCore({
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
		now: () => clock,
		features: { ...DEFAULT_FEATURES, ...features },
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
/** A platform operator (`platform:ha`, not admin): reads the HA views, changes nothing admin-only. */
core.ctx.platformIam.bind(owner, { userId: 'user_op', roleId: 'platform-operator' });
const operator = buildPrincipal({ kind: 'user', userId: 'user_op', orgId: 'org_1', role: 'viewer', platformAdmin: false });
type JoinedNode = { nodeId: string; token: string; name: string };
let nodeIndex = 1;
const joinNode = (name: string): JoinedNode => {
	const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, name).token, name });
	const roles = name === 'data' ? (['data'] as const) : name === 'edge' ? null : (['compute'] as const);
	core.nodes.update(owner, node.nodeId, { sliceMemoryMb: 16_384, ...(roles ? { roles: [...roles] } : {}) });
	opened.sqlite.run('UPDATE nodes SET private_address = ? WHERE id = ?', [`10.47.2.${nodeIndex++}`, node.nodeId]);
	return { ...node, name };
};
const edge = joinNode('edge');
const workerA = joinNode('worker-a');
const workerB = joinNode('worker-b');
const data = joinNode('data');
const allNodes = [edge, workerA, workerB, data];

/** Agents start without the gateway capability (an older agent); `upgrade()` adds it. */
let gatewayCapable = false;
function beat(node: JoinedNode, extra: Partial<Heartbeat> = {}): void {
	core.nodes.heartbeat(node.token, {
		nodeId: node.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: core.nodes.stateVersion(),
		status: 'online',
		caddyOk: true,
		releases: [],
		capabilities: [...nodeCapabilities, DATABASE_REPLICAS_CAPABILITY, ...(gatewayCapable ? [ENDPOINTS_GATEWAY_CAPABILITY] : [])],
		nodeCertificate: {
			certPem: 'pem',
			fingerprint: node.nodeId.replace(/[^a-f0-9]/g, '').padEnd(64, 'a').slice(0, 64),
			expiresAt: new Date(clock + 86_400_000).toISOString(),
		},
		...extra,
	});
}
const upgrade = () => {
	gatewayCapable = true;
	for (const node of allNodes) beat(node);
};
for (const node of allNodes) beat(node);

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const endpointRows = (nodeId: string, databaseId: string) =>
	opened.sqlite
		.query<{ role: string; localPort: number; upstreamNodeId: string; version: number }, [string, string]>(
			`SELECT role, local_port AS localPort, upstream_node_id AS upstreamNodeId, version
			 FROM service_endpoints WHERE consumer_node_id = ? AND service_kind = 'database' AND service_id = ? ORDER BY local_port`,
		)
		.all(nodeId, databaseId);

let specPort = 3_400;
let deploymentCounter = 1;
/** Plan and record a deployment the way DeploymentService does, without releasing content. */
function deploy(projectSlug: string, runtime: 'container' | 'process' = 'container'): void {
	const row = core.projects.requireRow(owner, projectSlug);
	if (!row.workloadJson)
		core.workloads.setSpec(owner, row, {
			runtime,
			...(runtime === 'container' ? { image: 'localhost/app:1' } : { command: ['bun', 'server.ts'] }),
			port: specPort++,
			memoryMb: 128,
			cpus: 1,
			healthPath: '/',
			env: {},
			secrets: [],
		} as never);
	const current = core.projects.requireRow(owner, projectSlug);
	const resolved = core.workloads.plan(owner, current, { replicas: 1 });
	const deploymentId = `dep_${projectSlug}_${deploymentCounter}`;
	opened.sqlite.run(
		`INSERT INTO deployments (id, org_id, project_id, release_id, config_snapshot_id, short_id, runtime, runtime_name, status, preview_host, created_by, created_at)
		 VALUES (?, 'org_1', ?, 'rel_none', 'cfg_none', ?, ?, ?, 'active', ?, 'user_1', ?)`,
		[deploymentId, row.id, `m${deploymentCounter++}`, resolved.spec.runtime, resolved.spec.runtime, `${projectSlug}-${deploymentCounter}.preview.test`, clock],
	);
	core.workloads.record(current, deploymentId, resolved);
}

async function project(slug: string, placement: string, runtime: 'container' | 'process' = 'container') {
	return core.projects.create(owner, { name: slug, slug, runtime, placement, productionAccess: 'public', previewAccess: 'platform' });
}

function streamReplica(dbId: string, slot: string, extra: Partial<DatabaseReplicationSlotStatus> = {}, primary: JoinedNode = data): void {
	beat(primary, {
		databaseReplication: [
			{
				databaseId: dbId,
				appliedVersion: core.databaseReplicas.replicationTasksForNode(primary.nodeId).find((item) => item.databaseId === dbId)!.version,
				error: null,
				slots: [
					{
						slot,
						active: true,
						walStatus: 'reserved',
						state: 'streaming',
						sentLsn: '0/3000148',
						replayLsn: '0/3000148',
						lagBytes: 0,
						lagSeconds: 0,
						syncState: 'async',
						...extra,
					},
				],
				sampledAt: new Date(clock).toISOString(),
			},
		],
	});
}

const env = (projectId: string, nodeId: string, runtime: 'container' | 'process' = 'container') => ({
	env: core.databases.consumerEnv(projectId, nodeId, runtime),
	version: core.databases.consumerVersion(projectId, nodeId, runtime),
});

describe('existing attachments move on their own next deploy (item 7)', () => {
	let bId = '';
	let dbId = '';
	test('a neighbour deploying, or a replica coming and going, moves no other app', async () => {
		const a = await project('mig-a', workerA.nodeId);
		const b = await project('mig-b', workerA.nodeId);
		bId = b.id;
		const db = core.databases.create(owner, { name: 'mig-db', placement: workerA.nodeId });
		dbId = db.id;
		for (const p of [a, b]) core.databases.attach(owner, core.projects.requireRow(owner, p.slug), { database: 'mig-db', envPrefix: 'DATABASE' });
		// Deployed while the agents could not run the gateway: both connect directly.
		deploy(a.slug);
		deploy(b.slug);
		const bBefore = env(b.id, workerA.nodeId);
		expect(bBefore.env.DATABASE_HOST).toBe(databaseAlias(db.id));
		expect(Number(bBefore.env.DATABASE_PORT)).toBeLessThan(21_000);

		// The agents are upgraded; A deploys again and moves to its stable endpoint.
		upgrade();
		deploy(a.slug);
		const aAfter = env(a.id, workerA.nodeId);
		expect(Number(aAfter.env.DATABASE_PORT)).toBeGreaterThanOrEqual(21_000);
		// B did not deploy: its environment and activation are untouched.
		expect(env(b.id, workerA.nodeId)).toEqual(bBefore);

		// A replica added and removed re-plans every consumer node; B still does not move.
		const replica = core.databaseReplicas.add(owner, 'mig-db', { node: workerB.nodeId });
		streamReplica(db.id, replica.slot!, {}, workerA);
		expect(env(b.id, workerA.nodeId)).toEqual(bBefore);
		core.databaseReplicas.remove(owner, 'mig-db', replica.id);
		expect(env(b.id, workerA.nodeId)).toEqual(bBefore);
		const desired = await core.nodes.desiredState(workerA.token);
		const bWorkload = desired.workloads.find((item) => item.projectId === b.id)!;
		expect(bWorkload.addHosts ?? []).toEqual([]);
	});

	test('`ha migrate attachments` lists the apps still connecting directly and moves them only on apply', () => {
		const plan = core.endpoints.migrationPlan(owner);
		expect(plan.apply).toBe(false);
		const bItem = plan.projects.find((item) => item.projectId === bId)!;
		expect(bItem).toMatchObject({ slug: 'mig-b', status: 'will-move' });
		expect(plan.projects.find((item) => item.slug === 'mig-a')).toBeUndefined();
		const before = env(bId, workerA.nodeId);
		// A dry run changes nothing.
		expect(env(bId, workerA.nodeId)).toEqual(before);

		// A platform operator may look, not move (review fix 2).
		expect(core.endpoints.migrateAttachments(operator, { projects: ['mig-b'] }).apply).toBe(false);
		expect(() => core.endpoints.migrateAttachments(operator, { apply: true, projects: ['mig-b'] })).toThrow(/platform admin/);
		expect(env(bId, workerA.nodeId)).toEqual(before);
		const applied = core.endpoints.migrateAttachments(owner, { apply: true, projects: ['mig-b'] });
		expect(applied.apply).toBe(true);
		expect(applied.projects.find((item) => item.slug === 'mig-b')!.status).toBe('moved');
		const after = env(bId, workerA.nodeId);
		expect(Number(after.env.DATABASE_PORT)).toBeGreaterThanOrEqual(21_000);
		expect(after.version).not.toBe(before.version);
		// Nothing left to move.
		expect(core.endpoints.migrationPlan(owner).projects.filter((item) => item.status === 'will-move')).toEqual([]);
	});

	test('the attachments view names each endpoint, its port and its node', () => {
		const view = core.endpoints.attachmentsView(owner);
		const row = view.attachments.find((item) => item.project === 'mig-b' && item.database === 'mig-db')!;
		expect(row).toBeDefined();
		expect(row.consumers).toHaveLength(1);
		expect(row.consumers[0]).toMatchObject({ node: 'worker-a', mode: 'gateway', databaseNode: 'worker-a' });
		expect(row.consumers[0]!.port).toBe(endpointRows(workerA.nodeId, dbId).find((item) => item.role === 'primary')!.localPort);
		expect(row.consumers[0]!.readPort).toBeGreaterThanOrEqual(23_000);
	});
});

describe('the read endpoint exists from the first deploy (item 8)', () => {
	test('adding, streaming, removing and promoting replicas change no env and restart nobody', async () => {
		const app = await project('read-first', workerB.nodeId);
		const db = core.databases.create(owner, { name: 'read-first-db', placement: data.nodeId });
		core.databases.attach(owner, core.projects.requireRow(owner, app.slug), { database: 'read-first-db', envPrefix: 'DATABASE' });
		deploy(app.slug);
		const first = env(app.id, workerB.nodeId);
		// No replica yet: the read URL is there, pointing at the primary through its own stable port.
		const read = endpointRows(workerB.nodeId, db.id).find((row) => row.role === 'read')!;
		expect(read).toBeDefined();
		expect(read.upstreamNodeId).toBe(data.nodeId);
		expect(first.env.DATABASE_READ_URL).toContain(`:${read.localPort}/`);
		const activation = async () => (await core.nodes.desiredState(workerB.token)).workloads.find((item) => item.projectId === app.id)!.activationVersion;
		const firstActivation = await activation();

		const replica = core.databaseReplicas.add(owner, 'read-first-db', { node: workerA.nodeId });
		streamReplica(db.id, replica.slot!);
		expect(env(app.id, workerB.nodeId)).toEqual(first);
		expect(await activation()).toBe(firstActivation);
		const following = endpointRows(workerB.nodeId, db.id).find((row) => row.role === 'read')!;
		expect(following.localPort).toBe(read.localPort);
		// The replica set changed, so the forwarder is told (a newer version), not the app.
		expect(following.version).toBeGreaterThan(read.version);

		streamReplica(db.id, replica.slot!, { active: false, state: null });
		const stopped = endpointRows(workerB.nodeId, db.id).find((row) => row.role === 'read')!;
		expect(stopped.version).toBeGreaterThan(following.version);
		expect(env(app.id, workerB.nodeId)).toEqual(first);

		core.databaseReplicas.remove(owner, 'read-first-db', replica.id);
		expect(env(app.id, workerB.nodeId)).toEqual(first);
		expect(await activation()).toBe(firstActivation);
	});
});

describe('an app the upgrade backfill marked gains its read URL only on its own deploy (review fix 1)', () => {
	test('a neighbour deploying on the same node changes neither its environment nor its version', async () => {
		const a = await project('up-a', workerA.nodeId);
		const b = await project('up-b', workerA.nodeId);
		const c = await project('up-c', workerA.nodeId);
		const db = core.databases.create(owner, { name: 'up-db', placement: data.nodeId });
		for (const p of [a, c]) core.databases.attach(owner, core.projects.requireRow(owner, p.slug), { database: 'up-db', envPrefix: 'DATABASE' });
		deploy(a.slug);
		// The state main plus migration 0133 leaves: A on the gateway (backfilled), no read row and no
		// read URL, because no replica ever served reads on main.
		opened.sqlite.run("DELETE FROM service_endpoints WHERE role = 'read'");
		opened.sqlite.run('UPDATE database_attachments SET read_endpoint = 0 WHERE project_id = ?', [a.id]);
		expect(core.endpoints.marked(a.id)).toBe(true);
		const before = env(a.id, workerA.nodeId);
		expect(before.env.DATABASE_READ_URL).toBeUndefined();
		// A neighbour without the database deploys, then one attached to the same database does
		// (its own deploy gives it a read endpoint on this node, shared by row with A's database).
		deploy(b.slug);
		expect(env(a.id, workerA.nodeId)).toEqual(before);
		deploy(c.slug);
		expect(env(c.id, workerA.nodeId).env.DATABASE_READ_URL).toBeDefined();
		expect(env(a.id, workerA.nodeId)).toEqual(before);
		// A replica coming changes nothing for A either.
		const replica = core.databaseReplicas.add(owner, 'up-db', { node: workerB.nodeId });
		streamReplica(db.id, replica.slot!);
		expect(env(a.id, workerA.nodeId)).toEqual(before);
		// A's own next deploy gives it the read URL.
		deploy(a.slug);
		expect(env(a.id, workerA.nodeId).env.DATABASE_READ_URL).toBeDefined();
	});
});

describe('attaching to a running copy renders its endpoint now (item 11)', () => {
	test('a container on another node gets its URL without a redeploy', async () => {
		const app = await project('late-attach', workerB.nodeId);
		deploy(app.slug);
		const db = core.databases.create(owner, { name: 'late-db', placement: data.nodeId });
		const { warning } = core.databases.attach(owner, core.projects.requireRow(owner, app.slug), { database: 'late-db', envPrefix: 'DATABASE' });
		expect(warning).toBeNull();
		const now = core.databases.consumerEnv(app.id, workerB.nodeId, 'container');
		expect(now.DATABASE_HOST).toBe(databaseAlias(db.id));
		expect(Number(now.DATABASE_PORT)).toBeGreaterThanOrEqual(21_000);
		const desired = await core.nodes.desiredState(workerB.token);
		expect(desired.serviceEndpoints.some((item) => item.serviceId === db.id)).toBe(true);
	});
});

describe('the install CA in the HA status (item 10)', () => {
	test('reports the active CA and the leaves without creating anything', () => {
		const status = core.nodeCa.status();
		expect(status.inUse).toBe(true);
		expect(status.authorities.map((ca) => ca.state)).toContain('active');
		expect(status.leaves.issued).toBeGreaterThanOrEqual(0);
	});

	test('only a platform operator reads it, and only a platform admin rotates it; the old CA stays trusted', () => {
		const member = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer', platformAdmin: false });
		expect(() => core.nodeCa.statusFor(member)).toThrow(/platform operators/);
		expect(() => core.nodeCa.rotateAs(member)).toThrow(/platform admin/);
		// An operator reads the CA but may not rotate it (review fix 2).
		expect(core.nodeCa.statusFor(operator).inUse).toBe(true);
		expect(() => core.nodeCa.rotateAs(operator)).toThrow(/platform admin/);
		expect(() => core.endpoints.migrationPlan(member)).toThrow(/platform operators/);
		expect(() => core.endpoints.attachmentsView(member)).toThrow(/platform operators/);
		const before = core.nodeCa.statusFor(owner).authorities.find((ca) => ca.state === 'active')!;
		const after = core.nodeCa.rotateAs(owner);
		expect(after.authorities.map((ca) => ca.state)).toEqual(['active', 'previous']);
		expect(after.authorities[1]!.fingerprint).toBe(before.fingerprint);
		expect(after.authorities[0]!.fingerprint).not.toBe(before.fingerprint);
		// Every leaf issued so far came from the old CA; none has renewed under the new one yet.
		expect(after.leaves.onPreviousCa).toBe(after.leaves.nodes);
		expect(opened.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM audit_log WHERE action = 'ha.ca.rotate'").get()!.n).toBe(1);
	});

	test('a second rotation is refused while a node still holds a leaf the previous CA signed (review fix 3)', () => {
		// worker-a enrols under the current CA, then the CA rotates once: worker-a is on the previous CA.
		const csrDir = mkdtempSync(join(tmpdir(), 'yoal-attach-csr-'));
		const result = Bun.spawnSync({
			cmd: ['openssl', 'req', '-new', '-nodes', '-subj', `/CN=${workerA.nodeId}`, '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
				'-addext', `subjectAltName=URI:yoal://node/${workerA.nodeId}`, '-keyout', join(csrDir, 'k.pem'), '-out', join(csrDir, 'r.csr')],
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(result.exitCode).toBe(0);
		core.nodeCa.signCsr(workerA.nodeId, { csrPem: readFileSync(join(csrDir, 'r.csr'), 'utf8'), reason: 'enrol' });
		rmSync(csrDir, { recursive: true, force: true });
		const once = core.nodeCa.rotateAs(owner);
		expect(once.leaves.onPreviousCa).toBe(1);
		const activeBefore = once.authorities[0]!.fingerprint;
		expect(() => core.nodeCa.rotateAs(owner)).toThrow(/still hold/);
		// Nothing changed: the same CA signs, the previous one is still trusted.
		const after = core.nodeCa.statusFor(owner);
		expect(after.authorities.map((ca) => ca.state)).toEqual(['active', 'previous']);
		expect(after.authorities[0]!.fingerprint).toBe(activeBefore);
	});
});
