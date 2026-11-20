import { z } from 'zod';

/**
 * Database members, durability and the synchronous set (HA-PLAN H21–H23, Wave 3 opening). The
 * lease object is the authority for the sync set; these contracts are what the control plane and
 * agents exchange. The member machine is lane A/B after the approved W9 spec.
 */

/** An agent that runs the database member machine (role discovery, keep-alive, fencing). */
export const DB_MEMBER_CAPABILITY = 'db-member';

export const databaseDurabilities = ['async', 'sync'] as const;
export type DatabaseDurability = (typeof databaseDurabilities)[number];

export const syncLossPolicies = ['downgrade', 'block'] as const;
export type SyncLossPolicy = (typeof syncLossPolicies)[number];

export const databaseMemberRoles = [
	'streaming',
	'candidate',
	'promoting',
	'primary',
	'fencing',
	'fenced',
	'rewind',
] as const;

export type DatabaseMemberRole = (typeof databaseMemberRoles)[number];

/** How a database is configured to behave when its synchronous replica is lost. */
export const durabilitySettingsSchema = z.object({
	durability: z.enum(databaseDurabilities),
	/** `downgrade` waits this long before switching to async. */
	syncTimeoutSeconds: z.number().int().min(0).max(300),
	onSyncLoss: z.enum(syncLossPolicies),
});

export type DurabilitySettings = z.infer<typeof durabilitySettingsSchema>;

/** The sync set as recorded in the lease object (authority) and cached on the row for display. */
export const syncSetSchema = z.object({
	databaseId: z.string().min(1).max(64),
	generation: z.number().int().nonnegative(),
	/** Node ids in the synchronous set; at most one for `sync` today. */
	nodes: z.array(z.string().max(64)).max(3),
	durability: z.enum(databaseDurabilities),
	syncSetAt: z.string().datetime().nullable(),
});

export type SyncSet = z.infer<typeof syncSetSchema>;

/** One member, as desired state tells every consumer to ask "role and generation?". */
export const databaseMemberSchema = z.object({
	nodeId: z.string().min(1).max(64),
	address: z.string().max(253).nullable(),
	role: z.enum(['primary', 'replica']),
});

export type DatabaseMember = z.infer<typeof databaseMemberSchema>;

/** What a member reports in its heartbeat. */
export const databaseMemberReportSchema = z.object({
	databaseId: z.string().min(1).max(64),
	role: z.enum(databaseMemberRoles),
	generation: z.number().int().nonnegative(),
	epoch: z.number().int().nonnegative(),
	/** WAL receiver state where the engine exposes one. */
	streaming: z.boolean(),
	observedAt: z.string().datetime(),
});

export type DatabaseMemberReport = z.infer<typeof databaseMemberReportSchema>;

/** The desired-state entry per database that has replicas (lane B renders it). */
export const databaseMembersDesiredSchema = z.object({
	databaseId: z.string().min(1).max(64),
	generation: z.number().int().nonnegative(),
	members: z.array(databaseMemberSchema).min(1).max(4),
	sync: z.array(z.string().max(64)).max(3),
	durability: z.enum(databaseDurabilities),
});

export type DatabaseMembersDesired = z.infer<typeof databaseMembersDesiredSchema>;
