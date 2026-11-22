import * as z from 'zod';

/**
 * Cloud shell (D236, docs/CLOUD-SHELL.md): a per-person terminal in the browser that runs in a
 * small container on one of the install's nodes, with the `yoal` CLI preinstalled and signed in
 * as that person, and a 1 GiB ext4 disk mounted as its home directory.
 *
 * It is a desired-state workload like the registry (a `cloudShell` profile on a container
 * workload, `csh_…` ids) and is reached through the container console's path (D127): browser →
 * control plane → internal gateway → the node's console front → the helper's exec verbs.
 */

/** Agents advertising this accept `cloudShell` workloads, `cloudShellPurges` and `csh_` console ids. */
export const CLOUD_SHELL_CAPABILITY = 'cloud-shell';

/** Every cloud shell's desired workload id starts with this. Reserved: nothing else may use it. */
export const CLOUD_SHELL_ID_PREFIX = 'csh_';
export const cloudShellIdPattern = /^csh_[a-f0-9]{32}$/;

/** The default image repository; the tag is the control plane's version (release.yml publishes it). */
export const CLOUD_SHELL_IMAGE_REPOSITORY = 'ghcr.io/kieranholroyd/yoal-cloud-shell';

/** Where the disk is mounted inside the shell, and the shell user's `$HOME`. */
export const CLOUD_SHELL_HOME = '/home/yoal';

export const cloudShellLimits = {
	/** Size of each person's home disk: a real ext4 filesystem, so the limit is enforced. */
	diskMb: 1024,
	/** Smallest and largest disk the helper accepts on the wire. */
	minDiskMb: 256,
	maxDiskMb: 8192,
	memoryMb: 512,
	cpus: 1,
	/** A shell nobody has typed into or opened for this long is stopped (the disk stays). */
	idleMs: 20 * 60_000,
	/** A shell is stopped after this long whatever happens; opening it again starts a fresh one. */
	maxSessionMs: 12 * 60 * 60_000,
	/** The CLI's access key lives a little longer than the longest session, then expires. */
	keyTtlSeconds: 12 * 60 * 60 + 15 * 60,
	/** Activity is written at most this often (every keystroke reaches the control plane). */
	touchEveryMs: 30_000,
} as const;

/** The workload profile: the helper derives the disk, mounts, user and sandbox from it. */
export const workloadCloudShellSchema = z.object({
	diskMb: z.number().int().min(cloudShellLimits.minDiskMb).max(cloudShellLimits.maxDiskMb),
});
export type WorkloadCloudShell = z.infer<typeof workloadCloudShellSchema>;

export const cloudShellStatuses = ['stopped', 'starting', 'running', 'deleting'] as const;
export type CloudShellStatus = (typeof cloudShellStatuses)[number];

/** `GET /api/v1/cloud-shell`: the caller's own shell, or `shell: null` before the first start. */
export const cloudShellViewSchema = z.object({
	id: z.string(),
	status: z.enum(cloudShellStatuses),
	node: z.object({ id: z.string(), name: z.string(), online: z.boolean() }).nullable(),
	diskMb: z.number().int(),
	home: z.string(),
	image: z.string(),
	/** True when the shell's CLI was handed an access key; false when the role cannot mint one. */
	cliSignedIn: z.boolean(),
	startedAt: z.string().nullable(),
	lastActiveAt: z.string().nullable(),
	/** When the idle timer stops it, while running. */
	stopsAt: z.string().nullable(),
	createdAt: z.string(),
});
export type CloudShellView = z.infer<typeof cloudShellViewSchema>;

export const cloudShellStateSchema = z.object({
	enabled: z.boolean(),
	shell: cloudShellViewSchema.nullable(),
	limits: z.object({ diskMb: z.number().int(), memoryMb: z.number().int(), idleMinutes: z.number().int() }),
});
export type CloudShellState = z.infer<typeof cloudShellStateSchema>;
