import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, desiredStateSchema, nodeCapabilities, type DesiredState, type Heartbeat } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { gateDesiredState } from './capability-gate.ts';
import { INGRESS_DRIFT_AFTER_MS } from './ingress-service.ts';

/**
 * The W6 exit (docs/build-plan/HA-WAVE-2.md): two ingress nodes render the same route payload for
 * every route type, the worker that gains the role gets listeners/TLS from desired state, the
 * secrets arrive through activation and drift is reported from `actualStateVersion`.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-ingress-set-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.now();
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

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
		features: { ...DEFAULT_FEATURES, INGRESS_SET: true },
		acmeEmail: 'ops@example.com',
		accessJwtSecret: 'ingress-jwt-secret-value',
		platformUpstream: 'unix//run/yoal/control.sock',
	},
});

const nodes: Record<string, { id: string; token: string }> = {};
for (const name of ['edge-a', 'edge-b', 'worker']) {
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
	nodes[name] = { id: joined.nodeId, token: joined.token };
	opened.sqlite.run('UPDATE nodes SET public_address = ? WHERE id = ?', [`${name}.test:8080`, joined.nodeId]);
}
// The second ingress: a worker that an operator gave the `ingress` role.
core.nodes.update(principal, nodes['edge-b']!.id, { roles: ['ingress', 'compute', 'data'] });

function beat(name: string, extra: Partial<Heartbeat> = {}): void {
	const { id, token } = nodes[name]!;
	core.nodes.heartbeat(token, {
		nodeId: id,
		agentVersion: '0.1.0',
		actualStateVersion: core.nodes.stateVersion(),
		status: 'online',
		caddyOk: true,
		capabilities: [...nodeCapabilities, 'ingress-set'],
		stats: { diskUsedBytes: 1, diskTotalBytes: 100_000_000_000, uptimeSeconds: 1, load1: 0, certs: [] },
		releases: [],
		...extra,
	});
}
for (const name of Object.keys(nodes)) beat(name);

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const project = (slug: string) => core.projects.requireRow(principal, slug);
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

async function deployStatic(slug: string, content: string, promote = true) {
	await core.projects.create(principal, { name: slug, slug, runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'public' });
	clock += 1_000;
	return core.uploads.deployInline(principal, project(slug), [file('index.html', `<h1>${content}</h1>`)], { promote });
}

async function states(): Promise<{ a: DesiredState; b: DesiredState }> {
	return {
		a: await core.nodes.desiredState(nodes['edge-a']!.token),
		b: await core.nodes.desiredState(nodes['edge-b']!.token),
	};
}

describe('W6 ingress payload', () => {
	test('the set is the compatibility first ingress plus every capable role member', async () => {
		expect(new Set(core.ingressSet.nodes())).toEqual(new Set([nodes['edge-a']!.id, nodes['edge-b']!.id]));
		expect(core.ingressSet.isIngress(nodes['worker']!.id)).toBe(false);
		expect(core.ingressSet.isIngress(nodes['edge-b']!.id)).toBe(true);
	});

	test('every ingress renders the same routes, releases, domains, storage and platform route', async () => {
		await deployStatic('site', 'Production');
		clock += 1_000;
		await core.uploads.deployInline(principal, project('site'), [file('index.html', '<h1>Preview</h1>')], { promote: false });
		clock += 1_000;
		const domain = await core.domains.create(principal, { project: 'site', hostname: 'site.example.com', redirectWww: false });
		opened.sqlite.run(`UPDATE domains SET status = 'verified', verified_at = ? WHERE id = ?`, [clock, domain.id]);
		clock += 1_000;
		core.storage.create(principal, { name: 'assets', buckets: ['public'], public: true });

		const { a, b } = await states();
		const hosts = (state: typeof a) => state.routes.map((route) => route.host).sort();
		expect(hosts(a)).toEqual(hosts(b));
		expect(hosts(a).length).toBeGreaterThan(0);

		// Static (production) and preview both serve from the release on either ingress.
		const production = a.routes.find((route) => route.production === true)!;
		const previewA = a.routes.find((route) => route.production !== true && route.projectId === production.projectId)!;
		const productionB = b.routes.find((route) => route.host === production.host)!;
		const previewB = b.routes.find((route) => route.host === previewA.host)!;
		expect(productionB.release).toBe(production.release);
		expect(previewB.release).toBe(previewA.release);
		expect(production.upstream).toBeNull();
		expect(productionB.upstream).toBeNull();
		expect(a.releases.map((release) => release.sha256).sort()).toEqual(b.releases.map((release) => release.sha256).sort());
		expect(a.releases.map((release) => release.sha256)).toContain(production.release);

		// Custom domain clones the production route on both.
		expect(a.domains).toEqual(b.domains);
		expect(a.domains.map((entry) => entry.host)).toContain('site.example.com');

		// S3/public storage routes: the same hosts on both; one serves its own gateway, the other
		// proxies to it, which is the same response.
		expect(a.storageRoutes.map((route) => route.host)).toEqual(b.storageRoutes.map((route) => route.host));
		expect(a.storageRoutes.length).toBeGreaterThan(0);

		// Placeholders (a project created and never deployed) reach both.
		await core.projects.create(principal, { name: 'draft', slug: 'draft', runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'public' });
		const withPlaceholder = await states();
		expect(withPlaceholder.a.placeholders).toEqual(withPlaceholder.b.placeholders);
		expect(withPlaceholder.a.placeholders.map((entry) => entry.host)).toContain('draft.sites.test');

		// The platform route is rendered on both; the first/control node dials the socket, the second
		// relays over HTTPS until W9 renders the control-node upstream list.
		expect(a.ingress?.platform?.host).toBe('control.test');
		expect(b.ingress?.platform?.host).toBe('control.test');
		expect(a.ingress?.platform?.upstream).toBe('unix//run/yoal/control.sock');
		expect(b.ingress?.platform?.upstream).toBe('https://edge-a.test');
	});

	test('an app placed on the first ingress is proxied identically by both', async () => {
		await core.projects.create(principal, { name: 'app', slug: 'app', runtime: 'process', placement: 'edge', productionAccess: 'public', previewAccess: 'public' });
		core.workloads.setSpec(principal, project('app'), {
			runtime: 'process',
			command: ['bun', 'run', 'start'],
			port: 3000,
			memoryMb: 256,
			cpus: 1,
			socketActivation: true,
			env: {},
			secrets: [],
		} as never);
		clock += 1_000;
		await core.uploads.deployInline(principal, project('app'), [file('index.js', 'console.log(1)')], { promote: true });
		const { a, b } = await states();
		const routeA = a.routes.find((route) => route.projectId === project('app').id && route.production === true);
		const routeB = b.routes.find((route) => route.projectId === project('app').id && route.production === true);
		expect(routeA).toBeDefined();
		expect(routeB).toBeDefined();
		// The first ingress serves its own copy; the second proxies to it. Both name the same copy.
		expect(routeB!.upstream).toBe('http://edge-a.test:8080');
		expect(routeA!.release).toBe(routeB!.release);
		expect(routeA!.access.siteKey).toBe(routeB!.access.siteKey);
	});

	test('a worker that gains the ingress role gets public listeners and TLS from desired state', async () => {
		const state = await core.nodes.desiredState(nodes['edge-b']!.token);
		expect(state.ingress).toEqual({
			drainSeconds: 20,
			proxyProtocol: 'off',
			trustedProxies: [],
			healthPort: null,
			certificateFingerprint: null,
			listeners: [':443'],
			tls: { email: 'ops@example.com' },
			platform: { host: 'control.test', upstream: 'https://edge-a.test' },
		});
		// A node outside the set gets no payload at all.
		expect((await core.nodes.desiredState(nodes['worker']!.token)).ingress).toBeUndefined();
		// The same payload never carries a secret.
		const text = JSON.stringify(state);
		expect(text).not.toContain('ingress-jwt-secret-value');
		expect(text).not.toContain('site-cookie-secret-123');
	});

	test('shared secrets arrive through the node-authenticated activation only', async () => {
		const activation = core.ingressSet.activation(nodes['edge-b']!.id);
		expect(activation).toEqual({
			accessJwtSecret: 'ingress-jwt-secret-value',
			siteCookieSecret: 'site-cookie-secret-123',
			cloudflareApiToken: null,
		});
		expect(() => core.ingressSet.activation(nodes['worker']!.id)).toThrow(/not in the ingress set/);
	});

	test('setEdge still works with the set on', async () => {
		const view = core.nodes.setEdge(principal, nodes['edge-b']!.id);
		expect(view.mode).toBe('edge');
		expect(core.ingressSet.isIngress(nodes['edge-b']!.id)).toBe(true);
		// setEdge keeps its D98 meaning: the old edge is demoted, and with no operator-set `ingress`
		// role it leaves the set. The new edge serves the full payload immediately.
		expect(core.ingressSet.isIngress(nodes['edge-a']!.id)).toBe(false);
		const state = await core.nodes.desiredState(nodes['edge-b']!.token);
		expect(state.routes.length).toBeGreaterThan(0);
		// Put the fixture back so the drift test measures the same node.
		core.nodes.setEdge(principal, nodes['edge-a']!.id);
		expect(core.ingressSet.isIngress(nodes['edge-a']!.id)).toBe(true);
	});

	test('drift is reported from actualStateVersion after the window', () => {		const desired = core.nodes.stateVersion();
		beat('edge-a', { actualStateVersion: desired - 1 });
		clock += 1_000;
		expect(core.ingressSet.drifted(nodes['edge-a']!.id)).toBe(false);
		clock += INGRESS_DRIFT_AFTER_MS;
		expect(core.ingressSet.drifted(nodes['edge-a']!.id)).toBe(true);
		const report = core.ingressSet.drift().find((entry) => entry.nodeId === nodes['edge-a']!.id)!;
		expect(report).toMatchObject({ desiredStateVersion: desired, actualStateVersion: desired - 1, drifted: true });
		expect(core.ingressSet.view().nodes.find((node) => node.id === nodes['edge-a']!.id)?.drifted).toBe(true);

		beat('edge-a');
		expect(core.ingressSet.drifted(nodes['edge-a']!.id)).toBe(false);
	});
});

describe('ingress capability gate', () => {

	test('the payload reaches only a capable agent while the flag is on', () => {
		const state = desiredStateSchema.parse({
			version: 1,
			nodeId: 'nod_1',
			agentVersion: '0.1.0',
			generatedAt: '2026-11-20T00:00:00.000Z',
			contentDomain: 'sites.test',
			releases: [],
			routes: [],
			ingress: { listeners: [':443'], tls: { email: 'ops@example.com' }, platform: null },
		});
		expect(gateDesiredState(state, ['ingress-set'], { ENDPOINTS_GATEWAY: false, RELEASE_PHASE: false, INGRESS_SET: true })).toHaveProperty('ingress');
		expect(gateDesiredState(state, [], { ENDPOINTS_GATEWAY: false, RELEASE_PHASE: false, INGRESS_SET: true })).not.toHaveProperty('ingress');
		expect(gateDesiredState(state, ['ingress-set'], { ENDPOINTS_GATEWAY: false, RELEASE_PHASE: false, INGRESS_SET: false })).not.toHaveProperty('ingress');
	});
});
