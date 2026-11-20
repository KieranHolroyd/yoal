import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkManager } from './network.ts';
import type { CommandRunner } from './wireguard.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-network-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runnerFor(status: { ufw?: string; firewalld?: string }, calls: string[][]): CommandRunner {
	return async (argv) => {
		calls.push(argv);
		if (argv[0] === 'ufw' && argv[1] === 'status') return { code: 0, stdout: status.ufw ?? 'Status: inactive', stderr: '' };
		if (argv[0] === 'firewall-cmd' && argv[1] === '--state')
			return { code: 0, stdout: status.firewalld ?? 'not running', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	};
}

describe('NetworkManager', () => {
	test('opens the underlay port and overlay port through ufw', async () => {
		const calls: string[][] = [];
		const manager = new NetworkManager({ runner: runnerFor({ ufw: 'Status: active' }, calls), paths: { configPath: join(dir, 'ufw.nft') } });
		expect(await manager.apply()).toEqual({ backend: 'ufw', opened: 4 });
		expect(calls).toContainEqual(['ufw', 'allow', '51820/udp']);
		expect(calls.some((call) => call.includes('8080'))).toBe(true);
		// Provider listeners (cross-node attachments, replica streaming) must be reachable too.
		expect(calls).toContainEqual(['ufw', 'allow', 'in', 'on', 'wg0', 'to', 'any', 'port', '15432:16431', 'proto', 'tcp']);
		expect(calls).toContainEqual(['ufw', 'allow', 'in', 'on', 'wg0', 'to', 'any', 'port', '19000:19999', 'proto', 'tcp']);
	});

	test('uses firewalld when it is running', async () => {
		const calls: string[][] = [];
		const manager = new NetworkManager({ runner: runnerFor({ firewalld: 'running' }, calls), paths: { configPath: join(dir, 'fw.nft') } });
		expect(await manager.apply()).toEqual({ backend: 'firewalld', opened: 4 });
		expect(calls).toContainEqual(['firewall-cmd', '--permanent', '--add-port=51820/udp']);
	});

	test('falls back to a dedicated nftables table', async () => {
		const calls: string[][] = [];
		const path = join(dir, 'yoal.nft');
		const manager = new NetworkManager({ runner: runnerFor({}, calls), paths: { configPath: path } });
		expect(await manager.apply()).toEqual({ backend: 'nftables', opened: 3 });
		expect(readFileSync(path, 'utf8')).toContain('table inet yoal');
		// Before the fix only 8080 was accepted, so every provider listener was dropped on wg0.
		expect(readFileSync(path, 'utf8')).toContain('tcp dport 15432-16431 accept');
		expect(readFileSync(path, 'utf8')).toContain('tcp dport 19000-19999 accept');
		expect(calls).toContainEqual(['nft', '-c', '-f', path]);
		expect(calls).toContainEqual(['nft', '-f', path]);
	});

	test('renders a default-drop overlay chain with the served ports', () => {
		const manager = new NetworkManager({ paths: { configPath: join(dir, 'render.nft'), overlayTcpPorts: [8080, 9090] } });
		const rules = manager.renderNftables();
		expect(rules).toContain('tcp dport 8080 accept');
		expect(rules).toContain('tcp dport 9090 accept');
		expect(rules).toContain('iifname "wg0" drop');
	});

	test('replaces the table instead of appending, and lets replies back in first', () => {
		const rules = new NetworkManager({ paths: { configPath: join(dir, 'idem.nft') } }).renderNftables();
		// Declare + delete + recreate in one file: re-applying it cannot duplicate the chain.
		expect(rules.indexOf('delete table inet yoal')).toBeGreaterThan(rules.indexOf('table inet yoal'));
		expect(rules.match(/chain input/g)).toHaveLength(1);
		const established = rules.indexOf('ct state established,related accept');
		expect(established).toBeGreaterThan(0);
		// Replies to an ingress's own connections arrive on ephemeral ports: accepted before the drop.
		expect(established).toBeLessThan(rules.indexOf('iifname "wg0" drop'));
		expect(established).toBeLessThan(rules.indexOf('tcp dport 8080 accept'));
	});

	test('refuses an invalid range instead of rendering it', () => {
		const manager = new NetworkManager({ paths: { configPath: join(dir, 'bad.nft'), overlayTcpPorts: [[200, 100]] } });
		expect(() => manager.renderNftables()).toThrow(/invalid overlay port range/);
	});
});

describe('defaultRunner', () => {
	test('a missing executable is exit 127, not a thrown error', async () => {
		const { defaultRunner } = await import('./wireguard.ts');
		const result = await defaultRunner(['yoal-definitely-not-installed', '--state']);
		expect(result.code).toBe(127);
	});
});

describe('endpoint guard (HA-PLAN H24)', () => {
	test('renders one table: loopback and the address-owning interface pass, everything else is dropped', () => {
		const manager = new NetworkManager({ paths: { configPath: join(dir, 'render-guard', 'yoal.nft') } });
		const rules = manager.renderEndpointGuard();
		expect(rules).toContain('table inet yoal-endpoints');
		expect(rules).toContain('iifname "lo" accept');
		// The contract ranges the forwarder binds (primary/pool then read).
		expect(rules).toContain('tcp dport { 21000-21999, 23000-23999 }');
		expect(rules).toContain('fib daddr . iif type != local drop');
		// One declare/delete/recreate pair, so a re-apply never stacks a second chain.
		expect(rules.match(/delete table inet yoal-endpoints/g)?.length).toBe(1);
	});

	test('writes a separate file, checks it, then loads it', async () => {
		const calls: string[][] = [];
		const configPath = join(dir, 'apply-guard', 'yoal.nft');
		const manager = new NetworkManager({ runner: runnerFor({}, calls), paths: { configPath } });
		expect(await manager.applyEndpointGuard()).toEqual({ table: 'inet yoal-endpoints' });
		const path = join(dir, 'apply-guard', 'yoal-endpoints.nft');
		expect(manager.endpointGuardPath()).toBe(path);
		expect(readFileSync(path, 'utf8')).toContain('table inet yoal-endpoints');
		expect(calls).toContainEqual(['nft', '-c', '-f', path]);
		expect(calls).toContainEqual(['nft', '-f', path]);
		// The host's own filter table is never touched.
		expect(calls.some((call) => call.includes(configPath))).toBe(false);
	});

	test('a file name that is not yoal.nft still keeps the guard in its own file', () => {
		const manager = new NetworkManager({ paths: { configPath: join(dir, 'custom.nft') } });
		expect(manager.endpointGuardPath()).toBe(join(dir, 'yoal-endpoints.nft'));
	});

	test('a failed syntax check applies nothing and reports it', async () => {
		const calls: string[][] = [];
		const manager = new NetworkManager({
			runner: async (argv) => {
				calls.push(argv);
				if (argv[1] === '-c') return { code: 1, stdout: '', stderr: 'line 6: bad expression' };
				return { code: 0, stdout: '', stderr: '' };
			},
			paths: { configPath: join(dir, 'fail-guard', 'yoal.nft') },
		});
		await expect(manager.applyEndpointGuard()).rejects.toThrow(/nftables check failed: line 6/);
		expect(calls.some((call) => call[1] === '-f')).toBe(false);
	});
});
