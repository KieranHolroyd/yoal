import { z } from 'zod';

/**
 * Control-plane standby: lease, epoch and status (HA-PLAN H21/C6, Wave 3 opening). The wire
 * contracts are here; the lease store and state machine are lane A, after the approved W9 spec.
 */

/** An agent that understands the control address list and epoch fencing. */
export const HA_EPOCH_CAPABILITY = 'ha-epoch';

export const controlRoles = [
	'joining',
	'standby',
	'standby-behind',
	'promoting',
	'primary',
	'fenced',
	'unavailable',
] as const;

export type ControlRole = (typeof controlRoles)[number];

/** The arbiter object `yoal/ha/control-lease.json` (CLUSTERING §6.3). */
export const controlLeaseSchema = z.object({
	epoch: z.number().int().nonnegative(),
	holderNodeId: z.string().min(1).max(64),
	holderVersion: z.string().min(1).max(64),
	/** ISO 8601, on the arbiter's clock. */
	expiresAt: z.string().datetime(),
});

export type ControlLease = z.infer<typeof controlLeaseSchema>;

/** One control node an agent may reach; `url` is the agent API origin. */
export const controlNodeAddressSchema = z.object({
	nodeId: z.string().min(1).max(64),
	url: z.string().url().max(2048),
	zone: z.string().max(64).default('default'),
});

export type ControlNodeAddress = z.infer<typeof controlNodeAddressSchema>;

/**
 * What every agent receives while `CONTROL_STANDBY` is on: the address list in preference order and
 * the highest epoch the control plane has asserted. An agent refuses a lower epoch and moves to the
 * next address; it keeps serving cached desired state when none answers (I11).
 */
export const controlDesiredSchema = z.object({
	nodes: z.array(controlNodeAddressSchema).min(1).max(8),
	epoch: z.number().int().nonnegative(),
});

export type ControlDesired = z.infer<typeof controlDesiredSchema>;

/** `/api/agent/heartbeat` field a control node reports. */
export const controlReportSchema = z.object({
	role: z.enum(controlRoles),
	epoch: z.number().int().nonnegative(),
	/** The lease holder this node last observed. */
	leaseHolderNodeId: z.string().max(64).nullable(),
	leaseExpiresAt: z.string().datetime().nullable(),
	canPromote: z.boolean(),
	replicationLagSeconds: z.number().nonnegative().nullable(),
});

export type ControlReport = z.infer<typeof controlReportSchema>;

/** `GET /api/v1/ha/status` per control node. */
export const controlStatusSchema = z.object({
	nodeId: z.string(),
	name: z.string(),
	role: z.enum(controlRoles),
	epoch: z.number().int().nonnegative(),
	holderNodeId: z.string().nullable(),
	leaseExpiresAt: z.string().datetime().nullable(),
	canPromote: z.boolean(),
	replicationLagSeconds: z.number().nonnegative().nullable(),
	version: z.string().nullable(),
	updatedAt: z.string().datetime().nullable(),
});

export type ControlStatus = z.infer<typeof controlStatusSchema>;

/** `POST /api/v1/ha/control/promote`: an operator promotion, still a CAS at the ETag just read. */
export const controlPromoteRequestSchema = z.object({
	/** Refuse with 409 when the lease is not at this epoch (CLUSTERING §6.5). */
	expectedEpoch: z.number().int().positive().optional(),
});
export type ControlPromoteRequest = z.infer<typeof controlPromoteRequestSchema>;

/** `POST /api/v1/ha/control/enrol`: a standby's CSR, signed after a second factor. */
export const controlEnrolRequestSchema = z.object({
	nodeId: z.string().min(1).max(64),
	csrPem: z.string().min(64).max(100_000),
	reason: z.string().max(200).optional(),
});
export type ControlEnrolRequest = z.infer<typeof controlEnrolRequestSchema>;
