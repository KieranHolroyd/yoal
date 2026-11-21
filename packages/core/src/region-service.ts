import type { Principal, RegionPromoteRequest, RegionPromotionView, RegionsView } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';

/**
 * Regions and the region promotion (HA-PLAN H26, W13). **Owner: Wave 5 lane A
 * (`ha/w5-a-regions`).** The signatures are final; the bodies are lane A's.
 *
 * - `view` lists regions (from node `region`, migration 0132), ambiguous zones (`zoneRegions`),
 *   the open promotion and recent ones. Needs `platform:ha`.
 * - `promote` runs `yoal ha region promote <region>`: without `confirm` it records and returns the
 *   plan (`awaiting-confirmation`, with the generation to pass back); with `confirm` (the region
 *   name typed back), `expectedGeneration`, `acceptDataLoss: true` and a reason, it fences (lease
 *   generation + 1) and runs control plane → databases → steering (`nextRegionPromotionStage`).
 *   Platform admin signed in to the dashboard or CLI only; never an MCP write tool. Audited.
 * Both refuse while `REGIONS` is off.
 */
export class RegionService {
	constructor(private readonly ctx: CoreContext) {}

	view(_principal: Principal): RegionsView {
		void this.ctx;
		throw new CoreError('not_built', 'The regions view is not built yet (HA-PLAN W13, Wave 5 lane A).', 501);
	}

	async promote(_principal: Principal, _region: string, _input: RegionPromoteRequest): Promise<RegionPromotionView> {
		throw new CoreError('not_built', 'Region promotion is not built yet (HA-PLAN W13, Wave 5 lane A).', 501);
	}
}
