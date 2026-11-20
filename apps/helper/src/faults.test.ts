import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	assertFaultUnit,
	FaultInjector,
	faketimeOffset,
	parseCidr,
	parseFaultRequest,
	renderClockDropIn,
	renderNetemCommands,
	renderNftRuleset,
} from './faults.ts';
import type { CommandRunner, CommandRunOptions, RunResult } from './systemd.ts';
import { ValidationError } from './validate.ts';

interface Call {
	argv: string[];
	stdin?: string;
}

function fakeRunner(answer: (argv: string[]) => Partial<RunResult> = () => ({})): CommandRunner & { calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		async run(argv: string[], options: CommandRunOptions = {}): Promise<RunResult> {
			calls.push({ argv, ...(options.stdin !== undefined ? { stdin: String(options.stdin) } : {}) });
			return { code: 0, stdout: '', stderr: '', ...answer(argv) };
		},
	};
}

describe('parseFaultRequest', () => {
	test('normalizes CIDRs and refuses loopback, /0 and junk', () => {
		expect(parseCidr('172.30.147.12', 'peer')).toBe('172.30.147.12/32');
		expect(parseCidr('10.47.0.9/16', 'peer')).toBe('10.47.0.0/16');
		for (const bad of ['127.0.0.1', '0.0.0.0/0', '10.0.0.1/33', '300.1.1.1', '10.0.0.1; rm -rf /', '::1', 7])
			expect(() => parseCidr(bad, 'peer')).toThrow(ValidationError);
	});

	test('partition takes peers, a direction and a bounded duration', () => {
		expect(parseFaultRequest('partition', { peers: ['172.30.147.12'], durationS: 30 })).toEqual({
			verb: 'partition',
			peers: ['172.30.147.12/32'],
			direction: 'both',
			durationS: 30,
		});
		expect(() => parseFaultRequest('partition', { peers: [], durationS: 30 })).toThrow(ValidationError);
		expect(() => parseFaultRequest('partition', { peers: ['10.0.0.1'], durationS: 0 })).toThrow(ValidationError);
		expect(() => parseFaultRequest('partition', { peers: ['10.0.0.1'], durationS: 3601 })).toThrow(ValidationError);
		expect(() => parseFaultRequest('partition', { peers: ['10.0.0.1'], durationS: 10, command: 'nft flush ruleset' })).toThrow(/unknown field command/);
	});

	test('units come from the allowlist only, never the helper', () => {
		expect(assertFaultUnit('yoal-agent.service')).toBe('yoal-agent.service');
		expect(assertFaultUnit('yoal-workload-wld_abc123.service')).toBe('yoal-workload-wld_abc123.service');
		for (const bad of ['yoal-helper.service', 'sshd.service', 'yoal-workload-../x.service', 'yoal-agent.service --now', 'yoal-workload-a.service;reboot'])
			expect(() => assertFaultUnit(bad)).toThrow(ValidationError);
	});

	test('netem needs an effect; fill-disk paths stay under the data roots', () => {
		expect(() => parseFaultRequest('netem', { device: 'eth0', durationS: 5 })).toThrow(/delayMs or lossPct/);
		expect(() => parseFaultRequest('netem', { device: 'eth0 root', delayMs: 5, durationS: 5 })).toThrow(ValidationError);
		expect(() => parseFaultRequest('netem', { device: 'lo', delayMs: 5, durationS: 5 })).toThrow(ValidationError);
		expect(parseFaultRequest('fill-disk', { durationS: 5 })).toMatchObject({ path: null, sizeMb: 64, leaveKb: 0 });
		expect(() => parseFaultRequest('fill-disk', { path: '/etc', durationS: 5 })).toThrow(ValidationError);
		expect(() => parseFaultRequest('fill-disk', { path: '/var/lib/yoal/../../etc', durationS: 5 })).toThrow(ValidationError);
		expect(() => parseFaultRequest('fill-disk', { sizeMb: 4096, durationS: 5 })).toThrow(ValidationError);
		expect(() => parseFaultRequest('clock-skew', { unit: 'yoal-agent.service', offsetS: 0, durationS: 5 })).toThrow(ValidationError);
		expect(() => parseFaultRequest('reboot', {})).toThrow(/unknown fault verb/);
	});
});

describe('rendering', () => {
	test('a partition is one table per fault with input, output and forward drops', () => {
		const both = renderNftRuleset('0a0b0c0d', parseFaultRequest('partition', { peers: ['172.30.147.12', '10.47.0.2'], durationS: 5 }));
		expect(both).toContain('table inet yoal_fault_0a0b0c0d {');
		expect(both).toContain('ip saddr { 172.30.147.12/32, 10.47.0.2/32 } drop');
		expect(both).toContain('ip daddr { 172.30.147.12/32, 10.47.0.2/32 } drop');
		expect(both).toContain('type filter hook forward priority -50; policy accept;');
		const outOnly = renderNftRuleset('0a0b0c0d', parseFaultRequest('partition', { peers: ['10.0.0.1'], direction: 'out', durationS: 5 }));
		expect(outOnly).not.toContain('chain input');
		expect(outOnly).toContain('ip daddr { 10.0.0.1/32 } drop');
	});

	test('block-arbiter and pause-heartbeat are narrow output rules', () => {
		const arbiter = renderNftRuleset('00000001', parseFaultRequest('block-arbiter', { endpoints: [{ cidr: '172.30.147.20', port: 9000 }], action: 'reject', durationS: 5 }));
		expect(arbiter).toContain('ip daddr 172.30.147.20/32 tcp dport 9000 reject with tcp reset');
		const heartbeat = renderNftRuleset('00000002', parseFaultRequest('pause-heartbeat', { endpoints: [{ cidr: '172.30.147.11', port: 80 }], durationS: 5 }));
		expect(heartbeat).toContain('meta skuid "yoal" ip daddr 172.30.147.11/32 tcp dport 80 drop');
		expect(heartbeat).not.toContain('chain input');
	});

	test('netem with peers steers only their traffic through a prio band', () => {
		const all = renderNetemCommands(parseFaultRequest('netem', { device: 'eth0', delayMs: 200, jitterMs: 20, lossPct: 5, durationS: 5 }) as never);
		expect(all).toEqual([['tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'handle', 'fa17:', 'netem', 'delay', '200ms', '20ms', 'loss', '5%']]);
		const some = renderNetemCommands(parseFaultRequest('netem', { device: 'eth0', delayMs: 100, peers: ['172.30.147.12'], durationS: 5 }) as never);
		expect(some).toHaveLength(3);
		expect(some[2]).toEqual(['tc', 'filter', 'add', 'dev', 'eth0', 'parent', 'fa17:', 'protocol', 'ip', 'prio', '1', 'u32', 'match', 'ip', 'dst', '172.30.147.12/32', 'flowid', 'fa17:4']);
	});

	test('clock skew is a libfaketime drop-in reading an offset file', () => {
		expect(faketimeOffset(5)).toBe('+5');
		expect(faketimeOffset(-60)).toBe('-60');
		const dropIn = renderClockDropIn('/usr/lib/x/libfaketime.so.1', '/run/yoal-faults/clock-yoal-agent.service');
		expect(dropIn).toContain('Environment=LD_PRELOAD=/usr/lib/x/libfaketime.so.1');
		expect(dropIn).toContain('Environment=FAKETIME_TIMESTAMP_FILE=/run/yoal-faults/clock-yoal-agent.service');
		expect(dropIn).toContain('FAKETIME_DONT_FAKE_MONOTONIC=1');
	});
});

describe('FaultInjector', () => {
	let root: string;
	let timers: { fn: () => void; ms: number; cleared: boolean }[];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'yoal-faults-'));
		mkdirSync(join(root, 'net', 'eth0'), { recursive: true });
		mkdirSync(join(root, 'dropins'), { recursive: true });
		timers = [];
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function injector(runner: CommandRunner): FaultInjector {
		return new FaultInjector({
			runner,
			systemctlPath: '/bin/systemctl',
			runDir: join(root, 'run'),
			dataDir: join(root, 'data'),
			dropInRoot: join(root, 'dropins'),
			netDir: join(root, 'net'),
			now: () => Date.UTC(2026, 10, 20),
			setTimer: (fn, ms) => {
				const timer = { fn, ms, cleared: false };
				timers.push(timer);
				return timer;
			},
			clearTimer: (handle) => {
				(handle as { cleared: boolean }).cleared = true;
			},
		});
	}

	test('partition applies with nft -f -, auto-reverts on its timer and is recorded while active', async () => {
		const runner = fakeRunner();
		const faults = injector(runner);
		const fault = await faults.apply(parseFaultRequest('partition', { peers: ['172.30.147.12'], durationS: 30 }));
		expect(runner.calls[0]!.argv).toEqual(['nft', '-f', '-']);
		expect(runner.calls[0]!.stdin).toContain(`table inet yoal_fault_${fault.id}`);
		expect(fault.expiresAt).toBe('2026-11-20T00:00:30.000Z');
		expect(timers[0]!.ms).toBe(30_000);
		expect(JSON.parse(readFileSync(join(root, 'run', 'active.json'), 'utf8'))).toHaveLength(1);

		timers[0]!.fn();
		await Bun.sleep(5);
		expect(runner.calls.some((call) => call.argv.join(' ') === `nft delete table inet yoal_fault_${fault.id}`)).toBe(true);
		expect(faults.list()).toEqual([]);
		expect(JSON.parse(readFileSync(join(root, 'run', 'active.json'), 'utf8'))).toEqual([]);
	});

	test('freeze sends SIGSTOP to the whole unit and SIGCONT on revert', async () => {
		const runner = fakeRunner();
		const faults = injector(runner);
		const fault = await faults.apply(parseFaultRequest('freeze', { unit: 'yoal-agent.service', durationS: 60 }));
		expect(runner.calls[0]!.argv).toEqual(['/bin/systemctl', 'kill', '--kill-whom=all', '--signal=SIGSTOP', 'yoal-agent.service']);
		const result = await faults.revert(fault.id);
		expect(result.reverted).toBe(true);
		expect(timers[0]!.cleared).toBe(true);
		expect(runner.calls.some((call) => call.argv.includes('--signal=SIGCONT'))).toBe(true);
		await expect(faults.apply(parseFaultRequest('freeze', { unit: 'yoal-agent.service', durationS: 60 }))).resolves.toBeDefined();
		await expect(faults.apply(parseFaultRequest('freeze', { unit: 'yoal-agent.service', durationS: 60 }))).rejects.toThrow(/already active/);
	});

	test('kill-unit with a signal leaves nothing to revert; with stop it starts the unit again', async () => {
		const runner = fakeRunner();
		const faults = injector(runner);
		const killed = await faults.apply(parseFaultRequest('kill-unit', { unit: 'caddy.service' }));
		expect(killed.expiresAt).toBeNull();
		expect(faults.list()).toEqual([]);
		const stopped = await faults.apply(parseFaultRequest('kill-unit', { unit: 'caddy.service', mode: 'stop', durationS: 10 }));
		await faults.revert(stopped.id);
		expect(runner.calls.map((call) => call.argv.slice(1, 3).join(' '))).toContain('start caddy.service');
	});

	test('clock-skew writes the offset and a runtime drop-in, restarts the unit, and reverts to +0', async () => {
		const runner = fakeRunner();
		const faults = injector(runner);
		const params = parseFaultRequest('clock-skew', { unit: 'yoal-agent.service', offsetS: -60, durationS: 30 });
		// The test host has no libfaketime: the verb refuses rather than pretending.
		const libraries = ['/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1', '/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1'];
		if (!libraries.some((path) => existsSync(path))) {
			await expect(faults.apply(params)).rejects.toThrow(/libfaketime is not installed/);
			return;
		}
		const fault = await faults.apply(params);
		expect(readFileSync(join(root, 'run', 'clock-yoal-agent.service'), 'utf8')).toBe('-60\n');
		await faults.revert(fault.id);
		expect(readFileSync(join(root, 'run', 'clock-yoal-agent.service'), 'utf8')).toBe('+0\n');
		expect(existsSync(join(root, 'dropins', 'yoal-agent.service.d', '90-yoal-fault-clock.conf'))).toBe(false);
	});

	test('fill-disk refuses a filesystem that is not loopback-backed', async () => {
		writeFileSync(join(root, 'mountinfo'), '22 1 8:1 / / rw - ext4 /dev/vda1 rw\n');
		const faults = new FaultInjector({ runner: fakeRunner(), mountInfoPath: join(root, 'mountinfo'), runDir: join(root, 'run') });
		await expect(faults.apply(parseFaultRequest('fill-disk', { path: '/var/lib/yoal/data', durationS: 5 }))).rejects.toThrow(/not loopback-backed/);
	});

	test('netem refuses a device that does not exist and a second qdisc on one device', async () => {
		const runner = fakeRunner((argv) => (argv[1] === 'qdisc' && argv[2] === 'show' ? { stdout: 'qdisc noqueue 0: root refcnt 2' } : {}));
		const faults = injector(runner);
		await expect(faults.apply(parseFaultRequest('netem', { device: 'eth9', delayMs: 10, durationS: 5 }))).rejects.toThrow(/does not exist/);
		await faults.apply(parseFaultRequest('netem', { device: 'eth0', delayMs: 10, durationS: 5 }));
		await expect(faults.apply(parseFaultRequest('netem', { device: 'eth0', lossPct: 5, durationS: 5 }))).rejects.toThrow(/already active/);
	});

	test('clear-all reverts known faults and sweeps leftovers by name', async () => {
		const runner = fakeRunner((argv) => {
			if (argv.join(' ') === 'nft list tables') return { stdout: 'table inet filter\ntable inet yoal_fault_deadbeef\n' };
			if (argv.join(' ') === 'tc qdisc show dev eth0') return { stdout: 'qdisc netem fa17: root refcnt 2 limit 1000 delay 100ms\n' };
			return {};
		});
		mkdirSync(join(root, 'dropins', 'yoal-agent.service.d'), { recursive: true });
		writeFileSync(join(root, 'dropins', 'yoal-agent.service.d', '90-yoal-fault-clock.conf'), '[Service]\n');
		const faults = injector(runner);
		await faults.apply(parseFaultRequest('block-arbiter', { endpoints: [{ cidr: '172.30.147.20', port: 9000 }], durationS: 600 }));
		const result = await faults.clearAll();
		expect(result.reverted).toHaveLength(1);
		expect(result.swept).toEqual(['nft:yoal_fault_deadbeef', 'tc:eth0', 'clock:yoal-agent.service']);
		expect(runner.calls.some((call) => call.argv.join(' ') === 'nft delete table inet filter')).toBe(false);
		expect(existsSync(join(root, 'dropins', 'yoal-agent.service.d', '90-yoal-fault-clock.conf'))).toBe(false);
	});

	test('a fresh process reverts what an earlier one persisted', async () => {
		const runner = fakeRunner();
		await injector(runner).apply(parseFaultRequest('freeze', { unit: 'yoal-control-plane.service', durationS: 600 }));
		const restarted = injector(runner);
		const result = await restarted.clearAll('startup sweep');
		expect(result.swept.some((entry) => entry.startsWith('freeze:'))).toBe(true);
		expect(runner.calls.filter((call) => call.argv.includes('--signal=SIGCONT'))).toHaveLength(1);
	});

	test('HTTP: list, apply, revert and clear-all; other paths fall through', async () => {
		const faults = injector(fakeRunner());
		const call = (method: string, path: string, body?: unknown) =>
			faults.handle(new Request(`http://helper${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://helper${path}`));
		expect(await call('GET', '/v1/status')).toBeNull();
		const applied = await call('POST', '/v1/faults/partition', { peers: ['10.47.0.2'], durationS: 20 });
		expect(applied!.status).toBe(200);
		const { fault } = (await applied!.json()) as { fault: { id: string } };
		const listed = (await (await call('GET', '/v1/faults'))!.json()) as { faults: unknown[] };
		expect(listed.faults).toHaveLength(1);
		expect((await call('POST', '/v1/faults/revert', { id: fault.id }))!.status).toBe(200);
		expect((await call('POST', '/v1/faults/revert', { id: fault.id }))!.status).toBe(404);
		expect((await call('POST', '/v1/faults/clear-all'))!.status).toBe(200);
		expect((await call('DELETE', '/v1/faults'))!.status).toBe(405);
		await expect(call('POST', '/v1/faults/partition', { peers: ['10.47.0.2'], durationS: 20, shell: 'x' })).rejects.toThrow(ValidationError);
	});
});
