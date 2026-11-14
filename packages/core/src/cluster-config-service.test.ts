import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-cluster-config-'));
const opened = createDb({ path: ':memory:' });
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
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('cluster configuration', () => {
	test('defaults are the documented values', () => {
		expect(core.cluster.get()).toMatchObject({
			overlay: { cidr: '10.47.0.0/22', listenPort: 51820 },
			endpoints: { portMin: 21000, portMax: 21999, requireMtls: true },
			replicas: { max: 20, spread: 'node' },
			database: { maxReplicas: 2, defaultMode: 'async' },
			storage: { maxTargets: 2 },
			controlPlane: { leaseTtlSeconds: 30, renewSeconds: 5 },
			failover: { enabled: false, graceSeconds: 120 },
			shares: { mountRoot: '/run/yoal-shares' },
		});
	});

	test('merges a section patch and persists it', () => {
		const updated = core.cluster.update(owner, {
			overlay: { cidr: '10.99.0.0/22', mtu: 1380 },
			replicas: { max: 6, spread: 'zone' },
		});
		expect(updated.overlay.cidr).toBe('10.99.0.0/22');
		expect(updated.overlay.mtu).toBe(1380);
		expect(updated.replicas.spread).toBe('zone');
		expect(core.cluster.get().overlay.cidr).toBe('10.99.0.0/22');
	});

	test('a patch changes only the keys it names, not their neighbours', () => {
		core.cluster.update(owner, { failover: { graceSeconds: 300, maxPerMinute: 2 } });
		const updated = core.cluster.update(owner, { failover: { enabled: true } });
		expect(updated.failover).toEqual({ enabled: true, graceSeconds: 300, maxPerMinute: 2 });
		core.cluster.update(owner, { failover: { enabled: false, graceSeconds: 120, maxPerMinute: 6 } });
		// A single bound is checked against the stored other bound.
		expect(() => core.cluster.update(owner, { endpoints: { portMax: 20000 } })).toThrow(/min < max/);
	});

	test('refuses an inverted endpoint range', () => {
		expect(() => core.cluster.update(owner, { endpoints: { portMin: 22000, portMax: 21000 } })).toThrow(/min < max/);
	});

	test('only a platform admin reads it, and only their own session changes it', () => {
		const member = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'deployer' });
		const orgOwner = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_1', role: 'owner' });
		const adminKey = buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true, keyId: 'key_1' });
		const adminMcp = buildPrincipal({ kind: 'mcp', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true, clientId: 'client_1' });
		const before = core.cluster.get();
		const audited = () => core.audit.list({ orgId: 'org_1' }).filter((entry) => entry.action === 'platform.cluster_config').length;
		const auditedBefore = audited();
		for (const principal of [member, orgOwner, adminKey, adminMcp])
			expect(() => core.cluster.update(principal, { replicas: { max: 2 } })).toThrow(/platform admin/);
		expect(core.cluster.get()).toEqual(before);
		expect(() => core.cluster.view(member)).toThrow(/platform admin/);
		expect(() => core.cluster.view(orgOwner)).toThrow(/platform admin/);
		expect(core.cluster.view(adminKey)).toEqual(before);
		expect(core.cluster.view(owner)).toEqual(before);
		// Refused changes are not audited as changes.
		expect(audited()).toBe(auditedBefore);
	});
});
