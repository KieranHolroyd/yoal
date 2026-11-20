import { describe, expect, test } from 'bun:test';
import { ingressSettingsSchema, steeringDriverKinds, type IngressSettings, type SteeringDriver } from '@yoal/contracts';
import type { SteeringDriverContext, SteeringNode } from './types.ts';

const T0 = Date.parse('2026-11-20T12:00:00Z');

/** A node as the controller sees it, with the fields these tests care about. */
export function steeringNode(overrides: Partial<SteeringNode> = {}): SteeringNode {
	return {
		id: 'node-a',
		name: 'node-a',
		zone: 'a',
		status: 'online',
		roles: ['ingress', 'compute'],
		capabilities: ['ingress-set'],
		ingress: true,
		capable: true,
		lastHeartbeatAt: T0,
		...overrides,
	};
}

/** A frozen read-only context. A driver that mutates what it is given throws in the suite. */
export function steeringContext(
	nodes: SteeringNode[],
	settings: Partial<IngressSettings> = {},
	now = T0,
): SteeringDriverContext {
	const fleet = Object.freeze(nodes.map((node) => Object.freeze({ ...node })));
	const resolved = Object.freeze(ingressSettingsSchema.parse(settings));
	return {
		now: () => now,
		nodes: () => fleet,
		settings: () => resolved,
	};
}

export interface SteeringConformanceOptions {
	/** Build a driver for one context. Each test gets a fresh instance. */
	create(context: SteeringDriverContext): SteeringDriver;
	/** Set false only for `direct`, which is valid with no ingress and owns no serving set. */
	requiresIngress?: boolean;
	/** `withdraw` for a floating address: a stale VIP is worse than none. Default `keep` (DNS). */
	lastHealthyAllFail?: 'keep' | 'withdraw';
}

const fleet = (statuses: Array<Partial<SteeringNode>> = [{}, {}, {}]) =>
	statuses.map((overrides, index) =>
		steeringNode({ id: `node-${index + 1}`, name: `node-${index + 1}`, zone: String.fromCharCode(97 + index), ...overrides }),
	);

/**
 * The suite every steering driver passes (HA-PLAN §4 W8, §7.1 "driver conformance"). It asserts the
 * contract, the read-only shape of the context, idempotent `desired()`, the conventional
 * `observe()` result and the rule that a driver never removes the last healthy ingress.
 */
export function describeSteeringConformance(label: string, options: SteeringConformanceOptions): void {
	const requiresIngress = options.requiresIngress ?? true;
	const managesServingSet = (driver: SteeringDriver) => driver.capabilities.writes || driver.capabilities.probes !== 'none';

	describe(`steering conformance: ${label}`, () => {
		test('declares a known kind and honest capabilities', () => {
			const driver = options.create(steeringContext(fleet()));
			expect(steeringDriverKinds).toContain(driver.kind);
			expect(['yoal', 'external', 'none']).toContain(driver.capabilities.probes);
			expect(typeof driver.capabilities.writes).toBe('boolean');
			expect(['native', 'proxy-protocol', 'header']).toContain(driver.capabilities.preservesClientIp);
		});

		test('a healthy fleet preflights clean', () => {
			expect(options.create(steeringContext(fleet())).preflight()).toEqual([]);
		});

		test('preflight is deterministic, names a reason and the real incapable node', () => {
			const nodes = fleet([{}, { capable: false }, {}]);
			const driver = options.create(steeringContext(nodes));
			const first = driver.preflight();
			const second = driver.preflight();
			expect(second).toEqual(first);
			if (requiresIngress) {
				const incapable = nodes.find((node) => !node.capable)!;
				expect(first.map((finding) => finding.nodeId)).toContain(incapable.id);
			}
			// At most one reason per node, even when several things are wrong with it.
			const perNode = first.flatMap((finding) => (finding.nodeId === null ? [] : [finding.nodeId]));
			expect(new Set(perNode).size).toBe(perNode.length);
			for (const finding of first) {
				expect(finding.reason.trim().length).toBeGreaterThan(0);
				if (finding.nodeId !== null) expect(nodes.map((node) => node.id)).toContain(finding.nodeId);
			}
		});

		test('refuses an empty fleet when it needs ingress to steer', () => {
			const driver = options.create(steeringContext([]));
			const findings = driver.preflight();
			if (!requiresIngress) {
				expect(findings).toEqual([]);
				return;
			}
			expect(findings.some((finding) => finding.nodeId === null)).toBe(true);
			expect(findings.find((finding) => finding.nodeId === null)!.reason.length).toBeGreaterThan(0);
		});

		test('desired() is idempotent and reads only what the context gives it', async () => {
			const driver = options.create(steeringContext(fleet()));
			await driver.desired();
			const first = await driver.observe();
			await driver.desired();
			const second = await driver.observe();
			expect(second).toEqual(first);
		});

		test('observe() returns the conventional shape and only known node ids', async () => {
			const nodes = fleet();
			const driver = options.create(steeringContext(nodes));
			const observed = (await driver.observe()) as Record<string, unknown>;
			expect(observed.kind).toBe(driver.kind);
			expect(typeof observed.observedAt).toBe('number');
			expect(Array.isArray(observed.healthy)).toBe(true);
			expect(Array.isArray(observed.serving)).toBe(true);
			const ids = nodes.map((node) => node.id);
			for (const id of [...(observed.healthy as string[]), ...(observed.serving as string[])]) expect(ids).toContain(id);
		});

		test('never removes the last healthy ingress', async () => {
			let nodes = fleet();
			const settings = Object.freeze(ingressSettingsSchema.parse({}));
			const context: SteeringDriverContext = {
				now: () => T0,
				nodes: () => nodes,
				settings: () => settings,
			};
			const driver = options.create(context);
			await driver.desired();
			const before = (await driver.observe()) as { serving: string[] };
			expect(before.serving.length).toBe(3);
			if (!managesServingSet(driver)) return;

			// Two go silent: only the healthy one remains a candidate.
			nodes = fleet([{}, { status: 'offline' }, { status: 'offline' }]);
			await driver.desired();
			const oneLeft = (await driver.observe()) as { serving: string[] };
			expect(oneLeft.serving).toEqual(['node-1']);

			// The last one goes silent too. DNS keeps the last record; a floating address withdraws.
			nodes = fleet([{ status: 'offline' }, { status: 'offline' }, { status: 'offline' }]);
			await driver.desired();
			const kept = (await driver.observe()) as { serving: string[] };
			expect(kept.serving).toEqual(options.lastHealthyAllFail === 'withdraw' ? [] : ['node-1']);
		});
	});
}
