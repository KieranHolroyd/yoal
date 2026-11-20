import { describe, expect, test } from 'bun:test';
import { ControlLease, MemoryConditionalStore } from './ha-lease.ts';
import {
	CONTROL_STANDBY_TIMERS,
	ControlStandby,
	evaluatePromotion,
	evaluatePrimaryReadiness,
	type PromotionEvidence,
} from './control-standby.ts';

function readyEvidence(overrides: Partial<PromotionEvidence> = {}): PromotionEvidence {
	return {
		replica: { restored: true, lagSeconds: 0, position: 'ltx:1/0' },
		masterKeyFingerprint: 'aa',
		expectedMasterKeyFingerprint: 'aa',
		configDigest: 'bb',
		expectedConfigDigest: 'bb',
		migrationsApplied: true,
		...overrides,
	};
}

/**
 * One simulated clock for the arbiter and every node, mirroring `ha-lease.test.ts`. Each node has
 * its own store view, so a partition is a per-node fault.
 */
function world() {
	let now = 1_000_000;
	const store = new MemoryConditionalStore(() => now);
	const node = (nodeId: string) => {
		const view = store.view();
		const lease = new ControlLease({ store: view, nodeId, monotonic: () => now, wallClock: () => now });
		return { view, lease };
	};
	return {
		store,
		node,
		advance(ms: number) {
			now += ms;
		},
		get now() {
			return now;
		},
	};
}

function standby(
	lease: ControlLease,
	nodeId: string,
	options: {
		roleHint?: 'primary' | 'standby';
		evidence?: () => PromotionEvidence | Promise<PromotionEvidence>;
		persisted?: number[];
		now: () => number;
	} = { now: Date.now },
) {
	return new ControlStandby({
		lease,
		nodeId,
		roleHint: options.roleHint ?? 'standby',
		evidence: options.evidence ?? (() => readyEvidence()),
		persistEpoch: (epoch) => {
			options.persisted?.push(epoch);
		},
		monotonic: options.now,
		wallClock: () => options.now(),
		autoPromote: true,
	});
}

describe('W9 control-plane machine (W9-SPEC §4)', () => {
	test('a standby with no restored replica is joining and never serves agents', async () => {
		const w = world();
		const a = w.node('a');
		await a.lease.bootstrap(3);
		const b = w.node('b');
		let evidence = readyEvidence({ replica: { restored: false, lagSeconds: null, position: null } });
		const control = standby(b.lease, 'b', { evidence: () => evidence, now: () => w.now });
		await control.start();
		expect(control.snapshot().role).toBe('joining');
		expect(control.agentGate()?.status).toBe(503);
		expect(control.readyz().status).toBe(503);

		evidence = readyEvidence();
		await control.tick();
		expect(control.snapshot().role).toBe('standby');
		expect(control.agentGate()?.headers['x-yoal-role']).toBe('standby');
		expect(control.mayRenewRunLease()).toBe(false);
		expect(control.readyz().status).toBe(200);
	});

	test('a standby behind by more than 5 s is standby-behind with canPromote false', async () => {
		const w = world();
		const a = w.node('a');
		await a.lease.bootstrap();
		const b = w.node('b');
		const control = standby(b.lease, 'b', {
			evidence: () => readyEvidence({ replica: { restored: true, lagSeconds: 9, position: 'ltx:1/0' } }),
			now: () => w.now,
		});
		await control.start();
		await control.tick();
		expect(control.snapshot().role).toBe('standby-behind');
		expect(control.snapshot().canPromote).toBe(false);
		expect(control.readyz().body.replication).toMatchObject({ restored: true, lagSeconds: 9 });
	});

	test('promotion waits for the 40 s quiet window, then CASes to epoch + 1 and persists first', async () => {
		const w = world();
		const a = w.node('a');
		await a.lease.bootstrap(4);
		const b = w.node('b');
		const persisted: number[] = [];
		const control = standby(b.lease, 'b', { persisted, now: () => w.now });
		await control.start();
		await control.tick();
		expect(control.snapshot().role).toBe('standby');

		// The old primary has stopped renewing, but the object is still inside the quiet window.
		w.advance(35_000);
		await control.tick();
		expect(control.snapshot().role).toBe('standby');

		w.advance(6_000);
		await control.tick();
		expect(control.snapshot()).toMatchObject({ role: 'primary', epoch: 5 });
		expect(control.snapshot().lease.holderNodeId).toBe('b');
		expect(persisted.at(-1)).toBe(5);
		expect(control.agentGate()).toBeNull();
		expect(control.mayRenewRunLease()).toBe(true);
	});

	test('a promotion whose post-CAS evidence fails releases the lease and fences', async () => {
		const w = world();
		const a = w.node('a');
		await a.lease.bootstrap(1);
		const b = w.node('b');
		let calls = 0;
		const control = standby(b.lease, 'b', {
			evidence: () => {
				calls += 1;
				// Tick's pre-CAS check passes; the confirmation re-read fails.
				return calls <= 3 ? readyEvidence() : readyEvidence({ expectedConfigDigest: 'cc' });
			},
			now: () => w.now,
		});
		await control.start();
		await control.tick();
		w.advance(CONTROL_STANDBY_TIMERS.takeoverQuietMs + 1_000);
		await control.tick();
		expect(control.snapshot().role).toBe('fenced');
		expect(control.agentGate()?.status).toBe(503);
	});

	test('the primary fences 20 s after the arbiter disappears, before any standby can take over', async () => {
		const w = world();
		const a = w.node('a');
		await a.lease.bootstrap(2);
		const persisted: number[] = [];
		const control = standby(a.lease, 'a', { roleHint: 'primary', persisted, now: () => w.now });
		await control.start();
		expect(control.snapshot().role).toBe('primary');
		expect(control.readyz().status).toBe(200);

		a.view.partitioned = true;
		let fencedAt: number | null = null;
		for (let elapsed = 1_000; elapsed <= 30_000; elapsed += 1_000) {
			w.advance(1_000);
			await control.tick();
			if (control.snapshot().role === 'fenced' && fencedAt === null) {
				fencedAt = elapsed;
				break;
			}
		}
		expect(fencedAt).not.toBeNull();
		expect(fencedAt!).toBeLessThanOrEqual(CONTROL_STANDBY_TIMERS.fenceAfterMs);
		expect(control.agentGate()?.headers['x-yoal-role']).toBe('fenced');
		expect(control.agentGate()?.headers['x-yoal-epoch']).toBe('2');
		expect(control.mayRenewRunLease()).toBe(false);
		expect(control.readyz().status).toBe(503);
	});

	test('a stale primary that returns sees the higher epoch, fences and only rejoins as standby', async () => {
		const w = world();
		const a = w.node('a');
		await a.lease.bootstrap(1);
		const controlA = standby(a.lease, 'a', { roleHint: 'primary', now: () => w.now });
		await controlA.start();
		const b = w.node('b');
		const controlB = standby(b.lease, 'b', { now: () => w.now });
		await controlB.start();
		await controlB.tick();

		a.view.partitioned = true;
		for (let i = 0; i < 10; i++) {
			w.advance(5_000);
			await controlA.tick();
			await controlB.tick();
		}
		expect(controlA.snapshot().role).toBe('fenced');
		expect(controlB.snapshot().role).toBe('primary');

		a.view.partitioned = false;
		await controlA.tick();
		expect(controlA.snapshot().role).toBe('standby');
		expect(controlA.agentGate()).not.toBeNull();
		expect(controlA.snapshot().epoch).toBe(2);
		expect(controlA.snapshot().role).not.toBe('primary');
	});

	test('an unverifiable master key, config or replay refuses promotion', () => {
		expect(evaluatePromotion(readyEvidence()).canPromote).toBe(true);
		const cases: Array<[Partial<PromotionEvidence>, RegExp]> = [
			[{ masterKeyFingerprint: null }, /master key is not present/],
			[{ masterKeyFingerprint: 'zz' }, /fingerprint differs/],
			[{ expectedMasterKeyFingerprint: null }, /cannot be verified/],
			[{ configDigest: null }, /config is missing/],
			[{ configDigest: 'zz' }, /config differs/],
			[{ expectedConfigDigest: null }, /config cannot be verified/],
			[{ migrationsApplied: false }, /migrations are not applied/],
			[{ replica: { restored: true, lagSeconds: 7, position: null } }, /7 s behind/],
			[{ replica: { restored: false, lagSeconds: 0, position: null } }, /not restored/],
		];
		for (const [override, reason] of cases) {
			const check = evaluatePromotion(readyEvidence(override));
			expect(check.canPromote).toBe(false);
			expect(check.reasons.join('\n')).toMatch(reason);
		}
		// A primary does not compare a peer's fingerprint; it only needs its own key and schema.
		expect(evaluatePrimaryReadiness(readyEvidence({ expectedMasterKeyFingerprint: null })).ok).toBe(true);
		expect(evaluatePrimaryReadiness(readyEvidence({ masterKeyFingerprint: null })).ok).toBe(false);
	});

	test('operator promotion refuses a stale expected epoch and an unverifiable node', async () => {
		const w = world();
		const a = w.node('a');
		await a.lease.bootstrap(7);
		const b = w.node('b');
		let evidence = readyEvidence({ expectedConfigDigest: 'nope' });
		const control = standby(b.lease, 'b', { evidence: () => evidence, now: () => w.now });
		await control.start();
		await control.tick();
		expect((await control.promoteNow(7)).role).toBe('standby');
		evidence = readyEvidence();
		const wrong = await control.promoteNow(6);
		expect(wrong.role).toBe('standby');
		expect(wrong.reason).toContain('not 6');
	});

	test('fenced/standby write gates refuse writes and allow reads', async () => {
		const w = world();
		const a = w.node('a');
		await a.lease.bootstrap(1);
		const b = w.node('b');
		const control = standby(b.lease, 'b', { now: () => w.now });
		await control.start();
		await control.tick();
		const write = control.writeGate('POST', '/api/v1/projects');
		expect(write?.status).toBe(503);
		expect(write?.headers['x-yoal-role']).toBe('standby');
		expect(control.writeGate('GET', '/api/v1/projects')).toBeNull();
		expect(control.writeGate('GET', '/api/agent/desired-state')).not.toBeNull();
		// The standby's own CAS is the one write it may attempt.
		expect(control.writeGate('POST', '/api/v1/ha/control/promote')).toBeNull();
	});
});
