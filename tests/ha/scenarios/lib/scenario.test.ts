import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Scenario.run → finish end to end, in a child process (finish exits the process): the report it
 * writes, the exit code, and that cleanups run before it.
 */
async function runScenario(body: string, accept = ''): Promise<{ code: number; report: any; cleanup: string }> {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-scenario-run-'));
	const script = join(dir, 'demo.ts');
	writeFileSync(
		script,
		`import { appendFileSync } from 'node:fs';
import { Scenario } from ${JSON.stringify(join(import.meta.dir, 'scenario.ts'))};
const s = new Scenario('demo', {}, { out: ${JSON.stringify(join(dir, 'out'))}, accept: ${JSON.stringify(accept)} });
await s.run(async (s) => {
	s.onCleanup('mark', () => appendFileSync(${JSON.stringify(join(dir, 'cleanup'))}, 'ran\\n'));
	${body}
});
`,
	);
	const child = Bun.spawn(['bun', script], { stdout: 'ignore', stderr: 'ignore' });
	const code = await child.exited;
	const report = JSON.parse(readFileSync(join(dir, 'out', 'scenario.json'), 'utf8'));
	let cleanup = '';
	try {
		cleanup = readFileSync(join(dir, 'cleanup'), 'utf8');
	} catch {
		// none
	}
	return { code, report, cleanup };
}

describe('Scenario.finish', () => {
	test('all checks pass: verdict pass, exit 0, cleanups ran', async () => {
		const { code, report, cleanup } = await runScenario(`s.check('a', 'pass', null);`);
		expect(code).toBe(0);
		expect(report.verdict).toBe('pass');
		expect(cleanup).toBe('ran\n');
	});

	test('a failed check after an early skip still fails (exit 1)', async () => {
		const { code, report } = await runScenario(`s.check('spread', 'fail', 'refused'); s.stop('skip', 'flag off');`);
		expect(code).toBe(1);
		expect(report.verdict).toBe('fail');
		expect(report.reason).toBe('spread: refused (then: flag off)');
	});

	test('a skip exits 3 unless --accept skip', async () => {
		expect((await runScenario(`s.stop('skip', 'RELEASE_PHASE is off');`)).code).toBe(3);
		const accepted = await runScenario(`s.stop('skip', 'RELEASE_PHASE is off');`, 'skip');
		expect(accepted.code).toBe(0);
		expect(accepted.report.reason).toBe('RELEASE_PHASE is off');
	});

	test('a harness exception is an error (exit 4) with the stack kept, and nothing judged is an error', async () => {
		const thrown = await runScenario(`throw new Error('lab down');`);
		expect(thrown.code).toBe(4);
		expect(thrown.report.reason).toBe('harness error: lab down');
		expect(thrown.report.error).toContain('lab down');
		const empty = await runScenario('');
		expect(empty.code).toBe(4);
		expect(empty.report.reason).toBe('the scenario judged nothing');
	});
});
