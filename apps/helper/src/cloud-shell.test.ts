import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	cloudShellDiskPaths,
	ensureHomeDisk,
	homeMountUnitName,
	renderHomeMountUnit,
	systemdEscapePath,
} from './cloud-shell.ts';
import { SystemdDriver, type CommandRunner, type RunResult } from './systemd.ts';
import { renderCloudShellUnit } from './units.ts';
import { assertManagedId, parseWorkload, type WorkloadActivation } from './validate.ts';

/** Cloud shells (D236): the profile, the home disk and the units the helper renders for them. */

const CSH_ID = 'csh_0123456789abcdef0123456789abcdef';
const directories: string[] = [];

class FakeRunner implements CommandRunner {
	calls: string[][] = [];
	constructor(private readonly mkfsCode = 0) {}
	async run(argv: string[]): Promise<RunResult> {
		this.calls.push(argv);
		if (argv[0]!.endsWith('mkfs.ext4')) return { code: this.mkfsCode, stdout: '', stderr: this.mkfsCode ? 'no space' : '' };
		if (argv[1] === 'show') return { code: 0, stdout: 'ActiveState=activating\nSubState=start\nNRestarts=0\n', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: CSH_ID,
		projectId: CSH_ID,
		projectSlug: 'cloud-shell',
		deploymentId: CSH_ID,
		orgId: 'org_1',
		runtime: 'container',
		status: 'running',
		release: null,
		image: 'ghcr.io/kieranholroyd/yoal-cloud-shell:0.17.0',
		upstream: '127.0.0.1:8080',
		memoryMb: 512,
		cpus: 1,
		port: 8080,
		healthPath: '/',
		socketActivation: false,
		activationVersion: 'b'.repeat(64),
		env: {},
		secrets: [],
		dataSizeMb: null,
		ingress: 'none',
		cloudShell: { diskMb: 1024 },
		...overrides,
	};
}

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'yoal-cloud-shell-'));
	directories.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('cloud shell profile', () => {
	test('accepts a csh_ worker with a disk size and nothing else persistent', () => {
		expect(parseWorkload(input()).cloudShell).toEqual({ diskMb: 1024 });
		expect(assertManagedId(CSH_ID)).toBe(CSH_ID);
	});

	test('refuses anything that would widen it', () => {
		expect(() => parseWorkload(input({ id: 'wld_abc' }))).toThrow(/id like "csh_/);
		expect(() => parseWorkload(input({ cloudShell: undefined }))).toThrow(/reserved for cloud shells/);
		expect(() => parseWorkload(input({ ingress: undefined }))).toThrow(/workers/);
		expect(() => parseWorkload(input({ cloudShell: { diskMb: 100 } }))).toThrow(/diskMb/);
		expect(() => parseWorkload(input({ cloudShell: { diskMb: 100_000 } }))).toThrow(/diskMb/);
		expect(() => parseWorkload(input({ secrets: [{ name: 'X', delivery: 'file' }] }))).toThrow(/no secrets/);
		expect(() => parseWorkload(input({ dataSizeMb: 512 }))).toThrow(/home disk/);
		expect(() => parseWorkload(input({ volumes: [{ id: 'vol_1', mountPath: '/srv', readOnly: false }] }))).toThrow(/volumes/);
		expect(() => parseWorkload(input({ identity: true }))).toThrow(/identity/);
		expect(() => parseWorkload(input({ runtime: 'process', release: 'a'.repeat(64), image: undefined }))).toThrow();
	});
});

describe('home disk', () => {
	test('escapes paths the way systemd-escape --path does', () => {
		expect(systemdEscapePath('/var/lib/yoal-workloads/csh_abc/home')).toBe('var-lib-yoal\\x2dworkloads-csh_abc-home');
		expect(systemdEscapePath('//srv//a.b/')).toBe('srv-a.b');
		expect(systemdEscapePath('/srv/.hidden/x y')).toBe('srv-.hidden-x\\x20y');
		expect(systemdEscapePath('/.state/é')).toBe('\\x2estate-\\xc3\\xa9');
		expect(systemdEscapePath('/')).toBe('-');
		expect(() => systemdEscapePath('/srv/../etc')).toThrow();
		expect(homeMountUnitName('/var/lib/yoal-workloads/csh_abc/home')).toBe('var-lib-yoal\\x2dworkloads-csh_abc-home.mount');
	});

	test('the mount unit loop-mounts the image without setuid or devices', () => {
		const unit = renderHomeMountUnit({ id: CSH_ID, image: '/state/csh_x/home.ext4', mountPoint: '/state/csh_x/home' });
		expect(unit).toContain('What=/state/csh_x/home.ext4');
		expect(unit).toContain('Where=/state/csh_x/home');
		expect(unit).toContain('Type=ext4');
		expect(unit).toContain('Options=loop,nosuid,nodev,noatime');
	});

	test('creates a sparse image of the requested size once, and keeps an existing one', async () => {
		const dir = await tempDir();
		const image = join(dir, 'home.ext4');
		const runner = new FakeRunner();
		expect(await ensureHomeDisk({ runner, mkfsPath: '/usr/sbin/mkfs.ext4', image, sizeMb: 1024, id: CSH_ID })).toEqual({ created: true });
		expect((await fs.stat(image)).size).toBe(1024 * 1024 * 1024);
		expect(runner.calls[0]).toEqual([
			'/usr/sbin/mkfs.ext4', '-q', '-F', '-m', '0', '-L', 'yoal-home', '-E', 'lazy_itable_init=1,lazy_journal_init=1', `${image}.new`,
		]);
		expect(await ensureHomeDisk({ runner, mkfsPath: '/usr/sbin/mkfs.ext4', image, sizeMb: 2048, id: CSH_ID })).toEqual({ created: false });
		expect(runner.calls).toHaveLength(1);
	});

	test('a failed mkfs leaves nothing behind, and a symlink is never mounted', async () => {
		const dir = await tempDir();
		const image = join(dir, 'home.ext4');
		await expect(
			ensureHomeDisk({ runner: new FakeRunner(1), mkfsPath: '/usr/sbin/mkfs.ext4', image, sizeMb: 256, id: CSH_ID }),
		).rejects.toThrow(/mkfs.ext4 failed/);
		expect(await fs.readdir(dir)).toEqual([]);
		await fs.symlink('/etc/passwd', image);
		await expect(
			ensureHomeDisk({ runner: new FakeRunner(), mkfsPath: '/usr/sbin/mkfs.ext4', image, sizeMb: 256, id: CSH_ID }),
		).rejects.toThrow(/not a regular file/);
	});
});

describe('cloud shell units', () => {
	test('the container gets the app sandbox, the home disk and nothing published', () => {
		const unit = renderCloudShellUnit({
			workload: parseWorkload(input()),
			envFile: '/run/yoal-workloads/csh_x/env',
			homeMount: '/state/csh_x/home',
			homePath: '/home/yoal',
			tmpMb: 256,
		});
		expect(unit).toContain('RequiresMountsFor=/state/csh_x/home');
		expect(unit).toContain('Volume=/state/csh_x/home:/home/yoal:Z,U');
		for (const line of ['DropCapability=all', 'NoNewPrivileges=true', 'ReadOnly=true', 'Tmpfs=/tmp:rw,size=256m', 'UserNS=auto:size=65536', 'MemoryMax=512M'])
			expect(unit).toContain(line);
		expect(unit).not.toContain('PublishPort');
		expect(unit).not.toContain(':/data');
	});

	test('apply makes the disk, the mount and the unit; remove unmounts; purge refuses through a mount', async () => {
		const root = await tempDir();
		const runner = new FakeRunner();
		let mounted = true;
		const driver = new SystemdDriver({
			runner,
			unitDir: join(root, 'units'),
			quadletDir: join(root, 'quadlet'),
			runtimeDir: join(root, 'run'),
			stateDir: join(root, 'state'),
			releaseDirs: [join(root, 'releases')],
			volumeRegistryFile: join(root, 'volumes.json'),
			bunPath: '/usr/local/bin/bun',
			isMounted: async () => mounted,
		});
		await Promise.all([fs.mkdir(join(root, 'units')), fs.mkdir(join(root, 'quadlet'))]);
		const workload = parseWorkload(input());
		const activation: WorkloadActivation = {
			workloadId: CSH_ID,
			activationVersion: 'b'.repeat(64),
			env: { YOAL_URL: 'https://control.test', YOAL_TOKEN: 'yoal_secret' },
			files: {},
		};
		await driver.apply(workload, activation);

		const disk = cloudShellDiskPaths(join(root, 'state'), CSH_ID);
		expect((await fs.stat(disk.image)).size).toBe(1024 * 1024 * 1024);
		const mountUnit = homeMountUnitName(disk.mountPoint);
		expect(await fs.readFile(join(root, 'units', mountUnit), 'utf8')).toContain(`What=${disk.image}`);
		const container = await fs.readFile(join(root, 'quadlet', `yoal-workload-${CSH_ID}.container`), 'utf8');
		expect(container).toContain(`Volume=${disk.mountPoint}:/home/yoal:Z,U`);
		const env = await fs.readFile(join(root, 'run', CSH_ID, 'env'), 'utf8');
		expect(env).toContain('YOAL_TOKEN=yoal_secret');
		expect(env).toContain('HOME=/home/yoal');
		const systemctl = runner.calls.filter((call) => call[0]!.endsWith('systemctl')).map((call) => call.slice(1).join(' '));
		expect(systemctl).toContain(`start ${mountUnit}`);
		expect(systemctl.indexOf(`start ${mountUnit}`)).toBeLessThan(systemctl.findIndex((call) => call.startsWith('restart --no-block')));

		// A disk that did not mount stops the start before the container runs.
		mounted = false;
		await expect(driver.apply(workload, activation)).rejects.toThrow(/did not mount/);

		mounted = true;
		await expect(driver.purge(CSH_ID)).rejects.toThrow(/still mounted/);
		expect(runner.calls.some((call) => call.slice(1).join(' ') === `stop ${mountUnit}`)).toBe(true);
		await expect(fs.stat(join(root, 'units', mountUnit))).rejects.toThrow();
		mounted = false;
		await driver.purge(CSH_ID);
		await expect(fs.stat(disk.dir)).rejects.toThrow();
	});
});
