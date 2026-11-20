import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * HA-PLAN §10: "a release build has no fault endpoint to call". This builds the helper exactly as
 * the release does (`bun run --cwd apps/helper build`: the `build` script in package.json, which
 * publish.yml, the installer and the node bundle all use) and asserts that no fault route, verb or
 * fault-only string survives. A second build with the define on proves the markers are real, so
 * the first assertion cannot pass by searching for strings that never existed.
 */

const HELPER = resolve(import.meta.dir, '..');
const MARKERS = [
	'/v1/faults',
	'yoal_fault_',
	'clear-all',
	'block-arbiter',
	'pause-heartbeat',
	'clock-skew',
	'fill-disk',
	'kill-unit',
	'libfaketime',
	'FAKETIME_TIMESTAMP_FILE',
	'yoal-fault-fill',
	'90-yoal-fault-clock',
	'fault injection verbs',
	'FaultError',
];

function scriptArgs(name: 'build' | 'build:faults', outfile: string): string[] {
	const pkg = JSON.parse(readFileSync(join(HELPER, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
	const script = pkg.scripts[name];
	if (!script) throw new Error(`apps/helper/package.json has no ${name} script`);
	const argv = script.split(/\s+/);
	if (argv[0] !== 'bun' || argv[1] !== 'build') throw new Error(`${name} is not a bun build: ${script}`);
	const out = argv.indexOf('--outfile');
	if (out < 0) throw new Error(`${name} has no --outfile`);
	argv[out + 1] = outfile;
	return argv;
}

function build(argv: string[]): Buffer {
	const result = Bun.spawnSync([process.execPath, ...argv.slice(1)], { cwd: HELPER, stdout: 'pipe', stderr: 'pipe' });
	if (result.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${result.stderr.toString()}`);
	return readFileSync(argv[argv.indexOf('--outfile') + 1]!);
}

describe('fault verbs are compiled only into test builds', () => {
	test('the release build script defines YOAL_FAULT_INJECTION=false', () => {
		expect(scriptArgs('build', 'x').join(' ')).toContain('--define YOAL_FAULT_INJECTION=false');
		expect(scriptArgs('build:faults', 'x').join(' ')).toContain('--define YOAL_FAULT_INJECTION=true');
	});

	test(
		'a release helper contains no fault route, verb or string; a faults build does',
		() => {
			const dir = mkdtempSync(join(tmpdir(), 'yoal-helper-release-'));
			try {
				const release = build(scriptArgs('build', join(dir, 'yoal-helper'))).toString('latin1');
				const survivors = MARKERS.filter((marker) => release.includes(marker));
				expect(survivors).toEqual([]);

				// Positive control: the same entry point with the define on carries every marker. A
				// bundle (not --compile) keeps this fast; --compile embeds exactly this bundle.
				const argv = scriptArgs('build:faults', join(dir, 'faults.js')).map((arg) => (arg === '--compile' ? '--target=bun' : arg));
				const faults = build(argv).toString('utf8');
				expect(MARKERS.filter((marker) => !faults.includes(marker))).toEqual([]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		120_000,
	);
});
