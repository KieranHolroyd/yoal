import { blueprintHaKeys, type Blueprint, type BlueprintResourceDiff, type Principal } from '@yoal/contracts';
import { CoreError } from './errors.ts';
import type { CoreContext } from './context.ts';

/**
 * Blueprint HA keys (HA-PLAN §8, W14). **Owner: Wave 5 lane C (`ha/w5-c-blueprint`).**
 *
 * The keys parse today (`blueprintClusterSchema`, the project and database HA fields in
 * `packages/contracts/src/blueprint.ts`), so a file can be validated. Plan and apply do not act on
 * them yet: `assertBlueprintHaKeysSupported` refuses a document that sets any, naming each key, so
 * a file never applies without the part an operator cared about most. Lane C replaces the refusal
 * with `planBlueprintHa` and `applyBlueprintHa`, checks `cluster.requires` as assertions, and adds
 * an HA section to the plan diff. Decisions it must keep:
 * - `projects.<p>.placement: { spread }` is the workload's `placement.spread`, applied through
 *   `setSpec` (so `RELEASE_PHASE` and `REGIONS` gate it as today); it never touches `placementSpec`;
 * - `databases.<d>.failover: auto` (with `acceptDataLoss` for async) goes through
 *   `DatabaseFailoverPolicyService.arm`, as `yoal db failover --arm` does, never a direct write;
 *   `manual` goes through `disarm`;
 * - `cluster.steering` goes through `ClusterConfigService.update`, as `ha init` does: the last
 *   write wins, and the plan shows the diff against the live value;
 * - region values go through `assertRegionWrites`.
 */
export function assertBlueprintHaKeysSupported(doc: Blueprint): void {
	const keys = blueprintHaKeys(doc);
	if (keys.length === 0) return;
	throw new CoreError(
		'not_built',
		`This blueprint sets HA keys that plan and apply do not support yet (HA-PLAN §8, Wave 5 lane C): ${keys.join(', ')}. Remove them to plan the rest.`,
		501,
	);
}

/** The HA section of a plan: one diff per HA key against live state. Lane C. */
export function planBlueprintHa(_ctx: CoreContext, _principal: Principal, _doc: Blueprint): BlueprintResourceDiff[] {
	throw new CoreError('not_built', 'Blueprint HA plan is not built yet (HA-PLAN W14, Wave 5 lane C).', 501);
}

/** Apply the HA section of a reviewed plan through the normal services. Lane C. */
export async function applyBlueprintHa(_ctx: CoreContext, _principal: Principal, _doc: Blueprint): Promise<void> {
	throw new CoreError('not_built', 'Blueprint HA apply is not built yet (HA-PLAN W14, Wave 5 lane C).', 501);
}
