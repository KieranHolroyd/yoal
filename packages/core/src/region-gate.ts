import { regionWriteIssues, type RegionWrite } from '@yoal/contracts';
import { featureEnabled, type CoreConfig } from './config.ts';
import { ValidationError } from './errors.ts';

/**
 * The `REGIONS` gate (HA-PLAN H26, W13), the way `release-phase-gate.ts` gates H25. Every write path
 * that can carry a region value calls it before it stores anything:
 * - `NodeService.update` (`node.region`; REST `PATCH /nodes/:id`, the dashboard, `yoal nodes set`);
 * - `DatabaseService.create` and `update` (`database.standbyRegion`; REST, MCP, blueprints,
 *   config import, which all create through the service);
 * - `ClusterConfigService.update` (`cluster.replicas.spread`; REST, dashboard, `ha init`);
 * - `ProjectService.create` and `update` (`project.placementSpec.spread`; REST, MCP, dashboard,
 *   config import);
 * - `assertReleasePhaseSpec` (`workload.placement.spread`; every `setSpec` and deploy plan).
 *
 * With the flag **off**, a write that changes a region value is a `ValidationError` naming the
 * field and the flag; re-sending the stored value, naming the default region and clearing a
 * standby region are always allowed. With the flag **on**, every region value is stored and acted
 * on: `spread: region` places copies in distinct regions (`replicas.ts`), a standby region places
 * an async replica there (`DatabaseService`), and a zone stays in one region (`zoneRegionIssue`).
 */
export function assertRegionWrites(config: Pick<CoreConfig, 'features'>, writes: readonly RegionWrite[]): void {
	const [issue] = regionWriteIssues(writes, { REGIONS: featureEnabled(config, 'REGIONS') });
	if (issue) throw new ValidationError(issue.message);
}
