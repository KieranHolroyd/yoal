import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, RELEASE_PHASE_SPEC_FIELDS, type FeatureFlags } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

/**
 * HA-PLAN H25: with `RELEASE_PHASE` off, no write path may store a release-phase field. Every path
 * ends in `WorkloadService.setSpec` (REST, dashboard, MCP, blueprints, config import, GitHub
 * import, templates, image deploys, pipelines) or `plan()` (deploys).
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-w1-release-writes-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeCore(features: Partial<FeatureFlags>): { core: Core; close: () => void } {
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
			features: { ...DEFAULT_FEATURES, ...features },
		},
	});
	return { core, close: () => opened.sqlite.close() };
}

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const base = { runtime: 'process' as const, command: ['bun', 'run', 'start'], port: 3000, replicas: 2 };
const fields = {
	release: { command: ['bin/migrate'] },
	readinessPath: '/ready',
	drainSeconds: 15,
	stopTimeoutSeconds: 45,
	rollout: { canary: 1, soakSeconds: 60 },
	placement: { spread: 'zone' },
} as const;

async function project(core: Core, slug: string) {
	const node = core.nodes.join({ token: core.nodes.createJoinToken(principal, `n-${slug}`).token, name: `n-${slug}` });
	await core.projects.create(principal, { name: slug, slug, runtime: 'process', placement: node.nodeId, productionAccess: 'public', previewAccess: 'platform' });
	return core.projects.requireRow(principal, slug);
}

describe('RELEASE_PHASE off: every write is refused', () => {
	test('setSpec (REST, dashboard, MCP, templates, GitHub import) refuses each field and stores nothing', async () => {
		const { core, close } = makeCore({});
		const row = await project(core, 'app-a');
		for (const field of RELEASE_PHASE_SPEC_FIELDS) {
			expect(() => core.workloads.setSpec(principal, row, { ...base, [field]: fields[field] } as never)).toThrow(
				`${field} needs the release phase, which is not enabled on this platform (YOAL_FEATURE_RELEASE_PHASE).`,
			);
			expect(core.workloads.projectSpec(core.projects.requireRow(principal, 'app-a'))?.[field]).toBeUndefined();
		}
		close();
	});

	test('plan() refuses a deploy input that sets a field', async () => {
		const { core, close } = makeCore({});
		const row = await project(core, 'app-b');
		core.workloads.setSpec(principal, row, base);
		for (const field of RELEASE_PHASE_SPEC_FIELDS)
			expect(() => core.workloads.plan(principal, core.projects.requireRow(principal, 'app-b'), { [field]: fields[field] } as never)).toThrow(
				'YOAL_FEATURE_RELEASE_PHASE',
			);
		close();
	});

	test('setVariables keeps refusing through setSpec', async () => {
		const { core, close } = makeCore({});
		const row = await project(core, 'app-c');
		core.workloads.setSpec(principal, row, base);
		// A variables save rewrites the stored spec; with nothing release-phase in it, it passes.
		await core.workloads.setVariables(principal, core.projects.requireRow(principal, 'app-c'), { env: { A: '1' }, secrets: [], newSecrets: [] });
		expect(core.workloads.projectSpec(core.projects.requireRow(principal, 'app-c'))?.env).toEqual({ A: '1' });
		close();
	});

	test('config import refuses a workload exported from an install with the flag on', async () => {
		const on = makeCore({ RELEASE_PHASE: true });
		const row = await project(on.core, 'app-d');
		on.core.workloads.setSpec(principal, row, { ...base, release: { command: ['bin/migrate'] } });
		expect(on.core.workloads.projectSpec(on.core.projects.requireRow(principal, 'app-d'))?.release).toEqual({
			command: ['bin/migrate'],
			timeoutSeconds: 600,
		});
		on.close();
		// The import path calls setSpec with the exported spec as is (config-import/stack.ts).
		const off = makeCore({});
		const target = await project(off.core, 'app-d');
		expect(() => off.core.workloads.setSpec(principal, target, { ...base, release: { command: ['bin/migrate'], timeoutSeconds: 600 } })).toThrow(
			'YOAL_FEATURE_RELEASE_PHASE',
		);
		off.close();
	});

	test('a value stored while the flag was on survives an unrelated save after it is turned off', async () => {
		// Turning a flag off must be reversible: image deploys and pipelines re-send the stored spec.
		const { core, close } = makeCore({ RELEASE_PHASE: true });
		const row = await project(core, 'app-e');
		core.workloads.setSpec(principal, row, { ...base, drainSeconds: 20 });
		(core.ctx.config.features as Record<keyof FeatureFlags, boolean>).RELEASE_PHASE = false;
		const stored = core.workloads.projectSpec(core.projects.requireRow(principal, 'app-e'))!;
		expect(() => core.workloads.setSpec(principal, core.projects.requireRow(principal, 'app-e'), { ...stored, port: 3001 })).not.toThrow();
		// Changing it is still refused.
		expect(() => core.workloads.setSpec(principal, core.projects.requireRow(principal, 'app-e'), { ...stored, drainSeconds: 30 })).toThrow(
			'drainSeconds needs the release phase',
		);
		close();
	});
});

describe('RELEASE_PHASE on: the fields are stored', () => {
	test('setSpec keeps every field', async () => {
		const { core, close } = makeCore({ RELEASE_PHASE: true });
		const row = await project(core, 'app-f');
		core.workloads.setSpec(principal, row, { ...base, ...fields } as never);
		const stored = core.workloads.projectSpec(core.projects.requireRow(principal, 'app-f'))!;
		for (const field of RELEASE_PHASE_SPEC_FIELDS) expect(stored[field]).toBeDefined();
		close();
	});
});

describe('blueprints never carry release-phase fields', () => {
	test('a blueprint project that sets one is refused by the blueprint schema', () => {
		const { core, close } = makeCore({ BLUEPRINTS: true });
		expect(() => core.blueprints.validate(principal, `apiVersion: yoal/v1\nname: stack-a\nprojects:\n  api:\n    runtime: process\n    command: [bun, run, start]\n`)).not.toThrow();
		for (const line of ['release: { command: [bin/migrate] }', 'drainSeconds: 10', 'stopTimeoutSeconds: 30', 'readinessPath: /ready'])
			expect(() =>
				core.blueprints.validate(
					principal,
					`apiVersion: yoal/v1\nname: stack-a\nprojects:\n  api:\n    runtime: process\n    command: [bun, run, start]\n    ${line}\n`,
				),
			).toThrow(/Unrecognized key|unrecognized/i);
		close();
	});
});
