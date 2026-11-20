import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';

/**
 * Test-only PKI with the node's openssl: an install CA (standing in for the control plane's
 * `NodeCaService`, lane B), CA-signed node leaves and C2 self-signed identities. Not imported by
 * the agent itself.
 */
export class TestPki {
	readonly dir = mkdtempSync(join(tmpdir(), 'yoal-test-pki-'));
	readonly caPem: string;
	private serial = 0x1000;

	constructor(name = 'yoal-test-ca') {
		run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30', '-subj', `/CN=${name}`, '-keyout', this.path('ca.key'), '-out', this.path('ca.crt')]);
		this.caPem = readFileSync(this.path('ca.crt'), 'utf8');
	}

	path(name: string): string {
		return join(this.dir, name);
	}

	/** Sign a CSR the way the install CA does: URI SAN, both key usages, `days` validity. */
	signCsr(csrPem: string, nodeId: string, days = 90): { certPem: string; serial: string } {
		const id = `${nodeId}-${this.serial}`;
		writeFileSync(this.path(`${id}.csr`), csrPem);
		writeFileSync(this.path(`${id}.ext`), `subjectAltName=URI:yoal://node/${nodeId}\nextendedKeyUsage=serverAuth,clientAuth\n`);
		const serial = (this.serial++).toString(16);
		run(['x509', '-req', '-in', this.path(`${id}.csr`), '-CA', this.path('ca.crt'), '-CAkey', this.path('ca.key'), '-set_serial', `0x${serial}`, '-days', String(days), '-extfile', this.path(`${id}.ext`), '-out', this.path(`${id}.crt`)]);
		const certPem = readFileSync(this.path(`${id}.crt`), 'utf8');
		return { certPem, serial: new X509Certificate(certPem).serialNumber.toLowerCase().replace(/^0+(?=.)/, '') };
	}

	/** A key and CA-signed leaf for a node, made here (for peers that are not under test). */
	leaf(nodeId: string): { keyPem: string; certPem: string; serial: string } {
		const keyPath = this.path(`${nodeId}-${this.serial}.key`);
		run(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', `/CN=${nodeId}`, '-keyout', keyPath, '-out', `${keyPath}.csr`]);
		const signed = this.signCsr(readFileSync(`${keyPath}.csr`, 'utf8'), nodeId);
		return { keyPem: readFileSync(keyPath, 'utf8'), ...signed };
	}

	/** A C2 self-signed identity and its SHA-256 fingerprint (lowercase hex, no colons). */
	selfSigned(nodeId: string): { keyPem: string; certPem: string; fingerprint: string } {
		const base = this.path(`self-${nodeId}`);
		run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30', '-subj', `/CN=${nodeId}`, '-keyout', `${base}.key`, '-out', `${base}.crt`]);
		const certPem = readFileSync(`${base}.crt`, 'utf8');
		return {
			keyPem: readFileSync(`${base}.key`, 'utf8'),
			certPem,
			fingerprint: new X509Certificate(certPem).fingerprint256.replaceAll(':', '').toLowerCase(),
		};
	}

	dispose(): void {
		rmSync(this.dir, { recursive: true, force: true });
	}
}

function run(args: string[]): void {
	const result = Bun.spawnSync({ cmd: ['openssl', ...args], stdout: 'pipe', stderr: 'pipe' });
	if (result.exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr.toString()}`);
}
