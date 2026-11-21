import type { SloBurnAlert, SloBurnAlertState, SloErrorBudget } from '@yoal/contracts';
import type { CoreContext } from './context.ts';

/**
 * SLO evaluation (HA-PLAN W15).
 *
 * The arithmetic is pure so it can be tested without ClickHouse; the signal source turns an
 * indicator into a good/total pair from the existing telemetry. A trailing window is always fully
 * elapsed, so `burnRate` equals `consumed` for the budget; the elapsed fraction is still a parameter
 * so a future calendar-window SLO does not have to change the formula.
 *
 * An unavailable or empty source never fabricates a healthy ratio: the evaluation reports zero
 * events and a note, and no burn alert fires (a blind window is not a burn).
 */

export interface SloSignalCounts {
	/** Events the indicator counts as successful. */
	good: number;
	/** All events observed; zero means the source could not answer or saw none. */
	total: number;
	/** Why the counts are empty or incomplete, if they are. */
	note: string | null;
}

export interface SloSignalSource {
	counts(indicator: string, projectId: string, fromMs: number, toMs: number): Promise<SloSignalCounts>;
}

const HOUR_MS = 3_600_000;
/** The hot store keeps 1-minute rows for 48 h; older windows read rolled-up hours. */
const MINUTE_ROWS_MAX_MS = 47 * HOUR_MS;

/** The telemetry interval that can answer a window without reading data that has been pruned. */
export function intervalForWindow(fromMs: number, toMs: number): '1m' | '1h' {
	return toMs - fromMs > MINUTE_ROWS_MAX_MS ? '1h' : '1m';
}

const finiteNonNegative = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * The error budget over a window. `total` is the allowed failure fraction (`1 - target`);
 * `consumed`/`remaining` are shares of that fraction; `burnRate` is consumption per elapsed unit.
 */
export function computeErrorBudget(input: {
	target: number;
	good: number;
	total: number;
	/** Share of the SLO window that has elapsed, in (0, 1]. */
	elapsedFraction?: number;
}): SloErrorBudget {
	const allowed = 1 - input.target;
	const events = finiteNonNegative(input.total);
	const good = Math.min(events, finiteNonNegative(input.good));
	if (allowed <= 0 || events === 0)
		return { hasData: false, total: Math.max(0, allowed), consumed: 0, remaining: 1, burnRate: 0 };
	const badRatio = (events - good) / events;
	const raw = badRatio / allowed;
	const consumed = Math.min(1, Math.max(0, raw));
	const elapsed = Math.min(1, Math.max(0.000_001, input.elapsedFraction ?? 1));
	return {
		hasData: true,
		total: allowed,
		consumed,
		remaining: 1 - consumed,
		burnRate: Math.max(0, raw) / elapsed,
	};
}

/** The burn rate a window observed, or null when it has no events to judge. */
export function observedBurnRate(good: number, total: number, target: number): number | null {
	const allowed = 1 - target;
	if (!(allowed > 0) || !(total > 0)) return null;
	const badRatio = Math.max(0, total - Math.max(0, good)) / total;
	return badRatio / allowed;
}

/**
 * One burn alert at evaluation time. A multi-window alert fires only when both the long and the
 * short window exceed its threshold; a window without events cannot confirm a burn.
 */
export function evaluateBurnAlert(
	alert: SloBurnAlert,
	target: number,
	long: { good: number; total: number },
	short: { good: number; total: number } | null,
): SloBurnAlertState {
	const observed = observedBurnRate(long.good, long.total, target) ?? 0;
	const shortObserved = short ? observedBurnRate(short.good, short.total, target) : null;
	const firing =
		observed >= alert.burnRate && (short === null || (shortObserved !== null && shortObserved >= alert.burnRate));
	return { severity: alert.severity, burnRate: alert.burnRate, observedBurnRate: observed, firing };
}

/** The evaluator's telemetry adapter; a missing or offline store is a note, never an error. */
export class TelemetrySloSignalSource implements SloSignalSource {
	constructor(private readonly ctx: CoreContext) {}

	async counts(indicator: string, projectId: string, fromMs: number, toMs: number): Promise<SloSignalCounts> {
		const telemetry = this.ctx.telemetry;
		if (!telemetry) return { good: 0, total: 0, note: 'telemetry is not configured on this control plane' };
		let ready = false;
		try {
			ready = await telemetry.ready();
		} catch {
			ready = false;
		}
		if (!ready) return { good: 0, total: 0, note: 'the telemetry store is unavailable' };
		const interval = intervalForWindow(fromMs, toMs);
		if (indicator === 'http_availability') {
			const points = await telemetry.query({ projectIds: [projectId], from: fromMs, to: toMs, interval });
			let total = 0;
			let bad = 0;
			for (const point of points) {
				total += Math.max(0, point.requests);
				bad += Math.max(0, point.status5xx);
			}
			return {
				good: Math.max(0, total - Math.min(total, bad)),
				total,
				note: total === 0 ? 'no requests were recorded in the window' : null,
			};
		}
		if (indicator === 'database_writable') {
			const ids = this.ctx.sqlite
				.query<{ database_id: string }, [string]>('SELECT database_id FROM database_attachments WHERE project_id = ?')
				.all(projectId)
				.map((row) => row.database_id);
			if (ids.length === 0) return { good: 0, total: 0, note: 'the project has no attached database' };
			let total = 0;
			let good = 0;
			for (const databaseId of ids) {
				const points = await telemetry.queryDatabaseMetrics({ databaseId, from: fromMs, to: toMs, interval });
				for (const point of points) {
					total += 1;
					good += Math.min(1, Math.max(0, point.up));
				}
			}
			return {
				good,
				total,
				note: total === 0 ? 'no database samples were recorded in the window' : null,
			};
		}
		return {
			good: 0,
			total: 0,
			note: `indicator "${indicator}" has no evaluator; supported indicators are http_availability and database_writable`,
		};
	}
}
