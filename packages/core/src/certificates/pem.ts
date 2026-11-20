import {
	X509Certificate,
	createHash,
	createPrivateKey,
	createSign,
	createVerify,
	randomBytes,
} from 'node:crypto';
import { normalizeCertificateHost } from '@yoal/contracts';
import { ValidationError } from '../errors.ts';

/**
 * Reading a PEM pair the holder uploaded, or an operator brought (HA-PLAN H20). Nothing here keeps
 * a key: the caller seals it at once with the platform master key (`ingress_certificates.key_sealed`).
 */
export interface ParsedCertificate {
	/** SHA-256 of the DER leaf, lower-case hex. This is what every heartbeat reports. */
	fingerprint: string;
	serial: string;
	notBefore: number;
	notAfter: number;
	/** Every DNS name the leaf covers (wildcards are kept as written). */
	hosts: string[];
}

/** The first certificate block in a PEM (the leaf), with its trailing chain left in place. */
export function leafCertificatePem(pem: string): string {
	const match = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
	if (!match) throw new ValidationError('The certificate is not a PEM certificate.');
	return match[0];
}

/** Parse and validate one certificate before it is stored. */
export function parseCertificatePem(pem: string): ParsedCertificate {
	const leaf = leafCertificatePem(pem);
	let cert: X509Certificate;
	try {
		cert = new X509Certificate(leaf);
	} catch (cause) {
		throw new ValidationError(`The certificate could not be read: ${(cause as Error).message}`);
	}
	const notBefore = Date.parse(cert.validFrom);
	const notAfter = Date.parse(cert.validTo);
	if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter))
		throw new ValidationError('The certificate has no valid validity dates.');
	return {
		fingerprint: createHash('sha256').update(cert.raw).digest('hex'),
		serial: cert.serialNumber.toLowerCase(),
		notBefore,
		notAfter,
		hosts: certificateHosts(cert),
	};
}

/** DNS names and the subject CN the certificate covers. */
export function certificateHosts(cert: X509Certificate): string[] {
	const hosts = new Set<string>();
	for (const name of (cert.subjectAltName ?? '').split(/,\s*/)) {
		const match = /^DNS:(.+)$/i.exec(name.trim());
		if (match?.[1]) hosts.add(normalizeCertificateHost(match[1]));
	}
	const cn = /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1];
	if (cn) hosts.add(normalizeCertificateHost(cn));
	return [...hosts].filter(Boolean);
}

/**
 * Whether the leaf covers `host` by exact name or by a single-label wildcard. A nested name needs
 * its own certificate (CLUSTERING §7.3 "One-level wildcard").
 */
export function certificateCoversHost(hosts: readonly string[], host: string): boolean {
	const wanted = normalizeCertificateHost(host);
	for (const name of hosts) {
		if (name === wanted) return true;
		if (name.startsWith('*.')) {
			const suffix = name.slice(1); // ".example.com"
			if (wanted.endsWith(suffix) && !wanted.slice(0, -suffix.length).includes('.')) return true;
		}
	}
	return false;
}

/**
 * Prove the private key belongs to the leaf without exporting either. A random nonce is signed with
 * the key and verified with the certificate's public key; a mismatched pair never reaches the store.
 */
export function keyPairMatches(certPem: string, keyPem: string): boolean {
	try {
		const key = createPrivateKey(keyPem);
		const leaf = new X509Certificate(leafCertificatePem(certPem));
		const nonce = randomBytes(32);
		const signer = createSign('sha256');
		signer.update(nonce);
		signer.end();
		const signature = signer.sign(key);
		const verifier = createVerify('sha256');
		verifier.update(nonce);
		verifier.end();
		// `leaf.publicKey` is already a public KeyObject; wrapping it again throws in Bun.
		return verifier.verify(leaf.publicKey, signature);
	} catch {
		return false;
	}
}

/** Validate an uploaded pair for `host`, returning the parsed leaf or a `ValidationError`. */
export function validateCertificatePair(host: string, certPem: string, keyPem: string): ParsedCertificate {
	const parsed = parseCertificatePem(certPem);
	if (!certificateCoversHost(parsed.hosts, host))
		throw new ValidationError(
			`The certificate does not cover ${normalizeCertificateHost(host)} (it names ${parsed.hosts.join(', ') || 'nothing'}).`,
		);
	if (parsed.notAfter <= Date.now()) throw new ValidationError('The certificate has already expired.');
	if (!/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(keyPem))
		throw new ValidationError('The private key is not a PEM private key.');
	if (!keyPairMatches(certPem, keyPem))
		throw new ValidationError('The private key does not match the certificate.');
	return parsed;
}
