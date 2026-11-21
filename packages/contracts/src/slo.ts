import { z } from 'zod';

/**
 * W15 service-level objectives and the external prober (HA-PLAN §4 W15).
 *
 * An SLO object belongs to one project: a success-ratio `target` over a rolling window, an error
 * budget derived from it, and a multi-window burn policy. Evaluation reads telemetry and is lane
 * B's; these shapes are what the dashboard, REST and the prober exchange. A prober runs outside the
 * fleet and reports what it saw, so an outage that hides the control plane is still observable.
 */

/** One burn-rate alert: the classic long/short window pair (SRE workbook, multi-burn-rate). */
export const sloBurnAlertSchema = z
	.object({
		severity: z.enum(['warning', 'critical']),
		/** Fire when consumption exceeds this multiple of the allowed rate. */
		burnRate: z.number().positive().max(1_000),
		/** The long window that confirms the burn. */
		windowSeconds: z.number().int().min(60).max(90 * 24 * 60 * 60),
		/** Optional short window for a fast burn; when set it must be shorter than `windowSeconds`. */
		shortWindowSeconds: z.number().int().min(60).max(90 * 24 * 60 * 60).nullable().default(null),
	})
	.refine((alert) => alert.shortWindowSeconds === null || alert.shortWindowSeconds < alert.windowSeconds, {
		message: 'shortWindowSeconds must be shorter than windowSeconds',
		path: ['shortWindowSeconds'],
	});
export type SloBurnAlert = z.infer<typeof sloBurnAlertSchema>;

/** A project's SLO: `target` is a success ratio in (0, 1), e.g. 0.999. */
export const sloObjectInputSchema = z
	.object({
		name: z.string().min(1).max(100),
		description: z.string().max(2_000).nullable().default(null),
		/**
		 * The signal lane B evaluates, e.g. `http_availability`, `database_writable` or
		 * `mail_delivery`. Interpreted against telemetry by the evaluator, never as a query.
		 */
		indicator: z.string().min(1).max(100),
		target: z.number().gt(0).lt(1),
		/** Rolling window over which the target applies. */
		windowSeconds: z.number().int().min(3_600).max(90 * 24 * 60 * 60),
		burnAlerts: z.array(sloBurnAlertSchema).max(8).default([]),
		enabled: z.boolean().default(true),
	})
	.superRefine((slo, ctx) => {
		const windows = new Set<number>();
		for (const [index, alert] of slo.burnAlerts.entries()) {
			const key = alert.windowSeconds * 1_000_000 + (alert.shortWindowSeconds ?? 0);
			if (windows.has(key))
				ctx.addIssue({ code: 'custom', message: 'duplicate burn alert window', path: ['burnAlerts', index] });
			windows.add(key);
			if (alert.windowSeconds > slo.windowSeconds)
				ctx.addIssue({
					code: 'custom',
					message: 'a burn alert window cannot be longer than the SLO window',
					path: ['burnAlerts', index, 'windowSeconds'],
				});
		}
	});
export type SloObjectInput = z.infer<typeof sloObjectInputSchema>;

/** The stored object, as every read surface returns it. */
export const sloObjectSchema = z.object({
	id: z.string().min(1).max(100),
	orgId: z.string().min(1).max(100),
	projectId: z.string().min(1).max(100),
	name: z.string().min(1).max(100),
	description: z.string().max(2_000).nullable(),
	indicator: z.string().min(1).max(100),
	target: z.number().gt(0).lt(1),
	windowSeconds: z.number().int().min(3_600).max(90 * 24 * 60 * 60),
	burnAlerts: z.array(sloBurnAlertSchema),
	enabled: z.boolean(),
	createdBy: z.string().min(1).max(100),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type SloObject = z.infer<typeof sloObjectSchema>;

/**
 * The error budget over a window. `total` is the fraction of events allowed to fail (1 - target);
 * `consumed` is the share of that budget already spent. `burnRate` is 1 while consumption tracks
 * the elapsed window, above 1 when it is exhausting early.
 */
export const sloErrorBudgetSchema = z.object({
	total: z.number().min(0).max(1),
	consumed: z.number().min(0).max(1),
	remaining: z.number().min(0).max(1),
	burnRate: z.number().nonnegative(),
});
export type SloErrorBudget = z.infer<typeof sloErrorBudgetSchema>;

export const sloWindowSchema = z.object({
	startsAt: z.string().datetime(),
	endsAt: z.string().datetime(),
});
export type SloWindow = z.infer<typeof sloWindowSchema>;

/** The read view. `errorBudget` is null until the evaluator has a window to report. */
export const sloObjectViewSchema = sloObjectSchema.extend({
	errorBudget: sloErrorBudgetSchema.nullable(),
});
export type SloObjectView = z.infer<typeof sloObjectViewSchema>;

/** One burn alert's state at evaluation time. */
export const sloBurnAlertStateSchema = z.object({
	severity: z.enum(['warning', 'critical']),
	burnRate: z.number().positive(),
	observedBurnRate: z.number().nonnegative(),
	firing: z.boolean(),
});
export type SloBurnAlertState = z.infer<typeof sloBurnAlertStateSchema>;

/** What `evaluate` returns for one SLO at one instant. */
export const sloEvaluationSchema = z.object({
	sloId: z.string().min(1).max(100),
	evaluatedAt: z.string().datetime(),
	window: sloWindowSchema,
	errorBudget: sloErrorBudgetSchema,
	burnAlerts: z.array(sloBurnAlertStateSchema),
	/** Why the evaluation could not be complete, if it was not. */
	note: z.string().max(1_000).nullable(),
});
export type SloEvaluation = z.infer<typeof sloEvaluationSchema>;

/** A single probe the external prober ran. */
export const externalProberTargetSchema = z.object({
	/** Stable id within the prober, e.g. `https://app.example.com/healthz`. */
	target: z.string().min(1).max(2_048),
	kind: z.enum(['http', 'https', 'tcp', 'dns', 'database', 'other']),
	status: z.enum(['up', 'degraded', 'down']),
	statusCode: z.number().int().min(100).max(599).nullable().default(null),
	/** Round trip in milliseconds; null when the probe could not complete one. */
	latencyMs: z.number().nonnegative().nullable().default(null),
	error: z.string().max(2_000).nullable().default(null),
	checkedAt: z.string().datetime(),
});
export type ExternalProberTarget = z.infer<typeof externalProberTargetSchema>;

/**
 * What an external prober POSTs to the control plane. It is deliberately small and push-only: the
 * prober holds no credentials beyond its registration token and never reads desired state.
 */
export const externalProberReportSchema = z.object({
	proberId: z.string().min(1).max(100),
	/** Monotonic per prober; a report at or below the last sequence is stale and ignored. */
	sequence: z.number().int().nonnegative(),
	sentAt: z.string().datetime(),
	/** The install the prober was registered for; omitted on older registrations. */
	installId: z.string().max(100).nullable().default(null),
	targets: z.array(externalProberTargetSchema).min(1).max(1_000),
});
export type ExternalProberReport = z.infer<typeof externalProberReportSchema>;

/** The control plane's answer to an accepted report. */
export const externalProberAckSchema = z.object({
	proberId: z.string().min(1).max(100),
	sequence: z.number().int().nonnegative(),
	receivedAt: z.string().datetime(),
	/** Targets the sink accepted; lower than `targets.length` only for documented drops. */
	accepted: z.number().int().nonnegative(),
});
export type ExternalProberAck = z.infer<typeof externalProberAckSchema>;
