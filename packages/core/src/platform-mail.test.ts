import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES, type MailInject } from '@yoal/contracts';
import type { EmailMessage } from './config.ts';
import type { EmailDnsResolver } from './email.ts';
import { createCore, type Core } from './index.ts';
import { PlatformMailTransport } from './notify.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

/** Platform mail through Yoal Email (docs/EMAIL.md §10, D238): the sender choice and the relay fallback. */

const dir = mkdtempSync(join(tmpdir(), 'yoal-platform-mail-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-22T10:00:00Z');

/** The SMTP relay (D22) as the tests see it. */
const relayed: EmailMessage[] = [];
const relay = {
	async send(message: EmailMessage) {
		relayed.push(message);
	},
};
const transport = new PlatformMailTransport(relay);

const txt = new Map<string, string[]>();
const dns: EmailDnsResolver = {
	async resolveTxt(name) {
		const values = txt.get(name);
		if (!values) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
		return values.map((value) => [value]);
	},
	async resolveMx() {
		throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
	},
};

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.yoal.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
		features: { ...DEFAULT_FEATURES },
		email: transport,
	},
	email: { dns },
});
transport.attach(core.email);

const admin = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_admin', role: 'owner', platformAdmin: true });
const tenant = buildPrincipal({ kind: 'user', userId: 'user_owner', orgId: 'org_t', role: 'owner' });
let nodeId = '';
let nodeToken = '';
let adminDomainId = '';
let tenantDomainId = '';

function outbox(): MailInject[] {
	return opened.sqlite
		.query<{ payload_json: string }, []>('SELECT payload_json FROM email_outbox ORDER BY created_at, rowid')
		.all()
		.map((row) => JSON.parse(row.payload_json) as MailInject);
}

function heartbeat(): void {
	core.nodes.heartbeat(nodeToken, { nodeId, agentVersion: '0.1.0', actualStateVersion: 1, status: 'online', caddyOk: true, releases: [], capabilities: ['mail'] });
}

async function verifiedDomain(principal: typeof admin, name: string): Promise<string> {
	const domain = await core.email.createDomain(principal, { name, autoDns: false });
	const dkim = domain.records.find((record) => record.purpose === 'dkim')!;
	txt.set(dkim.name, [dkim.value]);
	expect((await core.email.checkDomain(principal, name)).status).toBe('verified');
	return domain.id;
}

const message = { to: 'ada@example.com', subject: 'Sign into your cloud', text: 'https://control.yoal.test/link', tags: { yoal: 'sign-in' } };

beforeAll(async () => {
	opened.sqlite.run('CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT)');
	opened.sqlite.run('CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT, createdAt TEXT)');
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'edge').token, name: 'edge', publicAddress: '203.0.113.10' });
	nodeId = joined.nodeId;
	nodeToken = joined.token;
	heartbeat();
	adminDomainId = await verifiedDomain(admin, 'acme.test');
	tenantDomainId = await verifiedDomain(tenant, 'tenant.test');
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('platform mail without a mail node', () => {
	test('goes through the relay, and the view says why', async () => {
		expect(await transport.deliver(message)).toEqual({ via: 'relay', fallbackReason: null });
		expect(relayed.at(-1)).toEqual({ to: message.to, subject: message.subject, text: message.text });
		const view = core.email.platformSenderView(admin);
		expect(view).toMatchObject({ choice: 'auto', route: { via: 'relay' }, mail: { available: false, nodeSet: false } });
		expect(view.mail.reason).toContain('No mail node');
	});
});

describe('platform mail with a mail node', () => {
	beforeAll(async () => {
		await core.email.configure(admin, { nodeId });
	});

	test('automatic sends through Yoal Email from the platform mail domain, logged under the platform', async () => {
		const before = relayed.length;
		const delivery = await transport.deliver(message);
		expect(delivery).toMatchObject({ via: 'mail', from: 'no-reply@sites.test' });
		expect(relayed.length).toBe(before);
		expect(outbox().at(-1)).toMatchObject({ orgId: '*', from: 'no-reply@sites.test', recipients: ['ada@example.com'], tags: { yoal: 'sign-in' } });
	});

	test('the chooser offers the platform domain and only the admin org’s verified domains', () => {
		const view = core.email.platformSenderView(admin);
		expect(view.options.map((option) => [option.value, option.address])).toEqual([
			['auto', 'no-reply@sites.test'],
			[adminDomainId, 'no-reply@acme.test'],
		]);
		expect(view.route).toEqual({ via: 'mail', from: 'no-reply@sites.test' });
	});

	test('a chosen org domain sends from that domain, logged under its org', async () => {
		expect(core.email.setPlatformSender(admin, adminDomainId).route).toEqual({ via: 'mail', from: 'no-reply@acme.test' });
		await transport.send(message);
		expect(outbox().at(-1)).toMatchObject({ orgId: 'org_admin', from: 'no-reply@acme.test' });
		// The mail node signs acme.test only for its own org, which is what the message is logged under.
		const state = core.email.stateForNode(nodeId);
		expect(state.domains.find((domain) => domain.name === 'acme.test')?.orgId).toBe('org_admin');
	});

	test('nobody can pick another tenant’s domain, and only platform admins can choose', () => {
		expect(() => core.email.setPlatformSender(admin, tenantDomainId)).toThrow('sending domains');
		expect(() => core.email.setPlatformSender(tenant, tenantDomainId)).toThrow('platform admin');
	});

	test('a chosen domain that stops verifying falls back to the platform sender and says so', async () => {
		opened.sqlite.run("UPDATE email_domains SET status = 'failed' WHERE id = ?", [adminDomainId]);
		const view = core.email.platformSenderView(admin);
		expect(view.problem).toBe('acme.test is not verified.');
		expect(view.route).toEqual({ via: 'mail', from: 'no-reply@sites.test' });
		expect(view.options.some((option) => option.value === adminDomainId)).toBe(true);
		opened.sqlite.run("UPDATE email_domains SET status = 'verified' WHERE id = ?", [adminDomainId]);
	});

	test('a suppressed recipient falls back to the relay', async () => {
		await core.email.addSuppression(admin, { address: 'gone@example.com' });
		const delivery = await transport.deliver({ ...message, to: 'gone@example.com' });
		expect(delivery.via).toBe('relay');
		expect(relayed.at(-1)?.to).toBe('gone@example.com');
	});

	test('relay only never uses the mail node', async () => {
		core.email.setPlatformSender(admin, 'relay');
		const queued = outbox().length;
		expect(await transport.deliver(message)).toEqual({ via: 'relay', fallbackReason: null });
		expect(outbox().length).toBe(queued);
		core.email.setPlatformSender(admin, 'auto');
	});

	test('a paused platform or an offline mail node sends through the relay', async () => {
		await core.email.configure(admin, { paused: true });
		expect((await transport.deliver(message)).via).toBe('relay');
		expect(core.email.platformSenderView(admin).mail.reason).toContain('paused');
		await core.email.configure(admin, { paused: false });

		clock += 5 * 60_000;
		expect((await transport.deliver(message)).via).toBe('relay');
		expect(core.email.platformSenderView(admin).mail.reason).toContain('offline');
		heartbeat();
		expect((await transport.deliver(message)).via).toBe('mail');
	});
});
