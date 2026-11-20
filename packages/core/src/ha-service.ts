import { eq } from 'drizzle-orm';
import { nodes } from '@yoal/db';
import { IDENTITY_CAPABILITY, haProfiles, selectIdentityNode, type HaProfile, type Principal } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError, ValidationError } from './errors.ts';
import { haFindings, type HaFinding } from './ha-preflight.ts';
import { IDENTITY_NODE_SETTING } from './identity-desired.ts';
import { parseJson } from './util.ts';

/**
 * The HA profile and the platform dependencies it asserts (HA-PLAN H27/H28, W12/W14).
 *
 * The profile lives in `cluster_config.ha.profile` and defaults to `single`. Turning it on is a
 * refusal-first action: the platform store, the registry's blobs and the identity/mail placement
 * are checked, and a blocker names the exact fix. Identity and mail stay on one node each by
 * design, but the node is a setting here, not a hard-coded host, so an operator can move either.
 *
 * W14's `yoal ha init|preflight` is the guided surface; this service is what it calls.
 */
export interface HaDependencyView {
	/** `true` when losing one node does not lose the dependency itself. */
	survivesNodeLoss: boolean;
	detail: string;
	nodeId?: string | null;
	nodeName?: string | null;
	online?: boolean;
	/** False when no operator action can move it (the platform store is set in yoal.env). */
	movable: boolean;
}

export interface HaPlatformView {
	profile: HaProfile;
	/** No blockers: the profile can be asserted (or is already). */
	ok: boolean;
	blockers: number;
	findings: HaFinding[];
	/** Nodes that may run identity or mail, for the move controls. */
	nodes: Array<{ id: string; name: string; online: boolean; identity: boolean; mail: boolean }>;
	dependencies: {
		platformStore: HaDependencyView & { kind: string; bucket: string | null };
		registry: HaDependencyView & { enabled: boolean; mode: string; bucket: string | null };
		identity: HaDependencyView & { pools: number };
		mail: HaDependencyView & { configured: boolean };
		telemetrySpool: Array<{
			nodeId: string;
			nodeName: string | null;
			queued: number;
			bytes: number;
			dropped: number;
			gaps: number;
			at: number;
		}>;
	};
}

export interface HaPlacementInput {
	/** Node id or name; null clears the pin and returns identity to automatic placement. */
	identityNode?: string | null;
	/** Node id or name; null clears the mail node. */
	mailNode?: string | null;
}

export class HaService {
	constructor(private readonly ctx: CoreContext) {}

	/** Internal facts used by the preflight; no principal and no permission check. */
	identityPlacement(): { nodeId: string | null; nodeName: string | null; online: boolean; pools: number } {
		const rows = this.ctx.db.select().from(nodes).all();
		const capable = rows.filter((row) => parseJson<string[]>(row.capabilitiesJson, []).includes(IDENTITY_CAPABILITY));
		const configured =
			this.ctx.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(IDENTITY_NODE_SETTING)?.value ??
			null;
		// The same choice desired state makes: an operator pin while it is capable, then the edge,
		// then any online capable node in id order.
		const online = capable.filter((row) => row.status === 'online');
		const nodeId = selectIdentityNode(
			(online.length > 0 ? online : capable).map((row) => row.id),
			configured,
			this.ctx.config.edgeNodeId ?? null,
		);
		const node = nodeId ? rows.find((row) => row.id === nodeId) : undefined;
		const pools =
			this.ctx.sqlite
				.query<{ count: number }, []>("SELECT count(*) AS count FROM user_pools WHERE disabled_at IS NULL AND engine = 'yoal-identity'")
				.get()?.count ?? 0;
		return {
			nodeId: node?.id ?? null,
			nodeName: node?.name ?? null,
			online: node?.status === 'online',
			pools,
		};
	}

	mailPlacement(): { nodeId: string | null; nodeName: string | null; online: boolean; configured: boolean } {
		const settings = this.ctx.email.settings();
		const node = settings.nodeId ? this.ctx.db.select().from(nodes).where(eq(nodes.id, settings.nodeId)).get() : undefined;
		return {
			nodeId: settings.nodeId,
			nodeName: node?.name ?? null,
			online: node?.status === 'online',
			configured: Boolean(settings.nodeId),
		};
	}

	view(principal: Principal): HaPlatformView {
		if (!this.ctx.platformIam.allows(principal, 'platform:ha'))
			throw new CoreError('forbidden', 'High availability is for platform operators and admins.', 403);
		return this.#view();
	}

	/** Change the profile. A non-single profile is refused while any blocker remains. */
	setProfile(principal: Principal, profile: HaProfile): HaPlatformView {
		if (!this.ctx.platformIam.canAdminister(principal))
			throw new CoreError(
				'forbidden',
				'Only a platform admin role signed in to the dashboard can change the HA profile.',
				403,
			);
		if (!haProfiles.includes(profile)) throw new ValidationError(`Unknown HA profile "${profile}".`);
		this.ctx.cluster.update(principal, { ha: { profile } });
		return this.#view();
	}

	/**
	 * Move identity or mail to another node, or clear the pin. Both are ordinary settings, not
	 * hostnames: desired state follows on the next bump, and the operator steps are in
	 * docs/OPS.md §3.9 (identity's SQLite follows by Litestream once it is replicated).
	 */
	async move(principal: Principal, input: HaPlacementInput): Promise<HaPlatformView> {
		if (!this.ctx.platformIam.canAdminister(principal))
			throw new CoreError('forbidden', 'Only a platform admin role can move identity or mail.', 403);
		if (input.identityNode !== undefined) {
			if (input.identityNode === null) {
				this.ctx.sqlite.run('DELETE FROM settings WHERE key = ?', [IDENTITY_NODE_SETTING]);
			} else {
				const node = this.#node(input.identityNode);
				if (!parseJson<string[]>(node.capabilitiesJson, []).includes(IDENTITY_CAPABILITY))
					throw new ValidationError(`Node "${node.name}" runs an agent without identity support; update its agent first.`);
				this.ctx.sqlite.run(
					'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
					[IDENTITY_NODE_SETTING, node.id, this.ctx.now()],
				);
			}
			this.ctx.nodes.bump();
			this.ctx.audit.record({
				principal,
				action: 'ha.placement',
				resource: 'platform',
				resourceId: 'identity',
				args: { node: input.identityNode },
				result: 'ok',
			});
		}
		if (input.mailNode !== undefined) {
			const node = input.mailNode === null ? null : this.#node(input.mailNode);
			await this.ctx.email.configure(principal, { nodeId: node?.id ?? null });
		}
		return this.#view();
	}

	#node(idOrName: string) {
		const node =
			this.ctx.db
				.select()
				.from(nodes)
				.all()
				.find((row) => row.id === idOrName) ?? this.ctx.db.select().from(nodes).where(eq(nodes.name, idOrName)).get();
		if (!node) throw new NotFoundError('Node');
		return node;
	}

	#view(): HaPlatformView {
		const profile = this.ctx.cluster.get().ha.profile;
		const findings = haFindings(this.ctx, profile);
		const store = this.ctx.config.platformStore;
		const registry = this.ctx.registry.storagePlacement();
		const identity = this.identityPlacement();
		const mail = this.mailPlacement();
		const spools = this.ctx.telemetrySpool.nodes();
		const nameOf = (nodeId: string | null | undefined) =>
			nodeId ? (this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name ?? nodeId) : null;
		return {
			profile,
			ok: findings.every((finding) => finding.severity !== 'blocker'),
			blockers: findings.filter((finding) => finding.severity === 'blocker').length,
			findings,
			nodes: this.ctx.db
				.select()
				.from(nodes)
				.all()
				.map((node) => {
					const capabilities = parseJson<string[]>(node.capabilitiesJson, []);
					return {
						id: node.id,
						name: node.name,
						online: node.status === 'online',
						identity: capabilities.includes(IDENTITY_CAPABILITY),
						mail: capabilities.includes('mail'),
					};
				}),
			dependencies: {
				platformStore: {
					kind: store?.kind ?? 'local',
					bucket: store?.s3?.bucket ?? null,
					survivesNodeLoss: Boolean(store && store.kind !== 'local'),
					movable: false,
					detail:
						store && store.kind !== 'local'
							? `External ${store.kind} store${store.s3 ? ` (bucket ${store.s3.bucket})` : ''}; set in yoal.env.`
							: 'Local disk on the control host. Set YOAL_OBJECT_STORE and its credentials in yoal.env.',
				},
				registry: {
					enabled: this.ctx.registry.enabled(),
					mode: registry.mode,
					bucket: registry.bucket,
					survivesNodeLoss: !this.ctx.registry.enabled() || registry.mode === 'external' || registry.mode === 'platform',
					movable: this.ctx.registry.enabled(),
					nodeId: registry.nodeId,
					nodeName: registry.nodeName ?? nameOf(registry.nodeId),
					detail: !this.ctx.registry.enabled()
						? 'The registry is off; nodes pull from upstream registries.'
						: registry.mode === 'local'
							? 'Blobs are in the registry node’s data directory.'
							: registry.mode === 'managed'
								? 'Blobs are on a managed RustFS instance, which is also one node.'
								: `Blobs are in ${registry.mode === 'platform' ? 'the platform object store' : 'an external S3 store'}; the registry node can be replaced without copying data.`,
				},
				identity: {
					nodeId: identity.nodeId,
					nodeName: identity.nodeName,
					online: identity.online,
					pools: identity.pools,
					survivesNodeLoss: false,
					movable: true,
					detail: identity.nodeId
						? `Pinned to ${identity.nodeName ?? identity.nodeId}; move it before the node is lost. Its SQLite follows by Litestream once replicated.`
						: 'No capable node; hosted sign-in is unavailable.',
				},
				mail: {
					configured: mail.configured,
					nodeId: mail.nodeId,
					nodeName: mail.nodeName,
					online: mail.online,
					survivesNodeLoss: false,
					movable: true,
					detail: mail.configured
						? `Pinned to ${mail.nodeName ?? mail.nodeId}; a move re-renders the front and drains the spool.`
						: 'No mail node chosen; platform SMTP is used when YOAL_SMTP_* is set.',
				},
				telemetrySpool: spools.map((node) => ({
					nodeId: node.nodeId,
					nodeName: nameOf(node.nodeId),
					queued: node.queued,
					bytes: node.bytes,
					dropped: node.dropped,
					gaps: node.gaps.length,
					at: node.at,
				})),
			},
		};
	}
}
