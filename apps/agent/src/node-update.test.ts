import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesiredState } from '@yoal/contracts';
import { readFileSync } from 'node:fs';
import { NodeUpdateRunner, type HelperNodeUpdateRollback } from './node-update.ts';

let dir: string;
let clock: number;
let calls: Array<{ version: string; repo: string }>;
let fail: string | null;
let confirms: string[];
let confirmFails: boolean;
let rollback: HelperNodeUpdateRollback | null | 'unsupported';

const state = (nodeUpdate: DesiredState['nodeUpdate']) => ({ nodeUpdate }) as DesiredState;
const task = (generation = 1, version = '0.8.0') => ({ generation, version, repo: 'owner/yoal' });

function runner(currentVersion = '0.7.15') {
	return new NodeUpdateRunner({
		currentVersion,
		statePath: join(dir, 'node-update.json'),
		now: () => clock,
		helper: {
			updateNode: async (input) => {
				calls.push(input);
				if (fail) throw new Error(fail);
				return { version: input.version };
			},
			confirmNodeUpdate: async (version) => {
				if (confirmFails) throw new Error('helper POST /v1/node/update/confirm -> 404: not_found');
				confirms.push(version);
				return { confirmed: true };
			},
			nodeUpdateRollback: async () => {
				if (rollback === 'unsupported') throw new Error('helper GET /v1/node/update/guard -> 404');
				return rollback;
			},
		},
	});
}

const attempt = () => JSON.parse(readFileSync(join(dir, 'node-update.json'), 'utf8'));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'yoal-agent-node-update-'));
	clock = 1_000_000;
	calls = [];
	fail = null;
	confirms = [];
	confirmFails = false;
	rollback = null;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('node update runner (D99)', () => {
	test('hands the version to the helper once per generation and reports nothing on success', async () => {
		const agent = runner();
		await agent.runOnce(state(task()));
		await agent.runOnce(state(task()));
		expect(calls).toEqual([{ version: '0.8.0', repo: 'owner/yoal' }]);
		expect(agent.pendingResult()).toBeNull();
	});

	test('does nothing without a task or when already on the target', async () => {
		await runner().runOnce(state(null));
		await runner('0.8.0').runOnce(state(task()));
		await runner('0.9.0').runOnce(state(task()));
		expect(calls).toEqual([]);
	});

	test('reports a helper refusal once, then waits for a new generation', async () => {
		fail = 'helper POST /v1/node/update -> 409: v0.8.0 is not trusted';
		const agent = runner();
		await agent.runOnce(state(task()));
		const result = agent.pendingResult();
		expect(result).toEqual({ generation: 1, error: fail });
		await agent.acknowledge(result);
		expect(agent.pendingResult()).toBeNull();

		// A restarted agent remembers the reported attempt and neither retries nor re-reports it.
		const restarted = runner();
		await restarted.runOnce(state(task()));
		expect(restarted.pendingResult()).toBeNull();
		expect(calls).toHaveLength(1);

		// The operator's retry is a new generation.
		fail = null;
		await restarted.runOnce(state(task(2)));
		expect(calls).toHaveLength(2);
	});

	test('an install that came back on the old version is reported after the restart grace period', async () => {
		await runner().runOnce(state(task()));
		const sameOldBinary = runner();
		await sameOldBinary.runOnce(state(task()));
		expect(sameOldBinary.pendingResult()).toBeNull();
		clock += 121_000;
		await sameOldBinary.runOnce(state(task()));
		expect(sameOldBinary.pendingResult()?.error).toMatch(/still runs 0\.7\.15/);
		expect(calls).toHaveLength(1);
	});

	test('the new agent confirms once, after an accepted heartbeat, and not before', async () => {
		const old = runner();
		await old.runOnce(state(task()));
		expect(attempt()).toMatchObject({ generation: 1, version: '0.8.0', installedAt: clock });
		// The old binary never confirms a release it is not running.
		await old.confirmHealthy();
		expect(confirms).toEqual([]);

		// Restarted on 0.8.0: nothing happens until the heartbeat path calls confirmHealthy.
		const fresh = runner('0.8.0');
		await fresh.runOnce(state(task()));
		expect(confirms).toEqual([]);

		// The confirm fails (helper not restarted yet) and is retried on the next heartbeat.
		confirmFails = true;
		await fresh.confirmHealthy();
		expect(attempt().confirmed).toBeUndefined();
		confirmFails = false;
		await fresh.confirmHealthy();
		await fresh.confirmHealthy();
		expect(confirms).toEqual(['0.8.0']);
		expect(attempt().confirmed).toBe(true);

		// A later restart of the same binary does not confirm again.
		await runner('0.8.0').confirmHealthy();
		expect(confirms).toEqual(['0.8.0']);
	});

	test('an attempt written before versions were recorded is never confirmed', async () => {
		await runner().runOnce(state(task()));
		const record = attempt();
		delete record.version;
		await Bun.write(join(dir, 'node-update.json'), JSON.stringify(record));
		await runner('0.8.0').confirmHealthy();
		expect(confirms).toEqual([]);
	});

	test('a rolled-back install is explained by the guard marker', async () => {
		await runner().runOnce(state(task()));
		rollback = { from: '0.8.0', to: '0.7.15', afterSeconds: 600, rolledBackAt: '2026-11-14T10:00:00+00:00' };
		clock += 601_000;
		const rolledBack = runner();
		await rolledBack.runOnce(state(task()));
		expect(rolledBack.pendingResult()?.error).toBe(
			'0.8.0 was installed but did not confirm a healthy heartbeat within 10 minutes, so the node rolled back to 0.7.15.',
		);
	});

	test('a marker for another release, or a helper without the guard verb, keeps the plain message', async () => {
		await runner().runOnce(state(task()));
		clock += 601_000;
		rollback = { from: '0.7.99', to: '0.7.15', afterSeconds: 600, rolledBackAt: '' };
		const other = runner();
		await other.runOnce(state(task()));
		expect(other.pendingResult()?.error).toMatch(/still runs 0\.7\.15/);

		rollback = 'unsupported';
		const oldHelper = runner();
		await oldHelper.runOnce(state(task()));
		expect(oldHelper.pendingResult()?.error).toMatch(/still runs 0\.7\.15/);
	});
});
