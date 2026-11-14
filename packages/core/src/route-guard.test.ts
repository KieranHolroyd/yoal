import { describe, expect, test } from 'bun:test';
import { loopbackPort, routeBlockReason, tcpPortWinners } from './route-guard.ts';

const row = (projectId: string, port: number, createdAt: number, extra: Record<string, unknown> = {}) => ({
	id: `wld_${projectId}`,
	projectId,
	status: 'running',
	upstream: `127.0.0.1:${port}`,
	specJson: JSON.stringify({ runtime: 'container', image: 'localhost/app:1', port, memoryMb: 64 }),
	createdAt,
	...extra,
});

describe('route guard (D225)', () => {
	test('the app placed first owns a contested port', () => {
		const winners = tcpPortWinners([row('late', 3000, 20), row('early', 3000, 10), row('other', 4100, 5)]);
		expect(winners.get(3000)).toBe('early');
		expect(winners.get(4100)).toBe('other');
	});

	test('blocks the loser, a platform port and an app without an upstream', () => {
		const winners = new Map([[3000, 'early']]);
		const reserved = (port: number) => (port === 8084 ? 'the container console' : null);
		const check = (workload: ReturnType<typeof row> | null, runtime = 'container') =>
			routeBlockReason({ runtime, workload, portWinners: winners, reserved });
		expect(check(row('early', 3000, 10))).toBeNull();
		expect(check(row('late', 3000, 20))).toContain('belongs to another app');
		expect(check(row('squat', 8084, 1))).toContain('the container console');
		// A `failed` row can be an app that recovered after a restart loop: never blocked on status.
		expect(check(row('early', 3000, 10, { status: 'failed' }))).toBeNull();
		expect(check(null, 'process')).toContain('no running workload');
		expect(check(row('early', 3000, 10, { upstream: null }), 'process')).toContain('no running workload');
	});

	test('static sites, functions and socket upstreams pass through', () => {
		const args = { portWinners: new Map(), reserved: () => 'x' };
		expect(routeBlockReason({ ...args, runtime: 'static', workload: null })).toBeNull();
		expect(routeBlockReason({ ...args, runtime: 'function', workload: null })).toBeNull();
		expect(routeBlockReason({ ...args, runtime: 'process', workload: row('a', 3000, 1, { upstream: 'unix//run/yoal-workloads/a.sock' }) })).toBeNull();
	});

	test('parses only loopback upstreams', () => {
		expect(loopbackPort('127.0.0.1:3000')).toBe(3000);
		expect(loopbackPort('http://127.0.0.1:8080')).toBe(8080);
		expect(loopbackPort('unix//run/x.sock')).toBeNull();
		expect(loopbackPort('http://10.47.0.2:443')).toBeNull();
		expect(loopbackPort(null)).toBeNull();
	});
});
