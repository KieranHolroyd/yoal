import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { promises as fs, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signManifest } from '../../../scripts/update-self/signing.ts';
import { createHandler, type HelperRuntime } from './server.ts';
import {
	compareVersions,
	guardFiles,
	NODE_UPDATE_GUARD_SECONDS,
	NodeUpdateError,
	NodeUpdater,
	parseNodeUpdateConfirm,
	parseNodeUpdateRequest,
	renderGuardArgv,
	renderGuardScript,
	shellQuote,
} from './node-update.ts';
import { ValidationError } from './validate.ts';

const REPO = 'owner/yoal';
const COMMIT = 'a'.repeat(40);
const keys = generateKeyPairSync('ed25519');
const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const trusted = (): Map<string, KeyObject> =>
	new Map([['test', createPublicKey(keys.publicKey.export({ type: 'spki', format: 'pem' }))]]);

let root: string;
let files: Map<string, Uint8Array>;
let restarts: number;
/** Commands the guard ran (systemd-run, systemctl), with the binaries as they were at that moment. */
let commands: Array<{ argv: string[]; agentAtTheTime: string }>;
let systemdRunFails: boolean;

function paths() {
	return {
		agentBinary: join(root, 'opt/yoal/current/agent/yoal-agent'),
		helperBinary: join(root, 'opt/yoal/helper/yoal-helper'),
		releaseLink: join(root, 'opt/yoal/current'),
		workDir: join(root, 'var/lib/yoal-helper/node-update'),
	};
}

/** Build a node bundle with `members`, sign a manifest for it and serve both from the fake GitHub. */
function publish(input: {
	version?: string;
	members?: Record<string, string>;
	signWith?: string;
	tamper?: boolean;
	noNodeArtifacts?: boolean;
	manifestVersion?: string;
} = {}) {
	const version = input.version ?? '0.8.0';
	const members = input.members ?? { 'yoal-agent': `agent ${version}`, 'yoal-helper': `helper ${version}` };
	const src = mkdtempSync(join(tmpdir(), 'yoal-node-src-'));
	for (const [name, body] of Object.entries(members)) writeFileSync(join(src, name), body);
	const file = `yoal-node-${version}-linux-amd64.tar.gz`;
	const archive = join(src, file);
	execFileSync('tar', ['-czf', archive, '-C', src, ...Object.keys(members)]);
	const bytes = readFileSync(archive);
	const manifest = {
		schema: 1,
		version: input.manifestVersion ?? version,
		commit: COMMIT,
		repo: REPO,
		channel: 'stable',
		createdAt: '2026-11-06T00:00:00.000Z',
		updaterVersion: null,
		minUpdater: null,
		hookProtocol: 1,
		artifacts: {},
		...(input.noNodeArtifacts
			? {}
			: {
					nodeArtifacts: {
						'linux-amd64': {
							file,
							sha256: input.tamper ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
							size: bytes.length,
						},
					},
				}),
	};
	const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
	const base = `https://github.com/${REPO}/releases/download/v${version}`;
	files.set(`${base}/manifest.json`, manifestBytes);
	files.set(`${base}/manifest.json.sig`, new TextEncoder().encode(signManifest(manifestBytes, input.signWith ?? privatePem)));
	files.set(`${base}/${file}`, new Uint8Array(bytes));
}

function updater(currentVersion = '0.7.15') {
	return new NodeUpdater({
		paths: paths(),
		currentVersion,
		trustedKeys: trusted,
		platform: () => 'linux-amd64',
		scheduleRestart: () => void (restarts += 1),
		systemctlPath: '/usr/bin/systemctl',
		now: () => 1_000_000,
		exec: async (argv) => {
			commands.push({ argv, agentAtTheTime: readFileSync(paths().agentBinary, 'utf8') });
			if (argv[0] === '/usr/bin/systemd-run' && systemdRunFails)
				return { code: 1, stdout: '', stderr: 'Failed to connect to bus: No such file or directory' };
			return { code: 0, stdout: '', stderr: '' };
		},
		fetch: (async (url: string | URL | Request) => {
			const body = files.get(String(url));
			return body ? new Response(body) : new Response('not found', { status: 404 });
		}) as typeof fetch,
	});
}

const read = (path: string) => readFileSync(path, 'utf8');

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'yoal-node-update-'));
	files = new Map();
	restarts = 0;
	commands = [];
	systemdRunFails = false;
	const { agentBinary, helperBinary } = paths();
	await fs.mkdir(join(agentBinary, '..'), { recursive: true });
	await fs.mkdir(join(helperBinary, '..'), { recursive: true });
	writeFileSync(agentBinary, 'agent old');
	writeFileSync(helperBinary, 'helper old');
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe('node update (D99)', () => {
	test('installs a verified bundle, keeps the previous binaries and schedules the restart', async () => {
		publish();
		const result = await updater().update({ version: '0.8.0', repo: REPO });
		const { agentBinary, helperBinary, workDir } = paths();
		expect(result).toMatchObject({ version: '0.8.0', previous: '0.7.15' });
		expect(read(agentBinary)).toBe('agent 0.8.0');
		expect(read(helperBinary)).toBe('helper 0.8.0');
		expect(read(`${agentBinary}.previous`)).toBe('agent old');
		expect(read(`${helperBinary}.previous`)).toBe('helper old');
		expect((await fs.stat(agentBinary)).mode & 0o777).toBe(0o755);
		expect(restarts).toBe(1);
		await expect(fs.stat(workDir)).rejects.toThrow();
	});

	test('a manifest signed by an unknown key changes nothing', async () => {
		publish({ signWith: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
		await expect(updater().update({ version: '0.8.0', repo: REPO })).rejects.toThrow(/not trusted/);
		expect(read(paths().agentBinary)).toBe('agent old');
		expect(restarts).toBe(0);
	});

	test('a bundle that does not match its signed checksum is never unpacked', async () => {
		publish({ tamper: true });
		await expect(updater().update({ version: '0.8.0', repo: REPO })).rejects.toThrow(/signed checksum/);
		expect(read(paths().agentBinary)).toBe('agent old');
		expect(read(paths().helperBinary)).toBe('helper old');
	});

	test('a bundle with anything besides the two binaries is refused', async () => {
		publish({ members: { 'yoal-agent': 'a', 'yoal-helper': 'h', 'evil.sh': 'x' } });
		await expect(updater().update({ version: '0.8.0', repo: REPO })).rejects.toThrow(/must contain exactly/);
		expect(read(paths().agentBinary)).toBe('agent old');
	});

	test('refuses a downgrade, a mislabelled manifest and a release without node bundles', async () => {
		publish({ version: '0.7.0' });
		await expect(updater().update({ version: '0.7.0', repo: REPO })).rejects.toThrow(/downgrade/);
		publish({ version: '0.8.1', manifestVersion: '0.9.0' });
		await expect(updater().update({ version: '0.8.1', repo: REPO })).rejects.toThrow(/mislabelled/);
		publish({ version: '0.8.2', noNodeArtifacts: true });
		await expect(updater().update({ version: '0.8.2', repo: REPO })).rejects.toThrow(/predates node updates/);
		await expect(updater().update({ version: '0.9.9', repo: REPO })).rejects.toThrow(/no signed manifest/);
		expect(read(paths().agentBinary)).toBe('agent old');
	});

	test('refuses a control-plane release layout (yoal-update-self owns it)', async () => {
		const { releaseLink } = paths();
		const release = join(root, 'opt/yoal/releases/r1');
		await fs.mkdir(join(release, 'agent'), { recursive: true });
		writeFileSync(join(release, 'agent/yoal-agent'), 'agent release');
		await fs.rm(releaseLink, { recursive: true });
		await fs.symlink(release, releaseLink);
		publish();
		await expect(updater().update({ version: '0.8.0', repo: REPO })).rejects.toThrow(/yoal-update-self/);
		expect(read(join(release, 'agent/yoal-agent'))).toBe('agent release');
	});

	test('validates the request strictly', () => {
		expect(parseNodeUpdateRequest({ version: '1.2.3', repo: 'a/b' })).toEqual({ version: '1.2.3', repo: 'a/b' });
		for (const body of [
			{ version: '1.2', repo: 'a/b' },
			{ version: '1.2.3-rc.1', repo: 'a/b' },
			{ version: '1.2.3', repo: 'https://evil/x' },
			{ version: '1.2.3', repo: 'a/b', path: '/bin/sh' },
			[],
		])
			expect(() => parseNodeUpdateRequest(body)).toThrow(ValidationError);
		expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
		expect(compareVersions('0.7.15', '0.7.15')).toBe(0);
	});

	test('is a fixed verb on the helper socket: 404 without an updater, 400 bad input, 409 refusal', async () => {
		const runtime = {} as HelperRuntime;
		const post = (body: unknown) =>
			new Request('http://localhost/v1/node/update', { method: 'POST', body: JSON.stringify(body) });
		expect((await createHandler(runtime, { version: '0.7.15' })(post({ version: '0.8.0', repo: REPO }))).status).toBe(404);
		const handler = createHandler(runtime, {
			version: '0.7.15',
			nodeUpdate: {
				update: async () => {
					throw new NodeUpdateError('refused');
				},
			},
		});
		expect((await handler(post({ version: 'latest', repo: REPO }))).status).toBe(400);
		const refused = await handler(post({ version: '0.8.0', repo: REPO }));
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: 'refused' });
	});
});

describe('node update rollback guard', () => {
	const systemdRuns = () => commands.filter((command) => command.argv[0] === '/usr/bin/systemd-run');

	test('arms a one-shot systemd timer before the binaries are swapped', async () => {
		publish();
		const result = await updater().update({ version: '0.8.0', repo: REPO });
		expect(result.guarded).toBe(true);
		const [run] = systemdRuns();
		expect(run).toBeDefined();
		// The old pair was still in place, and already saved as .previous, when the timer was armed.
		expect(run!.agentAtTheTime).toBe('agent old');
		expect(run!.argv.slice(0, 7)).toEqual([
			'/usr/bin/systemd-run',
			'--unit=yoal-node-update-guard',
			'--description=Yoal node update rollback guard',
			`--on-active=${NODE_UPDATE_GUARD_SECONDS}s`,
			'--timer-property=AccuracySec=5s',
			'/bin/sh',
			'-c',
		]);
		expect(run!.argv[7]).toContain(`${shellQuote(`${paths().agentBinary}.previous`)}`);
		// A previous guard is stopped and its failed state cleared first.
		const before = commands.slice(0, commands.indexOf(run!)).map((command) => command.argv.slice(1, 2)[0]);
		expect(before).toEqual(['stop', 'reset-failed']);
		const guard = JSON.parse(read(guardFiles(paths()).guard));
		expect(guard).toEqual({ version: '0.8.0', previous: '0.7.15', armedAt: 1_000_000, deadline: 1_000_000 + NODE_UPDATE_GUARD_SECONDS * 1000 });
		expect(read(paths().agentBinary)).toBe('agent 0.8.0');
	});

	test('without systemd-run the update continues unguarded', async () => {
		systemdRunFails = true;
		publish();
		const result = await updater().update({ version: '0.8.0', repo: REPO });
		expect(result.guarded).toBe(false);
		expect(read(paths().agentBinary)).toBe('agent 0.8.0');
		expect(restarts).toBe(1);
		await expect(fs.stat(guardFiles(paths()).guard)).rejects.toThrow();
	});

	test('a refused update never arms the guard', async () => {
		publish({ tamper: true });
		await expect(updater().update({ version: '0.8.0', repo: REPO })).rejects.toThrow(/signed checksum/);
		expect(systemdRuns()).toHaveLength(0);
	});

	test('confirm disarms only the armed version and is idempotent', async () => {
		publish();
		const node = updater();
		await node.update({ version: '0.8.0', repo: REPO });
		commands = [];
		expect(await node.confirm('0.9.0')).toEqual({ confirmed: false });
		expect(commands).toHaveLength(0);
		expect((await node.guardStatus()).guard?.version).toBe('0.8.0');

		expect(await node.confirm('0.8.0')).toEqual({ confirmed: true });
		expect(commands.map((command) => command.argv)).toEqual([
			['/usr/bin/systemctl', 'stop', 'yoal-node-update-guard.timer', 'yoal-node-update-guard.service'],
			['/usr/bin/systemctl', 'reset-failed', 'yoal-node-update-guard.timer', 'yoal-node-update-guard.service'],
		]);
		expect(read(guardFiles(paths()).confirmed)).toBe('0.8.0\n');
		expect(await node.guardStatus()).toEqual({ guard: null, rollback: null });

		commands = [];
		expect(await node.confirm('0.8.0')).toEqual({ confirmed: false });
		expect(commands).toHaveLength(0);
	});

	test('quotes every path for the shell and refuses what systemd would expand', () => {
		const input = {
			version: '0.8.0',
			previous: '0.7.15',
			agentBinary: "/opt/it's/yoal-agent",
			helperBinary: '/opt/yoal/helper/yoal-helper',
			confirmedPath: '/var/lib/yoal-helper/node-update-confirmed',
			guardPath: '/var/lib/yoal-helper/node-update-guard.json',
			rollbackPath: '/var/lib/yoal-helper/node-update-rollback.json',
			systemctlPath: '/usr/bin/systemctl',
			guardSeconds: 600,
		};
		const script = renderGuardScript(input);
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		expect(script).toContain(`mv -f '/opt/it'\\''s/yoal-agent.rollback' '/opt/it'\\''s/yoal-agent'`);
		expect(script).not.toContain('$');
		expect(script.split('\n')[0]).toBe(`grep -qxF '0.8.0' '/var/lib/yoal-helper/node-update-confirmed' 2>/dev/null && exit 0`);
		expect(script).toContain(`'/usr/bin/systemctl' --no-block restart yoal-agent.service yoal-helper.service`);
		expect(script).toContain(`'/usr/bin/systemctl' --no-block try-restart yoal-builder.service yoal-studio.service yoal-mail.service`);
		expect(() => renderGuardScript({ ...input, agentBinary: '/opt/$HOME/yoal-agent' })).toThrow(NodeUpdateError);
		expect(() => renderGuardScript({ ...input, rollbackPath: '/var/lib/%n' })).toThrow(NodeUpdateError);
		expect(() => renderGuardScript({ ...input, version: '0.8.0; rm -rf /' })).toThrow(NodeUpdateError);
		expect(renderGuardArgv('/usr/bin/systemd-run', 30, 'true').slice(-3)).toEqual(['/bin/sh', '-c', 'true']);
	});

	/** Run the real script under /bin/sh with a fake systemctl, as the timer would. */
	function runGuard(confirmed?: string) {
		const dir = join(root, "state with 'quote");
		execFileSync('mkdir', ['-p', dir]);
		const log = join(root, 'systemctl.log');
		const systemctl = join(root, 'fake-systemctl');
		writeFileSync(systemctl, `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
		const { agentBinary, helperBinary } = paths();
		writeFileSync(agentBinary, 'agent new');
		writeFileSync(`${agentBinary}.previous`, 'agent old');
		writeFileSync(helperBinary, 'helper new');
		writeFileSync(`${helperBinary}.previous`, 'helper old');
		const files = { confirmedPath: join(dir, 'confirmed'), guardPath: join(dir, 'guard.json'), rollbackPath: join(dir, 'rollback.json') };
		writeFileSync(files.guardPath, '{}');
		if (confirmed) writeFileSync(files.confirmedPath, `${confirmed}\n`);
		const script = renderGuardScript({
			version: '0.8.0',
			previous: '0.7.15',
			agentBinary,
			helperBinary,
			...files,
			systemctlPath: systemctl,
			guardSeconds: 600,
		});
		execFileSync('/bin/sh', ['-c', script]);
		return { files, log };
	}

	test('the guard script restores the previous pair, records the rollback and restarts', async () => {
		const { files, log } = runGuard();
		expect(read(paths().agentBinary)).toBe('agent old');
		expect(read(paths().helperBinary)).toBe('helper old');
		expect(read(`${paths().agentBinary}.previous`)).toBe('agent old');
		expect((await fs.stat(paths().agentBinary)).mode & 0o777).toBe(0o755);
		const marker = JSON.parse(read(files.rollbackPath));
		expect(marker).toMatchObject({ from: '0.8.0', to: '0.7.15', afterSeconds: 600 });
		expect(typeof marker.rolledBackAt).toBe('string');
		await expect(fs.stat(files.guardPath)).rejects.toThrow();
		expect(read(log).trim().split('\n')).toEqual([
			'--no-block try-restart yoal-builder.service yoal-studio.service yoal-mail.service',
			'--no-block restart yoal-agent.service yoal-helper.service',
		]);
	});

	test('the guard script does nothing once the version confirmed', async () => {
		const { files, log } = runGuard('0.8.0');
		expect(read(paths().agentBinary)).toBe('agent new');
		await expect(fs.stat(files.rollbackPath)).rejects.toThrow();
		await expect(fs.stat(log)).rejects.toThrow();
		// A confirm for some other version does not count.
		runGuard('0.7.99');
		expect(read(paths().agentBinary)).toBe('agent old');
	});

	test('guard status reports the rollback marker the script wrote', async () => {
		const { rollback } = guardFiles(paths());
		await fs.mkdir(join(rollback, '..'), { recursive: true });
		writeFileSync(rollback, '{"from":"0.8.0","to":"0.7.15","afterSeconds":600,"rolledBackAt":"2026-11-14T10:00:00+00:00"}');
		expect(await updater().guardStatus()).toEqual({
			guard: null,
			rollback: { from: '0.8.0', to: '0.7.15', afterSeconds: 600, rolledBackAt: '2026-11-14T10:00:00+00:00' },
		});
	});

	test('confirm and guard are fixed verbs: strict body, 404 on a helper without them', async () => {
		const runtime = {} as HelperRuntime;
		const confirm = (body: unknown) =>
			new Request('http://localhost/v1/node/update/confirm', { method: 'POST', body: JSON.stringify(body) });
		const old = createHandler(runtime, { version: '0.7.15', nodeUpdate: { update: async () => ({}) as never } });
		expect((await old(confirm({ version: '0.8.0' }))).status).toBe(404);
		expect((await old(new Request('http://localhost/v1/node/update/guard'))).status).toBe(404);

		const confirmed: string[] = [];
		const handler = createHandler(runtime, {
			version: '0.8.0',
			nodeUpdate: {
				update: async () => ({}) as never,
				confirm: async (version) => {
					confirmed.push(version);
					return { confirmed: version === '0.8.0' };
				},
				guardStatus: async () => ({ guard: null, rollback: null }),
			},
		});
		expect(await (await handler(confirm({ version: '0.8.0' }))).json()).toEqual({ ok: true, confirmed: true });
		expect(await (await handler(confirm({ version: '0.9.0' }))).json()).toEqual({ ok: true, confirmed: false });
		expect((await handler(confirm({ version: 'latest' }))).status).toBe(400);
		expect((await handler(confirm({ version: '0.8.0', extra: 1 }))).status).toBe(400);
		expect(confirmed).toEqual(['0.8.0', '0.9.0']);
		const guard = await handler(new Request('http://localhost/v1/node/update/guard'));
		expect(await guard.json()).toEqual({ ok: true, guard: null, rollback: null });
		expect(() => parseNodeUpdateConfirm({ version: '1.2.3-rc.1' })).toThrow(ValidationError);
	});
});
