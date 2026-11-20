import { releasePhaseSpecIssues, type WorkloadSpec } from '@yoal/contracts';
import { featureEnabled, type CoreConfig } from './config.ts';
import { ValidationError } from './errors.ts';

/**
 * Refuse a workload spec that sets release-phase fields (`release`, `readinessPath`,
 * `drainSeconds`, `stopTimeoutSeconds`, `rollout`, `placement`) while `RELEASE_PHASE` is off, the
 * way `workloads.ts` refuses compose and functions behind their flags (HA-PLAN H25).
 *
 * Called from `WorkloadService.setSpec()` (every write path: REST, dashboard, MCP, blueprints,
 * config import, GitHub import, templates, image deploys, pipelines) and `plan()` (deploys).
 * `current` is the stored spec: an unchanged leftover from when the flag was on is allowed.
 */
export function assertReleasePhaseSpec(
	config: Pick<CoreConfig, 'features'>,
	spec: Partial<WorkloadSpec>,
	current?: Partial<WorkloadSpec> | null,
): void {
	const [issue] = releasePhaseSpecIssues(spec, { RELEASE_PHASE: featureEnabled(config, 'RELEASE_PHASE') }, current);
	if (issue) throw new ValidationError(issue.message);
}
