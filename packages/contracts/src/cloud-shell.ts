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

/**
 * Agents advertising this grow an existing home disk when `cloudShell.diskMb` is larger than its
 * image (offline: unmount, `e2fsck -f`, extend the file, `resize2fs`). A node without it keeps the
 * disk at its size, so the control plane never asks it for a bigger one.
 */
export const CLOUD_SHELL_RESIZE_CAPABILITY = 'cloud-shell-resize';

/** Every cloud shell's desired workload id starts with this. Reserved: nothing else may use it. */
export const CLOUD_SHELL_ID_PREFIX = 'csh_';
export const cloudShellIdPattern = /^csh_[a-f0-9]{32}$/;

/** The default image repository; the tag is the control plane's version (publish.yml publishes it). */
export const CLOUD_SHELL_IMAGE_REPOSITORY = 'ghcr.io/kieranholroyd/yoal-cloud-shell';

/** Where the disk is mounted inside the shell, and the shell user's `$HOME`. */
export const CLOUD_SHELL_HOME = '/home/yoal';

export const cloudShellLimits = {
	/** Default size of a person's home disk: a real ext4 filesystem, so the limit is enforced. */
	diskMb: 1024,
	/** Smallest and largest disk the helper accepts on the wire, and a person may choose. */
	minDiskMb: 256,
	maxDiskMb: 8192,
	/** Default memory and CPUs, and the range a person may choose. */
	memoryMb: 512,
	minMemoryMb: 256,
	maxMemoryMb: 4096,
	cpus: 1,
	maxCpus: 4,
	/** A shell nobody has typed into or opened for this long is stopped (the disk stays). */
	idleMs: 20 * 60_000,
	/** The idle stop a person may choose, in minutes. */
	minIdleMinutes: 5,
	maxIdleMinutes: 240,
	/** A shell is stopped after this long whatever happens; opening it again starts a fresh one. */
	maxSessionMs: 12 * 60 * 60_000,
	/** The CLI's access key lives a little longer than the longest session, then expires. */
	keyTtlSeconds: 12 * 60 * 60 + 15 * 60,
	/** Activity is written at most this often (every keystroke reaches the control plane). */
	touchEveryMs: 30_000,
	/** A shell still not running this long after a start is stopped as failed. */
	startTimeoutMs: 10 * 60_000,
	/** A starting shell whose container has restarted this often is stopped as failed. */
	startRestartLimit: 5,
} as const;

/** The workload profile: the helper derives the disk, mounts, user and sandbox from it. */
export const workloadCloudShellSchema = z.object({
	diskMb: z.number().int().min(cloudShellLimits.minDiskMb).max(cloudShellLimits.maxDiskMb),
});
export type WorkloadCloudShell = z.infer<typeof workloadCloudShellSchema>;

/** The presets the dashboard offers; the API takes any value in range. */
export const cloudShellPresets = {
	diskMb: [512, 1024, 2048, 4096, 8192],
	memoryMb: [256, 512, 1024, 2048, 4096],
	cpus: [1, 2, 4],
	idleMinutes: [10, 20, 30, 60, 120, 240],
} as const;

/**
 * A person's cloud shell settings, kept apart from the shell itself so they survive a reset.
 * Memory, CPUs and the idle stop apply at the next start; a bigger disk grows at the next start;
 * a smaller disk or another node needs a reset, because the files are on that disk on that node.
 */
export const cloudShellSettingsSchema = z.object({
	/** The node for a new shell's disk; null lets the control plane pick one. */
	nodeId: z.string().min(1).max(64).nullable(),
	diskMb: z
		.number()
		.int()
		.min(cloudShellLimits.minDiskMb)
		.max(cloudShellLimits.maxDiskMb)
		.refine((value) => value % 256 === 0, 'Disk sizes are whole multiples of 256 MiB.'),
	memoryMb: z
		.number()
		.int()
		.min(cloudShellLimits.minMemoryMb)
		.max(cloudShellLimits.maxMemoryMb)
		.refine((value) => value % 128 === 0, 'Memory is a whole multiple of 128 MiB.'),
	cpus: z.number().int().min(1).max(cloudShellLimits.maxCpus),
	idleMinutes: z.number().int().min(cloudShellLimits.minIdleMinutes).max(cloudShellLimits.maxIdleMinutes),
});
export type CloudShellSettings = z.infer<typeof cloudShellSettingsSchema>;

/** `PUT /api/v1/cloud-shell/settings`: any subset; the rest stays as it is. */
export const cloudShellSettingsInputSchema = cloudShellSettingsSchema.partial().strict();
export type CloudShellSettingsInput = z.infer<typeof cloudShellSettingsInputSchema>;

export const cloudShellDefaultSettings: CloudShellSettings = {
	nodeId: null,
	diskMb: cloudShellLimits.diskMb,
	memoryMb: cloudShellLimits.memoryMb,
	cpus: cloudShellLimits.cpus,
	idleMinutes: cloudShellLimits.idleMs / 60_000,
};

/** A node a person may pick for their shell, and why not when they cannot. */
export const cloudShellNodeOptionSchema = z.object({
	id: z.string(),
	name: z.string(),
	online: z.boolean(),
	/** Null when a new shell may be placed there; otherwise the reason it may not. */
	unavailable: z.string().nullable(),
	/** Shells (any person's) whose disk is on this node. */
	shells: z.number().int(),
	/** Free disk the node last reported, in MiB; null before its first report. */
	diskFreeMb: z.number().int().nullable(),
	/** Memory left in the node's workload slice, in MiB, after workloads and running shells. */
	memoryFreeMb: z.number().int(),
	/** The node grows an existing disk in place. */
	canGrowDisk: z.boolean(),
});
export type CloudShellNodeOption = z.infer<typeof cloudShellNodeOptionSchema>;

export const cloudShellStatuses = ['stopped', 'starting', 'running', 'deleting'] as const;

/**
 * What a saved setting waits for: the next `start` (nothing to do), a `restart` of the running
 * shell, a `reset` (a smaller disk, another node), or a `node-update` (its agent cannot grow disks).
 */
export const cloudShellPendingNeeds = ['start', 'restart', 'reset', 'node-update'] as const;
export type CloudShellPendingNeed = (typeof cloudShellPendingNeeds)[number];
export type CloudShellStatus = (typeof cloudShellStatuses)[number];

/** `GET /api/v1/cloud-shell`: the caller's own shell, or `shell: null` before the first start. */
export const cloudShellViewSchema = z.object({
	id: z.string(),
	status: z.enum(cloudShellStatuses),
	node: z.object({ id: z.string(), name: z.string(), online: z.boolean() }).nullable(),
	diskMb: z.number().int(),
	/** What this run of the shell got (fixed at its start). */
	memoryMb: z.number().int(),
	cpus: z.number().int(),
	idleMinutes: z.number().int(),
	home: z.string(),
	image: z.string(),
	/** True when the shell's CLI was handed an access key; false when the role cannot mint one. */
	cliSignedIn: z.boolean(),
	startedAt: z.string().nullable(),
	lastActiveAt: z.string().nullable(),
	/** When the idle timer stops it, while running. */
	stopsAt: z.string().nullable(),
	/** Why the last start failed; null after a start that worked or before any. */
	message: z.string().nullable(),
	/** Saved settings that differ from this shell, and what makes them apply. */
	pending: z.array(z.object({ message: z.string(), needs: z.enum(cloudShellPendingNeeds) })),
	createdAt: z.string(),
});
export type CloudShellView = z.infer<typeof cloudShellViewSchema>;

export const cloudShellStateSchema = z.object({
	enabled: z.boolean(),
	shell: cloudShellViewSchema.nullable(),
	/** The caller's saved settings (defaults until they save some). */
	settings: cloudShellSettingsSchema,
	/** Compute nodes that run cloud shells, for the node picker. */
	nodes: z.array(cloudShellNodeOptionSchema),
	limits: z.object({
		diskMb: z.number().int(),
		memoryMb: z.number().int(),
		idleMinutes: z.number().int(),
		minDiskMb: z.number().int(),
		maxDiskMb: z.number().int(),
		minMemoryMb: z.number().int(),
		maxMemoryMb: z.number().int(),
		maxCpus: z.number().int(),
		minIdleMinutes: z.number().int(),
		maxIdleMinutes: z.number().int(),
		maxSessionHours: z.number().int(),
	}),
});
export type CloudShellState = z.infer<typeof cloudShellStateSchema>;
