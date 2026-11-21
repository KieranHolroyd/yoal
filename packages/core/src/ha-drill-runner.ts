import {
	HA_DRILL_CATALOGUE,
	type HaDrillAllRequest,
	type HaDrillAllView,
	type HaDrillCatalogueView,
	type HaDrillRunRequest,
	type HaDrillRunView,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';

/**
 * `yoal ha drill <scenario> [resource]` and `yoal ha drill --all` (HA-PLAN H27, §7.2, §10, W14).
 * **Owner: Wave 5 lane B (`ha/w5-b-ha-commands`).** The signatures are final.
 *
 * `catalogue` returns `HA_DRILL_CATALOGUE` as it is. `run` checks the platform admin, the
 * scenario's flags, its confirmation (`haDrillConfirmationIssue`) and the resource's HA level
 * against `minHaLevel`, then hands `node-offline` to `NodeDrillService` and `database-failover` to
 * `DatabaseFailoverPolicyService.drill` unchanged, and records every other scenario in `ha_drills`
 * (lane B's migration). `runAll` runs the `fleet` scenarios with `inAll`, one resource each, and
 * lists the rest as skipped with the reason. Lab-only scenarios are refused on a fleet.
 */
export class HaDrillRunner {
	constructor(private readonly ctx: CoreContext) {}

	catalogue(principal: Principal): HaDrillCatalogueView {
		if (!this.ctx.platformIam.allows(principal, 'platform:ha'))
			throw new CoreError('forbidden', 'High availability is for platform operators and admins.', 403);
		return { scenarios: HA_DRILL_CATALOGUE };
	}

	async run(_principal: Principal, _input: HaDrillRunRequest): Promise<HaDrillRunView> {
		throw new CoreError('not_built', 'Catalogue drills are not built yet (HA-PLAN W14, Wave 5 lane B); `yoal ha drill node-offline` works today.', 501);
	}

	async runAll(_principal: Principal, _input: HaDrillAllRequest): Promise<HaDrillAllView> {
		throw new CoreError('not_built', '`yoal ha drill --all` is not built yet (HA-PLAN W14, Wave 5 lane B).', 501);
	}
}
