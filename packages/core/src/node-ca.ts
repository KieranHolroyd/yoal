import { and, desc, eq, isNotNull, isNull, gt } from 'drizzle-orm';
import { nodeCa, nodeCaCertificates } from '@yoal/db';
import {
	NODE_CERT_VALIDITY_DAYS,
	NODE_CA_VALIDITY_DAYS,
	type NodeCaView,
	type NodeCsr,
	type NodeTrustDesired,
	type Principal,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, ValidationError } from './errors.ts';
import { generateInstallCa, issueNodeCertificate, parseNodeCsr } from './node-pki.ts';
import { decrypt, encrypt, newId, randomBytes, sha256Hex } from './util.ts';

/**
 * The per-install CA (HA-PLAN H24 "Trust", CLUSTERING §4.3). Owned by Wave 1 lane B (issuance in
 * core); lane A makes nodes generate keys, send `nodeCsr` and trust `nodeTrust`. Backed by
 * `node_ca` and `node_ca_certificates` (0118). The CA key is sealed with the master key and never
 * leaves this service; nothing here ever handles a node's private key. Unreachable while
 * `ENDPOINTS_GATEWAY` is off: no desired state carries `nodeTrust` and no CSR is signed.
 */
export interface SignedNodeCertificate {
	serial: string;
	certPem: string;
	/** ISO 8601. */
	notAfter: string;
}

/** The install CA and its leaves, for `yoal ha status` and `GET /api/v1/ha/status`. */
export interface NodeCaStatus {
	/** ENDPOINTS_GATEWAY is on, so nodes use the CA for endpoint mTLS. */
	inUse: boolean;
	/** The active CA first, then a previous one still trusted after a rotation. */
	authorities: NodeCaView[];
	leaves: {
		issued: number;
		/** Not revoked and not expired. */
		live: number;
		/** Nodes holding a live leaf. */
		nodes: number;
		revoked: number;
		/** Nodes past two-thirds of their leaf's life (they renew on their next heartbeat). */
		renewDue: number;
		/** Nodes whose leaf the previous CA signed: rotating again before this is 0 cuts them off. */
		onPreviousCa: number;
		nextExpiry: string | null;
	};
}

const CA_COMMON_NAME = 'Yoal install CA';

type CaRow = typeof nodeCa.$inferSelect;
type LeafRow = typeof nodeCaCertificates.$inferSelect;

export class NodeCaService {
	constructor(private readonly ctx: CoreContext) {}

	/** Create the install CA if there is none; return the active one. */
	issue(): NodeCaView {
		const existing = this.activeRow();
		return this.view(existing ?? this.createActive());
	}

	/**
	 * Rotate the install CA: the current one becomes `previous` (still trusted by every bundle) and
	 * a new one signs from now. Existing leaves stay valid until their own renewal, so no node loses
	 * mTLS at the moment of rotation.
	 */
	rotate(): NodeCaView {
		if (!featureEnabled(this.ctx.config, 'ENDPOINTS_GATEWAY'))
			throw new ValidationError('The install CA is not in use until ENDPOINTS_GATEWAY is on.');
		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			// Keep one previous CA at most: an older previous is retired (its leaves are long gone or
			// already superseded).
			this.ctx.db.update(nodeCa).set({ state: 'retired', updatedAt: now }).where(eq(nodeCa.state, 'previous')).run();
			this.ctx.db.update(nodeCa).set({ state: 'previous', updatedAt: now }).where(eq(nodeCa.state, 'active')).run();
			this.createActive();
		})();
		this.ctx.projects.bump();
		return this.view(this.activeRow()!);
	}

	private createActive(): CaRow {
		const generated = generateInstallCa(CA_COMMON_NAME, this.ctx.now(), NODE_CA_VALIDITY_DAYS);
		const sealed = encrypt(this.ctx.config.masterKey, new TextEncoder().encode(generated.keyPem));
		const id = newId('nca_');
		const now = this.ctx.now();
		this.ctx.db
			.insert(nodeCa)
			.values({
				id,
				state: 'active',
				certPem: generated.certPem,
				keySealed: JSON.stringify(sealed),
				fingerprint: generated.fingerprint,
				subject: generated.subject,
				notBefore: generated.notBefore.getTime(),
				notAfter: generated.notAfter.getTime(),
				issuedCount: 0,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		// A concurrent caller may have won the partial unique index; its row is the one that signs.
		const row = this.activeRow();
		if (!row) throw new ValidationError('Could not create the install CA.');
		return row;
	}

	/**
	 * Sign a CSR from `nodeId`. Refuses a CSR whose subject is not that node, whose key is weak,
	 * or that asks for anything beyond CN = node id and URI SAN `yoal://node/<id>`.
	 */
	signCsr(nodeId: string, csr: NodeCsr): SignedNodeCertificate {
		if (!featureEnabled(this.ctx.config, 'ENDPOINTS_GATEWAY'))
			throw new ValidationError('The install CA is not in use until ENDPOINTS_GATEWAY is on.');
		let parsed;
		try {
			parsed = parseNodeCsr(csr.csrPem, nodeId);
		} catch (cause) {
			throw new ValidationError(`The node certificate request was refused: ${(cause as Error).message}`);
		}
		const now = this.ctx.now();
		// A re-sent CSR for the same key is answered with the leaf it already has, not re-signed
		// (the partial unique index enforces the same thing).
		const live = this.ctx.db
			.select()
			.from(nodeCaCertificates)
			.where(
				and(
					eq(nodeCaCertificates.nodeId, nodeId),
					eq(nodeCaCertificates.publicKeySha256, parsed.publicKeySha256),
					isNull(nodeCaCertificates.revokedAt),
				),
			)
			.get();
		// Renew at two-thirds of the leaf's life, so a control plane that is unreachable during the
		// last day does not let the leaf expire. A re-sent CSR before that gets its existing leaf.
		const renewAt = live ? live.notBefore + ((live.notAfter - live.notBefore) * 2) / 3 : 0;
		if (live && now < renewAt) return this.signed(live);

		this.issue();
		const caRow = this.activeRow()!;
		const keyPem = new TextDecoder().decode(
			decrypt(
				this.ctx.config.masterKey,
				(JSON.parse(caRow.keySealed) as { ciphertext: string }).ciphertext,
				(JSON.parse(caRow.keySealed) as { nonce: string }).nonce,
			),
		);
		const serial = randomBytes(16).toString('hex');
		const notBefore = new Date(now - 60_000);
		const notAfter = new Date(now + NODE_CERT_VALIDITY_DAYS * 86_400_000);
		const certPem = issueNodeCertificate({
			caCertPem: caRow.certPem,
			caKeyPem: keyPem,
			caCommonName: caRow.subject.replace(/^CN=/, '') || CA_COMMON_NAME,
			nodeId,
			spkiDer: parsed.spkiDer,
			serialHex: serial,
			notBefore,
			notAfter,
		});
		this.ctx.db.transaction(() => {
			// One live leaf per node: a renewal or re-key supersedes the old one in the same write.
			this.ctx.db
				.update(nodeCaCertificates)
				.set({ revokedAt: now, revokeReason: 'superseded' })
				.where(and(eq(nodeCaCertificates.nodeId, nodeId), isNull(nodeCaCertificates.revokedAt)))
				.run();
			this.ctx.db
				.insert(nodeCaCertificates)
				.values({
					serial,
					caId: caRow.id,
					nodeId,
					certPem,
					publicKeySha256: parsed.publicKeySha256,
					reason: csr.reason,
					notBefore: notBefore.getTime(),
					notAfter: notAfter.getTime(),
					createdAt: now,
				})
				.run();
			this.ctx.db
				.update(nodeCa)
				.set({ issuedCount: caRow.issuedCount + 1, updatedAt: now })
				.where(eq(nodeCa.id, caRow.id))
				.run();
		});
		this.ctx.projects.bump();
		return { serial, certPem, notAfter: notAfter.toISOString() };
	}

	/** Every CA a node should trust right now, as one PEM bundle. */
	bundle(): string {
		this.issue();
		const rows = this.ctx.db
			.select()
			.from(nodeCa)
			.where(eq(nodeCa.state, 'active'))
			.all()
			.concat(this.ctx.db.select().from(nodeCa).where(eq(nodeCa.state, 'previous')).all())
			.sort((a, b) => a.createdAt - b.createdAt);
		return rows
			.slice(-3)
			.map((row) => row.certPem.trim())
			.join('\n');
	}

	/** `nodeTrust` for one node's desired state, or null before the CA exists. */
	trustFor(nodeId: string): NodeTrustDesired | null {
		if (!featureEnabled(this.ctx.config, 'ENDPOINTS_GATEWAY')) return null;
		this.issue();
		const caBundlePem = this.bundle();
		const leaf =
			this.ctx.db
				.select()
				.from(nodeCaCertificates)
				.where(and(eq(nodeCaCertificates.nodeId, nodeId), isNull(nodeCaCertificates.revokedAt)))
				.orderBy(desc(nodeCaCertificates.notAfter))
				.get() ?? null;
		// Only unexpired revocations matter: an expired leaf is refused by its dates anyway. The cap
		// then counts real, still-usable revocations rather than history (a compromised node that
		// re-keys repeatedly must not push an older revoked leaf out of the list while it is valid).
		const revokedSerials = this.ctx.db
			.select({ serial: nodeCaCertificates.serial })
			.from(nodeCaCertificates)
			.where(and(isNotNull(nodeCaCertificates.revokedAt), gt(nodeCaCertificates.notAfter, this.ctx.now())))
			.orderBy(desc(nodeCaCertificates.revokedAt))
			.limit(1_000)
			.all()
			.map((row) => row.serial);
		// The generation covers every input, so a new leaf or a revocation reloads listeners once.
		const generation = Number.parseInt(
			sha256Hex(
				JSON.stringify({
					bundle: caBundlePem,
					serial: leaf?.serial ?? null,
					notAfter: leaf?.notAfter ?? null,
					revoked: revokedSerials,
				}),
			).slice(0, 8),
			16,
		);
		return {
			generation: generation & 0x7fffffff,
			caBundlePem,
			certificatePem: leaf?.certPem ?? null,
			serial: leaf?.serial ?? null,
			notAfter: leaf ? new Date(leaf.notAfter).toISOString() : null,
			revokedSerials,
		};
	}

	/** ENDPOINTS_GATEWAY is on: nodes use the install CA for endpoint mTLS. */
	inUse(): boolean {
		return featureEnabled(this.ctx.config, 'ENDPOINTS_GATEWAY');
	}

	/** `GET /api/v1/ha/ca`: the status, for platform operators. */
	statusFor(principal: Principal): NodeCaStatus {
		if (!this.ctx.platformIam.allows(principal, 'platform:ha'))
			throw new CoreError('forbidden', 'High availability is for platform operators and admins.', 403);
		return this.status();
	}

	/**
	 * `POST /api/v1/ha/ca/rotate` and `yoal ha ca rotate`, audited. A platform admin only (a platform
	 * operator reads the CA). Refused while a node still holds a leaf the previous CA signed: a second
	 * rotation retires that CA and the node would lose mTLS with every peer until it renews.
	 */
	rotateAs(principal: Principal): NodeCaStatus {
		if (!this.ctx.platformIam.canAdminister(principal))
			throw new CoreError('forbidden', 'Only a platform admin role can rotate the install CA.', 403);
		const waiting = this.status().leaves.onPreviousCa;
		if (waiting > 0)
			throw new ConflictError(
				`${waiting} ${waiting === 1 ? 'node still holds a certificate' : 'nodes still hold certificates'} the previous CA signed. Rotating again would retire that CA and cut ${waiting === 1 ? 'it' : 'them'} off from every peer; wait until each has renewed (yoal ha ca shows the count).`,
			);
		const before = this.activeRow()?.fingerprint ?? null;
		const active = this.rotate();
		this.ctx.audit.record({
			principal,
			action: 'ha.ca.rotate',
			resource: 'platform',
			resourceId: 'node-ca',
			args: { previous: before, active: active.fingerprint },
			result: 'ok',
		});
		return this.status();
	}

	/**
	 * The install CA as `yoal ha status` shows it: the CAs nodes trust, and the leaves they hold.
	 * Read-only: it never creates the CA (that happens on the first node that needs a leaf).
	 */
	status(): NodeCaStatus {
		const now = this.ctx.now();
		const authorities = this.ctx.db
			.select()
			.from(nodeCa)
			.all()
			.filter((row) => row.state !== 'retired')
			// The CA that signs first, then the one still trusted after a rotation.
			.sort((a, b) => (a.state === b.state ? b.createdAt - a.createdAt : a.state === 'active' ? -1 : 1))
			.map((row) => this.view(row));
		const leaves = this.ctx.db.select().from(nodeCaCertificates).all();
		const live = leaves.filter((row) => row.revokedAt === null && row.notAfter > now);
		// The newest live leaf per node is the one it serves; a node renews at two-thirds of its life.
		const newest = new Map<string, LeafRow>();
		for (const row of live) if ((newest.get(row.nodeId)?.notAfter ?? 0) < row.notAfter) newest.set(row.nodeId, row);
		const renewDue = [...newest.values()].filter((row) => now >= row.notBefore + ((row.notAfter - row.notBefore) * 2) / 3).length;
		const soonest = [...newest.values()].sort((a, b) => a.notAfter - b.notAfter)[0];
		const previousIds = new Set(
			this.ctx.db.select({ id: nodeCa.id }).from(nodeCa).where(eq(nodeCa.state, 'previous')).all().map((row) => row.id),
		);
		return {
			inUse: this.inUse(),
			authorities,
			leaves: {
				issued: leaves.length,
				live: live.length,
				nodes: newest.size,
				revoked: leaves.filter((row) => row.revokedAt !== null).length,
				renewDue,
				onPreviousCa: [...newest.values()].filter((row) => previousIds.has(row.caId)).length,
				nextExpiry: soonest ? new Date(soonest.notAfter).toISOString() : null,
			},
		};
	}


	revoke(nodeId: string, reason: string): number {
		const result = this.ctx.sqlite.run(
			'UPDATE node_ca_certificates SET revoked_at = ?, revoke_reason = ? WHERE node_id = ? AND revoked_at IS NULL',
			[this.ctx.now(), reason.slice(0, 200), nodeId],
		);
		const changes = Number(result.changes ?? 0);
		if (changes > 0) this.ctx.projects.bump();
		return changes;
	}

	private activeRow(): CaRow | undefined {
		return this.ctx.db.select().from(nodeCa).where(eq(nodeCa.state, 'active')).get();
	}

	private signed(row: LeafRow): SignedNodeCertificate {
		return { serial: row.serial, certPem: row.certPem, notAfter: new Date(row.notAfter).toISOString() };
	}

	private view(row: CaRow): NodeCaView {
		return {
			fingerprint: row.fingerprint,
			subject: row.subject,
			notBefore: new Date(row.notBefore).toISOString(),
			notAfter: new Date(row.notAfter).toISOString(),
			state: row.state,
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}
}
