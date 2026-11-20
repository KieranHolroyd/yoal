import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, RELEASE_PHASE_SPEC_FIELDS, type FeatureFlags } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/** HA-PLAN H25: `set_workload` neither advertises nor stores release-phase fields while the flag is off. */

const dir = mkdtempSync(join(tmpdir(), 'yoal-w1-mcp-release-'));
const opened = createDb({ path: ':memory:' });
const features: Record<keyof FeatureFlags, boolean> = { ...DEFAULT_FEATURES };
const realCore: Core = createCore({
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
		features
	}
});

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { yoalToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

function advertised(): string[] {
	const tool = yoalToolDefinitions(owner).find((entry) => entry.name === 'set_workload');
	if (!tool) throw new Error('no set_workload');
	const schema = tool.config.inputSchema as unknown as { shape: Record<string, unknown> };
	return Object.keys(schema.shape);
}

async function setWorkload(args: Record<string, unknown>) {
	const tool = assistantTools(owner).find((entry) => entry.name === 'set_workload');
	if (!tool) throw new Error('no set_workload');
	return tool.run(args);
}

describe('set_workload and RELEASE_PHASE', () => {
	test('flag off: the fields are not advertised, and sending one is refused with the flag message', async () => {
		const node = realCore.nodes.join({ token: realCore.nodes.createJoinToken(owner, 'n1').token, name: 'n1' });
		await realCore.projects.create(owner, { name: 'shop', slug: 'shop', runtime: 'process', placement: node.nodeId, productionAccess: 'public', previewAccess: 'platform' });
		const keys = advertised();
		expect(keys).toContain('project');
		expect(keys).toContain('healthPath');
		for (const field of RELEASE_PHASE_SPEC_FIELDS) expect(keys).not.toContain(field);
		const result = await setWorkload({ project: 'shop', runtime: 'process', command: ['bun', 'run', 'start'], drainSeconds: 20 });
		expect(result.ok).toBe(false);
		expect(result.text).toContain('drainSeconds needs the release phase, which is not enabled on this platform (YOAL_FEATURE_RELEASE_PHASE).');
		expect(realCore.workloads.projectSpec(realCore.projects.requireRow(owner, 'shop'))?.drainSeconds).toBeUndefined();
	});

	test('flag on: advertised and stored', async () => {
		features.RELEASE_PHASE = true;
		for (const field of RELEASE_PHASE_SPEC_FIELDS) expect(advertised()).toContain(field);
		const result = await setWorkload({ project: 'shop', runtime: 'process', command: ['bun', 'run', 'start'], drainSeconds: 20 });
		expect(result.ok).toBe(true);
		expect(realCore.workloads.projectSpec(realCore.projects.requireRow(owner, 'shop'))?.drainSeconds).toBe(20);
		features.RELEASE_PHASE = false;
	});
});
