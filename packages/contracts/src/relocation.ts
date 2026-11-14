import * as z from 'zod';

/**
 * Moving an app together with its app volumes (docs/SCALING.md §7).
 *
 * A volume's data lives on one node, so an app that mounts one cannot simply be started elsewhere.
 * A relocation stops the app, snapshots each volume to the backup target, restores the snapshots
 * onto the target node and then switches the app over. Until that switch the source is untouched,
 * so a failure at any earlier point just starts the app again where it was.
 */
export const relocationPhases = ['stopping', 'snapshotting', 'restoring', 'done', 'failed', 'cancelled'] as const;
export type RelocationPhase = (typeof relocationPhases)[number];

export const relocationRequestSchema = z
	.object({
		/** A node id or name; omitted lets the scheduler choose. */
		node: z.string().trim().min(1).max(100).optional(),
	})
	.strict();
export type RelocationRequest = z.infer<typeof relocationRequestSchema>;

export interface RelocationVolumeView {
	name: string;
	sizeMb: number;
	/** waiting, snapshotting, snapshotted, restoring, restored or failed. */
	state: string;
}

export interface RelocationView {
	id: string;
	project: string;
	from: { id: string; name: string };
	to: { id: string; name: string };
	phase: RelocationPhase;
	/** True while the app is stopped for the move. */
	active: boolean;
	detail: string | null;
	error: string | null;
	volumes: RelocationVolumeView[];
	startedAt: string;
	finishedAt: string | null;
}
