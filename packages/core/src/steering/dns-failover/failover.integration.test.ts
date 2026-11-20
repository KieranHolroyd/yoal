import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import type { DnsProvider, DnsRecord, DnsRecordInput } from '../dns/provider.ts';
import type { DnsFailoverNode, ProbeObservation } from './health.ts';
import type { IngressProber } from './probe.ts';
import { buildPrincipal } from '../../orgs.ts';
import { createCore, type Core } from '../../index.ts';
import type { FailoverTickReport } from '../../failover-service.ts';
import { LocalObjectStore } from '../../object-store.ts';

/**
 * `dns-failover` through the real failover controller (HA-PLAN H18, Wave 2 lane E).
 *
 * This is the integration point lane D shares: the driver is registered behind
 * `SteeringService.driver(kind)`, the controller calls it only while it holds the lease, and the
 * writes land in `failover_events`. The provider and prober are fakes; no token and no zone.
 */

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-11-20T12:00:00Z');
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

class FakeCloudflare implements DnsProvider {
	readonly kind = 'cloudflare';
	readonly records: Array<DnsRecord & { name: string }> = [];
	writes = 0;
	#seq = 0;
	async listRecords(name: string): Promise<DnsRecord[]> {
		return this.records.filter((record) => record.name === name);
	}
	async createRecord(input: DnsRecordInput): Promise<DnsRecord> {
		const record = { id: `r${++this.#seq}`, ...input, ttl: input.proxied ? 1 : input.ttl };
		this.records.push(record);
		this.writes += 1;
		return record;
	}
	async updateRecord(id: string, input: DnsRecordInput): Promise<DnsRecord> {
		const record = this.records.find((candidate) => candidate.id === id)!;
		Object.assign(record, input);
		this.writes += 1;
		return record;
	}
	async deleteRecord(id: string): Promise<void> {
		const index = this.records.findIndex((candidate) => candidate.id === id);
		if (index >= 0) this.records.splice(index, 1);
		this.writes += 1;
	}
	contents(name: string): string[] {
		return this.records.filter((record) => record.name === name).map((record) => record.content).sort();
	}
}

class ControlledProber implements IngressProber {
	readonly failing = new Set<string>();
	readonly corroborated = new Set<string>();
	async probe(nodes: readonly DnsFailoverNode[], at: number): Promise<ProbeObservation[]> {
		const primary = nodes.map(
			(node): ProbeObservation => ({
				nodeId: node.id,
				observerId: `control-plane:${hostname()}`,
				observerZone: 'control',
				ok: !this.failing.has(node.id),
				at,
				reason: this.failing.has(node.id) ? 'timeout' : 'ok',
			}),
		);
		const second = [...this.corroborated].map(
			(nodeId): ProbeObservation => ({ nodeId, observerId: 'edge-observer', observerZone: 'z2', ok: false, at, reason: 'timeout' }),
		);
		return [...primary, ...second];
	}
}

interface Harness {
	core: Core;
	provider: FakeCloudflare;
	prober: ControlledProber;
	clock: { now: number };
	node: Record<'a' | 'b', string>;
	tick(...silent: string[]): Promise<FailoverTickReport>;
}

function harness(steering: boolean): Harness {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-dns-failover-'));
	dirs.push(dir);
	const opened = createDb({ path: ':memory:' });
	const clock = { now: T0 };
	const provider = new FakeCloudflare();
	const prober = new ControlledProber();
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
			dnsProvider: provider,
			ingressProber: prober,
			features: { ...DEFAULT_FEATURES, STEERING: steering, INGRESS_SET: steering },
		},
	});
	const node: Record<string, string> = {};
	for (const name of ['a', 'b']) {
		core.nodes.join({ token: core.nodes.createJoinToken(principal, name).token, name });
		node[name] = opened.sqlite.query<{ id: string }, [string]>('SELECT id FROM nodes WHERE name = ?').get(name)!.id;
		opened.sqlite.run(
			`UPDATE nodes SET roles_json = '["ingress","compute"]', capabilities_json = '["ingress-set"]',
			 status = 'online', last_heartbeat_at = ?, zone = ?, public_address = ? WHERE id = ?`,
			[clock.now, name === 'a' ? 'z1' : 'z2', name === 'a' ? '192.0.2.10' : '192.0.2.11', node[name]!],
		);
	}
	core.policies.update(principal, { ingressDriver: 'dns-failover' });
	const h: Harness = {
		core,
		provider,
		prober,
		clock,
		node: node as Harness['node'],
		async tick(...silent) {
			for (const [name, id] of Object.entries(node))
				if (!silent.includes(name))
					opened.sqlite.run("UPDATE nodes SET status = 'online', last_heartbeat_at = ? WHERE id = ?", [clock.now, id]);
			return core.failover.tick();
		},
	};
	return h;
}

function events(h: Harness): Array<{ kind: string; status: string; stage: string; subject_id: string; epoch: number; reason: string }> {
	return h.core.ctx.sqlite
		.query<{ kind: string; status: string; stage: string; subject_id: string; epoch: number; reason: string }, []>(
			"SELECT kind, status, stage, subject_id, epoch, reason FROM failover_events WHERE kind = 'ingress' ORDER BY rowid",
		)
		.all();
}

describe('dns-failover under the controller lease', () => {
	test('writes the records, records each write, and withdraws after the hold-down', async () => {
		const h = harness(true);
		const first = await h.tick();
		expect(first.lease).toBe('holder');
		// Apex, wildcard and platform host, one A record per ingress.
		expect(h.provider.contents('sites.test')).toEqual(['192.0.2.10', '192.0.2.11']);
		expect(h.provider.contents('*.sites.test')).toEqual(['192.0.2.10', '192.0.2.11']);
		expect(h.provider.contents('control.test')).toEqual(['192.0.2.10', '192.0.2.11']);
		expect(h.provider.writes).toBe(6);
		const writes = events(h);
		expect(writes).toHaveLength(6);
		expect(writes.every((event) => event.status === 'completed' && event.stage === 'repoint' && event.epoch === first.epoch)).toBe(true);

		h.prober.failing.add(h.node.b);
		h.prober.corroborated.add(h.node.b);
		h.clock.now += 20_000;
		await h.tick();
		h.clock.now += 46_000;
		const removed = await h.tick();
		expect(removed.ingress.withdrawn).toEqual([h.node.b]);
		expect(h.provider.contents('sites.test')).toEqual(['192.0.2.10']);
		expect(h.provider.contents('*.sites.test')).toEqual(['192.0.2.10']);
		const removal = events(h).filter((event) => event.subject_id === h.node.b && event.reason.startsWith('Removed'));
		expect(removal).toHaveLength(3);
		expect(removal.every((event) => event.status === 'completed')).toBe(true);

		// The old heartbeat-only path would have written a `manual` event; the DNS driver does not.
		expect(events(h).some((event) => event.status === 'manual')).toBe(false);
		const view = h.core.failover.status(principal).ingress.nodes.find((node) => node.id === h.node.b)!;
		expect(view.inRotation).toBe(false);
	});

	test('the last healthy record is never removed', async () => {
		const h = harness(true);
		await h.tick();
		h.prober.failing.add(h.node.b);
		h.prober.corroborated.add(h.node.b);
		h.clock.now += 20_000;
		await h.tick();
		h.clock.now += 46_000;
		await h.tick();
		expect(h.provider.contents('sites.test')).toEqual(['192.0.2.10']);

		h.prober.failing.add(h.node.a);
		h.prober.corroborated.add(h.node.a);
		h.clock.now += 20_000;
		await h.tick();
		h.clock.now += 46_000;
		const refused = await h.tick();
		expect(refused.ingress.withdrawn).toEqual([]);
		expect(h.provider.contents('sites.test')).toEqual(['192.0.2.10']);
		expect(h.provider.contents('*.sites.test')).toEqual(['192.0.2.10']);
	});

	test("with STEERING off the driver writes nothing and today's manual event remains", async () => {
		const h = harness(false);
		await h.tick();
		expect(h.provider.writes).toBe(0);
		expect(h.provider.records).toEqual([]);
		h.clock.now += 31_000;
		await h.tick('b');
		h.clock.now += 90_000;
		const report = await h.tick('b');
		expect(report.ingress.withdrawn).toEqual([]);
		h.clock.now += 30_000;
		const withdrawn = await h.tick('b');
		expect(withdrawn.ingress.withdrawn).toEqual([h.node.b]);
		const manual = events(h);
		expect(manual).toHaveLength(1);
		expect(manual[0]).toMatchObject({ status: 'manual', subject_id: h.node.b });
	});
});
