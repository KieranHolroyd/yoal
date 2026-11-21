/**
 * W11-SPEC §3, the arming policy. Pure functions over the per-database policy and the fleet facts an
 * operator action is checked against. No simulation state, so every rule can be exercised directly.
 *
 * W11-SPEC §3:
 *
 *   `auto` may be armed only when all hold:
 *   - the global flag `DB_AUTO_PROMOTE` is on and the database's `durability` is `sync`, or `async`
 *     with `acceptDataLoss = true`;
 *   - `count(nodes with role data and capability db-member) >= 3`, in ≥ 2 distinct zones;
 *   - `now - lastFailoverDrillAt <= 30 days`, and the drill passed;
 *   - the database has a replica on another online node;
 *   - no active switchover (`switchoverStep` not null) and no sync transition
 *     (`syncState !== 'stepping'`);
 *   - every involved node is on a version that declares `db-member`.
 */
import type { ArmDecision, Durability, PolicyConfig, RefusalReason } from './spec.ts';

export interface ArmingInput extends PolicyConfig {
	durability: Durability;
}

/**
 * Evaluate every rule (not just the first failing one), so a refusal can name all its causes.
 *
 * `requested: 'manual'` is not a refusal: it is the default mode. The model reports `armed: false`
 * with an empty `refusals` list, which is what makes `auto` an explicit operator action.
 */
export function evaluateArming(input: ArmingInput): ArmDecision {
	if (input.requested !== 'auto') return { armed: false, mode: 'manual', refusals: [] };

	const refusals: RefusalReason[] = [];
	if (!input.globalFlag) refusals.push('global-flag-off');

	// W11 §1.3: `async` auto needs an explicit acceptDataLoss; without it the mode is refused, not
	// silently RPO > 0. A `sync` database does not need the flag.
	if (input.durability === 'async' && !input.acceptDataLoss)
		refusals.push('durability-async-without-accept-data-loss');

	if (input.dataNodes < 3) refusals.push('fewer-than-three-data-nodes');
	if (input.zones < 2) refusals.push('fewer-than-two-zones');

	switch (input.drill) {
		case 'none':
			refusals.push('no-failover-drill');
			break;
		case 'failed':
			refusals.push('failover-drill-failed');
			break;
		case 'stale':
			refusals.push('failover-drill-stale');
			break;
		case 'passed':
			break;
	}

	if (!input.replicaOnAnotherOnlineNode) refusals.push('no-replica-on-another-online-node');
	if (input.switchoverActive) refusals.push('active-switchover');
	if (input.syncStepping) refusals.push('sync-transition');
	if (!input.allDbMember) refusals.push('node-not-db-member');

	return {
		armed: refusals.length === 0,
		mode: refusals.length === 0 ? 'auto' : 'manual',
		refusals,
	};
}

/** A valid, armed `auto` policy for the model's three members in two zones. */
export function defaultPolicy(durability: Durability): PolicyConfig {
	return {
		requested: 'auto',
		globalFlag: true,
		acceptDataLoss: durability === 'async',
		dataNodes: 3,
		zones: 2,
		drill: 'passed',
		replicaOnAnotherOnlineNode: true,
		switchoverActive: false,
		syncStepping: false,
		allDbMember: true,
	};
}

/**
 * The live half of the policy. W11 §3 states the arming action; the model re-evaluates the one
 * condition that can change without an operator action: a `sync` database that has been downgraded
 * to effective `async` by `on_sync_loss` no longer satisfies "durability is sync, or async with
 * acceptDataLoss". Re-evaluating can only *disable* auto, never enable it, so it is a conservative
 * reading (recorded in W11-MODEL.md §assumptions).
 */
export function autoEnabledFor(armed: boolean, durabilityEffective: Durability, acceptDataLoss: boolean): boolean {
	if (!armed) return false;
	if (durabilityEffective === 'async' && !acceptDataLoss) return false;
	return true;
}
