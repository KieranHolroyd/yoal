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
 * scenario's flags, its confirmation (`haDrillConfirmationIssue`; the resource is always named,
 * never picked at random) and `haDrillLevelIssue` (the scenario's minimum against the resource's
 * declared level, and the resource against its own declared level), then hands `node-offline` to
 * `NodeDrillService.start` with the named node and `database-failover` to
 * `DatabaseFailoverPolicyService.drill` unchanged, and records every other scenario in `ha_drills`
 * (lane B's migration). `runAll` runs exactly `planHaDrillAll(request, flags).runs`: fleet,
 * non-destructive, untyped scenarios against the resources the operator named, and returns the
 * skipped ones with their reasons. Lab-only scenarios are refused on a fleet.
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
