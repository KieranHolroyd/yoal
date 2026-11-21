import {
	CLUSTER_CONFIG_KEY,
	clusterConfigSchema,
	clusterConfigUpdateSchema,
	PLATFORM_HOST_PORTS,
	RESERVED_LATER_HOST_PORTS,
	type ClusterConfig,
	type ClusterConfigUpdate,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, ValidationError } from './errors.ts';
import { assertRegionWrites } from './region-gate.ts';
import { haBlockers } from './ha-preflight.ts';

/**
 * Cluster configuration (Settings → Clustering). One settings row, cached and re-read on save.
 * Platform-wide: platform admins read it (`view`), and only a platform admin's own dashboard
 * session changes it (`update`; API keys and OAuth tokens never carry platform scope, D107).
 * `get()` is the unchecked internal read the scheduler, nodes and replicas use.
 */
export class ClusterConfigService {
	#cache: ClusterConfig | null = null;

	constructor(private readonly ctx: CoreContext) {}

	get(): ClusterConfig {
		if (this.#cache) return this.#cache;
		let raw: unknown = {};
		try {
			const row = this.ctx.sqlite
				.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
				.get(CLUSTER_CONFIG_KEY);
			if (row) raw = JSON.parse(row.value);
		} catch {
			// First boot or a hand-edited row: defaults are the documented behaviour.
		}
		this.#cache = clusterConfigSchema.parse({
			overlay: {},
			endpoints: {},
			replicas: {},
			database: {},
			storage: {},
			controlPlane: {},
			failover: {},
			scheduling: {},
			updates: {},
			ingress: {},
			steering: {},
			ha: {},
			...(raw && typeof raw === 'object' ? raw : {}),
		});
		return this.#cache;
	}

	/** The configuration for a surface: platform admins only. */
	view(principal: Principal): ClusterConfig {
		if (!this.ctx.platformIam.canView(principal))
			throw new CoreError('forbidden', 'Only a platform admin role can read the cluster configuration.', 403);
		return this.get();
	}

	update(principal: Principal, input: unknown): ClusterConfig {
		if (!this.ctx.platformIam.canAdminister(principal))
			throw new CoreError(
				'forbidden',
				'Only a platform admin role signed in to the dashboard can change the cluster configuration.',
				403,
			);
		const patch = clusterConfigUpdateSchema.safeParse(input);
		if (!patch.success) throw new ValidationError('Invalid cluster configuration.', patch.error.issues);
		const current = this.get();
		// Zod fills a section's defaults even under `.partial()`, so `{ failover: { enabled: true } }`
		// parses with every other failover key at its default. Merge only the keys the caller sent,
		// or saving one setting would silently reset its neighbours.
		const raw = input as Record<string, Record<string, unknown> | undefined>;
		const sent = <K extends keyof ClusterConfig>(section: K): Partial<ClusterConfig[K]> => {
			const parsed = (patch.data[section] ?? {}) as Record<string, unknown>;
			const keys = Object.keys(raw[section] ?? {});
			return Object.fromEntries(keys.filter((key) => key in parsed).map((key) => [key, parsed[key]])) as Partial<
				ClusterConfig[K]
			>;
		};
		assertRegionWrites(this.ctx.config, [
			{ field: 'cluster.replicas.spread', value: sent('replicas').spread, current: current.replicas.spread },
		]);
		const merged = clusterConfigSchema.safeParse({
			...current,
			overlay: { ...current.overlay, ...sent('overlay') },
			endpoints: { ...current.endpoints, ...sent('endpoints') },
			replicas: { ...current.replicas, ...sent('replicas') },
			database: { ...current.database, ...sent('database') },
			storage: { ...current.storage, ...sent('storage') },
			controlPlane: { ...current.controlPlane, ...sent('controlPlane') },
			failover: { ...current.failover, ...sent('failover') },
			scheduling: { ...current.scheduling, ...sent('scheduling') },
			updates: { ...current.updates, ...sent('updates') },
			ingress: { ...current.ingress, ...sent('ingress') },
			steering: { ...current.steering, ...sent('steering') },
			ha: { ...current.ha, ...sent('ha') },
		});
		if (!merged.success) throw new ValidationError('Invalid cluster configuration.', merged.error.issues);
		// The HA profile is refusal-first (HA-PLAN H27/H28): it cannot be asserted while a
		// platform dependency still lives on one node. Existing `ha` installs may keep saving
		// unrelated settings even if a dependency later regresses; the preflight reports that.
		if (merged.data.ha.profile !== 'single' && merged.data.ha.profile !== current.ha.profile) {
			const blockers = haBlockers(this.ctx, merged.data.ha.profile);
			if (blockers.length > 0)
				throw new ValidationError(
					`The ${merged.data.ha.profile} profile is refused: ${blockers
						.map((blocker) => `${blocker.title}. ${blocker.fix ?? ''}`.trim())
						.join(' ')}`,
				);
		}
		if (merged.data.endpoints.portMin >= merged.data.endpoints.portMax)
			throw new ValidationError('The endpoint port range must have min < max.');
		const { driver, stacked } = merged.data.steering;
		if (stacked.includes('direct')) throw new ValidationError('direct cannot be stacked: it means no steering.');
		if (new Set(stacked).size !== stacked.length) throw new ValidationError('A stacked steering driver can appear only once.');
		if (stacked.includes(driver)) throw new ValidationError(`The steering driver ${driver} cannot also be stacked.`);
		// The endpoint allocator must never hand out another platform range (HA-PLAN F2).
		const { portMin, portMax } = merged.data.endpoints;
		const clash = [...PLATFORM_HOST_PORTS, ...RESERVED_LATER_HOST_PORTS].find(
			(range) => range.owner !== 'service endpoints' && range.min <= portMax && portMin <= range.max,
		);
		if (clash)
			throw new ValidationError(
				`The endpoint port range ${portMin}–${portMax} overlaps ${clash.owner} (${clash.min}–${clash.max}).`,
			);
		this.ctx.sqlite.run(
			'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
			[CLUSTER_CONFIG_KEY, JSON.stringify(merged.data), this.ctx.now()],
		);
		this.#cache = merged.data;
		// The edge's health-check interval is in every replicated route: re-render desired state.
		// Ingress settings are in the edge's desired state too (listeners, PROXY, health port).
		if (
			merged.data.replicas.healthIntervalSeconds !== current.replicas.healthIntervalSeconds ||
			JSON.stringify(merged.data.ingress) !== JSON.stringify(current.ingress)
		)
			this.ctx.projects.bump();
		this.ctx.audit.record({
			principal,
			action: 'platform.cluster_config',
			resource: 'platform',
			resourceId: 'cluster',
			args: patch.data as ClusterConfigUpdate,
			result: 'ok',
		});
		return merged.data;
	}
}
