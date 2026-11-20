import { describe, expect, test } from 'bun:test';
import { describeSteeringConformance, steeringContext } from './conformance.ts';
import { createDirectDriver } from './direct/index.ts';
import { createExternalLbDriver } from './external-lb/index.ts';
import { createSteeringDriver, implementedSteeringDrivers, STEERING_DRIVER_FACTORIES } from './registry.ts';

/**
 * Every built-in driver passes the same suite (HA-PLAN §4 W8, §6.3). The suite is what makes one
 * agent per driver safe: the reviewer reads this file's result, not each provider's API usage.
 *
 * `direct` is the single-node behaviour and owns no serving set, so it skips the empty-fleet refusal.
 */
describeSteeringConformance('direct', {
	create: createDirectDriver,
	requiresIngress: false,
});

describeSteeringConformance('external-lb', {
	create: createExternalLbDriver,
});

describe('steering registry', () => {
	test('every implemented kind has a factory and every factory has a kind', () => {
		const kinds = implementedSteeringDrivers();
		expect(new Set(kinds).size).toBe(kinds.length);
		expect(kinds.sort()).toEqual(['direct', 'external-lb']);
		for (const kind of kinds) expect(typeof STEERING_DRIVER_FACTORIES[kind]).toBe('function');
	});

	test('a kind the build has not built throws a named error instead of steering nothing', () => {
		expect(STEERING_DRIVER_FACTORIES['dns-failover']).toBeUndefined();
		expect(() => createSteeringDriver('dns-failover', steeringContext([]))).toThrow(/not implemented/);
	});
});
