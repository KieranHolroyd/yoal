import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import { acmeLeases, domains, ingressCertificates, nodes } from '@yoal/db';
import {
	ACME_LEASE_TTL_MS,
	BYO_EXPIRY_ALERT_DAYS,
	CERT_RENEWAL_WINDOW_MS,
	type AcmeLease,
	type CertificateActivation,
	type CertificateActivationEntry,
	type CertificateRelay,
	type CertificateUpload,
	type IngressCertificateView,
	type Principal,
	certificateFleetFingerprint,
	normalizeCertificateHost,
} from '@yoal/contracts';
import { featureEnabled } from '../config.ts';
import type { CoreContext } from '../context.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { ingressNodeIds, nodeRoles } from '../ingress.ts';
import { decrypt, encrypt, newId, randomToken, sha256Hex } from '../util.ts';
import { type CertificateIssuer, acmeIssuerFromEnv } from './issuer.ts';
import { validateCertificatePair } from './pem.ts';

/**
 * Shared certificates (HA-PLAN H20, W7). One issuer, one sealed pair per host, every ingress
 * fingerprinting the same set.
 *
 * - The flag off path writes nothing: `fingerprint()` is null, an activation is empty and Caddy on
 *   the node keeps issuing per-host exactly as today.
 * - The key is sealed with the platform master key (`ingress_certificates.key_sealed`). No view,
 *   heartbeat, log, audit argument or desired-state document ever reads it; only `distribute()`
 *   opens it, over the node-authenticated activation.
 * - A host has at most one live row and one ACME lease at a time; the partial unique index in 0122
 *   and the lease table are the enforcement, not this process's memory.
 */
export interface CertificateAlert {
	key: string;
	title: string;
	detail: string;
	severity: 'info' | 'warning' | 'critical';
}

export interface CertificateSweepReport {
	skipped: boolean;
	due: string[];
	expiredLeases: string[];
	alerts: CertificateAlert[];
}

export interface CertificateRenewalReport {
	skipped: string | null;
	due: string[];
	renewed: string[];
	errors: Array<{ host: string; error: string }>;
}

export interface ClaimedLease extends AcmeLease {
	acquired: boolean;
}

export interface CertificateListView {
	fingerprint: string | null;
	certificates: IngressCertificateView[];
}

/** The certificate columns every read path may see. `key_sealed` is deliberately absent. */
interface PublicCertificateRow {
	id: string;
	host: string;
	serial: string;
	fingerprint: string;
	certPem: string;
	source: 'acme' | 'byo';
	notAfter: number;
	renewedAt: number | null;
	revokedAt: number | null;
	reissueRequestedAt: number | null;
	createdAt: number;
}

const DAY_MS = 86_400_000;
/** Retry every 6 h after a failed order (CLUSTERING §7.3). */
const RENEW_RETRY_MS = 6 * 3_600_000;
/** One renewal attempt per host per 10 minutes, even if the maintenance sweep runs every minute. */
const RENEW_COOLDOWN_MS = 10 * 60_000;

export class CertificateService {
	private issuer: CertificateIssuer | null;
	private lastRenewAt = 0;
	private readonly retryAfter = new Map<string, number>();
	/** Hosts the fleet should serve but has no row for yet (cold start); filled by `bootstrap()`. */
	private readonly bootstrapHosts = new Set<string>();

	constructor(private readonly ctx: CoreContext) {
		this.issuer = acmeIssuerFromEnv();
	}

	/** Replace the issuer (tests, or an embedder wiring ACME differently). */
	setIssuer(issuer: CertificateIssuer | null): void {
		this.issuer = issuer;
	}

	enabled(): boolean {
		return featureEnabled(this.ctx.config, 'SHARED_CERTIFICATES');
	}

	/** The one fingerprint every ingress should report; null when nothing is distributed. */
	fingerprint(): string | null {
		if (!this.enabled()) return null;
		return certificateFleetFingerprint(this.liveRows().map((row) => ({ host: row.host, fingerprint: row.fingerprint })));
	}

	/** Public shape for the dashboard/CLI: never includes the key or the sealed envelope. */
	view(principal: Principal): CertificateListView {
		if (!this.ctx.platformIam.canView(principal)) throw new ForbiddenError('platform:read');
		if (!this.enabled()) return { fingerprint: null, certificates: [] };
		return { fingerprint: this.fingerprint(), certificates: this.liveRows().map((row) => this.toView(row)) };
	}

	/** What an ingress agent last reported, for `IngressSetService.view()` and the preflight. */
	reportedFingerprint(nodeId: string): string | null {
		if (!this.enabled()) return null;
		const row = this.ctx.db
			.select({ certificateFingerprint: nodes.certificateFingerprint })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		return row?.certificateFingerprint ?? null;
	}

	/** Persist a heartbeat's report (only while the feature is on; flag off stays null). */
	report(nodeId: string, fingerprint: string | null | undefined): void {
		if (!this.enabled()) return;
		this.ctx.db
			.update(nodes)
			.set({ certificateFingerprint: fingerprint ?? null })
			.where(eq(nodes.id, nodeId))
			.run();
	}

	// ------------------------------------------------------------------ ACME lease

	/** The live lease for `host`, or null. Expired rows are ignored (and swept). */
	leaseFor(host: string): AcmeLease | null {
		const wanted = normalizeCertificateHost(host);
		const row = this.ctx.db.select().from(acmeLeases).where(eq(acmeLeases.host, wanted)).get();
		if (!row || row.expiresAt <= this.ctx.now()) return null;
		return { host: row.host, nodeId: row.nodeId, token: row.token, expiresAt: row.expiresAt };
	}

	/**
	 * Take or renew the lease for `host` on `nodeId`. One holder per host: a live lease held by
	 * another node comes back with `acquired: false`, never stolen before its TTL ends.
	 */
	claimLease(host: string, nodeId: string, ttlMs = ACME_LEASE_TTL_MS): ClaimedLease {
		if (!this.enabled()) throw new ConflictError('Shared certificates are off (YOAL_FEATURE_SHARED_CERTIFICATES).');
		const wanted = normalizeCertificateHost(host);
		if (!this.leaseEligible(nodeId))
			throw new ValidationError(`"${nodeId}" cannot hold an ACME lease: it is not an ingress with the ingress-set capability.`);
		if (ttlMs < 60_000 || ttlMs > 3_600_000) throw new ValidationError('An ACME lease TTL is between 1 and 60 minutes.');
		const now = this.ctx.now();
		const current = this.ctx.db.select().from(acmeLeases).where(eq(acmeLeases.host, wanted)).get();
		if (current && current.expiresAt > now && current.nodeId !== nodeId)
			return {
				host: current.host,
				nodeId: current.nodeId,
				token: current.token,
				expiresAt: current.expiresAt,
				acquired: false,
			};
		const token = current && current.nodeId === nodeId && current.expiresAt > now ? current.token : randomToken(24);
		const expiresAt = now + ttlMs;
		this.ctx.db
			.insert(acmeLeases)
			.values({ host: wanted, nodeId, token, expiresAt, createdAt: current?.createdAt ?? now })
			.onConflictDoUpdate({ target: acmeLeases.host, set: { nodeId, token, expiresAt } })
			.run();
		return { host: wanted, nodeId, token, expiresAt, acquired: true };
	}

	/** Renew only if this node still holds the lease; false when another node has taken it. */
	renewLease(host: string, nodeId: string, ttlMs = ACME_LEASE_TTL_MS): boolean {
		const lease = this.leaseFor(host);
		if (!lease || lease.nodeId !== nodeId) return false;
		this.claimLease(host, nodeId, ttlMs);
		return true;
	}

	releaseLease(host: string, nodeId?: string): boolean {
		const wanted = normalizeCertificateHost(host);
		const result = this.ctx.sqlite.run(
			nodeId ? 'DELETE FROM acme_leases WHERE host = ? AND node_id = ?' : 'DELETE FROM acme_leases WHERE host = ?',
			nodeId ? [wanted, nodeId] : [wanted],
		);
		return Number(result.changes ?? 0) > 0;
	}

	/** Remove leases past their TTL; returns the hosts, so a sweep can report the takeover. */
	expireLeases(): string[] {
		const now = this.ctx.now();
		const expired = this.ctx.db.select({ host: acmeLeases.host }).from(acmeLeases).where(lte(acmeLeases.expiresAt, now)).all();
		if (expired.length > 0) this.ctx.db.delete(acmeLeases).where(lte(acmeLeases.expiresAt, now)).run();
		return expired.map((row) => row.host);
	}

	/** Where this host's challenges must be relayed, while a lease exists. */
	relaysFor(host?: string): CertificateRelay[] {
		if (!this.enabled()) return [];
		const now = this.ctx.now();
		const leases = host
			? this.ctx.db.select().from(acmeLeases).where(eq(acmeLeases.host, normalizeCertificateHost(host))).all()
			: this.ctx.db.select().from(acmeLeases).all();
		return leases
			.filter((lease) => lease.expiresAt > now)
			.flatMap((lease) => {
				const upstream = this.responderUpstream(lease.nodeId);
				return upstream ? [{ host: lease.host, upstream }] : [];
			});
	}

	// ------------------------------------------------------------------ distribution

	/**
	 * The node-authenticated activation body (CLUSTERING §7.3 "Distribution"). Only an ingress may
	 * fetch it; the key is opened here, at the control plane, and travels over the node-token
	 * channel, never in desired state.
	 */
	distribute(nodeId: string): CertificateActivation {
		const empty: CertificateActivation = { generation: 0, fingerprint: null, certificates: [], relays: [] };
		// Every agent asks on start and every 6 h; a node that is not an ingress gets nothing, so a
		// worker neither sees a key nor logs a refusal on each poll.
		if (!this.enabled() || !this.leaseEligible(nodeId)) return empty;
		// The only path that reads the sealed envelope: it is opened here, for this node's channel.
		const rows = this.ctx.db.select().from(ingressCertificates).where(isNull(ingressCertificates.revokedAt)).all();
		const relays = this.relaysFor().filter((relay) => this.leaseHolder(relay.host) !== nodeId);
		const certificates: CertificateActivationEntry[] = rows.map((row) => ({
			host: row.host,
			fingerprint: row.fingerprint,
			chainPem: row.certPem,
			keyPem: this.openKey(row.keySealed),
			notAfter: row.notAfter,
			source: row.source,
		}));
		const fingerprint = certificateFleetFingerprint(rows.map((row) => ({ host: row.host, fingerprint: row.fingerprint })));
		const generation =
			certificates.length === 0 && relays.length === 0
				? 0
				: Number.parseInt(
						sha256Hex(
							JSON.stringify({
								certificates: certificates.map((entry) => [entry.host, entry.fingerprint, entry.notAfter]),
								relays: relays.map((relay) => [relay.host, relay.upstream]),
							}),
						).slice(0, 8),
						16,
					) & 0x7fffffff;
		return { generation, fingerprint, certificates, relays };
	}

	// ------------------------------------------------------------------ ingestion

	/**
	 * The lease holder uploads the pair its issuer produced. The upload is refused unless this node
	 * holds the host's lease, so two issuers cannot race a key into the store.
	 */
	ingest(nodeId: string, input: CertificateUpload): IngressCertificateView {
		if (!this.enabled()) throw new ConflictError('Shared certificates are off (YOAL_FEATURE_SHARED_CERTIFICATES).');
		const host = normalizeCertificateHost(input.host);
		const lease = this.leaseFor(host);
		if (!lease || lease.nodeId !== nodeId)
			throw new ValidationError(`Only the ACME lease holder for ${host} may upload its certificate.`);
		const parsed = validateCertificatePair(host, input.certPem, input.keyPem);
		const now = this.ctx.now();
		if (parsed.notAfter <= now) throw new ValidationError('The certificate has already expired.');
		const row = this.store(host, input.certPem, input.keyPem, parsed.fingerprint, parsed.serial, parsed.notAfter, 'acme', now);
		this.ctx.projects.bump();
		return this.toView(row);
	}

	/** An operator brings a certificate. It is distributed like an issued one and never renewed. */
	uploadByo(principal: Principal, input: CertificateUpload): IngressCertificateView {
		this.requireAdmin(principal);
		if (!this.enabled()) throw new ConflictError('Shared certificates are off (YOAL_FEATURE_SHARED_CERTIFICATES).');
		const host = normalizeCertificateHost(input.host);
		const parsed = validateCertificatePair(host, input.certPem, input.keyPem);
		const now = this.ctx.now();
		if (parsed.notAfter <= now) throw new ValidationError('The certificate has already expired.');
		const row = this.store(host, input.certPem, input.keyPem, parsed.fingerprint, parsed.serial, parsed.notAfter, 'byo', now);
		this.ctx.audit.record({
			principal,
			action: 'certificate.upload_byo',
			resource: 'ingress_certificate',
			resourceId: row.id,
			args: { host, fingerprint: row.fingerprint, notAfter: row.notAfter },
			result: 'ok',
		});
		this.ctx.projects.bump();
		return this.toView(row);
	}

	/** Revoke one host's live certificate (an operator removing a name, or a compromised key). */
	remove(principal: Principal, host: string): { removed: boolean } {
		this.requireAdmin(principal);
		if (!this.enabled()) throw new ConflictError('Shared certificates are off (YOAL_FEATURE_SHARED_CERTIFICATES).');
		const wanted = normalizeCertificateHost(host);
		const now = this.ctx.now();
		const result = this.ctx.sqlite.run(
			'UPDATE ingress_certificates SET revoked_at = ?, reissue_requested_at = NULL WHERE host = ? AND revoked_at IS NULL',
			[now, wanted],
		);
		const removed = Number(result.changes ?? 0) > 0;
		if (removed) {
			this.ctx.audit.record({
				principal,
				action: 'certificate.remove',
				resource: 'ingress_certificate',
				resourceId: wanted,
				args: { host: wanted },
				result: 'ok',
			});
			this.ctx.projects.bump();
		}
		return { removed };
	}

	/** Ask the next sweep to renew one host (or every ACME host) now. */
	requestReissue(principal: Principal | null, host?: string): { requested: string[] } {
		if (!this.enabled()) return { requested: [] };
		if (principal) this.requireAdmin(principal);
		const now = this.ctx.now();
		const targets = this.liveRows()
			.filter((row) => row.source === 'acme' && (!host || row.host === normalizeCertificateHost(host)))
			.map((row) => row.host);
		if (targets.length === 0) {
			if (host) throw new NotFoundError('Certificate');
			return { requested: [] };
		}
		for (const target of targets)
			this.ctx.db
				.update(ingressCertificates)
				.set({ reissueRequestedAt: now })
				.where(and(eq(ingressCertificates.host, target), isNull(ingressCertificates.revokedAt)))
				.run();
		if (principal)
			this.ctx.audit.record({
				principal,
				action: 'certificate.reissue',
				resource: 'ingress_certificate',
				resourceId: host ?? 'all',
				args: { hosts: targets },
				result: 'ok',
			});
		this.ctx.projects.bump();
		return { requested: targets };
	}

	/**
	 * An ingress left the fleet. Taking its DNS address away does not take the key back
	 * (CLUSTERING §7.3 "Key security"), so every ACME host is reissued; BYO keys are the operator's
	 * and are only alerted on, never replaced.
	 */
	onIngressRemoved(nodeId: string): string[] {
		if (!this.enabled()) return [];
		const now = this.ctx.now();
		const hosts = this.liveRows()
			.filter((row) => row.source === 'acme')
			.map((row) => row.host);
		for (const host of hosts)
			this.ctx.db
				.update(ingressCertificates)
				.set({ reissueRequestedAt: now })
				.where(and(eq(ingressCertificates.host, host), isNull(ingressCertificates.revokedAt)))
				.run();
		const result = this.ctx.sqlite.run('DELETE FROM acme_leases WHERE node_id = ?', [nodeId]);
		if (hosts.length > 0 || Number(result.changes ?? 0) > 0) this.ctx.projects.bump();
		return hosts;
	}

	/**
	 * The hostnames an install with shared certificates must serve: the content apex and its
	 * one-level wildcard, the platform host, and every verified custom domain (CLUSTERING §7.3).
	 */
	wantedHosts(): string[] {
		const wanted = new Set<string>();
		const content = normalizeCertificateHost(this.ctx.config.contentDomain);
		if (content && content !== 'localhost') {
			wanted.add(content);
			wanted.add(`*.${content}`);
		}
		try {
			const platform = new URL(this.ctx.config.platformOrigin).hostname;
			if (platform && platform !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(platform))
				wanted.add(normalizeCertificateHost(platform));
		} catch {
			/* a malformed origin is refused elsewhere; it adds no wanted host */
		}
		const custom = this.ctx.db
			.select({ host: domains.hostname })
			.from(domains)
			.where(inArray(domains.status, ['verified', 'active']))
			.all()
			.map((row) => normalizeCertificateHost(row.host));
		for (const host of custom) wanted.add(host);
		return [...wanted].sort();
	}

	/**
	 * Seed the cold start: a flag-on fleet has no rows yet, so the sweep has nothing to renew.
	 * Returns the wanted hosts that have no row at all; `renewDue` issues them under the lease.
	 * A BYO or ACME row for the host is respected, so this never overwrites an operator's upload.
	 */
	bootstrap(): string[] {
		if (!this.enabled()) return [];
		// Any row for the host is the decision, including a revoked one: an operator's removal must
		// not be undone by the next bootstrap pass.
		const existing = new Set(
			this.ctx.db
				.select({ host: ingressCertificates.host })
				.from(ingressCertificates)
				.all()
				.map((row) => normalizeCertificateHost(row.host)),
		);
		for (const host of this.wantedHosts()) if (!existing.has(host)) this.bootstrapHosts.add(host);
		for (const host of [...this.bootstrapHosts]) if (existing.has(host)) this.bootstrapHosts.delete(host);
		return [...this.bootstrapHosts].sort();
	}

	// ------------------------------------------------------------------ sweep and renewal

	/**
	 * The renewal/alert sweep (maintenance, every 60 s). Pure reads plus lease expiry: the control
	 * plane decides what is due and what an operator must see. Issuance is `renewDue()`.
	 */
	sweep(): CertificateSweepReport {
		if (!this.enabled()) return { skipped: true, due: [], expiredLeases: [], alerts: [] };
		const expiredLeases = this.expireLeases();
		const now = this.ctx.now();
		const due: string[] = [];
		const alerts: CertificateAlert[] = [];
		for (const row of this.liveRows()) {
			if (row.source === 'acme') {
				if (row.reissueRequestedAt !== null || row.notAfter - now <= CERT_RENEWAL_WINDOW_MS) due.push(row.host);
				continue;
			}
			// BYO: never renewed, so its expiry is the operator's to act on. One alert per threshold.
			const remainingDays = (row.notAfter - now) / DAY_MS;
			// The tightest threshold it has crossed: 3 before 14 before 30.
			const threshold = [...BYO_EXPIRY_ALERT_DAYS].reverse().find((days) => remainingDays <= days);
			if (threshold === undefined) continue;
			const critical = threshold <= 3 || remainingDays <= 0;
			alerts.push({
				key: `certificate:byo:${threshold}:${row.host}:${row.notAfter}`,
				title: remainingDays <= 0 ? 'Brought certificate expired' : `Brought certificate expires in ${threshold} days`,
				detail:
					remainingDays <= 0
						? `The certificate uploaded for ${row.host} expired at ${new Date(row.notAfter).toISOString()}. Yoal never renews a brought certificate; upload a replacement.`
						: `The certificate uploaded for ${row.host} expires in ${Math.max(0, remainingDays).toFixed(1)} days. Yoal never renews it; upload a replacement before it expires.`,
				severity: critical ? 'critical' : 'warning',
			});
		}
		return { skipped: false, due: [...new Set(due)].sort(), expiredLeases, alerts };
	}

	/**
	 * Issue what the sweep found due, under the lease. The holder is the first eligible online
	 * ingress; the control-plane issuer runs the order and the holder relays the challenges. A dead
	 * holder costs one lease TTL, not the certificate.
	 */
	async renewDue(options: { force?: boolean } = {}): Promise<CertificateRenewalReport> {
		const empty: CertificateRenewalReport = { skipped: null, due: [], renewed: [], errors: [] };
		if (!this.enabled()) return { ...empty, skipped: 'flag_off' };
		const now = this.ctx.now();
		if (!options.force && now - this.lastRenewAt < RENEW_COOLDOWN_MS) return { ...empty, skipped: 'cooldown' };
		const sweep = this.sweep();
		const due = [...new Set([...sweep.due, ...this.bootstrapHosts])].sort();
		if (due.length === 0) return empty;
		const issuer = this.issuer;
		if (!issuer) return { ...empty, due, skipped: 'no_issuer' };
		const candidates = due.filter((host) => (this.retryAfter.get(host) ?? 0) <= now);
		if (candidates.length === 0) return { ...empty, due, skipped: 'retry_wait' };
		this.lastRenewAt = now;
		const holder = this.pickHolder();
		if (!holder)
			return {
				...empty,
				due: candidates,
				skipped: 'no_holder',
				errors: candidates.map((host) => ({ host, error: 'no online ingress can hold the ACME lease' })),
			};
		const renewed: string[] = [];
		const errors: Array<{ host: string; error: string }> = [];
		for (const host of candidates) {
			const lease = this.claimLease(host, holder);
			if (!lease.acquired) {
				errors.push({ host, error: `lease held by ${lease.nodeId}` });
				continue;
			}
			try {
				const pair = await issuer.issue(host, { relay: this.relaysFor(host)[0] });
				this.ingest(holder, { host, certPem: pair.certPem, keyPem: pair.keyPem });
				this.bootstrapHosts.delete(host);
				this.retryAfter.delete(host);
				renewed.push(host);
			} catch (cause) {
				this.retryAfter.set(host, this.ctx.now() + RENEW_RETRY_MS);
				errors.push({ host, error: (cause as Error).message });
			} finally {
				this.releaseLease(host, holder);
			}
		}
		return { skipped: null, due: candidates, renewed, errors };
	}

	// ------------------------------------------------------------------ internals

	/**
	 * Every read path except `distribute` uses this projection: `key_sealed` is not selected at all,
	 * so a view, a fingerprint or a sweep cannot leak it even by accident.
	 */
	private liveRows(): PublicCertificateRow[] {
		return this.ctx.db
			.select({
				id: ingressCertificates.id,
				host: ingressCertificates.host,
				serial: ingressCertificates.serial,
				fingerprint: ingressCertificates.fingerprint,
				certPem: ingressCertificates.certPem,
				source: ingressCertificates.source,
				notAfter: ingressCertificates.notAfter,
				renewedAt: ingressCertificates.renewedAt,
				revokedAt: ingressCertificates.revokedAt,
				reissueRequestedAt: ingressCertificates.reissueRequestedAt,
				createdAt: ingressCertificates.createdAt,
			})
			.from(ingressCertificates)
			.where(isNull(ingressCertificates.revokedAt))
			.all();
	}

	private toView(row: PublicCertificateRow): IngressCertificateView {
		return {
			id: row.id,
			host: row.host,
			serial: row.serial,
			fingerprint: row.fingerprint,
			source: row.source,
			notAfter: row.notAfter,
			renewedAt: row.renewedAt,
			revokedAt: row.revokedAt,
			reissueRequestedAt: row.reissueRequestedAt,
		};
	}

	/** One live row per host: the partial unique index makes the old one revocation part of the write. */
	private store(
		host: string,
		certPem: string,
		keyPem: string,
		fingerprint: string,
		serial: string,
		notAfter: number,
		source: 'acme' | 'byo',
		now: number,
	): typeof ingressCertificates.$inferSelect {
		const sealed = encrypt(this.ctx.config.masterKey, new TextEncoder().encode(keyPem));
		const id = newId('cert_');
		this.ctx.db.transaction(() => {
			this.ctx.db
				.update(ingressCertificates)
				.set({ revokedAt: now, reissueRequestedAt: null })
				.where(and(eq(ingressCertificates.host, host), isNull(ingressCertificates.revokedAt)))
				.run();
			this.ctx.db
				.insert(ingressCertificates)
				.values({
					id,
					host,
					serial,
					fingerprint,
					certPem,
					keySealed: JSON.stringify(sealed),
					source,
					notAfter,
					renewedAt: source === 'acme' ? now : null,
					revokedAt: null,
					reissueRequestedAt: null,
					createdAt: now,
				})
				.run();
		});
		const row = this.ctx.db.select().from(ingressCertificates).where(eq(ingressCertificates.id, id)).get();
		if (!row) throw new Error('The certificate was not stored.');
		return row;
	}

	private openKey(sealed: string): string {
		const envelope = JSON.parse(sealed) as { ciphertext: string; nonce: string };
		return new TextDecoder().decode(decrypt(this.ctx.config.masterKey, envelope.ciphertext, envelope.nonce));
	}

	private leaseHolder(host: string): string | null {
		return this.leaseFor(host)?.nodeId ?? null;
	}

	private responderUpstream(nodeId: string): string | null {
		const row = this.ctx.db
			.select({ privateAddress: nodes.privateAddress, publicAddress: nodes.publicAddress })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		const address = row?.privateAddress ?? row?.publicAddress;
		if (!address) return null;
		return `http://${address}:${this.ctx.config.acmeChallengePort ?? 8089}`;
	}

	/** An ingress (or the compatibility first ingress) that advertises the ingress-set capability. */
	private leaseEligible(nodeId: string): boolean {
		const row = this.ctx.db
			.select({ id: nodes.id, mode: nodes.mode, rolesJson: nodes.rolesJson })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		if (!row) return false;
		// Delivery is only to a member of the ingress set: a control-only node is not an ingress,
		// whatever capability it advertises.
		return this.ctx.ingressSet.isIngress(nodeId) && this.ctx.ingressSet.capable(nodeId);
	}

	private pickHolder(): string | null {
		for (const nodeId of this.ctx.ingressSet.nodes()) {
			if (!this.leaseEligible(nodeId)) continue;
			const row = this.ctx.db.select({ status: nodes.status }).from(nodes).where(eq(nodes.id, nodeId)).get();
			if (row?.status === 'online') return nodeId;
		}
		return null;
	}

	private requireAdmin(principal: Principal): void {
		if (!this.ctx.platformIam.canAdminister(principal)) throw new ForbiddenError('platform:settings');
	}
}
