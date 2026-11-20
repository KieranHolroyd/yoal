/**
 * Local object-store emulators for the W3 conformance suite (HA-PLAN W3; HA Wave 1 lane E).
 *
 *   bun tests/object-store/emulators.ts up     # start MinIO, Azurite and fake-gcs-server
 *   bun tests/object-store/emulators.ts env    # print their endpoints as JSON
 *   bun tests/object-store/emulators.ts down   # remove them
 *
 * Images are pinned. Containers are named `yoal-w1-e-*`, publish on 127.0.0.1 only, on free
 * high ports, keep their data in memory or in the container, and are removed by `down`. The
 * credentials below are each emulator's documented development defaults or made-up values;
 * nothing here is a secret and nothing here talks to a real cloud.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from '../e2e/lib/containers.ts';

export const EMULATOR_IMAGES = {
	/** RELEASE.2025-09-07T16-13-09Z, pinned by digest (quay no longer serves the tag anonymously). */
	minio: 'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
	azurite: 'mcr.microsoft.com/azure-storage/azurite:3.35.0',
	gcs: 'fsouza/fake-gcs-server:1.52.2',
} as const;

export const EMULATOR_CONTAINERS = {
	minio: 'yoal-w1-e-minio',
	azurite: 'yoal-w1-e-azurite',
	gcs: 'yoal-w1-e-gcs',
} as const;

export type EmulatorName = keyof typeof EMULATOR_CONTAINERS;

/** MinIO root credentials for this throwaway container. */
export const MINIO_ACCESS_KEY = 'yoalw1eminio';
export const MINIO_SECRET_KEY = 'yoal-w1-e-minio-not-a-secret';
/** Azurite's documented development account (a public, well-known key). */
export const AZURITE_ACCOUNT = 'devstoreaccount1';
export const AZURITE_ACCOUNT_KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

export interface EmulatorEndpoints {
	minio?: string;
	azurite?: string;
	gcs?: string;
}

const STATE_FILE = join(process.env.YOAL_W1E_STATE_DIR ?? tmpdir(), 'yoal-w1-e-emulators.json');
const ENGINE = process.env.YOAL_E2E_ENGINE === 'podman' ? 'podman' : 'docker';

async function run(args: string[], check = true): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([ENGINE, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (check && code !== 0) throw new Error(`${ENGINE} ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
	return { code, stdout, stderr };
}

async function waitHttp(url: string, ok: (status: number) => boolean, label: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = '';
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
			await response.body?.cancel().catch(() => undefined);
			if (ok(response.status)) return;
			last = `HTTP ${response.status}`;
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
		}
		await Bun.sleep(250);
	}
	throw new Error(`${label} did not become ready: ${last}`);
}

async function startOne(name: EmulatorName): Promise<string> {
	const container = EMULATOR_CONTAINERS[name];
	await run(['rm', '-fv', container], false);
	const port = await freePort();
	const common = ['run', '-d', '--name', container, '--label', 'yoal.w1e=true', '--memory', '512m'];
	if (name === 'minio') {
		await run([
			...common,
			'-p',
			`127.0.0.1:${port}:9000`,
			'-e',
			`MINIO_ROOT_USER=${MINIO_ACCESS_KEY}`,
			'-e',
			`MINIO_ROOT_PASSWORD=${MINIO_SECRET_KEY}`,
			EMULATOR_IMAGES.minio,
			'server',
			'/data',
		]);
		const url = `http://127.0.0.1:${port}`;
		await waitHttp(`${url}/minio/health/ready`, (status) => status === 200, 'MinIO');
		return url;
	}
	if (name === 'azurite') {
		await run([
			...common,
			'-p',
			`127.0.0.1:${port}:10000`,
			EMULATOR_IMAGES.azurite,
			'azurite-blob',
			'--blobHost',
			'0.0.0.0',
			'--blobPort',
			'10000',
			'--inMemoryPersistence',
			'--skipApiVersionCheck',
		]);
		const url = `http://127.0.0.1:${port}`;
		// Any HTTP answer (400 for a bare GET) means the listener is up.
		await waitHttp(`${url}/${AZURITE_ACCOUNT}?comp=list`, (status) => status > 0, 'Azurite');
		return url;
	}
	await run([
		...common,
		'-p',
		`127.0.0.1:${port}:4443`,
		EMULATOR_IMAGES.gcs,
		'-scheme',
		'http',
		'-port',
		'4443',
		'-backend',
		'memory',
		'-external-url',
		`http://127.0.0.1:${port}`,
		'-public-host',
		`127.0.0.1:${port}`,
	]);
	const url = `http://127.0.0.1:${port}`;
	await waitHttp(`${url}/storage/v1/b`, (status) => status === 200, 'fake-gcs-server');
	return url;
}

export async function startEmulators(names: EmulatorName[] = ['minio', 'azurite', 'gcs']): Promise<EmulatorEndpoints> {
	const endpoints: EmulatorEndpoints = { ...readEmulatorState() };
	for (const name of names) endpoints[name] = await startOne(name);
	writeFileSync(STATE_FILE, `${JSON.stringify(endpoints, null, 2)}\n`);
	return endpoints;
}

export async function stopEmulators(names: EmulatorName[] = ['minio', 'azurite', 'gcs']): Promise<void> {
	for (const name of names) await run(['rm', '-fv', EMULATOR_CONTAINERS[name]], false);
	const remaining = { ...readEmulatorState() };
	for (const name of names) delete remaining[name];
	if (Object.keys(remaining).length === 0) rmSync(STATE_FILE, { force: true });
	else writeFileSync(STATE_FILE, `${JSON.stringify(remaining, null, 2)}\n`);
}

/** Endpoints of emulators started by `up`, or `{}`. Verifies nothing. */
export function readEmulatorState(): EmulatorEndpoints {
	if (!existsSync(STATE_FILE)) return {};
	try {
		return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as EmulatorEndpoints;
	} catch {
		return {};
	}
}

function namesFrom(args: string[]): EmulatorName[] {
	const picked = args.filter((arg): arg is EmulatorName => arg in EMULATOR_CONTAINERS);
	return picked.length ? picked : ['minio', 'azurite', 'gcs'];
}

if (import.meta.main) {
	const [command, ...rest] = process.argv.slice(2);
	if (command === 'up') console.log(JSON.stringify(await startEmulators(namesFrom(rest)), null, 2));
	else if (command === 'down') await stopEmulators(namesFrom(rest));
	else if (command === 'env') console.log(JSON.stringify(readEmulatorState(), null, 2));
	else {
		console.error('usage: bun tests/object-store/emulators.ts up|down|env [minio] [azurite] [gcs]');
		process.exit(2);
	}
}
