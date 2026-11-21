import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, type SteeringDriver } from '@yoal/contracts';
import { buildPrincipal } from '../orgs.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { SteeringService } from '../ingress-service.ts';
import type { CoreConfig } from '../config.ts';
import { verifyWebhookSignature } from '../webhook-signature.ts';
import { setVipSettings } from './vip/core.ts';
import { setWebhookSettings } from './webhook/core.ts';

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-11-20T12:00:00Z');
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

function harness(features: Partial<typeof DEFAULT_FEATURES> = {}, overrides: Partial<CoreConfig> = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-steering-'));
	dirs.push(dir);
	const opened = createDb({ path: ':memory:' });
	const clock = { now: T0 };
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
			now: () => clock.now,
			features: { ...DEFAULT_FEATURES, ...features },
			...overrides,
		},
	});
	const nodes: Record<string, { id: string; token: string }> = {};
	const addNode = (name: string) => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
		nodes[name] = { id: joined.nodeId, token: joined.token };
		return nodes[name]!;
	};
	const beat = (name: string, capabilities: string[] = ['ingress-set']) => {
		const node = nodes[name]!;
		core.nodes.heartbeat(node.token, {
			nodeId: node.id,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			capabilities,
		});
	};
	return { core, clock, nodes, addNode, beat };
}

describe('steering selection and the STEERING flag (H18)', () => {
	test('defaults to direct, and the setting is inert while the flag is off', async () => {
		const h = harness();
		h.addNode('edge');
		h.beat('edge');
		expect(h.core.cluster.get().steering).toEqual({ driver: 'direct', stacked: [] });
		expect(h.core.steering.selection()).toEqual({ kind: 'direct', stacked: [] });

		h.core.cluster.update(principal, { steering: { driver: 'external-lb' } });
		expect(h.core.steering.selection()).toEqual({ kind: 'direct', stacked: [] });
		expect(h.core.steering.active()).toBe(false);
		expect((await h.core.steering.reconcile()).kind).toBe('direct');
		expect((await h.core.failover.tick()).steering).toMatchObject({ kind: 'direct', active: false });
		// The stored choice is kept for when the flag is turned on, not silently discarded.
		expect(h.core.cluster.get().steering.driver).toBe('external-lb');
	});

	test('the legacy policy rotation still runs with the flag off (dns-failover by hand)', async () => {
		const h = harness();
		h.addNode('edge');
		const worker = h.addNode('worker');
		h.beat('edge');
		h.beat('worker');
		h.core.cluster.update(principal, { steering: { driver: 'external-lb' } });
		h.core.policies.update(principal, { ingressDriver: 'dns-failover' });
		h.core.ctx.sqlite.run(`UPDATE nodes SET roles_json = '["ingress","compute"]' WHERE id = ?`, [worker.id]);
		await h.core.failover.tick();
		h.clock.now += 31_000;
		h.beat('edge');
		await h.core.failover.tick();
		h.clock.now += 120_000;
		h.beat('edge');
		const report = await h.core.failover.tick();
		expect(report.ingress.withdrawn).toEqual([worker.id]);
		expect(report.steering).toMatchObject({ kind: 'direct', active: false });
		expect(h.core.failover.status(principal).ingress).toMatchObject({ driver: 'dns-failover', rotates: true });
	});

	test('with the flag on, external-lb is selected, acts read-only and replaces the legacy rotation', async () => {
		const h = harness({ STEERING: true, INGRESS_SET: true });
		h.addNode('edge');
		const worker = h.addNode('worker');
		h.beat('edge');
		h.beat('worker');
		h.core.ctx.sqlite.run(`UPDATE nodes SET roles_json = '["ingress","compute"]' WHERE id = ?`, [worker.id]);
		h.core.cluster.update(principal, {
			steering: { driver: 'external-lb', stacked: ['dns-failover'] },
			ingress: { proxyProtocol: 'v2', trustedProxies: ['10.0.0.10/32'] },
		});
		h.core.policies.update(principal, { ingressDriver: 'dns-failover' });

		expect(h.core.steering.selection()).toEqual({ kind: 'external-lb', stacked: ['dns-failover'] });
		expect(h.core.steering.active()).toBe(true);
		expect(h.core.ingressSet.view().steering).toEqual({ kind: 'external-lb', stacked: ['dns-failover'] });
		expect(h.core.steering.driver('external-lb').capabilities).toEqual({
			probes: 'external',
			writes: false,
			preservesClientIp: 'proxy-protocol',
		});
		expect(h.core.steering.preflight()).toEqual({ kind: 'external-lb', findings: [] });

		const first = (await h.core.failover.tick()).steering;
		expect(first).toMatchObject({ kind: 'external-lb', active: true, applied: true, refused: 0, error: null });
		expect(h.core.failover.status(principal).ingress).toMatchObject({
			driver: 'external-lb',
			steers: false,
			rotates: false,
		});

		// The worker goes silent: external-lb never removes a node itself, and the legacy controller
		// that would have raised a manual DNS event is not running.
		h.clock.now += 300_000;
		h.beat('edge');
		await h.core.failover.tick();
		await h.core.failover.tick();
		const events = h.core.ctx.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM failover_events WHERE kind = 'ingress'").get();
		expect(events!.n).toBe(0);
	});

	test('preflight names the nodes and the client-address setting it refuses', async () => {
		const h = harness({ STEERING: true });
		const edge = h.addNode('edge');
		// No heartbeat yet: not capable and never seen.
		h.core.cluster.update(principal, { steering: { driver: 'external-lb' } });
		let findings = h.core.steering.preflight().findings;
		expect(findings.map((finding) => finding.nodeId)).toEqual([edge.id]);
		expect(findings[0]!.reason).toContain('does not advertise ingress-set');

		h.beat('edge');
		expect(h.core.steering.preflight().findings).toEqual([]);
		h.core.cluster.update(principal, { ingress: { proxyProtocol: 'v1' } });
		findings = h.core.steering.preflight().findings;
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ nodeId: null });
		expect(findings[0]!.reason).toContain('trustedProxies is empty');
	});

	test('a driver that writes provider state only runs while the controller lease is held', async () => {
		const h = harness({ STEERING: true });
		h.addNode('edge');
		h.beat('edge');
		h.core.cluster.update(principal, { steering: { driver: 'external-lb' } });
		let desired = 0;
		let observed = 0;
		const fake: SteeringDriver = {
			kind: 'external-lb',
			capabilities: { probes: 'external', writes: true, preservesClientIp: 'native' },
			preflight: () => [],
			desired: async () => {
				desired += 1;
			},
			observe: async () => {
				observed += 1;
				return { kind: 'external-lb' };
			},
		};
		const service = new SteeringService(h.core.ctx, { 'external-lb': () => fake });

		expect(await service.reconcile(null)).toMatchObject({ waitingForLease: true, applied: false });
		expect(await service.reconcile({ epoch: 1, holds: () => false })).toMatchObject({ waitingForLease: true });
		expect(desired).toBe(0);
		expect(observed).toBe(2); // observe is read-only, so status still works while waiting
		expect(await service.reconcile({ epoch: 1, holds: () => true })).toMatchObject({ waitingForLease: false, applied: true });
		expect(desired).toBe(1);
	});

	test('a selected driver this build has not built is a reason, not a crash', async () => {
		const h = harness({ STEERING: true });
		h.addNode('edge');
		h.beat('edge');
		h.core.cluster.update(principal, { steering: { driver: 'cloud-lb' } });
		expect(h.core.steering.preflight().findings[0]).toMatchObject({ nodeId: null });
		expect(h.core.steering.preflight().findings[0]!.reason).toContain('not implemented');
		expect(await h.core.steering.reconcile()).toMatchObject({ kind: 'cloud-lb', active: true, error: expect.stringContaining('not implemented') });
		// The controller tick records the reason instead of throwing.
		expect((await h.core.failover.tick()).steering.error).toContain('not implemented');
	});
});

describe('steering settings validation (H18)', () => {
	test('merges and persists the steering section', () => {
		const h = harness();
		const updated = h.core.cluster.update(principal, {
			steering: { driver: 'external-lb', stacked: ['dns-failover'] },
		});
		expect(updated.steering).toEqual({ driver: 'external-lb', stacked: ['dns-failover'] });
		expect(h.core.cluster.get().steering).toEqual({ driver: 'external-lb', stacked: ['dns-failover'] });
		// A patch that names one key does not reset the other.
		expect(h.core.cluster.update(principal, { steering: { stacked: [] } }).steering).toEqual({
			driver: 'external-lb',
			stacked: [],
		});
	});

	test('refuses direct and duplicate stacks, and stacking the primary driver', () => {
		const h = harness();
		expect(() => h.core.cluster.update(principal, { steering: { stacked: ['direct'] } })).toThrow(/direct cannot be stacked/);
		expect(() => h.core.cluster.update(principal, { steering: { stacked: ['vip', 'vip'] } })).toThrow(/only once/);
		expect(() => h.core.cluster.update(principal, { steering: { driver: 'external-lb', stacked: ['external-lb'] } })).toThrow(
			/cannot also be stacked/,
		);
		expect(() => h.core.cluster.update(principal, { steering: { driver: 'not-a-driver' as never } })).toThrow();
	});
});

describe('vip and webhook through the controller lease (W8 lane E)', () => {
	class RecordingVipControl {
		readonly states = new Map<string, unknown>();
		readonly started = new Set<string>();
		writes = 0;
		available(): boolean {
			return true;
		}
		async configure(nodeId: string, state: unknown) {
			this.writes += 1;
			this.states.set(nodeId, state);
			return { changed: true };
		}
		async start(nodeId: string) {
			this.writes += 1;
			this.started.add(nodeId);
		}
		async stop() {
			this.writes += 1;
		}
		async status() {
			return { running: true, interface: 'eth0', virtualAddress: '192.0.2.100', addressPresent: true };
		}
	}

	test('vip writes the floating address through the helper control and keeps the secret out of observe', async () => {
		const control = new RecordingVipControl();
		const h = harness({ STEERING: true, INGRESS_SET: true }, { vipControl: control });
		const node = h.addNode('edge');
		const second = h.addNode('edge-b');
		h.beat('edge');
		h.beat('edge-b');
		h.core.ctx.sqlite.run(`UPDATE nodes SET roles_json = '["ingress","compute"]', public_address = ? WHERE id = ?`, ['10.0.0.21', node.id]);
		h.core.ctx.sqlite.run(`UPDATE nodes SET roles_json = '["ingress","compute"]', public_address = ? WHERE id = ?`, ['10.0.0.22', second.id]);
		h.core.cluster.update(principal, { steering: { driver: 'vip' } });
		setVipSettings(h.core.ctx, {
			address: '192.0.2.100',
			interface: 'eth0',
			routerId: 51,
			authPass: 'vrrppass',
			sockets: {},
		});
		expect(h.core.steering.preflight().findings).toEqual([]);
		const tick = await h.core.steering.reconcile({ epoch: 1, holds: () => true });
		expect(tick).toMatchObject({ kind: 'vip', active: true, applied: true, writes: true });
		expect(control.writes).toBeGreaterThan(0);
		expect(JSON.stringify(control.states.get(node.id))).toContain('192.0.2.100');
		expect(JSON.stringify(await h.core.steering.driver('vip').observe())).not.toContain('vrrppass');
	});

	test('webhook posts a signed set and never stores the secret in plaintext', async () => {
		const calls: Array<{ headers: Record<string, string>; body: string }> = [];
		const fetchImpl = (async (_input: string, init?: RequestInit) => {
			calls.push({ headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()), body: String(init?.body ?? '') });
			return Response.json({ accepted: true });
		}) as unknown as typeof fetch;
		const h = harness({ STEERING: true, INGRESS_SET: true }, { webhookFetch: fetchImpl });
		h.addNode('edge');
		h.beat('edge');
		h.core.cluster.update(principal, { steering: { driver: 'webhook' } });
		const stored = setWebhookSettings(h.core.ctx, {
			url: 'https://ops.example.com/yoal',
			secret: 'sealed-webhook-secret',
			allowHosts: ['ops.example.com'],
		});
		const row = h.core.ctx.sqlite
			.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
			.get('ha:steering_webhook')!;
		expect(row.value).not.toContain('sealed-webhook-secret');
		expect(stored.secretSealed.length).toBeGreaterThan(10);
		expect(h.core.steering.preflight().findings).toEqual([]);
		const tick = await h.core.steering.reconcile({ epoch: 1, holds: () => true });
		expect(tick).toMatchObject({ kind: 'webhook', active: true, applied: true, writes: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.body).not.toContain('sealed-webhook-secret');
		expect(verifyWebhookSignature('sealed-webhook-secret', calls[0]!.body, calls[0]!.headers['x-yoal-signature'], { nowMs: T0 })).toBe(true);
	});

	test('with the flag off neither driver is selected or writes', async () => {
		const calls: unknown[] = [];
		const h = harness({}, { webhookFetch: (async () => { calls.push(1); return Response.json({ accepted: true }); }) as unknown as typeof fetch });
		h.addNode('edge');
		h.beat('edge');
		h.core.cluster.update(principal, { steering: { driver: 'webhook' } });
		setWebhookSettings(h.core.ctx, { url: 'https://ops.example.com/yoal', secret: 'x', allowHosts: ['ops.example.com'] });
		expect(h.core.steering.selection().kind).toBe('direct');
		expect((await h.core.steering.reconcile({ epoch: 1, holds: () => true })).kind).toBe('direct');
		expect(calls).toHaveLength(0);
	});
});
