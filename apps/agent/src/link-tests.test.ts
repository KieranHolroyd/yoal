import { describe, expect, test } from 'bun:test';
import { connect, createServer } from 'node:net';
import type { LinkTestTask } from '@yoal/contracts';
import { LinkTestRunner, connectRtt, probeLinkTest, sampleLinks, serveLinkTest } from './link-tests.ts';

const freePort = (): Promise<number> =>
	new Promise((resolve) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});

const task = async (over: Partial<LinkTestTask> = {}): Promise<LinkTestTask> => ({
	id: 'lnk_test',
	role: 'probe',
	peerNodeId: 'nod_b',
	address: '127.0.0.1',
	port: await freePort(),
	token: 'a-shared-token-for-one-test',
	seconds: 1,
	streams: 2,
	expiresAt: Date.now() + 20_000,
	...over,
});

describe('link sampling', () => {
	test('a refused connection still measures the round trip; silence is loss', async () => {
		const closed = await freePort();
		expect(await connectRtt('127.0.0.1', closed, 500)).toBeGreaterThanOrEqual(0);
		// TEST-NET-1 never answers.
		const [sample] = await sampleLinks([{ nodeId: 'nod_x', address: '192.0.2.1', port: 8080 }], 1, 200);
		expect(sample).toMatchObject({ nodeId: 'nod_x', rttMs: null, lossPercent: 100 });
	});
});

describe('link test', () => {
	test('measures latency and both directions against a listener', async () => {
		const spec = await task();
		const listener = await serveLinkTest(spec);
		try {
			const result = await probeLinkTest(spec);
			expect(result.rttMs).toBeGreaterThanOrEqual(0);
			expect(result.jitterMs).toBeGreaterThanOrEqual(0);
			// Loopback moves far more than a megabit; the point is that both directions carried data.
			expect(result.uploadBps).toBeGreaterThan(1_000_000);
			expect(result.downloadBps).toBeGreaterThan(1_000_000);
			expect(result.bytes).toBeGreaterThan(0);
		} finally {
			listener.close();
		}
	}, 20_000);

	test('the listener drops a connection without the token', async () => {
		const spec = await task();
		const listener = await serveLinkTest(spec);
		try {
			const closedWithoutData = await new Promise<boolean>((resolve) => {
				const socket = connect({ host: spec.address, port: spec.port });
				let got = false;
				socket.on('data', () => (got = true));
				socket.once('close', () => resolve(!got));
				socket.once('error', () => resolve(!got));
				socket.once('connect', () => socket.write('YOAL-LINK/1 wrong-token-wrong-token echo\nhello'));
			});
			expect(closedWithoutData).toBe(true);
		} finally {
			listener.close();
		}
	});

	test('the runner serves and probes from desired state and reports once', async () => {
		const spec = await task();
		const serving = new LinkTestRunner();
		const probing = new LinkTestRunner();
		serving.runOnce({ linkTests: [{ ...spec, role: 'serve' }] });
		probing.runOnce({ linkTests: [spec] });
		probing.runOnce({ linkTests: [spec] });
		expect(probing.results()).toMatchObject([{ taskId: 'lnk_test', status: 'running' }]);
		const deadline = Date.now() + 15_000;
		while (probing.results()[0]?.status === 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		const results = probing.results();
		expect(results).toMatchObject([{ taskId: 'lnk_test', status: 'ok' }]);
		probing.acknowledge(results);
		expect(probing.results()).toEqual([]);
		// Still in desired state: not run again.
		probing.runOnce({ linkTests: [spec] });
		expect(probing.results()).toEqual([]);
		serving.runOnce({ linkTests: [] });
		serving.stop();
	}, 20_000);

	test('a prober with no listener fails with a reason', async () => {
		const spec = await task({ expiresAt: Date.now() + 2_500 });
		await expect(probeLinkTest(spec)).rejects.toThrow('never started listening');
	}, 10_000);
});
