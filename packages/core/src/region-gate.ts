import { regionWriteIssues, isRegionWrite, type RegionWrite } from '@yoal/contracts';
import { featureEnabled, type CoreConfig } from './config.ts';
import { CoreError, ValidationError } from './errors.ts';

/**
 * The `REGIONS` gate (HA-PLAN H26, W13; Wave 5 foundation), the way `release-phase-gate.ts` gates
 * H25. Every write path that can carry a region value calls it before it stores anything:
 * - `NodeService.update` (`node.region`; REST `PATCH /nodes/:id`, the dashboard);
 * - `DatabaseService.create` and `update` (`database.standbyRegion`; REST, MCP, blueprints,
 *   config import, which all create through the service);
 * - `ClusterConfigService.update` (`cluster.replicas.spread`; REST, dashboard, `ha init`);
 * - `ProjectService.create` and `update` (`project.placementSpec.spread`; REST, MCP, dashboard,
 *   config import);
 * - `assertReleasePhaseSpec` (`workload.placement.spread`; every `setSpec` and deploy plan).
 * Blueprint HA keys are refused whole until lane C (`blueprints-ha.ts`).
 *
 * With the flag **off**, a write that changes a region value is a `ValidationError` naming the
 * field and the flag; re-sending the stored value is allowed. With the flag **on**, a node region
 * is stored (it is a label, and `zoneRegionIssue` keeps each zone in one region), but
 * `spread: region` and a standby region are refused as not built: placement and the standby
 * replica are W13 lane A (`ha/w5-a-regions`), which deletes that branch when it builds them.
 */
export function assertRegionWrites(config: Pick<CoreConfig, 'features'>, writes: readonly RegionWrite[]): void {
	const [issue] = regionWriteIssues(writes, { REGIONS: featureEnabled(config, 'REGIONS') });
	if (issue) throw new ValidationError(issue.message);
	const unbuilt = writes.find((write) => write.field !== 'node.region' && isRegionWrite(write));
	if (unbuilt)
		throw new CoreError(
			'not_built',
			`${unbuilt.field} is not built yet (HA-PLAN W13, Wave 5 lane A); regions are enabled but only node regions are stored.`,
			501,
		);
}
