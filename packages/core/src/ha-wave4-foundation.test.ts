import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, externalProberReportSchema, sloObjectInputSchema } from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

/**
 * Wave 4 foundation: the policy reads are honest, and every lane-owned write fails loudly instead
 * of pretending it was recorded (docs/build-plan/HA-WAVE-4.md).
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-w4-foundation-'));
const opened = createDb({ path: ':memory:' });
const clock = Date.parse('2026-11-21T10:00:00Z');
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
		features: { ...DEFAULT_FEATURES, SLO_OBJECTS: true, EXTERNAL_PROBER: true },
	},
});
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

const node = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'data').token, name: 'data' });
opened.sqlite.run('UPDATE nodes SET capabilities_json = ? WHERE id = ?', ['["db-member"]', node.nodeId]);
core.databases.create(principal, { name: 'main', placement: node.nodeId });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('database failover policy', () => {
	test('defaults to manual and explains every refusal without pretending auto is recorded', () => {
		const view = core.failoverPolicies.view(principal, 'main');
		expect(view.failoverMode).toBe('manual');
		expect(view.acceptDataLoss).toBe(false);
		expect(view.autoArmedAt).toBeNull();
		expect(view.lastDrill).toBeNull();
		expect(view.armedEvidence).toBeNull();
		expect(view.active).toBe(false);
		const codes = view.refusals.map((refusal) => refusal.code);
		expect(codes).toContain('auto-promote-off');
		expect(codes).toContain('data-loss-not-accepted');
		expect(codes).toContain('too-few-data-nodes');
		expect(codes).toContain('no-cross-node-replica');
		expect(codes).toContain('no-drill');
		expect(core.failoverPolicies.refusals(principal, 'main').map((refusal) => refusal.code)).toEqual(codes);
	});

	test('arming, disarming and drilling fail loudly until lane A implements them', async () => {
		// DB_AUTO_PROMOTE is off, so arming is refused at the first gate.
		await expect(core.failoverPolicies.arm(principal, 'main', { confirm: true, acceptDataLoss: false })).rejects.toMatchObject({
			code: 'unavailable',
		});
		await expect(core.failoverPolicies.disarm(principal, 'main')).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('not implemented'),
		});
		await expect(core.failoverPolicies.drill(principal, 'main', { confirm: true })).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('not implemented'),
		});
	});
});

describe('W15 foundation', () => {
	test('SLO list is empty and its writes fail loudly until lane B implements them', async () => {
		await core.projects.create(principal, {
			name: 'App',
			slug: 'app',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		expect(core.slos.list(principal, 'app')).toEqual([]);
		await expect(
			core.slos.upsert(
				principal,
				'app',
				sloObjectInputSchema.parse({ name: 'availability', indicator: 'http_availability', target: 0.999, windowSeconds: 86_400 }),
			),
		).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('not implemented') });
		await expect(core.slos.evaluate(principal, 'app')).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('not implemented'),
		});
	});

	test('the external prober sink refuses reports it cannot store', async () => {
		expect(core.externalProber.enabled()).toBe(true);
		const report = externalProberReportSchema.parse({
			proberId: 'prb_1',
			sequence: 1,
			sentAt: new Date(clock).toISOString(),
			installId: null,
			targets: [{ target: 'https://app.test/healthz', kind: 'https', status: 'up', checkedAt: new Date(clock).toISOString() }],
		});
		await expect(core.externalProber.report(report)).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('not implemented'),
		});
	});
});
