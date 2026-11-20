import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, memoryStore, type Store } from './app/server.ts';
import { runChecker, singletonsOfRun } from './client.ts';
import { reportSchema } from './report.ts';
import { summarize } from './summarize.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-ha-checker-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function serve(store: Store, onHost?: (host: string | null) => void) {
	const handler = createHandler(store, { node: 'lab-a', copy: 'web-1' });
	return Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch: (request) => {
			onHost?.(request.headers.get('host'));
			return handler(request);
		},
	});
}

describe('checker against the checker app (memory store)', () => {
	test('a healthy app: every write acknowledged and read back, I6 passes', async () => {
		const hosts = new Set<string | null>();
		const server = serve(memoryStore(), (h) => hosts.add(h));
		try {
			const log = await runChecker({ url: `http://127.0.0.1:${server.port}`, host: 'checker.lab.test', durationS: 1, rate: 60, seed: 3 });
			const report = summarize(log, []);
			expect(reportSchema.safeParse(report).success).toBe(true);
			expect(report.acknowledgedWrites).toBeGreaterThan(20);
			expect(report.failedRequests).toBe(0);
			expect(report.lostAcknowledgedWrites).toBe(0);
			expect(report.invariants.I6.status).toBe('pass');
			expect(report.longestWriteGapMs).toBeLessThan(1_000);
			expect(log.requests.every((r) => r.copy === 'web-1' && r.node === 'lab-a')).toBe(true);
			expect([...hosts]).toEqual(['checker.lab.test']);
		} finally {
			server.stop(true);
		}
	});

	test('the CLI exits 1 and reports the loss when the app forgets an acknowledged row', async () => {
		const inner = memoryStore();
		let forgotten = 0;
		const lossy: Store = {
			...inner,
			async read(n, writer) {
				if (n === 5) {
					forgotten++;
					return null; // row 5 was acknowledged, then "lost in a failover"
				}
				return inner.read(n, writer);
			},
		};
		const server = serve(lossy);
		const observe = join(dir, 'obs.jsonl');
		const out = join(dir, 'report.json');
		const t = Date.now();
		writeFileSync(
			observe,
			[
				{ t, kind: 'lease', node: 'lab-a', epoch: 1, holds: true },
				{ t: t + 100, kind: 'lease', node: 'lab-b', epoch: 1, holds: false },
			]
				.map((o) => JSON.stringify(o))
				.join('\n'),
		);
		try {
			const child = Bun.spawn(
				['bun', join(import.meta.dir, 'cli.ts'), '--url', `http://127.0.0.1:${server.port}`, '--duration-s', '1', '--rate', '30', '--seed', '9', '--observe', observe, '--out', out],
				{ stdout: 'pipe', stderr: 'pipe' },
			);
			expect(await child.exited).toBe(1);
			const report = reportSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
			expect(report.lostAcknowledgedWrites).toBe(1);
			expect(report.invariants.I6.status).toBe('fail');
			expect(report.invariants.I1.status).toBe('pass');
			expect(report.invariants.I3.status).toBe('not-observed');
			expect(forgotten).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	});

	test('singleton starts from before the run are not blamed on it', () => {
		const now = Date.now();
		const runs = [
			{ job: 'old', run: '1', at: now - 3_600_000 },
			{ job: 'old', run: '1', at: now - 3_500_000 },
			{ job: 'spans', run: '1', at: now - 3_600_000 },
			{ job: 'spans', run: '1', at: now + 5_000 },
			{ job: 'new', run: '1', at: now + 1_000 },
		];
		expect(singletonsOfRun(runs, now).map((r) => r.job)).toEqual(['spans', 'spans', 'new']);
	});

	test('the CLI refuses a call without its required flags', async () => {
		const child = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts'), '--url', 'http://127.0.0.1:1'], { stdout: 'pipe', stderr: 'pipe' });
		expect(await child.exited).toBe(2);
	});
});
