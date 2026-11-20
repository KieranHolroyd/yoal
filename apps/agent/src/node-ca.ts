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
const PEM_CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

interface LeafCheck {
	/** Valid key, chain, URI SAN and dates; presentable to a peer. */
	usable: boolean;
	/** Normalized serial when usable, else null. */
	serial: string | null;
	notAfter: number;
	/** `notAfter` minus the renewal window: the CSR starts when now passes this. */
	renewAt: number;
}

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
		const leaf = this.inspect(trust.certificatePem, keyPem, trust.caBundlePem);
		// A leaf that is the wrong key, names another node or does not chain to the bundle would be
		// refused by peers; presenting it is worse than failing closed with no material at all.
		if (!leaf.usable || revoked(trust, leaf.serial)) return null;
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
	 * heartbeat until a usable, not-yet-due leaf arrives.
	 */
	request(trust: NodeTrustDesired | undefined): NodeCsr | null {
		if (!trust || !this.available()) return null;
		const keyPem = this.ensureKey();
		if (!keyPem) return null;
		let reason: NodeCsr['reason'] = 'enrol';
		if (trust.certificatePem) {
			const leaf = this.inspect(trust.certificatePem, keyPem, trust.caBundlePem);
			if (!leaf.usable || revoked(trust, leaf.serial)) reason = 'rekey';
			else if (leaf.renewAt > this.now()) return null;
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

	/**
	 * Whether a leaf is usable by this node: its public key is this node's, it chains to one of the
	 * CAs in the bundle, its URI SAN names this node, and it is inside its validity window.
	 */
	private inspect(certPem: string, keyPem: string, bundlePem: string): LeafCheck {
		const unusable: LeafCheck = { usable: false, serial: null, notAfter: 0, renewAt: 0 };
		try {
			const certificate = new X509Certificate(certPem);
			const leafKey = certificate.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
			const ownKey = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' }) as Buffer;
			const notAfter = new Date(certificate.validTo).getTime();
			const notBefore = new Date(certificate.validFrom).getTime();
			const now = this.now();
			const usable =
				leafKey.equals(ownKey) &&
				notBefore <= now &&
				notAfter > now &&
				certificateNamesNode(certificate, this.nodeId) &&
				chainsToBundle(certificate, bundlePem, now);
			return {
				usable,
				serial: usable ? normalizeSerial(certificate.serialNumber) : null,
				notAfter,
				renewAt: notAfter - NODE_CERT_RENEW_BEFORE_DAYS * DAY_MS,
			};
		} catch {
			return unusable;
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

/** Whether a serial appears in the revoked list, comparing normalized forms. */
function revoked(trust: NodeTrustDesired, serial: string | null): boolean {
	return serial !== null && trust.revokedSerials.some((entry) => normalizeSerial(entry) === serial);
}

/** Whether the leaf's URI SANs include `yoal://node/<nodeId>` (the identity peers check). */
function certificateNamesNode(certificate: X509Certificate, nodeId: string): boolean {
	const names = certificate.subjectAltName ?? '';
	const wanted = nodeCertificateUri(nodeId);
	for (const part of names.split(',')) {
		if (part.trim() === `URI:${wanted}`) return true;
	}
	return false;
}

/**
 * Whether the leaf was signed by one of the CA certificates in the bundle and is currently valid.
 * The bundle is public material from desired state; a leaf that does not chain to it is never
 * presented (peers would refuse it, and a mis-issued leaf could name another node).
 */
function chainsToBundle(certificate: X509Certificate, bundlePem: string, now: number): boolean {
	for (const match of bundlePem.match(PEM_CERTIFICATE_BLOCK) ?? []) {
		try {
			const authority = new X509Certificate(match);
			if (new Date(authority.validFrom).getTime() > now) continue;
			if (new Date(authority.validTo).getTime() <= now) continue;
			if (certificate.checkIssued(authority) && certificate.verify(authority.publicKey)) return true;
		} catch {
			// A block that is not a certificate cannot be the issuer; try the next one.
		}
	}
	return false;
}
