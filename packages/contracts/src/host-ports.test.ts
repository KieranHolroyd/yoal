import { describe, expect, test } from 'bun:test';
import { appHostPorts, appPortProblem, platformPortOwner } from './host-ports.ts';

describe('platform host ports (D225)', () => {
	test('names the platform service behind each reserved port', () => {
		expect(platformPortOwner(8084)).toBe('the container console');
		expect(platformPortOwner(8083)).toBe('the database studio');
		expect(platformPortOwner(8086)).toBe('the workload identity endpoint');
		expect(platformPortOwner(15_432)).toBe('managed databases');
		expect(platformPortOwner(19_950)).toBe('managed object storage and link tests');
		expect(platformPortOwner(31_000)).toBe('compose service routes');
		expect(platformPortOwner(443)).toContain('privileged');
	});

	test('leaves ordinary app ports free', () => {
		for (const port of [3000, 4100, 5173, 8000, 8080, 8790, 9000, 40_000]) expect(platformPortOwner(port)).toBeNull();
	});

	test('install overrides add their own ranges', () => {
		expect(platformPortOwner(9_999, [{ min: 9_999, max: 9_999, owner: 'the storage gateway' }])).toBe('the storage gateway');
		expect(appPortProblem(9_999, [{ min: 9_999, max: 9_999, owner: 'the storage gateway' }])).toContain('reserved for the storage gateway');
	});

	test('only TCP listeners claim a port', () => {
		expect(appHostPorts({ runtime: 'container', port: 3000, ingress: 'http' })).toEqual([3000]);
		expect(appHostPorts({ runtime: 'process', port: 3000, socketActivation: false })).toEqual([3000]);
		expect(appHostPorts({ runtime: 'process', port: 3000, socketActivation: true })).toEqual([]);
		expect(appHostPorts({ runtime: 'function', port: 3000 })).toEqual([]);
		expect(appHostPorts({ runtime: 'container', port: 3000, ingress: 'none' })).toEqual([]);
		expect(appHostPorts({ runtime: 'compose', port: 0, compose: { routes: [{ hostPort: 30_001 }, { hostPort: null }] } })).toEqual([30_001]);
	});
});
