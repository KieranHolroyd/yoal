import { and, desc, eq, inArray, isNull, lt, lte } from 'drizzle-orm';
import {
	databaseCredentials,
	databasePublicAccess,
	databasePublicAccessEvents,
	databasePublicAccessNodes,
	databases,
	nodes,
	serviceEndpoints,
} from '@yoal/db';
import {
	PUBLIC_ACCESS_ANYWHERE,
	PUBLIC_ACCESS_EVENTS_KEPT,
	PUBLIC_ACCESS_MAX_EXPIRY_MS,
	PUBLIC_DATABASE_PORT_MAX,
	PUBLIC_DATABASE_PORT_MIN,
	PUBLIC_DB_CAPABILITY,
	checkPublicCidr,
	databaseIdentifier,
	databasePublicAccessInputSchema,
	databaseUrlDatabase,
	publicAccessProtocol,
	publicAccessUnsupportedReason,
	publicDatabaseHost,
	publicDatabaseUrl,
	publicDatabaseWildcard,
	type DatabasePublicAccessSummary,
	type DatabasePublicAccessView,
	type Principal,
	type PublicAccessCredentialView,
	type PublicAccessEventView,
	type PublicAccessNodeView,
	type PublicAccessRule,
	type PublicAccessStatus,
	type PublicDatabaseEvent,
	type PublicDatabaseListener,
	type PublicDatabaseStatus,
	type PublicRefusalReason,
} from '@yoal/contracts';
import { nodeHasCapability } from './capability-gate.ts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import type { DatabaseRow } from './databases.ts';
import type { EndpointService } from './endpoints.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { buildSystemPrincipal } from './iam/system.ts';
import { parseJson } from './util.ts';

/**
 * Public database access (docs/DATABASES.md §19, D241).
 *
 * The control plane owns the configuration, the port and the audit trail; ingress agents own the
 * listeners. Nothing here ever reaches a socket: a change bumps desired state and the agents
 * converge. A narrowing (disable, fewer CIDRs or roles, expiry) is never blocked on anything.
 */

type AccessRow = typeof databasePublicAccess.$inferSelect;
type CredentialRow = typeof databaseCredentials.$inferSelect;

/** Roles a person may name instead of a credential id. `monitor` is Yoal's own and never allowed. */
const ROLE_SHORTCUTS = ['owner', 'app', 'readonly', 'backup'] as const;
/** A node report older than this no longer counts as current. */
const REPORT_STALE_MS = 2 * 60_000;

export class DatabasePublicAccessService {
	constructor(private readonly ctx: CoreContext) {}

	// ------------------------------------------------------------------------------- surfaces

	/** `GET /databases/:name/public-access`. Needs `database:read`; carries no secret. */
	get(principal: Principal, name: string): DatabasePublicAccessView {
		const db = this.ctx.databases.requireRow(principal, name);
		this.ctx.databases.requireDatabasePermission(principal, 'database:read', db);
		return this.view(db, this.row(db.id));
	}

	/**
	 * Enable, or replace the whole configuration. Needs `database:expose` (step-up, never MCP).
	 * Validation happens before anything is written, and the audit row lists the rules.
	 */
	enable(principal: Principal, name: string, raw: unknown): DatabasePublicAccessView {
		const db = this.ctx.databases.requireRow(principal, name);
		this.ctx.databases.requireDatabasePermission(principal, 'database:expose', db);
		if (principal.kind === 'mcp')
			throw new CoreError('forbidden', 'Public database access is never changed over MCP. Use the dashboard or the CLI.', 403);
		if (!featureEnabled(this.ctx.config, 'DB_PUBLIC_ACCESS'))
			throw new CoreError('feature_disabled', 'Public database access is turned off on this install (YOAL_FEATURE_DB_PUBLIC_ACCESS).', 403);
		const protocol = publicAccessProtocol(db.engine);
		if (!protocol) throw new ValidationError(publicAccessUnsupportedReason(db.engine) ?? 'This engine cannot be exposed.');
		const input = databasePublicAccessInputSchema.parse(raw);

		// Sources.
		const rules: PublicAccessRule[] = [];
		const seen = new Set<string>();
		const problems: string[] = [];
		for (const rule of input.rules) {
			const checked = checkPublicCidr(rule.cidr);
			if (!checked.ok) {
				problems.push(checked.reason);
				continue;
			}
			if (seen.has(checked.cidr)) continue;
			seen.add(checked.cidr);
			rules.push({ cidr: checked.cidr, label: rule.label });
		}
		if (problems.length > 0) throw new ValidationError(problems.join(' '));
		if (input.allowAnywhere) {
			if (!featureEnabled(this.ctx.config, 'DB_PUBLIC_ANYWHERE'))
				throw new ValidationError(
					'This install does not allow public access from any address. List the CIDRs your app connects from, or ask an operator to set YOAL_FEATURE_DB_PUBLIC_ANYWHERE=1.',
				);
		} else if (rules.length === 0) {
			throw new ValidationError('List at least one CIDR the app connects from (for example 203.0.113.0/24).');
		}

		// Roles (Postgres): the proxy refuses every other `user` before the database sees it.
		let credentialIds: string[] = [];
		if (protocol === 'postgres') {
			if (input.credentials.length === 0)
				throw new ValidationError(
					'Choose the credentials that may log in through public access (for example an app or readonly credential, or owner).',
				);
			credentialIds = [...new Set(input.credentials.map((ref) => this.resolveCredential(db, ref).id))];
		} else if (input.credentials.length > 0) {
			throw new ValidationError('Only Postgres restricts roles at the proxy; leave credentials empty for this engine.');
		}

		// Expiry.
		const now = this.ctx.now();
		let expiresAt: number | null = null;
		if (input.expiresAt !== null) {
			expiresAt = Date.parse(input.expiresAt);
			if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new ValidationError('expiresAt must be in the future.');
			if (expiresAt - now > PUBLIC_ACCESS_MAX_EXPIRY_MS) throw new ValidationError('expiresAt may be at most a year ahead.');
		}

		// At least one ingress must be able to serve it, or the URL would never answer.
		const ingress = this.ingressNodes();
		if (!ingress.some((node) => node.capable)) {
			const names = ingress.map((node) => node.name).join(', ');
			throw new ConflictError(
				ingress.length === 0
					? 'No ingress node is configured, so nothing can serve public access.'
					: `Public access needs an ingress node running an agent with "${PUBLIC_DB_CAPABILITY}"; update ${names} first.`,
			);
		}

		const existing = this.row(db.id);
		const wasEnabled = existing?.enabled === true;
		const values = {
			enabled: true,
			rules: JSON.stringify(rules),
			allowAnywhere: input.allowAnywhere,
			credentialIds: JSON.stringify(credentialIds),
			maxConnections: input.maxConnections,
			expiresAt,
			enabledAt: wasEnabled ? (existing?.enabledAt ?? now) : now,
			enabledBy: wasEnabled ? (existing?.enabledBy ?? principal.userId) : principal.userId,
			disabledAt: null,
			disabledReason: null,
			updatedAt: now,
			updatedBy: principal.userId,
		};
		this.ctx.db.transaction(() => {
			if (existing) {
				this.ctx.db
					.update(databasePublicAccess)
					.set({ ...values, version: existing.version + 1 })
					.where(eq(databasePublicAccess.databaseId, db.id))
					.run();
			} else {
				this.ctx.db
					.insert(databasePublicAccess)
					.values({ databaseId: db.id, orgId: db.orgId, port: this.allocatePort(), version: 1, ...values })
					.run();
			}
		});
		this.ctx.audit.record({
			principal,
			action: wasEnabled ? 'database.public-access.update' : 'database.public-access.enable',
			resource: 'database',
			resourceId: db.id,
			args: {
				name,
				rules: rules.map((rule) => (rule.label ? `${rule.cidr} (${rule.label})` : rule.cidr)),
				allowAnywhere: input.allowAnywhere,
				credentials: credentialIds,
				maxConnections: input.maxConnections,
				expiresAt: input.expiresAt,
			},
			result: 'ok',
		});
		this.changed(db.orgId);
		return this.view(db, this.row(db.id));
	}

	/** Turn public access off. Needs only `database:update`: narrowing is never harder than widening. */
	disable(principal: Principal, name: string): DatabasePublicAccessView {
		const db = this.ctx.databases.requireRow(principal, name, { includeDeleted: true });
		this.ctx.databases.requireDatabasePermission(principal, 'database:update', db);
		const row = this.row(db.id);
		if (row?.enabled) {
			this.turnOff(row, 'manual', principal.userId);
			this.ctx.audit.record({
				principal,
				action: 'database.public-access.disable',
				resource: 'database',
				resourceId: db.id,
				args: { name },
				result: 'ok',
			});
			this.changed(db.orgId);
		}
		return this.view(db, this.row(db.id));
	}

	/** The summary `DatabaseView.publicAccess` carries. */
	summary(db: DatabaseRow): DatabasePublicAccessSummary {
		const row = this.row(db.id);
		const host = row ? this.host(db) : null;
		return {
			enabled: row?.enabled === true,
			status: this.status(db, row).status,
			host,
			port: row?.port ?? null,
			expiresAt: row?.expiresAt ? new Date(row.expiresAt).toISOString() : null,
		};
	}

	/**
	 * The outside URL for a role, or null when that role cannot use public access right now. Used
	 * by the credentials reveal, which already checked and audited the caller.
	 */
	publicUrlFor(db: DatabaseRow, credential: { id: string | null; username: string; password: string }): string | null {
		const row = this.row(db.id);
		if (!row?.enabled || db.deletedAt) return null;
		const protocol = publicAccessProtocol(db.engine);
		if (!protocol) return null;
		if (protocol === 'postgres') {
			const allowed = this.allowedUsers(db, row);
			if (!allowed.includes(credential.username)) return null;
		}
		return publicDatabaseUrl({
			engine: db.engine,
			user: credential.username,
			pass: credential.password,
			host: this.host(db),
			port: row.port,
			database: databaseUrlDatabase(db.engine, databaseIdentifier(db.name)),
		});
	}

	// ------------------------------------------------------------------------------- runtime

	/**
	 * Listeners for one node's desired state: every enabled, live database, on an ingress node with
	 * the capability, while the kill switch is on. Empty otherwise (the field is then omitted).
	 */
	listenersForNode(nodeId: string, isIngress: boolean, capabilitiesJson: string | null): PublicDatabaseListener[] {
		if (!isIngress || !featureEnabled(this.ctx.config, 'DB_PUBLIC_ACCESS')) return [];
		if (!nodeHasCapability({ capabilitiesJson }, PUBLIC_DB_CAPABILITY)) return [];
		const now = this.ctx.now();
		const rows = this.ctx.db
			.select({ access: databasePublicAccess, db: databases })
			.from(databasePublicAccess)
			.innerJoin(databases, eq(databases.id, databasePublicAccess.databaseId))
			.where(and(eq(databasePublicAccess.enabled, true), isNull(databases.deletedAt)))
			.all();
		const endpointPorts = new Map(
			this.ctx.db
				.select({ serviceId: serviceEndpoints.serviceId, localPort: serviceEndpoints.localPort, role: serviceEndpoints.role })
				.from(serviceEndpoints)
				.where(and(eq(serviceEndpoints.consumerNodeId, nodeId), eq(serviceEndpoints.serviceKind, 'database')))
				.all()
				.filter((row) => row.role === 'primary')
				.map((row) => [row.serviceId, row.localPort]),
		);
		const out: PublicDatabaseListener[] = [];
		for (const { access, db } of rows) {
			const protocol = publicAccessProtocol(db.engine);
			if (!protocol) continue;
			// Past its expiry it is not rendered at all; the sweep records the reason shortly after.
			if (access.expiresAt !== null && access.expiresAt <= now) continue;
			const host = this.host(db);
			const upstreamPort = db.nodeId === nodeId ? db.hostPort : (endpointPorts.get(db.id) ?? null);
			out.push({
				id: db.id,
				port: access.port,
				protocol,
				host,
				certificateNames: [host, publicDatabaseWildcard(this.ctx.config.contentDomain)],
				allow: access.allowAnywhere ? [...PUBLIC_ACCESS_ANYWHERE] : parseJson<PublicAccessRule[]>(access.rules, []).map((rule) => rule.cidr),
				users: protocol === 'postgres' ? this.allowedUsers(db, access) : [],
				upstreamPort,
				maxConnections: access.maxConnections,
				expiresAt: access.expiresAt !== null ? new Date(access.expiresAt).toISOString() : null,
				version: access.version,
			});
		}
		return out.sort((a, b) => a.port - b.port);
	}

	/**
	 * Databases an ingress needs a C2 service endpoint for: enabled public access to a database on
	 * another node. `ServiceEndpointService.reconcile` adds these to the ingress's plan, so the
	 * provider listener, its client pin and failover re-pointing are the attachment machinery's.
	 */
	endpointServicesFor(consumerNodeId: string): EndpointService[] {
		if (!featureEnabled(this.ctx.config, 'DB_PUBLIC_ACCESS')) return [];
		if (!this.ctx.ingressSet.nodes().includes(consumerNodeId)) return [];
		return this.ctx.db
			.select({ id: databases.id, nodeId: databases.nodeId, port: databases.hostPort, engine: databases.engine })
			.from(databasePublicAccess)
			.innerJoin(databases, eq(databases.id, databasePublicAccess.databaseId))
			.where(and(eq(databasePublicAccess.enabled, true), isNull(databases.deletedAt)))
			.all()
			.filter((row) => row.nodeId !== consumerNodeId && publicAccessProtocol(row.engine) !== null)
			.map((row) => ({ kind: 'database' as const, serviceId: row.id, upstreamNodeId: row.nodeId, upstreamPort: row.port }));
	}

	/** Store an ingress's listener reports and refusals from its heartbeat. */
	ingestHeartbeat(nodeId: string, statuses: readonly PublicDatabaseStatus[] | undefined, events: readonly PublicDatabaseEvent[] | undefined): void {
		if (statuses === undefined && events === undefined) return;
		const now = this.ctx.now();
		const known = new Set(
			this.ctx.db
				.select({ id: databasePublicAccess.databaseId })
				.from(databasePublicAccess)
				.all()
				.map((row) => row.id),
		);
		this.ctx.db.transaction(() => {
			if (statuses !== undefined) {
				// The report is the whole set for this node: a listener that left desired state is gone.
				this.ctx.db.delete(databasePublicAccessNodes).where(eq(databasePublicAccessNodes.nodeId, nodeId)).run();
				for (const status of statuses) {
					if (!known.has(status.id)) continue;
					this.ctx.db
						.insert(databasePublicAccessNodes)
						.values({
							databaseId: status.id,
							nodeId,
							state: status.state,
							error: status.error,
							open: status.open,
							accepted: status.accepted,
							refused: status.refused,
							authFailures: status.authFailures,
							banned: status.banned,
							version: status.version,
							reportedAt: now,
						})
						.run();
				}
			}
			const touched = new Set<string>();
			for (const event of events ?? []) {
				if (!known.has(event.id)) continue;
				const at = Date.parse(event.at);
				this.ctx.db
					.insert(databasePublicAccessEvents)
					.values({
						databaseId: event.id,
						nodeId,
						at: Number.isFinite(at) ? Math.min(at, now) : now,
						source: event.source,
						reason: event.reason,
						detail: event.detail,
					})
					.run();
				touched.add(event.id);
			}
			for (const databaseId of touched) this.trimEvents(databaseId);
		});
	}

	/**
	 * Maintenance: turn off access whose expiry passed (the agents already closed it at that time)
	 * and forget rows of purged databases, which frees their ports.
	 */
	sweep(): { expired: number; forgotten: number } {
		const now = this.ctx.now();
		const due = this.ctx.db
			.select()
			.from(databasePublicAccess)
			.where(and(eq(databasePublicAccess.enabled, true), lte(databasePublicAccess.expiresAt, now)))
			.all();
		for (const row of due) {
			this.turnOff(row, 'expired', 'system:public-access');
			const db = this.ctx.db.select({ name: databases.name }).from(databases).where(eq(databases.id, row.databaseId)).get();
			this.ctx.audit.record({
				principal: buildSystemPrincipal('system:public-access', row.orgId),
				action: 'database.public-access.expire',
				resource: 'database',
				resourceId: row.databaseId,
				args: { name: db?.name ?? row.databaseId },
				result: 'ok',
			});
		}
		const live = new Set(
			this.ctx.db
				.select({ id: databases.id })
				.from(databases)
				.all()
				.map((row) => row.id),
		);
		const orphans = this.ctx.db
			.select({ id: databasePublicAccess.databaseId })
			.from(databasePublicAccess)
			.all()
			.filter((row) => !live.has(row.id))
			.map((row) => row.id);
		if (orphans.length > 0)
			this.ctx.db.transaction(() => {
				this.ctx.db.delete(databasePublicAccess).where(inArray(databasePublicAccess.databaseId, orphans)).run();
				this.ctx.db.delete(databasePublicAccessNodes).where(inArray(databasePublicAccessNodes.databaseId, orphans)).run();
				this.ctx.db.delete(databasePublicAccessEvents).where(inArray(databasePublicAccessEvents.databaseId, orphans)).run();
			});
		if (due.length > 0) this.changed(null);
		return { expired: due.length, forgotten: orphans.length };
	}

	/** A deleted database loses public access: a restore must not reopen it silently. */
	onDatabaseDeleted(databaseId: string, principal: Principal): void {
		const row = this.row(databaseId);
		if (!row?.enabled) return;
		this.turnOff(row, 'manual', principal.userId);
		this.ctx.audit.record({
			principal,
			action: 'database.public-access.disable',
			resource: 'database',
			resourceId: databaseId,
			args: { reason: 'database deleted' },
			result: 'ok',
		});
		this.changed(row.orgId);
	}

	// ------------------------------------------------------------------------------- internals

	private row(databaseId: string): AccessRow | undefined {
		return this.ctx.db.select().from(databasePublicAccess).where(eq(databasePublicAccess.databaseId, databaseId)).get();
	}

	private host(db: DatabaseRow): string {
		return publicDatabaseHost(db.name, db.orgId, this.ctx.config.contentDomain);
	}

	private turnOff(row: AccessRow, reason: 'manual' | 'expired', by: string | null): void {
		const now = this.ctx.now();
		this.ctx.db
			.update(databasePublicAccess)
			.set({ enabled: false, disabledAt: now, disabledReason: reason, version: row.version + 1, updatedAt: now, updatedBy: by })
			.where(eq(databasePublicAccess.databaseId, row.databaseId))
			.run();
	}

	/** Bump desired state and re-plan every ingress's service endpoints (cross-node upstreams). */
	private changed(orgId: string | null): void {
		for (const nodeId of this.ctx.ingressSet.nodes()) {
			try {
				this.ctx.endpoints.reconcile(null, nodeId);
			} catch (error) {
				console.error('[public-access] endpoint reconcile failed:', error);
			}
		}
		if (orgId) this.ctx.projects.bump(orgId);
		else this.ctx.projects.bump();
	}

	/** Lowest free port in 24000–24999, counting every row (a disabled database keeps its port). */
	private allocatePort(): number {
		const used = new Set(
			this.ctx.db
				.select({ port: databasePublicAccess.port })
				.from(databasePublicAccess)
				.all()
				.map((row) => row.port),
		);
		for (let port = PUBLIC_DATABASE_PORT_MIN; port <= PUBLIC_DATABASE_PORT_MAX; port += 1) if (!used.has(port)) return port;
		throw new ConflictError('Every public database port (24000–24999) is taken.');
	}

	private credentialsOf(databaseId: string): CredentialRow[] {
		return this.ctx.db.select().from(databaseCredentials).where(eq(databaseCredentials.databaseId, databaseId)).all();
	}

	/** A credential id, or a role when exactly one ready credential has it. Never `monitor`. */
	private resolveCredential(db: DatabaseRow, ref: string): CredentialRow {
		const live = this.credentialsOf(db.id).filter(
			(item) => item.role !== 'monitor' && item.status !== 'revoked' && item.status !== 'revoking',
		);
		let credential: CredentialRow | undefined;
		if ((ROLE_SHORTCUTS as readonly string[]).includes(ref)) {
			const matches = live.filter((item) => item.role === ref && item.status === 'ready');
			if (matches.length === 0) throw new NotFoundError(`A ready ${ref} credential on "${db.name}"`);
			if (matches.length > 1)
				throw new ValidationError(`"${db.name}" has ${matches.length} ready ${ref} credentials; pass the credential id instead.`);
			credential = matches[0];
		} else {
			credential = live.find((item) => item.id === ref);
			if (!credential) throw new NotFoundError(`Credential "${ref}" on "${db.name}"`);
		}
		if (!credential || credential.status !== 'ready')
			throw new ConflictError(`Credential "${ref}" is not ready yet. Wait for the node to provision it.`);
		if (credential.expiresAt !== null && credential.expiresAt <= this.ctx.now())
			throw new ConflictError(`Credential "${ref}" has expired.`);
		return credential;
	}

	/** Usernames the proxy lets in: listed credentials that are still ready and unexpired. */
	private allowedUsers(db: DatabaseRow, row: AccessRow): string[] {
		const ids = new Set(parseJson<string[]>(row.credentialIds, []));
		if (ids.size === 0) return [];
		const now = this.ctx.now();
		return [
			...new Set(
				this.credentialsOf(db.id)
					.filter((item) => ids.has(item.id) && this.usable(item, now))
					.map((item) => item.username),
			),
		].sort();
	}

	private usable(item: CredentialRow, now: number): boolean {
		return item.role !== 'monitor' && item.status === 'ready' && (item.expiresAt === null || item.expiresAt > now);
	}

	private trimEvents(databaseId: string): void {
		const cutoff = this.ctx.db
			.select({ id: databasePublicAccessEvents.id })
			.from(databasePublicAccessEvents)
			.where(eq(databasePublicAccessEvents.databaseId, databaseId))
			.orderBy(desc(databasePublicAccessEvents.id))
			.limit(1)
			.offset(PUBLIC_ACCESS_EVENTS_KEPT - 1)
			.get();
		if (!cutoff) return;
		this.ctx.db
			.delete(databasePublicAccessEvents)
			.where(and(eq(databasePublicAccessEvents.databaseId, databaseId), lt(databasePublicAccessEvents.id, cutoff.id)))
			.run();
	}

	private ingressNodes(): Array<{ id: string; name: string; capable: boolean; capabilitiesJson: string | null }> {
		const ids = this.ctx.ingressSet.nodes();
		if (ids.length === 0) return [];
		return this.ctx.db
			.select({ id: nodes.id, name: nodes.name, capabilitiesJson: nodes.capabilitiesJson })
			.from(nodes)
			.where(inArray(nodes.id, ids))
			.all()
			.map((node) => ({ ...node, capable: nodeHasCapability(node, PUBLIC_DB_CAPABILITY) }));
	}

	private status(db: DatabaseRow, row: AccessRow | undefined): { status: PublicAccessStatus; detail: string | null; nodes: PublicAccessNodeView[] } {
		if (!publicAccessProtocol(db.engine)) return { status: 'unsupported', detail: publicAccessUnsupportedReason(db.engine), nodes: [] };
		if (!row?.enabled)
			return {
				status: 'disabled',
				detail: row?.disabledReason === 'expired' ? 'Turned off when it expired.' : null,
				nodes: [],
			};
		if (!featureEnabled(this.ctx.config, 'DB_PUBLIC_ACCESS'))
			return { status: 'disabled', detail: 'Turned off for the whole install (YOAL_FEATURE_DB_PUBLIC_ACCESS=0).', nodes: [] };
		const now = this.ctx.now();
		const reports = new Map(
			this.ctx.db
				.select()
				.from(databasePublicAccessNodes)
				.where(eq(databasePublicAccessNodes.databaseId, db.id))
				.all()
				.map((report) => [report.nodeId, report]),
		);
		const views: PublicAccessNodeView[] = this.ingressNodes().map((node) => {
			const report = reports.get(node.id);
			const fresh = report !== undefined && now - report.reportedAt < REPORT_STALE_MS && report.version >= row.version;
			return {
				nodeId: node.id,
				nodeName: node.name,
				state: !node.capable ? 'helper-outdated' : fresh ? (report.state as PublicAccessNodeView['state']) : 'unknown',
				error: !node.capable ? `The agent on ${node.name} does not support public access yet.` : (report?.error ?? null),
				open: report?.open ?? 0,
				accepted: report?.accepted ?? 0,
				refused: report?.refused ?? 0,
				authFailures: report?.authFailures ?? 0,
				banned: report?.banned ?? 0,
				reportedAt: report ? new Date(report.reportedAt).toISOString() : null,
			};
		});
		// Every listed credential revoked or expired: the proxy refuses every login (fail closed).
		if (publicAccessProtocol(db.engine) === 'postgres' && this.allowedUsers(db, row).length === 0)
			return {
				status: 'degraded',
				detail: 'None of the chosen credentials can log in any more (revoked or expired), so every login is refused. Choose another credential.',
				nodes: views,
			};
		const capable = views.filter((view) => view.state !== 'helper-outdated');
		const listening = capable.filter((view) => view.state === 'listening');
		if (capable.length > 0 && listening.length === capable.length) return { status: 'active', detail: null, nodes: views };
		const failing = capable.filter((view) => view.state !== 'listening' && view.state !== 'unknown');
		if (listening.length > 0 || failing.length > 0) {
			const first = failing[0];
			return {
				status: listening.length > 0 ? 'degraded' : 'pending',
				detail: first ? `${first.nodeName}: ${first.error ?? first.state}` : null,
				nodes: views,
			};
		}
		return { status: 'pending', detail: 'Waiting for the ingress nodes to open the listener.', nodes: views };
	}

	private view(db: DatabaseRow, row: AccessRow | undefined): DatabasePublicAccessView {
		const protocol = publicAccessProtocol(db.engine);
		const { status, detail, nodes: nodeViews } = this.status(db, row);
		const now = this.ctx.now();
		const ids = parseJson<string[]>(row?.credentialIds ?? null, []);
		const byId = new Map(this.credentialsOf(db.id).map((item) => [item.id, item]));
		const credentials: PublicAccessCredentialView[] = ids.map((id) => {
			const item = byId.get(id);
			return {
				id,
				role: item?.role ?? 'unknown',
				username: item?.username ?? '(removed)',
				usable: item !== undefined && this.usable(item, now),
			};
		});
		const events: PublicAccessEventView[] = row
			? this.ctx.db
					.select()
					.from(databasePublicAccessEvents)
					.where(eq(databasePublicAccessEvents.databaseId, db.id))
					.orderBy(desc(databasePublicAccessEvents.id))
					.limit(50)
					.all()
					.map((event) => ({
						at: new Date(event.at).toISOString(),
						nodeId: event.nodeId,
						source: event.source,
						reason: event.reason as PublicRefusalReason,
						detail: event.detail,
					}))
			: [];
		const host = row ? this.host(db) : null;
		const iso = (value: number | null | undefined) => (value ? new Date(value).toISOString() : null);
		return {
			enabled: row?.enabled === true,
			status,
			statusDetail: detail,
			protocol,
			host,
			port: row?.port ?? null,
			rules: parseJson<PublicAccessRule[]>(row?.rules ?? null, []),
			allowAnywhere: row?.allowAnywhere === true,
			anywhereAvailable: featureEnabled(this.ctx.config, 'DB_PUBLIC_ANYWHERE'),
			credentials,
			maxConnections: row?.maxConnections ?? 20,
			expiresAt: iso(row?.expiresAt),
			enabledAt: iso(row?.enabledAt),
			enabledBy: row?.enabledBy ?? null,
			updatedAt: iso(row?.updatedAt),
			updatedBy: row?.updatedBy ?? null,
			disabledAt: iso(row?.disabledAt),
			disabledReason: (row?.disabledReason as 'manual' | 'expired' | null | undefined) ?? null,
			connectionTemplate:
				row && host && protocol
					? publicDatabaseUrl({
							engine: db.engine,
							user: protocol === 'postgres' ? '<user>' : databaseIdentifier(db.name),
							pass: '<password>',
							host,
							port: row.port,
							database: databaseUrlDatabase(db.engine, databaseIdentifier(db.name)),
						})?.replace('%3Cuser%3E', '<user>').replace('%3Cpassword%3E', '<password>') ?? null
					: null,
			nodes: nodeViews,
			events,
		};
	}
}
