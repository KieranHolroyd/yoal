import * as z from 'zod';
import { ingressSettingsSchema, steeringDriverKinds } from './ingress.ts';
import { nodeRolloutOptionsSchema } from './node-rollout.ts';
import { replicaSpreads } from './replica.ts';

/**
 * Cluster configuration (docs/CLUSTERING.md).
 *
 * One `settings` row holds the tunables the clustering phases read: overlay addressing, endpoint
 * ports, replica limits, control-plane lease timing, failover policy and storage replication.
 * Every field has a default, so a missing or stale row keeps the documented behaviour.
 */
export const CLUSTER_CONFIG_KEY = 'cluster_config';

const int = (min: number, max: number) => z.number().int().min(min).max(max);

const overlay = z.object({
	/** Per-install overlay CIDR; the first /24 is reserved for gateways. */
	cidr: z.string().trim().regex(/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/).default('10.47.0.0/22'),
	mtu: int(1280, 1420).default(1420),
	listenPort: int(1, 65_535).default(51_820),
	keepaliveSeconds: int(0, 65_535).default(25),
});

const endpoints = z.object({
	portMin: int(10_000, 60_000).default(21_000),
	portMax: int(10_001, 61_000).default(21_999),
});

const replicas = z.object({
	max: int(1, 20).default(20),
	spread: z.enum(replicaSpreads).default('node'),
	/** Caddy's active health-check interval across a replica set's upstreams. */
	healthIntervalSeconds: int(1, 300).default(5),
	/** Seconds since a node's last heartbeat before its replica copies are re-placed (§8.3). */
	failoverGraceSeconds: int(0, 3_600).default(120),
});

const database = z.object({
	maxReplicas: int(0, 5).default(2),
	/** A replica further behind than either limit is never picked for promotion (§9.3). */
	maxLagBytes: int(0, 10_000_000_000).default(67_108_864),
	maxLagSeconds: int(0, 86_400).default(60),
});

const storage = z.object({
	maxTargets: int(0, 5).default(2),
	syncIntervalMinutes: int(1, 1_440).default(15),
});

/**
 * The failover controller's lease (§6.3): only the holder acts, it renews every `renewSeconds`
 * (the controller's tick), and a holder that stops renewing loses it after `leaseTtlSeconds`.
 * Standby promotion of the control plane itself is C6 and has no setting yet.
 */
const controlPlane = z.object({
	leaseTtlSeconds: int(5, 300).default(30),
	renewSeconds: int(1, 60).default(5),
});

/**
 * Automatic failover (§8.3, §11). Off by default: a lost node is reported, not acted on. A manual
 * drain moves replica copies whether or not this is on.
 */
const failover = z.object({
	enabled: z.boolean().default(false),
	/** Seconds since a node's last heartbeat before it counts as lost for ingress and databases. */
	graceSeconds: int(0, 3_600).default(120),
	/** Fleet-wide cap on automatic actions per minute. */
	maxPerMinute: int(1, 60).default(6),
});

/**
 * How the fleet's capacity is used (docs/CLUSTERING.md §3.10, D214). Placement is still decided by
 * the control plane and recorded; these settings shape the choice and let it be revisited.
 */
export const packingStrategies = ['spread', 'pack'] as const;
export type PackingStrategy = (typeof packingStrategies)[number];
const scheduling = z.object({
	/** `spread` picks the emptiest node (headroom everywhere); `pack` fills nodes before opening the next. */
	strategy: z.enum(packingStrategies).default('spread'),
	/**
	 * Admission ceiling as a percentage of each node's workload memory budget. Above 100 the fleet
	 * admits more reservations than the slice holds, on the bet that apps rarely use their limit at
	 * once; the slice's own limit still protects the host.
	 */
	memoryOvercommitPercent: int(100, 300).default(100),
	/** The same for a node's CPU budget. CPU is compressible, so this is the safer one to raise. */
	cpuOvercommitPercent: int(100, 800).default(100),
	/** Move workloads on the controller's own initiative when the fleet drifts out of balance. */
	autoRebalance: z.boolean().default(false),
	/** Gap between the fullest and emptiest node, in points of memory reserved, that counts as drift. */
	rebalanceThresholdPercent: int(5, 90).default(25),
	/** Minutes between automatic moves; one move per interval keeps the fleet calm. */
	rebalanceIntervalMinutes: int(1, 1_440).default(10),
	/** Moves a single manual Rebalance may apply. */
	maxMovesPerRebalance: int(1, 50).default(5),
	/** Re-place single-copy HTTP apps off a lost node when failover is enabled (§8.3). */
	failoverSingleCopies: z.boolean().default(true),
	/** Update a set of copies one at a time on deploy, waiting for each to be healthy (SCALING §4). */
	rollingDeploys: z.boolean().default(true),
	/** Seconds a copy may take to come up on a new release before the rollout pauses. */
	rolloutTimeoutSeconds: int(30, 3_600).default(300),
	/** Seconds between autoscaler evaluations. */
	autoscaleIntervalSeconds: int(10, 600).default(30),
	/**
	 * Deploy a single-copy HTTP app through a temporary second copy on another node, so the app
	 * keeps serving while its own copy restarts (SCALING §4). Needs a second node with room.
	 */
	surgeDeploys: z.boolean().default(true),
	/** Put the previous release back when a rollout fails, instead of pausing for a person. */
	autoRollback: z.boolean().default(true),
	/**
	 * A node whose host memory is this full takes no new copies while another node can, whatever
	 * its reservations say. It matters most with overcommit, where reservations stop being a promise.
	 */
	memoryPressurePercent: int(50, 100).default(90),
	/**
	 * Give single-copy workers a run lease: a node that loses the control plane for
	 * `runLeaseSeconds` stops them, which is what makes it safe to start them elsewhere (§8.4).
	 * Off by default, because it also stops them when the control plane itself is down that long.
	 */
	workerRunLeases: z.boolean().default(false),
	runLeaseSeconds: int(20, 600).default(60),
});

/**
 * Fleet node updates (docs/CLUSTERING.md §3.11, D217): the defaults a manual rollout starts from,
 * and whether the control plane rolls the fleet forward on its own after it updates itself.
 */
const updates = nodeRolloutOptionsSchema.extend({
	/** Start a rollout with these options once the control plane runs a release the nodes lack. */
	autoRollout: z.boolean().default(false),
});

/**
 * Traffic steering (HA-PLAN H18, W8). `direct` is today: Yoal writes nothing and a person moves the
 * record. Any other driver only acts while the `STEERING` flag is on, so setting one here is inert
 * until the operator enables it. `stacked` is for the R1 shape (for example `external-lb` inside a
 * region and `dns-failover` between regions, HA-PLAN H18/W13).
 */
const steering = z.object({
	driver: z.enum(steeringDriverKinds).default('direct'),
	stacked: z.array(z.enum(steeringDriverKinds)).max(4).default([]),
});

export const clusterConfigSchema = z.object({
	overlay,
	endpoints,
	replicas,
	database,
	storage,
	controlPlane,
	failover,
	scheduling,
	updates,
	ingress: ingressSettingsSchema,
	steering,
});
export type ClusterConfig = z.infer<typeof clusterConfigSchema>;

/**
 * Keys earlier releases accepted that no code reads (HA-PLAN F6). They are not part of the
 * configuration any more, so they are not stored or shown. An update may still carry one at its
 * old default, which is what the platform does anyway, so a saved JSON document keeps saving; any
 * other value is refused with the reason, rather than stored and silently ignored. A workstream
 * that wires one moves it back into its section.
 */
export const UNWIRED_CLUSTER_KEYS = [
	{ section: 'overlay', key: 'maxHubs', inert: 4, reason: 'the hub count is not configurable yet (CLUSTERING C1)' },
	{ section: 'endpoints', key: 'requireMtls', inert: true, reason: 'service endpoints always require mTLS' },
	{
		section: 'endpoints',
		key: 'forwarder',
		inert: 'auto',
		reason: "endpoints always use the agent's forwarder until spike S10 settles caddy-l4 (HA-PLAN W4)",
	},
	{ section: 'database', key: 'defaultMode', inert: 'async', reason: 'synchronous replication is not built (HA-PLAN W10)' },
	{ section: 'shares', key: 'mountRoot', inert: '/run/yoal-shares', reason: 'shares always mount under /mnt/yoal-shares' },
] as const;

const unwired = (section: string) =>
	Object.fromEntries(
		UNWIRED_CLUSTER_KEYS.filter((item) => item.section === section).map((item) => [item.key, z.unknown().optional()]),
	);

const sectionUpdates = {
	overlay: overlay.partial().extend(unwired('overlay')).optional(),
	endpoints: endpoints.partial().extend(unwired('endpoints')).optional(),
	replicas: replicas.partial().optional(),
	database: database.partial().extend(unwired('database')).optional(),
	storage: storage.partial().optional(),
	controlPlane: controlPlane.partial().optional(),
	failover: failover.partial().optional(),
	scheduling: scheduling.partial().optional(),
	updates: updates.partial().optional(),
	ingress: ingressSettingsSchema.partial().optional(),
	steering: steering.partial().optional(),
	/** Only ever held `mountRoot`; kept so an older saved document still parses. */
	shares: z.object(unwired('shares')).optional(),
};

export const clusterConfigUpdateSchema = z
	.object(sectionUpdates)
	.strict()
	.superRefine((value, ctx) => {
		for (const item of UNWIRED_CLUSTER_KEYS) {
			const section = (value as Record<string, Record<string, unknown> | undefined>)[item.section];
			if (!section || !(item.key in section) || section[item.key] === undefined) continue;
			if (section[item.key] === item.inert) continue;
			ctx.addIssue({
				code: 'custom',
				path: [item.section, item.key],
				message: `${item.section}.${item.key} cannot be changed: ${item.reason}.`,
			});
		}
	});
export type ClusterConfigUpdate = z.infer<typeof clusterConfigUpdateSchema>;
