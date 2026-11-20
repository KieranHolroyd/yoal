import type { SteeringDriver, SteeringDriverKind } from '@yoal/contracts';
import { createDirectDriver } from './direct/index.ts';
import { createExternalLbDriver } from './external-lb/index.ts';
import type { SteeringDriverContext, SteeringDriverFactory } from './types.ts';

/**
 * The steering driver registry (HA-PLAN H18, §6.3). Each driver is a directory with its own tests
 * and passes the shared conformance suite; adding one is a registry line, not a change to the
 * controller.
 *
 * Kinds that are in the contract but not built yet are absent, so selection fails with a reason
 * instead of silently steering nothing: `dns-failover`, `vip`, `cloud-lb`, `cloudflare-tunnel` and
 * `webhook` are later lanes (W8, after M5 for the cloud balancers).
 */
export const STEERING_DRIVER_FACTORIES: Readonly<Partial<Record<SteeringDriverKind, SteeringDriverFactory>>> = {
	direct: createDirectDriver,
	'external-lb': createExternalLbDriver,
};

export function createSteeringDriver(kind: SteeringDriverKind, context: SteeringDriverContext): SteeringDriver {
	const factory = STEERING_DRIVER_FACTORIES[kind];
	if (!factory) throw new Error(`not implemented (HA Wave 2): steering driver ${kind}`);
	return factory(context);
}

/** The kinds this build can actually run, for `yoal ha status`/preflight and the conformance run. */
export function implementedSteeringDrivers(): SteeringDriverKind[] {
	return Object.keys(STEERING_DRIVER_FACTORIES) as SteeringDriverKind[];
}

export type {
	SteeringDriverContext,
	SteeringDriverFactory,
	SteeringFence,
	SteeringFinding,
	SteeringNode,
	SteeringObserved,
	SteeringTickResult,
} from './types.ts';
