import * as z from 'zod';
import { replicaSpreads } from './replica.ts';

/**
 * Cluster topology (docs/CLUSTERING.md §3, phase C0).
 *
 * A node reports hardware facts; the operator assigns the failure domain and the roles the node
 * may run. Placement filters on those facts once, at deploy time. Everything here is additive:
 * an install that never sets a zone keeps `default`, and a node that predates hardware reporting
 * simply has no facts.
 */

export const nodeRoles = ['ingress', 'control', 'compute', 'data', 'build'] as const;
export type NodeRole = (typeof nodeRoles)[number];
export const nodeRoleSchema = z.enum(nodeRoles);

/** A failure domain: nodes in one zone share power, uplink and provider fate. */
export const nodeZoneSchema = z
	.string()
	.trim()
	.min(1)
	.max(32)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, digits and single hyphens.');

/**
 * Operator labels match placement constraints. Keys are lowercase and may contain dots, so
 * `owner=media` and `tier=critical` are valid; `yoal.io/*` is reserved for derived facts.
 */
export const nodeLabelKeySchema = z
	.string()
	.trim()
	.min(1)
	.max(63)
	.regex(/^[a-z0-9](?:[a-z0-9./-]*[a-z0-9])?$/, 'Use lowercase letters, digits, dots, slashes and hyphens.')
	.refine((key) => !key.startsWith('yoal.io/'), 'The yoal.io/ prefix is reserved for derived labels.');
export const nodeLabelValueSchema = z.string().trim().min(0).max(128);
export const nodeLabelsSchema = z.record(nodeLabelKeySchema, nodeLabelValueSchema);

/** Placement constraint on a node's disks (D169): a tier, or `remote` for a network share. `unknown` matches nothing. */
export const volumeClasses = ['fast', 'bulk', 'remote', 'unknown'] as const;
export type VolumeClass = (typeof volumeClasses)[number];
export const volumeClassSchema = z.enum(volumeClasses);

/** Hardware facts are optional field by field: a container or an older kernel cannot report all. */
export const nodeHardwareSchema = z
	.object({
		arch: z.string().max(32).optional(),
		cpuModel: z.string().max(160).optional(),
		cores: z.number().int().min(1).max(1024).optional(),
		threads: z.number().int().min(1).max(4096).optional(),
		memoryBytes: z.number().int().nonnegative().optional(),
		swapBytes: z.number().int().nonnegative().optional(),
		virtualization: z.string().max(64).optional(),
		gpus: z
			.array(
				z.object({
					name: z.string().max(160).optional(),
					memoryMiB: z.number().int().nonnegative().optional(),
					pciId: z.string().max(64).optional(),
				}),
			)
			.max(16)
			.optional(),
		disks: z
			.array(
				z.object({
					name: z.string().max(64),
					sizeBytes: z.number().int().nonnegative().optional(),
					rotational: z.boolean().optional(),
					transport: z.enum(['nvme', 'sata', 'sas', 'usb', 'virtio', 'unknown']).optional(),
				}),
			)
			.max(64)
			.optional(),
		nics: z
			.array(
				z.object({
					name: z.string().max(64),
					speedMbps: z.number().int().nonnegative().optional(),
					mtu: z.number().int().min(68).max(65_535).optional(),
				}),
			)
			.max(32)
			.optional(),
		os: z.string().max(160).optional(),
		kernel: z.string().max(160).optional(),
		power: z
			.object({
				state: z.string().max(32),
				percent: z.number().min(0).max(100).optional(),
			})
			.nullable()
			.optional(),
		collectedAt: z.string().max(40).optional(),
	})
	.strip();
export type NodeHardware = z.infer<typeof nodeHardwareSchema>;

/**
 * Placement constraints. The old `edge | <node> | auto` values on a project remain shorthands;
 * a spec adds hard constraints (zone, roles, labels, disk tier or id) and a soft locality hint.
 * `volumeClass` matches a node's disk tiers plus `remote` for a network disk; `volumeId` is a disk
 * id and pins its node (D169).
 */
export const placementSpecSchema = z
	.object({
		/** Pin to one node id. */
		node: z.string().trim().min(1).max(100).optional(),
		zone: z.union([nodeZoneSchema, z.array(nodeZoneSchema).min(1).max(16)]).optional(),
		roles: z.array(nodeRoleSchema).min(1).max(nodeRoles.length).optional(),
		labels: z.record(z.string().min(1).max(63), z.string().max(128)).optional(),
		volumeClass: volumeClassSchema.optional(),
		volumeId: z.string().trim().min(1).max(100).optional(),
		/** Replica constraint: never two copies on one node, zone or region (`region` needs `REGIONS`). */
		spread: z.enum(replicaSpreads).optional(),
		/** Prefer the node(s) running this database or storage instance. */
		near: z.string().trim().min(1).max(100).optional(),
	})
	.strict();
export type PlacementSpec = z.infer<typeof placementSpecSchema>;

/** A private network's name: a provider VPC, a vSwitch or a home LAN that some nodes share (D215). */
export const privateNetworkNameSchema = nodeZoneSchema;

export const nodeClusterSettingsSchema = z
	.object({
		zone: nodeZoneSchema.optional(),
		/** The region the node's zone belongs to (HA-PLAN H26); absent is `default`. Needs `REGIONS`. */
		region: nodeZoneSchema.optional(),
		roles: z.array(nodeRoleSchema).min(1).max(nodeRoles.length).optional(),
		labels: nodeLabelsSchema.optional(),
		/** LAN address used for direct peering inside one zone (C1). */
		lanEndpoint: z
			.string()
			.trim()
			.max(253)
			.regex(/^[A-Za-z0-9.\-[\]:]+$/, 'Use a host or host:port, without a scheme or path.')
			.nullable()
			.optional(),
		/** The private network this node sits on; nodes sharing one peer directly on `lanEndpoint` (D215). */
		privateNetwork: privateNetworkNameSchema.nullable().optional(),
		/** CPU reservation budget in millis; null removes the cap. */
		cpuBudgetMillis: z.number().int().min(100).max(1_000_000).nullable().optional(),
	})
	.strict();
export type NodeClusterSettings = z.infer<typeof nodeClusterSettingsSchema>;

/** A node in the topology view. Counts are live reservations, not historical totals. */
export interface TopologyNodeView {
	id: string;
	name: string;
	zone: string;
	/** The node's region (HA-PLAN H26). Optional until W13 lane A fills it; absent is `default`. */
	region?: string;
	roles: NodeRole[];
	labels: Record<string, string>;
	status: string;
	mode: string;
	publicAddress: string | null;
	privateAddress: string | null;
	lanEndpoint: string | null;
	privateNetwork: string | null;
	hardware: NodeHardware | null;
	/** Derived labels (yoal.io/*) plus operator labels. */
	derivedLabels: Record<string, string>;
	disks: Array<{
		id: string;
		name: string;
		tier: 'fast' | 'bulk';
		mountPath: string;
		sizeBytes: number | null;
		freeBytes: number | null;
		remote: boolean;
	}>;
	workloads: number;
	databases: number;
	storageInstances: number;
	cpuBudgetMillis: number | null;
}

export interface TopologyZoneView {
	zone: string;
	/** The zone's region (HA-PLAN H26). Optional until W13 lane A fills it; absent is `default`. */
	region?: string;
	nodes: string[];
	/** What an outage of this zone would take down, before failover. */
	workloads: number;
	databases: number;
	storageInstances: number;
}

export interface TopologyView {
	generatedAt: string;
	zones: TopologyZoneView[];
	nodes: TopologyNodeView[];
}

/**
 * Per-resource redundancy (CLUSTERING §8.1, HA-PLAN G24): `L0` single, `L1` recoverable (a
 * verified backup), `L2` failover (a replica or standby elsewhere), `L3` active (several copies
 * across zones). Computed from placement (`packages/core/src/ha-level.ts`), never stored as intent.
 */
export const haLevels = ['L0', 'L1', 'L2', 'L3'] as const;
export type HaLevel = (typeof haLevels)[number];

/** A computed HA level and why it is not the next one up. */
export interface HaLevelAssessment {
	level: HaLevel;
	/** What the next level needs that this resource lacks, e.g. "no second zone"; empty at `L3`. */
	blockers: string[];
}

export interface BlastRadiusItem {
	kind: 'workload' | 'database' | 'storage' | 'disk';
	id: string;
	name: string;
	nodeId: string;
	orgId: string | null;
	/** Today always `L0`; Wave 1 lane C computes it (`ha-level.ts`). */
	haLevel: HaLevel;
}

export interface BlastRadiusView {
	target: { kind: 'node' | 'zone'; id: string; name: string };
	affectedNodes: string[];
	items: BlastRadiusItem[];
	summary: {
		workloads: number;
		databases: number;
		storageInstances: number;
		disks: number;
	};
}
