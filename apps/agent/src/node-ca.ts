import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { NODE_CERT_RENEW_BEFORE_DAYS, nodeCertificateUri, type NodeCsr, type NodeTrustDesired } from '@yoal/contracts';
import { normalizeSerial, type NodeTrustMaterial } from './endpoints.ts';

/**
 * The node's install-CA identity (HA-PLAN H24 "Trust", CLUSTERING §4.3).
 *
 * The node generates its own P-256 key (`tls/node-ca.key`, 0600, never sent anywhere) and sends a
 * PKCS#10 CSR in its heartbeat (`nodeCsr`) while desired state carries `nodeTrust` without a leaf
 * for that key, or the leaf is within `NODE_CERT_RENEW_BEFORE_DAYS` of expiry. The signed leaf
 * arrives in `nodeTrust.certificatePem`; the agent keeps a copy in `tls/node-ca.crt` and hands
 * the forwarder its key, leaf, the CA bundle and the revoked serials.
 *
 * It is separate from the C2 self-signed identity (`node-cert.ts`), which stays in use for pinned
 * peers until every peer of a listener has a CA leaf (`endpointTrustMode`).
 *
 * The CSR is not sent at enrolment (`nodeJoinSchema.csrPem`): before the join the node does not
 * know its id, and the control plane signs only a CSR whose subject is the node's own id.
 */

/** Node ids reach `openssl -subj` and a URI SAN; anything else gets no CSR. */
const NODE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const DAY_MS = 86_400_000;

export interface NodeCaOptions {
	/** openssl on PATH, for the CSR. Null means no CSR can be made (and no capability). */
	openssl?: string | null;
	now?: () => number;
	log?: (level: 'info' | 'warn', message: string) => void;
}

export class NodeCaIdentity {
	private readonly dir: string;
	private readonly openssl: string | null;
	private readonly now: () => number;
	private readonly log: (level: 'info' | 'warn', message: string) => void;
	private keyPem: string | null = null;
	private csr: { forKey: string; pem: string } | null = null;

	constructor(
		dataDir: string,
		private readonly nodeId: string,
		options: NodeCaOptions = {},
	) {
		this.dir = join(dataDir, 'tls');
		this.openssl = options.openssl === undefined ? Bun.which('openssl') : options.openssl;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => undefined);
	}

	/** Whether this node can take part: it can make a CSR for a well-formed node id. */
	available(): boolean {
		return this.openssl !== null && NODE_ID.test(this.nodeId);
	}

	get keyPath(): string {
		return join(this.dir, 'node-ca.key');
	}

	get certPath(): string {
		return join(this.dir, 'node-ca.crt');
	}

	/**
	 * The forwarder's material for `install-ca`, or null while desired state has no leaf for this
	 * node's key (or none at all: the feature is off or this node lacks the capability). Stores a
	 * new matching leaf in `tls/node-ca.crt`.
	 */
	material(trust: NodeTrustDesired | undefined): NodeTrustMaterial | null {
		if (!trust || !this.available()) return null;
		const keyPem = this.ensureKey();
		if (!keyPem || !trust.certificatePem) return null;
		const leaf = this.inspect(trust.certificatePem, keyPem);
		if (!leaf.matches || leaf.notAfter <= this.now()) return null;
		this.store(trust.certificatePem);
		return {
			keyPem,
			certPem: trust.certificatePem,
			caBundlePem: trust.caBundlePem,
			revokedSerials: new Set(trust.revokedSerials.map(normalizeSerial)),
			generation: trust.generation,
		};
	}

	/**
	 * The CSR to send in this heartbeat, or null. Sent only while desired state carries `nodeTrust`
	 * (so a node with the feature off sends exactly what it sent before), and repeated every
	 * heartbeat until a matching, not-yet-due leaf arrives.
	 */
	request(trust: NodeTrustDesired | undefined): NodeCsr | null {
		if (!trust || !this.available()) return null;
		const keyPem = this.ensureKey();
		if (!keyPem) return null;
		let reason: NodeCsr['reason'] = 'enrol';
		if (trust.certificatePem) {
			const leaf = this.inspect(trust.certificatePem, keyPem);
			if (!leaf.matches) reason = 'rekey';
			else if (leaf.notAfter - NODE_CERT_RENEW_BEFORE_DAYS * DAY_MS > this.now()) return null;
			else reason = 'renew';
		}
		const pem = this.csrPem(keyPem);
		return pem ? { csrPem: pem, reason } : null;
	}

	private ensureKey(): string | null {
		if (this.keyPem) return this.keyPem;
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			if (!existsSync(this.keyPath)) {
				const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
				writeFileSync(this.keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600 });
				// A new key makes any stored leaf useless.
				rmSync(this.certPath, { force: true });
				this.log('info', 'Generated the node key for the install CA');
			}
			chmodSync(this.keyPath, 0o600);
			this.keyPem = readFileSync(this.keyPath, 'utf8');
			return this.keyPem;
		} catch (error) {
			this.log('warn', `Could not prepare the install-CA node key: ${(error as Error).message}`);
			return null;
		}
	}

	private inspect(certPem: string, keyPem: string): { matches: boolean; notAfter: number } {
		try {
			const certificate = new X509Certificate(certPem);
			const leafKey = certificate.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
			const ownKey = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' }) as Buffer;
			return { matches: leafKey.equals(ownKey), notAfter: new Date(certificate.validTo).getTime() };
		} catch {
			return { matches: false, notAfter: 0 };
		}
	}

	private store(certPem: string): void {
		try {
			if (existsSync(this.certPath) && readFileSync(this.certPath, 'utf8') === certPem) return;
			writeFileSync(this.certPath, certPem, { mode: 0o644 });
			this.log('info', 'Stored the node certificate signed by the install CA');
		} catch (error) {
			this.log('warn', `Could not store the install-CA node certificate: ${(error as Error).message}`);
		}
	}

	private csrPem(keyPem: string): string | null {
		if (this.csr?.forKey === keyPem) return this.csr.pem;
		// argv only, no shell; the node id is checked against NODE_ID first.
		const result = Bun.spawnSync({
			cmd: [
				this.openssl!,
				'req',
				'-new',
				'-key',
				this.keyPath,
				'-subj',
				`/CN=${this.nodeId}`,
				'-addext',
				`subjectAltName=${`URI:${nodeCertificateUri(this.nodeId)}`}`,
			],
			stdout: 'pipe',
			stderr: 'pipe',
		});
		if (result.exitCode !== 0) {
			this.log('warn', `openssl could not make the node CSR: ${result.stderr.toString().trim()}`);
			return null;
		}
		const pem = result.stdout.toString();
		this.csr = { forKey: keyPem, pem };
		return pem;
	}
}
