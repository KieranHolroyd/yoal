import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLeaseClock, leaseState } from './run-lease.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-lease-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const state = (ttlSeconds: number) => ({
	workloads: [
		{ id: 'wld_cron', status: 'running', runLease: { ttlSeconds } },
		{ id: 'wld_web', status: 'running' },
		{ id: 'wld_paused', status: 'stopped', runLease: { ttlSeconds } },
	],
}) as never;

describe('run lease', () => {
	test('valid only within the TTL of the last contact, and never before one', async () => {
		const clock = { now: 1_000_000 };
		const lease = new RunLeaseClock({ path: null, now: () => clock.now });
		expect(lease.valid(60)).toBe(false);
		await lease.touch(false);
		expect(lease.valid(60)).toBe(true);
		clock.now += 60_000;
		expect(lease.valid(60)).toBe(true);
		clock.now += 1;
		expect(lease.valid(60)).toBe(false);
		expect(lease.silentSeconds()).toBe(60);
		// A clock that jumped back does not extend the lease.
		clock.now -= 10 * 60_000;
		expect(lease.valid(60)).toBe(false);
	});

	test('only leased, running workloads are fenced', async () => {
		const clock = { now: 5_000_000 };
		const lease = new RunLeaseClock({ path: null, now: () => clock.now });
		await lease.touch(false);
		expect(leaseState(state(60), lease)).toEqual({ leased: ['wld_cron'], fenced: [] });
		clock.now += 61_000;
		expect(leaseState(state(60), lease)).toEqual({ leased: ['wld_cron'], fenced: ['wld_cron'] });
		expect(leaseState(null, lease)).toEqual({ leased: [], fenced: [] });
	});

	test('the contact time survives a restart: a stale one fences at once, a fresh one touches nothing', async () => {
		const path = join(dir, 'run-lease.json');
		const clock = { now: 9_000_000 };
		const first = new RunLeaseClock({ path, now: () => clock.now });
		await first.touch(true);

		// The agent restarts a few seconds later with the control plane still there.
		clock.now += 5_000;
		const restarted = new RunLeaseClock({ path, now: () => clock.now });
		await restarted.load();
		expect(restarted.valid(60)).toBe(true);

		// The node reboots ten minutes into a partition.
		clock.now += 10 * 60_000;
		const rebooted = new RunLeaseClock({ path, now: () => clock.now });
		await rebooted.load();
		expect(rebooted.valid(60)).toBe(false);

		// No file at all: never having had contact is the safe side.
		const fresh = new RunLeaseClock({ path: join(dir, 'missing.json'), now: () => clock.now });
		await fresh.load();
		expect(fresh.valid(60)).toBe(false);
	});
});
