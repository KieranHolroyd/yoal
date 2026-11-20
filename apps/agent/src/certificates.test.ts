import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { certificateFleetFingerprint, type CertificateActivation } from '@yoal/contracts';
import { CertificateDelivery } from './certificates.ts';

/**
 * W7 delivery on an ingress (HA-PLAN H20): the agent caches the activation, serves the pair to
 * Caddy through `get_certificate http`, and reports the same fleet fingerprint as the control
 * plane. The flag-off path delivers nothing and leaves Caddy issuing per node.
 */

const root = mkdtempSync(join(tmpdir(), 'yoal-agent-certificates-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function pair(host = 'app.sites.test'): { certPem: string; keyPem: string } {
	const base = join(root, `pair-${Math.random().toString(36).slice(2)}`);
	const result = Bun.spawnSync({
		cmd: [
			'openssl',
			'req',
			'-x509',
			'-newkey',
			'ec',
			'-pkeyopt',
			'ec_paramgen_curve:prime256v1',
			'-nodes',
			'-keyout',
			`${base}.key`,
			'-out',
			`${base}.crt`,
			'-days',
			'90',
			'-subj',
			`/CN=${host}`,
			'-addext',
			`subjectAltName=DNS:${host}`,
		],
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return { certPem: readFileSync(`${base}.crt`, 'utf8'), keyPem: readFileSync(`${base}.key`, 'utf8') };
}

function activation(overrides: Partial<CertificateActivation> = {}): CertificateActivation {
	const material = pair();
	return {
		generation: 4,
		fingerprint: certificateFleetFingerprint([{ host: 'app.sites.test', fingerprint: 'f'.repeat(64) }]),
		certificates: [
			{
				host: 'app.sites.test',
				fingerprint: 'f'.repeat(64),
				chainPem: material.certPem,
				keyPem: material.keyPem,
				notAfter: Date.now() + 90 * 86_400_000,
				source: 'acme',
			},
		],
		relays: [{ host: 'app.sites.test', upstream: 'http://10.47.0.2:8089' }],
		...overrides,
	};
}

function delivery(body: CertificateActivation, options: { now?: () => number; fetch?: typeof fetch } = {}) {
	const calls: string[] = [];
	const fetchImpl = (async (input: string | URL | Request) => {
		calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
		return Response.json(body);
	}) as typeof fetch;
	return {
		calls,
		client: new CertificateDelivery({
			controlUrl: 'https://control.test',
			nodeToken: 'node-token',
			dataDir: mkdtempSync(join(root, 'data-')),
			fetch: options.fetch ?? fetchImpl,
			now: options.now,
		}),
	};
}

describe('certificate delivery', () => {
	test('caches the activation, serves the pair to Caddy and reports the fleet fingerprint', async () => {
		const { client, calls } = delivery(activation());
		expect(await client.refresh()).toBe(true);
		expect(calls[0]).toBe('https://control.test/api/agent/certificates/activation');
		expect(client.fingerprint()).toBe(
			certificateFleetFingerprint([{ host: 'app.sites.test', fingerprint: 'f'.repeat(64) }]),
		);
		expect(client.relays()).toEqual([{ host: 'app.sites.test', upstream: 'http://10.47.0.2:8089' }]);

		const manager = client.manager()!;
		expect(manager.subjects).toEqual(['app.sites.test']);
		const url = new URL(manager.url);
		expect(url.hostname).toBe('127.0.0.1');
		// Caddy appends `server_name`; the token is what stops another local process reading keys.
		const response = await fetch(`${manager.url}&server_name=app.sites.test`);
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain('BEGIN CERTIFICATE');
		expect(body).toContain('PRIVATE KEY');
		expect((await fetch(`${manager.url.replace(/token=[^&]+/, 'token=wrong')}&server_name=app.sites.test`)).status).toBe(403);
		expect((await fetch(`${manager.url}&server_name=other.test`)).status).toBe(404);
		client.close();
	});

	test('a wildcard entry answers a single-label name', async () => {
		const material = pair('*.sites.test');
		const { client } = delivery(
			activation({
				certificates: [
					{
						host: '*.sites.test',
						fingerprint: 'f'.repeat(64),
						chainPem: material.certPem,
						keyPem: material.keyPem,
						notAfter: Date.now() + 90 * 86_400_000,
						source: 'acme',
					},
				],
			}),
		);
		await client.refresh();
		const manager = client.manager()!;
		expect((await fetch(`${manager.url}&server_name=shop.sites.test`)).status).toBe(200);
		expect((await fetch(`${manager.url}&server_name=deep.shop.sites.test`)).status).toBe(404);
		client.close();
	});

	test('the cache is 0600, reloads before a fetch, and pairs are 0640', async () => {
		const dir = mkdtempSync(join(root, 'cache-'));
		const first = new CertificateDelivery({
			controlUrl: 'https://control.test',
			nodeToken: 't',
			dataDir: dir,
			fetch: (async () => Response.json(activation())) as unknown as typeof fetch,
		});
		await first.refresh();
		first.close();
		expect(statSync(join(dir, 'certificates', 'activation.json')).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, 'certificates', 'app.sites.test.pem')).mode & 0o777).toBe(0o640);
		expect(statSync(join(dir, 'certificates', 'app.sites.test.key')).mode & 0o777).toBe(0o640);

		// A restart with the control plane unreachable still serves the cached pair.
		const second = new CertificateDelivery({
			controlUrl: 'https://control.test',
			nodeToken: 't',
			dataDir: dir,
			fetch: (async () => {
				throw new Error('offline');
			}) as unknown as typeof fetch,
		});
		expect(second.manager()?.subjects).toEqual(['app.sites.test']);
		expect(second.fingerprint()).toBe(first.fingerprint());
		second.close();
	});

	test('an empty activation (flag off) has no manager, no relays and clears the files', async () => {
		const dir = mkdtempSync(join(root, 'empty-'));
		let body = activation();
		const client = new CertificateDelivery({
			controlUrl: 'https://control.test',
			nodeToken: 't',
			dataDir: dir,
			fetch: (async () => Response.json(body)) as unknown as typeof fetch,
		});
		await client.refresh();
		expect(client.manager()).not.toBeNull();
		body = { generation: 0, fingerprint: null, certificates: [], relays: [] };
		expect(await client.refresh()).toBe(true);
		expect(client.manager()).toBeNull();
		expect(client.fingerprint()).toBeNull();
		expect(client.relays()).toEqual([]);
		// A removed host's key does not stay on disk.
		expect(() => statSync(join(dir, 'certificates', 'app.sites.test.key'))).toThrow();
		client.close();
	});

	test('ensureFresh honours the 30 s cap after a desired-state wake', async () => {
		let now = 1_000_000;
		const { client, calls } = delivery(activation(), { now: () => now });
		expect(await client.ensureFresh()).toBe(true);
		now += 1_000;
		expect(await client.ensureFresh()).toBe(false);
		expect(calls).toHaveLength(1);
		now += 30_000;
		expect(await client.ensureFresh()).toBe(false); // unchanged generation
		expect(calls).toHaveLength(2);
		client.close();
	});
});
