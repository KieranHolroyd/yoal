import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeTrustDesired } from '@yoal/contracts';
import { NodeCaIdentity } from './node-ca.ts';
import { TestPki } from './test-pki.ts';

const openssl = Bun.which('openssl');
const dirs: string[] = [];
const pkis: TestPki[] = [];

function dataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-node-ca-'));
	dirs.push(dir);
	return dir;
}

function pki(): TestPki {
	const created = new TestPki();
	pkis.push(created);
	return created;
}

/** Desired `nodeTrust` with no leaf yet (the first heartbeat after enrolment). */
function trustWithoutLeaf(caBundlePem: string, overrides: Partial<NodeTrustDesired> = {}): NodeTrustDesired {
	return { generation: 1, caBundlePem, certificatePem: null, serial: null, notAfter: null, revokedSerials: [], ...overrides };
}

afterAll(() => {
	for (const created of pkis.splice(0)) created.dispose();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('NodeCaIdentity', () => {
	test('with the feature off or no openssl it does nothing', () => {
		const dir = dataDir();
		const identity = new NodeCaIdentity(dir, 'nod_a', { openssl: null });
		expect(identity.available()).toBe(false);
		expect(identity.request(undefined)).toBeNull();
		expect(identity.request(trustWithoutLeaf('x'))).toBeNull();
		expect(identity.material(undefined)).toBeNull();
		// No key is generated while the node has no `nodeTrust` at all.
		const capable = new NodeCaIdentity(dir, 'nod_a');
		expect(capable.request(undefined)).toBeNull();
		expect(existsSync(join(dir, 'tls', 'node-ca.key'))).toBe(false);
	});

	test.skipIf(!openssl)('sends an enrolment CSR and stores only a leaf that chains and names the node', () => {
		const ca = pki();
		const dir = dataDir();
		const identity = new NodeCaIdentity(dir, 'nod_a');
		const enrolment = identity.request(trustWithoutLeaf(ca.caPem));
		expect(enrolment).not.toBeNull();
		expect(enrolment!.reason).toBe('enrol');
		expect(enrolment!.csrPem).toContain('BEGIN CERTIFICATE REQUEST');
		// The private key never leaves the node and is root-only.
		expect(statSync(join(dir, 'tls', 'node-ca.key')).mode & 0o777).toBe(0o600);
		expect(enrolment!.csrPem).not.toContain('PRIVATE KEY');

		const signed = ca.signCsr(enrolment!.csrPem, 'nod_a');
		const material = identity.material(trustWithoutLeaf(ca.caPem, { certificatePem: signed.certPem, serial: signed.serial }));
		expect(material).not.toBeNull();
		expect(material!.caBundlePem).toBe(ca.caPem);
		expect(material!.keyPem).toContain('PRIVATE KEY');
		expect(material!.generation).toBe(1);
		// The signed leaf is kept for the next process start.
		expect(readFileSync(join(dir, 'tls', 'node-ca.crt'), 'utf8')).toBe(signed.certPem);
		// A usable leaf stops the CSR: no repeated signing request every heartbeat.
		expect(identity.request(trustWithoutLeaf(ca.caPem, { certificatePem: signed.certPem, serial: signed.serial }))).toBeNull();
	});

	test.skipIf(!openssl)('asks for renewal inside the window, and keeps using the leaf meanwhile', () => {
		const ca = pki();
		const identity = new NodeCaIdentity(dataDir(), 'nod_a');
		const csr = identity.request(trustWithoutLeaf(ca.caPem))!;
		const signed = ca.signCsr(csr.csrPem, 'nod_a', 10);
		const trust = trustWithoutLeaf(ca.caPem, { certificatePem: signed.certPem, serial: signed.serial });
		// Nine days left is inside the 30-day window.
		expect(identity.request(trust)?.reason).toBe('renew');
		expect(identity.material(trust)).not.toBeNull();
	});

	test.skipIf(!openssl)('refuses a leaf for another key, another node, another CA, or an expiry', () => {
		const ca = pki();
		const other = pki();
		const identity = new NodeCaIdentity(dataDir(), 'nod_a');
		const csr = identity.request(trustWithoutLeaf(ca.caPem))!;

		// Another key signs the CSR? No: another node's leaf arrives whole, with its own key.
		const foreign = ca.leaf('nod_a');
		expect(identity.material(trustWithoutLeaf(ca.caPem, { certificatePem: foreign.certPem, serial: foreign.serial }))).toBeNull();

		// A leaf that names another node, though signed by the right CA.
		const misnamed = ca.signCsr(csr.csrPem, 'nod_b');
		expect(identity.material(trustWithoutLeaf(ca.caPem, { certificatePem: misnamed.certPem, serial: misnamed.serial }))).toBeNull();

		// A leaf signed by a CA that is not in the bundle.
		const untrusted = other.signCsr(csr.csrPem, 'nod_a');
		expect(identity.material(trustWithoutLeaf(ca.caPem, { certificatePem: untrusted.certPem, serial: untrusted.serial }))).toBeNull();

		// An expired leaf.
		let now = Date.now();
		const clocked = new NodeCaIdentity(dataDir(), 'nod_a', { now: () => now });
		const clockedCsr = clocked.request(trustWithoutLeaf(ca.caPem))!;
		const expired = ca.signCsr(clockedCsr.csrPem, 'nod_a', 1);
		now += 2 * 86_400_000;
		expect(clocked.material(trustWithoutLeaf(ca.caPem, { certificatePem: expired.certPem, serial: expired.serial }))).toBeNull();
	});

	test.skipIf(!openssl)('a revoked leaf is not presented and asks for a replacement', () => {
		const ca = pki();
		const identity = new NodeCaIdentity(dataDir(), 'nod_a');
		const csr = identity.request(trustWithoutLeaf(ca.caPem))!;
		const signed = ca.signCsr(csr.csrPem, 'nod_a');
		const trust = trustWithoutLeaf(ca.caPem, {
			certificatePem: signed.certPem,
			serial: signed.serial,
			revokedSerials: [signed.serial.padStart(4, '0').toUpperCase()],
		});
		expect(identity.material(trust)).toBeNull();
		expect(identity.request(trust)?.reason).toBe('rekey');
	});

	test.skipIf(!openssl)('a new key discards the old leaf and asks for a rekey', () => {
		const ca = pki();
		const dir = dataDir();
		const identity = new NodeCaIdentity(dir, 'nod_a');
		const csr = identity.request(trustWithoutLeaf(ca.caPem))!;
		const signed = ca.signCsr(csr.csrPem, 'nod_a');
		expect(identity.material(trustWithoutLeaf(ca.caPem, { certificatePem: signed.certPem, serial: signed.serial }))).not.toBeNull();

		// Simulate the key being replaced while the leaf stays in desired state.
		rmSync(join(dir, 'tls', 'node-ca.key'));
		const restarted = new NodeCaIdentity(dir, 'nod_a');
		const trust = trustWithoutLeaf(ca.caPem, { certificatePem: signed.certPem, serial: signed.serial });
		expect(restarted.material(trust)).toBeNull();
		expect(restarted.request(trust)?.reason).toBe('rekey');
		expect(existsSync(join(dir, 'tls', 'node-ca.crt'))).toBe(false);
	});
});
