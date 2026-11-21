import type { ExternalProberAck, ExternalProberReport } from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';

/**
 * The external prober's report sink (HA-PLAN W15).
 *
 * A tiny agent outside the fleet POSTs what it saw; the sink is the control plane's only entry for
 * it. Lane B owns validation, de-duplication by `sequence` and storage in telemetry. Until then the
 * sink refuses every report rather than acknowledging data it drops.
 */
export class ExternalProberService {
	constructor(private readonly ctx: CoreContext) {}

	/** Whether the sink accepts reports; the HTTP route is absent while this is false. */
	enabled(): boolean {
		return featureEnabled(this.ctx.config, 'EXTERNAL_PROBER');
	}

	async report(report: ExternalProberReport): Promise<ExternalProberAck> {
		if (!this.enabled())
			throw new CoreError('unavailable', 'The external prober is off: enable EXTERNAL_PROBER first (HA-PLAN W15).', 409);
		throw new CoreError(
			'conflict',
			`not implemented (HA Wave 4 lane B): external prober report sink (${report.proberId} #${report.sequence})`,
			409,
		);
	}
}
