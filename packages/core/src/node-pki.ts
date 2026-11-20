import {
	X509Certificate,
	constants as cryptoConstants,
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	sign,
	verify,
	type KeyObject,
} from 'node:crypto';

/**
 * The tiny X.509/PKCS#10 layer the per-install CA needs (HA-PLAN H24 "Trust", CLUSTERING §4.3).
 *
 * The control plane issues a leaf from a node's CSR; the node's private key never travels. This is
 * deliberately local DER building/parsing rather than a new dependency: the shapes are four fixed
 * extensions and one CSR attribute, and the certificate must be small and predictable. It is not a
 * general-purpose X.509 library and refuses anything outside the shapes below.
 */

const CERTIFICATE_PEM = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/;
const CSR_PEM = /-----BEGIN CERTIFICATE REQUEST-----([\s\S]+?)-----END CERTIFICATE REQUEST-----/;

const OID = {
	commonName: '2.5.4.3',
	ecdsaWithSha256: '1.2.840.10045.4.3.2',
	ecdsaWithSha384: '1.2.840.10045.4.3.3',
	ecdsaWithSha512: '1.2.840.10045.4.3.4',
	sha256WithRsa: '1.2.840.113549.1.1.11',
	sha384WithRsa: '1.2.840.113549.1.1.12',
	sha512WithRsa: '1.2.840.113549.1.1.13',
	extensionRequest: '1.2.840.113549.1.9.14',
	subjectAltName: '2.5.29.17',
	basicConstraints: '2.5.29.19',
	keyUsage: '2.5.29.15',
	extKeyUsage: '2.5.29.37',
	serverAuth: '1.3.6.1.5.5.7.3.1',
	clientAuth: '1.3.6.1.5.5.7.3.2',
} as const;

// ----------------------------------------------------------------------------------------- DER

function derLength(n: number): Buffer {
	if (n < 0x80) return Buffer.from([n]);
	const bytes: number[] = [];
	for (let value = n; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const setOf = (...parts: Buffer[]) => tlv(0x31, ...parts);

function oid(dotted: string): Buffer {
	const [a, b, ...rest] = dotted.split('.').map(Number);
	const bytes = [a! * 40 + b!];
	for (const value of rest) {
		const chunk: number[] = [value & 0x7f];
		for (let v = Math.floor(value / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
		bytes.push(...chunk);
	}
	return tlv(0x06, Buffer.from(bytes));
}

function integer(bytes: Buffer): Buffer {
	let value = bytes;
	while (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) value = value.subarray(1);
	if (value[0]! & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
	return tlv(0x02, value);
}

function boolean(value: boolean): Buffer {
	return tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function bitString(bytes: Buffer, unusedBits = 0): Buffer {
	return tlv(0x03, Buffer.from([unusedBits]), bytes);
}

function octetString(bytes: Buffer): Buffer {
	return tlv(0x04, bytes);
}

function utf8(value: string): Buffer {
	return tlv(0x0c, Buffer.from(value, 'utf8'));
}

function time(date: Date): Buffer {
	const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
	// UTCTime until 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5).
	return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

function name(commonName: string): Buffer {
	return sequence(setOf(sequence(oid(OID.commonName), utf8(commonName))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
	return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

function pemToDer(pem: string, pattern: RegExp, label: string): Buffer {
	const match = pattern.exec(pem);
	if (!match) throw new Error(`Give one PEM ${label}.`);
	return Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64');
}

function derToPem(der: Buffer, label: string): string {
	const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// -------------------------------------------------------------------------------------- reading

interface Asn1Node {
	tag: number;
	start: number;
	headerLength: number;
	contentStart: number;
	contentEnd: number;
	end: number;
}

function readNode(buffer: Buffer, offset: number): Asn1Node {
	if (offset + 2 > buffer.length) throw new Error('Truncated DER value.');
	const tag = buffer[offset]!;
	let length = buffer[offset + 1]!;
	let headerLength = 2;
	if (length & 0x80) {
		const count = length & 0x7f;
		if (count === 0 || count > 4 || offset + 2 + count > buffer.length) throw new Error('Bad DER length.');
		length = 0;
		for (let i = 0; i < count; i++) length = length * 256 + buffer[offset + 2 + i]!;
		headerLength = 2 + count;
	}
	const contentStart = offset + headerLength;
	const contentEnd = contentStart + length;
	if (contentEnd > buffer.length) throw new Error('Truncated DER value.');
	return { tag, start: offset, headerLength, contentStart, contentEnd, end: contentEnd };
}

function children(buffer: Buffer, node: Asn1Node): Asn1Node[] {
	const nodes: Asn1Node[] = [];
	let offset = node.contentStart;
	while (offset < node.contentEnd) {
		const child = readNode(buffer, offset);
		nodes.push(child);
		offset = child.end;
	}
	return nodes;
}

function content(buffer: Buffer, node: Asn1Node): Buffer {
	return buffer.subarray(node.contentStart, node.contentEnd);
}

function decodeOid(buffer: Buffer, node: Asn1Node): string {
	const bytes = content(buffer, node);
	if (bytes.length === 0) throw new Error('Empty OID.');
	let value = 0;
	const arcs: number[] = [];
	for (const byte of bytes) {
		value = value * 128 + (byte & 0x7f);
		if ((byte & 0x80) === 0) {
			arcs.push(value);
			value = 0;
		}
	}
	if (arcs.length === 0) throw new Error('Bad OID.');
	const first = arcs.shift()!;
	const head = first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
	return [...head, ...arcs].join('.');
}

function decodeString(buffer: Buffer, node: Asn1Node): string | null {
	const bytes = content(buffer, node);
	switch (node.tag) {
		case 0x0c: // UTF8String
		case 0x13: // PrintableString
		case 0x16: // IA5String
		case 0x14: // TeletexString
			return bytes.toString('utf8');
		default:
			return null;
	}
}

function commonNames(buffer: Buffer, subject: Asn1Node): string[] {
	const names: string[] = [];
	for (const rdn of children(buffer, subject)) {
		if (rdn.tag !== 0x31) continue;
		for (const attribute of children(buffer, rdn)) {
			const [type, value] = children(buffer, attribute);
			if (!type || !value || decodeOid(buffer, type) !== OID.commonName) continue;
			const text = decodeString(buffer, value);
			if (text !== null) names.push(text);
		}
	}
	return names;
}

// ------------------------------------------------------------------------------------- issuance

export interface InstallCa {
	keyPem: string;
	certPem: string;
	/** Lowercase hex SHA-256 of the certificate. */
	fingerprint: string;
	subject: string;
	notBefore: Date;
	notAfter: Date;
}

export interface ParsedNodeCsr {
	commonName: string;
	spkiDer: Buffer;
	/** Lowercase hex SHA-256 of the SubjectPublicKeyInfo. */
	publicKeySha256: string;
	publicKey: KeyObject;
}

const SUPPORTED_SIGNATURES: Record<string, { hash: string; rsa: boolean }> = {
	[OID.ecdsaWithSha256]: { hash: 'sha256', rsa: false },
	[OID.ecdsaWithSha384]: { hash: 'sha384', rsa: false },
	[OID.ecdsaWithSha512]: { hash: 'sha512', rsa: false },
	[OID.sha256WithRsa]: { hash: 'sha256', rsa: true },
	[OID.sha384WithRsa]: { hash: 'sha384', rsa: true },
	[OID.sha512WithRsa]: { hash: 'sha512', rsa: true },
};

/** Create the install CA: an EC P-256 key and a self-signed CA certificate. */
export function generateInstallCa(commonName: string, now = Date.now(), validityDays = 3_650): InstallCa {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	const spki = publicKey.export({ type: 'spki', format: 'der' });
	const notBefore = new Date(now - 60_000);
	const notAfter = new Date(now + validityDays * 24 * 3600_000);
	const algorithm = sequence(oid(OID.ecdsaWithSha256));
	const subject = name(commonName);
	const tbs = sequence(
		tlv(0xa0, integer(Buffer.from([2]))),
		integer(randomBytes(16)),
		algorithm,
		subject,
		sequence(time(notBefore), time(notAfter)),
		subject,
		spki,
		tlv(
			0xa3,
			sequence(
				// cA = TRUE, critical.
				extension(OID.basicConstraints, true, sequence(boolean(true))),
				// keyCertSign (5) and cRLSign (6), critical.
				extension(OID.keyUsage, true, bitString(Buffer.from([0x06]), 1)),
			),
		),
	);
	const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
	const certPem = derToPem(sequence(tbs, algorithm, bitString(signature)), 'CERTIFICATE');
	return {
		keyPem,
		certPem,
		fingerprint: createHash('sha256').update(pemToDer(certPem, CERTIFICATE_PEM, 'certificate')).digest('hex'),
		subject: `CN=${commonName}`,
		notBefore,
		notAfter,
	};
}

/** Sign one node leaf from its CSR's public key: CN = node id, URI SAN `yoal://node/<id>`. */
export function issueNodeCertificate(input: {
	caCertPem: string;
	caKeyPem: string;
	caCommonName: string;
	nodeId: string;
	spkiDer: Buffer;
	serialHex: string;
	notBefore: Date;
	notAfter: Date;
}): string {
	const algorithm = sequence(oid(OID.ecdsaWithSha256));
	const issuer = name(input.caCommonName);
	const subject = name(input.nodeId);
	const san = sequence(tlv(0x86, Buffer.from(`yoal://node/${input.nodeId}`, 'utf8')));
	const tbs = sequence(
		tlv(0xa0, integer(Buffer.from([2]))),
		integer(Buffer.from(input.serialHex, 'hex')),
		algorithm,
		issuer,
		sequence(time(input.notBefore), time(input.notAfter)),
		subject,
		input.spkiDer,
		tlv(
			0xa3,
			sequence(
				// Not a CA, critical.
				extension(OID.basicConstraints, true, sequence()),
				// digitalSignature (0) and keyEncipherment (5), critical.
				extension(OID.keyUsage, true, bitString(Buffer.from([0x84]), 2)),
				// TLS server and client, so the same leaf is both ends of the forwarder.
				extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth), oid(OID.clientAuth))),
				extension(OID.subjectAltName, false, san),
			),
		),
	);
	const signature = sign('sha256', tbs, { key: createPrivateKey(input.caKeyPem), dsaEncoding: 'der' });
	return derToPem(sequence(tbs, algorithm, bitString(signature)), 'CERTIFICATE');
}

/**
 * Parse and verify a node's PKCS#10 request. Refuses a subject that is not exactly `nodeId`, a key
 * below P-256/2048-bit, a bad self-signature, or any extension beyond the one URI SAN.
 */
export function parseNodeCsr(csrPem: string, nodeId: string): ParsedNodeCsr {
	const der = pemToDer(csrPem, CSR_PEM, 'certificate signing request');
	const outer = readNode(der, 0);
	if (outer.tag !== 0x30 || outer.end !== der.length) throw new Error('The CSR is not one DER sequence.');
	const [info, algorithmNode, signatureNode] = children(der, outer);
	if (!info || !algorithmNode || !signatureNode || signatureNode.tag !== 0x03)
		throw new Error('The CSR is malformed.');
	const algorithmOid = children(der, algorithmNode)[0];
	if (!algorithmOid) throw new Error('The CSR names no signature algorithm.');
	const signature = SUPPORTED_SIGNATURES[decodeOid(der, algorithmOid)];
	if (!signature) throw new Error('The CSR uses an unsupported signature algorithm.');
	const [version, subject, spkiNode, attributes] = children(der, info);
	if (!version || version.tag !== 0x02 || !subject || !spkiNode)
		throw new Error('The CSR is missing its subject or public key.');
	const subjectNames = commonNames(der, subject);
	if (subjectNames.length !== 1 || subjectNames[0] !== nodeId)
		throw new Error(`The CSR subject must be CN=${nodeId}.`);

	const spkiDer = der.subarray(spkiNode.start, spkiNode.end);
	let publicKey: KeyObject;
	try {
		publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
	} catch {
		throw new Error('The CSR public key is not a supported key.');
	}
	if (!keyIsStrong(publicKey)) throw new Error('The CSR public key is too weak: use EC P-256 or RSA 2048+.');
	const signatureValue = content(der, signatureNode).subarray(1);
	const verified = verify(
		signature.hash,
		der.subarray(info.start, info.end),
		signature.rsa
			? { key: publicKey, padding: cryptoConstants.RSA_PKCS1_PADDING }
			: { key: publicKey, dsaEncoding: 'der' },
		signatureValue,
	);
	if (!verified) throw new Error('The CSR signature does not verify.');

	if (attributes && attributes.tag === 0xa0) checkRequestedExtensions(der, attributes, nodeId);

	return {
		commonName: nodeId,
		spkiDer,
		publicKeySha256: createHash('sha256').update(spkiDer).digest('hex'),
		publicKey,
	};
}

function keyIsStrong(key: KeyObject): boolean {
	if (key.asymmetricKeyType === 'rsa') return (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
	if (key.asymmetricKeyType === 'ec') {
		const curve = key.asymmetricKeyDetails?.namedCurve ?? '';
		return ['prime256v1', 'secp384r1', 'secp521r1'].includes(curve);
	}
	return false;
}

/**
 * Only the URI SAN naming this node may be requested. Anything else (a CA bit, another SAN, a
 * key-usage change) would let a node ask for an identity the control plane did not intend.
 */
function checkRequestedExtensions(der: Buffer, attributes: Asn1Node, nodeId: string): void {
	for (const attribute of children(der, attributes)) {
		const [type, values] = children(der, attribute);
		if (!type || !values) continue;
		if (decodeOid(der, type) !== OID.extensionRequest) throw new Error('The CSR asks for an unsupported attribute.');
		const extensions = children(der, values)[0];
		if (!extensions || extensions.tag !== 0x30) throw new Error('The CSR extension request is malformed.');
		for (const requested of children(der, extensions)) {
			const parts = children(der, requested);
			const idNode = parts[0];
			if (!idNode) throw new Error('The CSR extension request is malformed.');
			const id = decodeOid(der, idNode);
			const valueNode = parts.at(-1);
			if (!valueNode || valueNode.tag !== 0x04) throw new Error('The CSR extension request is malformed.');
			if (id !== OID.subjectAltName) throw new Error(`The CSR asks for an unsupported extension (${id}).`);
			const inner = content(der, valueNode);
			const list = readNode(inner, 0);
			const names = children(inner, list);
			if (names.length !== 1 || names[0]!.tag !== 0x86)
				throw new Error("The CSR's subjectAltName must be exactly one URI.");
			if (content(inner, names[0]!).toString('utf8') !== `yoal://node/${nodeId}`)
				throw new Error(`The CSR's subjectAltName must name yoal://node/${nodeId}.`);
		}
	}
}

/** Parse a certificate's SAN URI names (used by tests and diagnostics). */
export function certificateUris(certPem: string): string[] {
	const certificate = new X509Certificate(certPem);
	return certificate.subjectAltName
		?.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith('URI:'))
		.map((entry) => entry.slice(4)) ?? [];
}
