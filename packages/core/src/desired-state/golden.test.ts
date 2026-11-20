import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Pins `NodeService.desiredState()` output for a set of fixture fleets (HA-PLAN §6.1, Wave 1
 * split). The fixtures run in their own process because they seed every random source; see
 * `golden/fixtures.ts`. A deliberate change to desired state regenerates the snapshot with
 * `bun packages/core/src/desired-state/golden/fixtures.ts --write`, and the diff is reviewed.
 */
const fixtures = fileURLToPath(new URL('./golden/fixtures.ts', import.meta.url));
const snapshot = fileURLToPath(new URL('./golden/desired-state.golden.json', import.meta.url));

describe('desired state golden output', () => {
	test('every fixture fleet builds byte-identical desired state', () => {
		const run = Bun.spawnSync([process.execPath, fixtures], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } });
		if (run.exitCode !== 0) throw new Error(`fixtures failed:\n${run.stderr.toString()}`);
		const actual = run.stdout.toString();
		const expected = readFileSync(snapshot, 'utf8');
		// Compare per node first so a failure names the node, then the whole document byte for byte.
		const actualJson = JSON.parse(actual) as Record<string, Record<string, unknown>>;
		const expectedJson = JSON.parse(expected) as Record<string, Record<string, unknown>>;
		expect(Object.keys(actualJson)).toEqual(Object.keys(expectedJson));
		for (const [fleet, nodes] of Object.entries(expectedJson)) {
			expect(Object.keys(actualJson[fleet]!)).toEqual(Object.keys(nodes));
			for (const [node, state] of Object.entries(nodes)) expect({ fleet, node, state: actualJson[fleet]![node] }).toEqual({ fleet, node, state });
		}
		expect(actual).toBe(expected);
	}, 60_000);
});
