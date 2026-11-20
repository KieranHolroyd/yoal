import { afterAll, describe, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { certificateUris } from './node-pki.ts';

/**
 * HA-PLAN H24 "Trust" (W4 lane B): core issues a leaf from a node CSR, renders public trust material
 * in desired state and refuses anything beyond CN = node id and URI SAN yoal://node/<id>.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-node-ca-'));
const csrDir = mkdtempSync(join(tmpdir(), 'yoal-node-ca-csr-'));
const opened = createDb({ path: ':memory:' });
const clock = Date.parse('2026-11-20T10:00:00Z');
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
		features: { ...DEFAULT_FEATURES, ENDPOINTS_GATEWAY: true },
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'node-a').token, name: 'node-a' });
core.nodes.update(owner, node.nodeId, { sliceMemoryMb: 4096 });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
	rmSync(csrDir, { recursive: true, force: true });
});

let counter = 0;
function makeCsr(input: { cn: string; san?: string | null; rsa?: number; extras?: string[] }): string {
	const name = `csr-${counter++}`;
	const key = join(csrDir, `${name}.key`);
	const csr = join(csrDir, `${name}.csr`);
	const args = [
		'req',
		'-new',
		'-nodes',
		'-subj',
		`/CN=${input.cn}`,
		...(input.rsa
			? ['-newkey', `rsa:${input.rsa}`]
			: ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1']),
	];
	if (input.san) args.push('-addext', `subjectAltName=URI:${input.san}`);
	for (const extra of input.extras ?? []) args.push('-addext', extra);
	args.push('-keyout', key, '-out', csr);
	const result = Bun.spawnSync({ cmd: ['openssl', ...args], stdout: 'pipe', stderr: 'pipe' });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return readFileSync(csr, 'utf8');
}

describe('the install CA issues node leaves (H24)', () => {
	test('signs a CSR, and the leaf chains to the CA with the node URI SAN', () => {
		const request = makeCsr({ cn: node.nodeId, san: `yoal://node/${node.nodeId}` });
		const signed = core.nodeCa.signCsr(node.nodeId, { csrPem: request, reason: 'enrol' });
		const trust = core.nodeCa.trustFor(node.nodeId)!;
		const ca = new X509Certificate(trust.caBundlePem);
		const leaf = new X509Certificate(signed.certPem);
		expect(leaf.subject).toContain(`CN=${node.nodeId}`);
		expect(leaf.issuer).toContain('CN=Yoal install CA');
		expect(leaf.checkIssued(ca)).toBe(true);
		expect(leaf.verify(ca.publicKey)).toBe(true);
		expect(certificateUris(signed.certPem)).toEqual([`yoal://node/${node.nodeId}`]);
		expect(leaf.keyUsage).toEqual(expect.arrayContaining(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']));
		expect(trust.certificatePem).toBe(signed.certPem);
		expect(trust.serial).toBe(signed.serial);
		expect(trust.revokedSerials).toEqual([]);
		expect(trust.generation).toBeGreaterThanOrEqual(0);
		// One CA row, and its private key is sealed: no key material in the certificate columns.
		expect(opened.sqlite.query('SELECT COUNT(*) AS n FROM node_ca').get()).toEqual({ n: 1 });
		expect(opened.sqlite.query<{ keySealed: string }, []>('SELECT key_sealed AS keySealed FROM node_ca').get()!.keySealed).not.toContain(
			'PRIVATE KEY',
		);
	});

	test('a re-sent CSR for the same key is answered with the same leaf', () => {
		const request = makeCsr({ cn: node.nodeId, san: `yoal://node/${node.nodeId}` });
		const first = core.nodeCa.signCsr(node.nodeId, { csrPem: request, reason: 'renew' });
		const again = core.nodeCa.signCsr(node.nodeId, { csrPem: request, reason: 'renew' });
		expect(again).toEqual(first);
	});

	test('a new key supersedes the old leaf and revokes its serial', () => {
		const first = core.nodeCa.signCsr(node.nodeId, {
			csrPem: makeCsr({ cn: node.nodeId, san: `yoal://node/${node.nodeId}` }),
			reason: 'enrol',
		});
		const second = core.nodeCa.signCsr(node.nodeId, {
			csrPem: makeCsr({ cn: node.nodeId, san: `yoal://node/${node.nodeId}` }),
			reason: 'rekey',
		});
		const trust = core.nodeCa.trustFor(node.nodeId)!;
		expect(trust.serial).toBe(second.serial);
		expect(trust.revokedSerials).toContain(first.serial);
	});

	test('refuses a CSR for another node, a weak key, or an extra extension', () => {
		expect(() =>
			core.nodeCa.signCsr(node.nodeId, {
				csrPem: makeCsr({ cn: 'someone-else', san: 'yoal://node/someone-else' }),
				reason: 'enrol',
			}),
		).toThrow(/subject must be CN=/);
		expect(() =>
			core.nodeCa.signCsr(node.nodeId, {
				csrPem: makeCsr({ cn: node.nodeId, san: `yoal://node/${node.nodeId}`, rsa: 1024 }),
				reason: 'enrol',
			}),
		).toThrow(/too weak/);
		expect(() =>
			core.nodeCa.signCsr(node.nodeId, {
				csrPem: makeCsr({ cn: node.nodeId, san: `yoal://node/${node.nodeId}`, extras: ['basicConstraints=CA:TRUE'] }),
				reason: 'enrol',
			}),
		).toThrow(/unsupported extension/);
		expect(() =>
			core.nodeCa.signCsr(node.nodeId, {
				csrPem: makeCsr({ cn: node.nodeId, san: 'yoal://node/other' }),
				reason: 'enrol',
			}),
		).toThrow(/subjectAltName must name/);
	});

	test('a node that advertises the capability sends a CSR and receives nodeTrust', () => {
		const request = makeCsr({ cn: node.nodeId, san: `yoal://node/${node.nodeId}` });
		core.nodes.heartbeat(node.token, {
			nodeId: node.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: core.nodes.stateVersion(),
			status: 'online',
			caddyOk: true,
			releases: [],
			capabilities: ['endpoints-gateway'],
			nodeCsr: { csrPem: request, reason: 'enrol' },
		});
		return core.nodes.desiredState(node.token).then((state) => {
			expect(state.nodeTrust?.caBundlePem).toContain('BEGIN CERTIFICATE');
			expect(state.nodeTrust?.certificatePem).toContain('BEGIN CERTIFICATE');
			expect(state.nodeTrust?.serial).toMatch(/^[a-f0-9]+$/);
		});
	});
});

describe('CA rotation (H24)', () => {
	test('keeps old leaves trusted and signs new ones under the new CA', () => {
		const before = core.nodeCa.issue();
		const request = makeCsr({ cn: node.nodeId, san: `yoal://node/${node.nodeId}` });
		const oldLeaf = core.nodeCa.signCsr(node.nodeId, { csrPem: request, reason: 'enrol' });

		const rotated = core.nodeCa.rotate();
		expect(rotated.fingerprint).not.toBe(before.fingerprint);
		expect(rotated.state).toBe('active');

		// The bundle still trusts the old CA, so the leaf issued before rotation keeps working.
		const trust = core.nodeCa.trustFor(node.nodeId)!;
		const bundle = (trust.caBundlePem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).map(
			(pem) => new X509Certificate(pem),
		);
		expect(bundle.length).toBeGreaterThanOrEqual(2);
		expect(bundle.some((ca) => new X509Certificate(oldLeaf.certPem).checkIssued(ca))).toBe(true);
		// A leaf cut after rotation chains to the new CA.
		const fresh = core.nodeCa.signCsr(node.nodeId, {
			csrPem: makeCsr({ cn: node.nodeId, san: `yoal://node/${node.nodeId}` }),
			reason: 'renew',
		});
		expect(bundle.some((ca) => new X509Certificate(fresh.certPem).checkIssued(ca))).toBe(true);

		// The CA private key never appears in trust material or desired state.
		expect(JSON.stringify(trust)).not.toContain('PRIVATE KEY');
	});
});
