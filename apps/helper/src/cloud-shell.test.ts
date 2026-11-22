import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	cloudShellDiskPaths,
	ensureHomeDisk,
	growHomeDisk,
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

describe('growing a home disk', () => {
	class ScriptedRunner implements CommandRunner {
		calls: string[][] = [];
		constructor(private readonly codes: Record<string, number> = {}) {}
		async run(argv: string[]): Promise<RunResult> {
			this.calls.push(argv);
			const code = this.codes[argv[0]!.split('/').pop()!] ?? 0;
			return { code, stdout: '', stderr: code ? 'bad superblock' : '' };
		}
	}
	const paths = { e2fsckPath: '/usr/sbin/e2fsck', resize2fsPath: '/usr/sbin/resize2fs' };

	async function image(sizeMb: number): Promise<string> {
		const path = join(await tempDir(), 'home.ext4');
		await fs.writeFile(path, '');
		await fs.truncate(path, sizeMb * 1024 * 1024);
		return path;
	}

	test('checks, extends and grows the filesystem, and does nothing when already that big', async () => {
		const path = await image(1024);
		const runner = new ScriptedRunner();
		expect(await growHomeDisk({ runner, ...paths, image: path, sizeMb: 4096, id: CSH_ID })).toEqual({ grown: true, fromMb: 1024 });
		expect(runner.calls).toEqual([
			['/usr/sbin/e2fsck', '-f', '-p', path],
			['/usr/sbin/resize2fs', path],
		]);
		expect((await fs.stat(path)).size).toBe(4096 * 1024 * 1024);
		expect(await growHomeDisk({ runner, ...paths, image: path, sizeMb: 2048, id: CSH_ID })).toEqual({ grown: false, fromMb: 4096 });
		expect(runner.calls).toHaveLength(2);
	});

	test('errors e2fsck corrected are fine; one it could not fix leaves the disk alone', async () => {
		const corrected = await image(512);
		await growHomeDisk({ runner: new ScriptedRunner({ e2fsck: 1 }), ...paths, image: corrected, sizeMb: 1024, id: CSH_ID });
		expect((await fs.stat(corrected)).size).toBe(1024 * 1024 * 1024);

		const broken = await image(512);
		const runner = new ScriptedRunner({ e2fsck: 4 });
		await expect(growHomeDisk({ runner, ...paths, image: broken, sizeMb: 1024, id: CSH_ID })).rejects.toThrow(/e2fsck failed \(4\)/);
		expect(runner.calls).toHaveLength(1);
		expect((await fs.stat(broken)).size).toBe(512 * 1024 * 1024);
	});

	test('a failed resize2fs puts the image back to its old length, so the next apply retries', async () => {
		const path = await image(1024);
		await expect(
			growHomeDisk({ runner: new ScriptedRunner({ resize2fs: 1 }), ...paths, image: path, sizeMb: 2048, id: CSH_ID }),
		).rejects.toThrow(/resize2fs failed/);
		expect((await fs.stat(path)).size).toBe(1024 * 1024 * 1024);
	});

	test('never resizes through a symlink', async () => {
		const dir = await tempDir();
		const path = join(dir, 'home.ext4');
		await fs.symlink('/etc/passwd', path);
		await expect(growHomeDisk({ runner: new ScriptedRunner(), ...paths, image: path, sizeMb: 2048, id: CSH_ID })).rejects.toThrow(
			/not a regular file/,
		);
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

	test('apply grows a smaller disk offline: container and mount stopped first, mounted again after', async () => {
		const root = await tempDir();
		const runner = new FakeRunner();
		const stateDir = join(root, 'state');
		const disk = cloudShellDiskPaths(stateDir, CSH_ID);
		const mountUnit = homeMountUnitName(disk.mountPoint);
		// Mounted until the driver stops the mount unit, and again once it starts it.
		const mounted = async () => {
			const last = runner.calls
				.map((call) => call.slice(1).join(' '))
				.filter((call) => call === `stop ${mountUnit}` || call === `start ${mountUnit}`)
				.at(-1);
			return last !== `stop ${mountUnit}`;
		};
		const driver = new SystemdDriver({
			runner,
			unitDir: join(root, 'units'),
			quadletDir: join(root, 'quadlet'),
			runtimeDir: join(root, 'run'),
			stateDir,
			releaseDirs: [join(root, 'releases')],
			volumeRegistryFile: join(root, 'volumes.json'),
			bunPath: '/usr/local/bin/bun',
			isMounted: mounted,
		});
		await Promise.all([fs.mkdir(join(root, 'units')), fs.mkdir(join(root, 'quadlet'))]);
		await fs.mkdir(disk.dir, { recursive: true });
		await fs.writeFile(disk.image, '');
		await fs.truncate(disk.image, 1024 * 1024 * 1024);
		const activation: WorkloadActivation = { workloadId: CSH_ID, activationVersion: 'b'.repeat(64), env: {}, files: {} };

		await driver.apply(parseWorkload(input({ cloudShell: { diskMb: 2048 } })), activation);
		expect((await fs.stat(disk.image)).size).toBe(2048 * 1024 * 1024);
		const calls = runner.calls.map((call) => call.join(' '));
		const index = (prefix: string) => calls.findIndex((call) => call.includes(prefix));
		expect(index(`stop yoal-workload-${CSH_ID}.service`)).toBeGreaterThan(-1);
		expect(index(`stop ${mountUnit}`)).toBeGreaterThan(index(`stop yoal-workload-${CSH_ID}.service`));
		expect(index('/usr/sbin/e2fsck -f -p')).toBeGreaterThan(index(`stop ${mountUnit}`));
		expect(index('/usr/sbin/resize2fs')).toBeGreaterThan(index('/usr/sbin/e2fsck'));
		expect(index(`start ${mountUnit}`)).toBeGreaterThan(index('/usr/sbin/resize2fs'));

		// Same size again: nothing is stopped or checked.
		runner.calls = [];
		await driver.apply(parseWorkload(input({ cloudShell: { diskMb: 2048 } })), activation);
		expect(runner.calls.some((call) => call[0]!.endsWith('e2fsck') || call.join(' ') === `/usr/bin/systemctl stop ${mountUnit}`)).toBe(false);
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
