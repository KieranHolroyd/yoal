import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHandler, type HelperRuntime } from './server.ts';
import { FaultInjector } from './faults.ts';

/**
 * HA-PLAN §10: "a release build has no fault endpoint to call". The fault verbs live in `faults.ts`,
 * which only the test entry `main-faults.ts` imports; the release entry `main.ts` and the router
 * `server.ts` never do, so no define, preload or global can switch them on in a release binary.
 *
 * This builds the release entry exactly as the `build` script does (what publish.yml, the
 * installer and node updates use), and again with `--define YOAL_FAULT_INJECTION=true` (the old
 * switch), and asserts that no fault route, verb or fault-only string survives either. A build of
 * the test entry proves the markers are real, so the first assertions cannot pass by searching for
 * strings that never existed.
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
	test('the release script builds main.ts; the test script builds main-faults.ts', () => {
		expect(scriptArgs('build', 'x').at(-1)).toBe('src/main.ts');
		expect(scriptArgs('build:faults', 'x').at(-1)).toBe('src/main-faults.ts');
	});

	test('main.ts and server.ts never import or mention faults', () => {
		for (const file of ['main.ts', 'server.ts']) {
			const source = readFileSync(join(import.meta.dir, file), 'utf8');
			// `default` contains "fault"; anything else spelling it is a reference.
			expect({ file, mentions: source.match(/(?<!de)fault/gi) ?? [] }).toEqual({ file, mentions: [] });
			expect(source).not.toContain('main-faults');
		}
	});

	test(
		'a release helper, built with or without the old define, contains no fault route, verb or string',
		() => {
			const dir = mkdtempSync(join(tmpdir(), 'yoal-helper-release-'));
			try {
				const plain = scriptArgs('build', join(dir, 'yoal-helper'));
				const defined = scriptArgs('build', join(dir, 'yoal-helper-defined'));
				defined.splice(defined.indexOf('--outfile'), 0, '--define', 'YOAL_FAULT_INJECTION=true');
				for (const argv of [plain, defined]) {
					const binary = build(argv).toString('latin1');
					expect({ argv: argv.join(' '), survivors: MARKERS.filter((marker) => binary.includes(marker)) }).toEqual({ argv: argv.join(' '), survivors: [] });
				}

				// Positive control: the test entry carries every marker. A bundle (not --compile) keeps
				// this fast; --compile embeds exactly this bundle.
				const argv = scriptArgs('build:faults', join(dir, 'faults.js')).map((arg) => (arg === '--compile' ? '--target=bun' : arg));
				const faults = build(argv).toString('utf8');
				expect(MARKERS.filter((marker) => !faults.includes(marker))).toEqual([]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		180_000,
	);
});

describe('single-node gate: the router has no fault route unless the test entry adds one', () => {
	const requests = [
		['GET', '/v1/faults'],
		['POST', '/v1/faults/partition'],
		['POST', '/v1/faults/clear-all'],
	] as const;
	const send = (handler: (request: Request) => Promise<Response>, method: string, path: string) =>
		handler(new Request(`http://helper${path}`, { method, ...(method === 'POST' ? { body: '{"peers":["10.47.0.9"],"durationS":5}' } : {}) }));

	test('without extra routes (the release entry) /v1/faults* is a 404', async () => {
		const handler = createHandler({} as HelperRuntime, { version: '0.0.0-test' });
		for (const [method, path] of requests) expect((await send(handler, method, path)).status).toBe(404);
		expect((await handler(new Request('http://helper/healthz'))).status).toBe(200);
	});

	test('with the injector wired the way main-faults.ts wires it, the routes answer', async () => {
		const faults = new FaultInjector({
			runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
			runDir: mkdtempSync(join(tmpdir(), 'yoal-faults-gate-')),
			setTimer: () => 0,
			clearTimer: () => undefined,
		});
		const handler = createHandler({} as HelperRuntime, { version: '0.0.0-test', extraRoutes: (request, url) => faults.handle(request, url) });
		expect((await send(handler, 'GET', '/v1/faults')).status).toBe(200);
		expect((await send(handler, 'POST', '/v1/faults/partition')).status).toBe(200);
		expect((await handler(new Request('http://helper/v1/slices'))).status).not.toBe(200);
	});
});
