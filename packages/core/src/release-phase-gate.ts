import { releasePhaseSpecIssues, type WorkloadSpec } from '@yoal/contracts';
import { featureEnabled, type CoreConfig } from './config.ts';
import { ValidationError } from './errors.ts';

/**
 * Refuse a workload spec that sets release-phase fields (`release`, `readinessPath`,
 * `drainSeconds`, `stopTimeoutSeconds`, `rollout`, `placement`) while `RELEASE_PHASE` is off, the
 * way `workloads.ts` refuses compose and functions behind their flags (HA-PLAN H25).
 *
 * Wave 1 lane C calls this from `WorkloadService.plan()` and `setSpec()` right after the existing
 * compose and function refusals; the foundation PR does not edit `workloads.ts`.
 */
export function assertReleasePhaseSpec(config: Pick<CoreConfig, 'features'>, spec: Partial<WorkloadSpec>): void {
	const [issue] = releasePhaseSpecIssues(spec, { RELEASE_PHASE: featureEnabled(config, 'RELEASE_PHASE') });
	if (issue) throw new ValidationError(issue.message);
}
