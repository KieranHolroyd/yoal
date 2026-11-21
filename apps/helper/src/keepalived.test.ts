import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	KeepalivedManager,
	parseKeepalivedState,
	renderKeepalivedConfig,
	type CommandResult,
	type CommandRunner,
	type KeepalivedState,
} from './keepalived.ts';

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const state: KeepalivedState = {
	instance: 'YOAL',
	state: 'MASTER',
	interface: 'eth0',
	virtualRouterId: 51,
	priority: 150,
	advertInterval: 1,
	localAddress: '192.0.2.10',
	unicastPeers: ['192.0.2.11'],
	virtualAddress: '192.0.2.100',
	authPass: 's3cr3t',
};

function fakeRunner(calls: string[][], active = true): CommandRunner {
	return async (argv): Promise<CommandResult> => {
		calls.push(argv);
		if (argv.includes('is-active')) return { code: active ? 0 : 3, stdout: active ? 'active\n' : 'inactive\n', stderr: '' };
		if (argv[1] === '-o') return { code: 0, stdout: '2: eth0    inet 192.0.2.100/32 scope global eth0\\n', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	};
}

function manager(calls: string[][], overrides: { active?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-keepalived-'));
	dirs.push(dir);
	return new KeepalivedManager({
		paths: {
			configPath: join(dir, 'keepalived.conf'),
			systemctlPath: '/usr/bin/systemctl',
			ipPath: '/usr/sbin/ip',
			service: 'keepalived.service',
		},
		runner: fakeRunner(calls, overrides.active),
	});
}

describe('keepalived config rendering', () => {
	test('renders one VRRP instance with unicast peers, authentication and the floating address', () => {
		const config = renderKeepalivedConfig(state);
		expect(config).toContain('vrrp_instance YOAL {');
		expect(config).toContain('    state MASTER');
		expect(config).toContain('    interface eth0');
		expect(config).toContain('    virtual_router_id 51');
		expect(config).toContain('    priority 150');
		expect(config).toContain('    unicast_src_ip 192.0.2.10');
		expect(config).toContain('        192.0.2.11');
		expect(config).toContain('        auth_pass s3cr3t');
		expect(config).toContain('        192.0.2.100/32 dev eth0');
		// No script, notify or track hooks: the security rule in HA-PLAN §10.
		expect(config).not.toContain('vrrp_script');
		expect(config).not.toContain('notify');
		expect(config).not.toContain('track_');
	});

	test('rejects values that would escape the fixed config grammar', () => {
		const base = { ...state };
		for (const broken of [
			{ ...base, instance: 'YOAL}\nvrrp_script x { script /bin/sh }' },
			{ ...base, interface: 'eth0\n}' },
			{ ...base, virtualAddress: '192.0.2.100\nnotify_master /bin/sh' },
			{ ...base, localAddress: 'not-an-ip' },
			{ ...base, unicastPeers: ['192.0.2.11', '192.0.2.11'] },
			{ ...base, unicastPeers: ['2001:db8::1'] },
			{ ...base, authPass: 'ninechars' },
			{ ...base, authPass: 'has space' },
			{ ...base, virtualRouterId: 0 },
			{ ...base, priority: 255 },
			{ ...base, advertInterval: 11 },
			{ ...base, command: 'sh -c id' },
		])
			expect(() => parseKeepalivedState(broken)).toThrow();
	});

	test('accepts a lone node without unicast peers', () => {
		const parsed = parseKeepalivedState({ ...state, unicastPeers: [] });
		expect(parsed.unicastPeers).toEqual([]);
	});
});

describe('KeepalivedManager', () => {
	test('install writes a 0600 config and enables the unit without starting it', async () => {
		const calls: string[][] = [];
		const keepalived = manager(calls);
		const result = await keepalived.install(state);
		expect(result).toEqual({ changed: true, service: 'keepalived.service' });
		const config = readFileSync(keepalived.paths.configPath, 'utf8');
		expect(config).toContain('vrrp_instance YOAL {');
		expect(calls.some((argv) => argv.includes('enable'))).toBe(true);
		expect(calls.some((argv) => argv.includes('start'))).toBe(false);
	});

	test('install is idempotent and keeps the config root-only', async () => {
		const calls: string[][] = [];
		const keepalived = manager(calls);
		expect((await keepalived.install(state)).changed).toBe(true);
		expect(statSync(keepalived.paths.configPath).mode & 0o777).toBe(0o600);
		expect((await keepalived.install(state)).changed).toBe(false);
		expect(calls.filter((argv) => argv.includes('enable'))).toHaveLength(2);
	});

	test('configure reloads only when the file changed and the unit is active', async () => {
		const calls: string[][] = [];
		const keepalived = manager(calls);
		await keepalived.configure(state);
		expect(calls.some((argv) => argv.includes('reload'))).toBe(true);
		const before = calls.length;
		await keepalived.configure(state);
		expect(calls.slice(before).some((argv) => argv.includes('reload'))).toBe(false);
	});

	test('configure does not start an inactive unit', async () => {
		const calls: string[][] = [];
		const keepalived = manager(calls, { active: false });
		await keepalived.configure({ ...state, priority: 100 });
		expect(calls.some((argv) => argv.includes('reload'))).toBe(false);
		expect(calls.some((argv) => argv.includes('start'))).toBe(false);
	});

	test('start and stop use the fixed service name only', async () => {
		const calls: string[][] = [];
		const keepalived = manager(calls);
		expect(await keepalived.start()).toEqual({ service: 'keepalived.service' });
		expect(await keepalived.stop()).toEqual({ service: 'keepalived.service' });
		expect(calls).toContainEqual(['/usr/bin/systemctl', 'start', 'keepalived.service']);
		expect(calls).toContainEqual(['/usr/bin/systemctl', 'stop', 'keepalived.service']);
		expect(calls.every((argv) => argv[0] === '/usr/bin/systemctl')).toBe(true);
	});

	test('status reports the unit and whether the floating address is present', async () => {
		const calls: string[][] = [];
		const keepalived = manager(calls);
		await keepalived.configure(state);
		const status = await keepalived.status();
		expect(status).toEqual({
			service: 'keepalived.service',
			running: true,
			interface: 'eth0',
			virtualAddress: '192.0.2.100',
			addressPresent: true,
		});
		expect(calls).toContainEqual(['/usr/sbin/ip', '-o', 'addr', 'show', 'dev', 'eth0']);
	});
});
