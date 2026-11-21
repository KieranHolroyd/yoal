import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/** Custom domain, build and environment tools against a real core. */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-deploy-surface-'));
const opened = createDb({ path: ':memory:' });
const realCore: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(
			join(dir, 'objects'),
			'https://control.test',
			'object-secret-123'
		),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features: { ...DEFAULT_FEATURES }
	}
});
// No real DNS or Cloudflare: the TXT record is never there, so a check reports what is missing.
const domainInternals = realCore.domains as unknown as { dns: unknown; cloudflare: unknown };
domainInternals.cloudflare = null;
domainInternals.dns = {
	resolveTxt: async () => [],
	resolveCname: async () => [],
	resolve4: async () => []
};

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { yoalToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');
const { CONFIRM_TOOLS } = await import('./assistant/confirm-policy');

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

beforeAll(async () => {
	await realCore.projects.create(owner, {
		name: 'shop',
		slug: 'shop',
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform'
	});
	realCore.builds.upsertGitSource(owner, realCore.projects.requireRow(owner, 'shop'), {
		repoUrl: 'https://github.com/acme/shop.git',
		branch: 'main',
		rootDir: '.',
		buildCommand: 'bun run build',
		outputDir: 'dist',
		enabled: true
	});
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function call(principal: typeof owner, name: string, args: Record<string, unknown>) {
	const tool = assistantTools(principal).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name} for ${principal.role}`);
	const result = await tool.run(args);
	return {
		ok: result.ok,
		text: result.text,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions on a JSON tool result
		body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null
	};
}

const NEW_TOOLS = [
	'list_domains',
	'add_domain',
	'check_domain',
	'remove_domain',
	'list_builds',
	'get_build',
	'cancel_build',
	'update_environment',
	'delete_environment'
];

describe('deploy surface tools', () => {
	test('annotations, confirmations and what a viewer is offered', () => {
		const tools = new Map(
			yoalToolDefinitions(owner).map((entry) => [entry.name, entry.config.annotations as Record<string, boolean>])
		);
		for (const name of NEW_TOOLS) expect(tools.has(name)).toBe(true);
		for (const name of ['list_domains', 'list_builds', 'get_build'])
			expect(tools.get(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		for (const name of ['remove_domain', 'delete_environment'])
			expect(tools.get(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		for (const name of ['add_domain', 'check_domain', 'cancel_build', 'update_environment'])
			expect(tools.get(name)).toMatchObject({ readOnlyHint: false, destructiveHint: false });

		expect(CONFIRM_TOOLS.has('add_domain')).toBe(true);
		expect(CONFIRM_TOOLS.has('update_environment')).toBe(true);
		expect(CONFIRM_TOOLS.has('cancel_build')).toBe(false);
		const assistant = new Map(assistantTools(owner).map((tool) => [tool.name, tool.destructive]));
		expect(assistant.get('remove_domain')).toBe(true);
		expect(assistant.get('delete_environment')).toBe(true);
		expect(assistant.get('check_domain')).toBe(false);

		const offered = new Set(assistantTools(viewer).map((tool) => tool.name));
		for (const name of ['list_domains', 'list_builds', 'get_build', 'check_domain']) expect(offered.has(name)).toBe(true);
		for (const name of ['add_domain', 'remove_domain', 'cancel_build', 'update_environment', 'delete_environment'])
			expect(offered.has(name)).toBe(false);
	});

	test('add, list, check and remove a custom domain', async () => {
		const added = await call(owner, 'add_domain', { project: 'shop', hostname: 'Shop.Example.com.' });
		expect(added.ok).toBe(true);
		const domain = added.body!.domain;
		expect(domain).toMatchObject({ hostname: 'shop.example.com', projectSlug: 'shop', status: 'pending' });
		expect(added.body!.nextSteps.join(' ')).toContain(domain.verification.recordValue);

		const listed = await call(viewer, 'list_domains', { project: 'shop' });
		expect(listed.body!.domains.map((entry: { id: string }) => entry.id)).toEqual([domain.id]);
		const all = await call(viewer, 'list_domains', {});
		expect(all.body!.domains).toHaveLength(1);

		const checked = await call(owner, 'check_domain', { domain: domain.id });
		expect(checked.ok).toBe(true);
		expect(checked.body!.domain.status).toBe('pending');
		expect(typeof checked.body!.detail).toBe('string');

		const clash = await call(owner, 'add_domain', { project: 'shop', hostname: 'shop.example.com' });
		expect(clash.ok).toBe(false);
		expect(clash.text).toContain('already attached');

		const removed = await call(owner, 'remove_domain', { domain: domain.id });
		expect(removed.body).toEqual({ ok: true, id: domain.id });
		expect(realCore.domains.list(owner)).toEqual([]);
	});

	test('list and read builds with a bounded log tail, then cancel one', async () => {
		const project = realCore.projects.requireRow(owner, 'shop');
		const build = realCore.builds.enqueue(owner, project, { ref: 'main', promote: false });
		const log = Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
		opened.sqlite.run('UPDATE builds SET log = ?, log_tail = ? WHERE id = ?', [log, log.slice(-50), build.id]);

		const listed = await call(viewer, 'list_builds', { project: 'shop' });
		expect(listed.body!.builds).toHaveLength(1);
		expect(listed.body!.builds[0]).toMatchObject({ id: build.id, status: 'queued', ref: 'main' });
		expect(listed.body!.builds[0]).not.toHaveProperty('logTail');

		const got = await call(viewer, 'get_build', { project: 'shop', build: build.id });
		const lines = (got.body!.logTail as string).split('\n');
		expect(lines).toHaveLength(200);
		expect(lines[0]).toBe('line 251');
		expect(lines.at(-1)).toBe('line 450');
		expect(got.body!.logTruncated).toBe(true);

		const cancelled = await call(owner, 'cancel_build', { project: 'shop', build: build.id });
		expect(cancelled.body!.status).toBe('cancelled');
		const again = await call(owner, 'cancel_build', { project: 'shop', build: build.id });
		expect(again.ok).toBe(false);
		expect(again.text).toContain('already cancelled');
	});

	test('update and delete a named environment; production is refused', async () => {
		const project = realCore.projects.requireRow(owner, 'shop');
		realCore.environments.create(owner, project, { name: 'staging' });

		const updated = await call(owner, 'update_environment', {
			project: 'shop',
			environment: 'staging',
			name: 'Staging two',
			access: 'password',
			password: 'correct-horse-battery'
		});
		expect(updated.ok).toBe(true);
		expect(updated.body).toMatchObject({ slug: 'staging', name: 'Staging two', access: 'password', passwordSet: true });
		expect(updated.text).not.toContain('correct-horse-battery');

		const production = await call(owner, 'delete_environment', { project: 'shop', environment: 'production' });
		expect(production.ok).toBe(false);
		expect(production.text).toContain('production environment cannot be deleted');

		const deleted = await call(owner, 'delete_environment', { project: 'shop', environment: 'staging' });
		expect(deleted.body).toEqual({ ok: true, project: 'shop', environment: 'staging' });
		expect(realCore.environments.list(owner, project).map((env) => env.slug)).toEqual(['production']);
	});
});
