import type { Principal, RegionPromoteRequest, RegionPromotionPlan, RegionPromotionView, RegionsView } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';

/**
 * Regions and the region promotion (HA-PLAN H26, W13). **Owner: Wave 5 lane A
 * (`ha/w5-a-regions`).** The signatures are final; the bodies are lane A's.
 *
 * - `view` lists regions (from node `region`, migration 0132), ambiguous zones (`zoneRegions`),
 *   the open promotion and recent ones. Needs `platform:ha`.
 * - `promote` runs `yoal ha region promote <region>` on the control plane in the surviving region:
 *   without `confirm` it computes and returns the plan (never stored; each step's expected
 *   generation and the `planHash`); with `confirm` (the region name typed back), `planHash`,
 *   `acceptDataLoss: true` and a reason, it runs the control-plane step first (W9 promote at the
 *   expected epoch), then writes `region_promotions` and its steps under the new epoch, then the
 *   database steps (each fenced on its own lease generation), then steering. Each step is
 *   idempotent, keyed on its fenced generation; the runner lease lets another control plane
 *   resume a crashed run and never run a step twice (`packages/contracts/src/region.ts`).
 *   Platform admin signed in to the dashboard or CLI only; never an MCP write tool. Audited.
 * Both refuse while `REGIONS` is off.
 */
export class RegionService {
	constructor(private readonly ctx: CoreContext) {}

	view(_principal: Principal): RegionsView {
		void this.ctx;
		throw new CoreError('not_built', 'The regions view is not built yet (HA-PLAN W13, Wave 5 lane A).', 501);
	}

	async promote(_principal: Principal, _region: string, _input: RegionPromoteRequest): Promise<RegionPromotionPlan | RegionPromotionView> {
		throw new CoreError('not_built', 'Region promotion is not built yet (HA-PLAN W13, Wave 5 lane A).', 501);
	}
}
