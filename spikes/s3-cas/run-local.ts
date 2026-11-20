/**
 * Run spike S3 against MinIO, Garage and RustFS, one at a time, each a single-node container named
 * `yoal-w0-s3-<store>` on a random loopback port with credentials made up for the run. Every
 * container (and its anonymous volume) is removed afterwards, pass or fail.
 *
 *   bun spikes/s3-cas/run-local.ts [> results.json]     STORES=minio,garage,rustfs (default all)
 *
 * The spike's own knobs (WRITERS, ATTEMPTS, SECONDS, FLOOD_SECONDS, LEASE_SECONDS) pass through.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSpike, type SpikeResult } from './spike.ts';
import { openTarget, type TargetConfig } from './targets.ts';

const MINIO_TAG = 'RELEASE.2025-10-15T17-29-55Z';
const IMAGES = {
	minio: `yoal-w0-s3-minio:${MINIO_TAG}`, // built from source by stores/minio.Dockerfile
	garage: 'dxflrs/garage:v2.5.0@sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5',
	rustfs: 'rustfs/rustfs:1.0.6@sha256:ee717072290bec9b11abfc0365f8310b00df1cd9b3639943edae47bdef05044a',
} as const;
type Store = keyof typeof IMAGES;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

function sh(args: string[], options: { allowFail?: boolean } = {}): string {
	const proc = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
	if (proc.exitCode !== 0 && !options.allowFail)
		throw new Error(`${args.join(' ')} → ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
	return proc.stdout.toString().trim();
}
const name = (store: Store) => `yoal-w0-s3-${store}`;
const remove = (store: Store) => sh(['docker', 'rm', '-f', '-v', name(store)], { allowFail: true });

function hostPort(container: string, port: number): number {
	const out = sh(['docker', 'port', container, `${port}/tcp`]);
	return Number(out.split('\n')[0]!.split(':').at(-1));
}

function digest(image: string): string {
	return sh(['docker', 'image', 'inspect', image, '--format', '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}']);
}

async function ready(config: TargetConfig): Promise<void> {
	const target = openTarget(config);
	for (let i = 0; i < 120; i++) {
		try {
			await target.ensureBucket();
			return;
		} catch {
			await sleep(500);
		}
	}
	throw new Error(`${config.name} did not become ready`);
}

async function start(store: Store, scratch: string): Promise<TargetConfig> {
	remove(store);
	const accessKeyId = store === 'garage' ? `GK${hex(12)}` : `yoalw0${hex(6)}`;
	const secretAccessKey = hex(32);
	const bucket = 'yoal-w0-s3';
	let region = 'us-east-1';
	let port: number;
	if (store === 'minio') {
		if (!sh(['docker', 'image', 'ls', '-q', IMAGES.minio]))
			sh(['docker', 'build', '-q', '-t', IMAGES.minio, '-f', join(import.meta.dir, 'stores/minio.Dockerfile'), join(import.meta.dir, 'stores')]);
		sh(['docker', 'run', '-d', '--name', name(store), '-p', '127.0.0.1::9000', '-e', `MINIO_ROOT_USER=${accessKeyId}`, '-e', `MINIO_ROOT_PASSWORD=${secretAccessKey}`, IMAGES.minio, 'server', '/data']);
		port = hostPort(name(store), 9000);
	} else if (store === 'rustfs') {
		sh(['docker', 'run', '-d', '--name', name(store), '-p', '127.0.0.1::9000', '-e', `RUSTFS_ACCESS_KEY=${accessKeyId}`, '-e', `RUSTFS_SECRET_KEY=${secretAccessKey}`, IMAGES.rustfs]);
		port = hostPort(name(store), 9000);
	} else {
		region = 'garage';
		const config = join(scratch, 'garage.toml');
		writeFileSync(
			config,
			[
				'metadata_dir = "/var/lib/garage/meta"',
				'data_dir = "/var/lib/garage/data"',
				'db_engine = "lmdb"',
				'replication_factor = 1',
				'rpc_bind_addr = "[::]:3901"',
				'rpc_public_addr = "127.0.0.1:3901"',
				`rpc_secret = "${hex(32)}"`,
				'[s3_api]',
				`s3_region = "${region}"`,
				'api_bind_addr = "[::]:3900"',
				'root_domain = ".s3.garage.localhost"',
			].join('\n'),
		);
		sh(['docker', 'run', '-d', '--name', name(store), '-p', '127.0.0.1::3900', '-v', `${config}:/etc/garage.toml:ro`, '-v', '/var/lib/garage', IMAGES.garage]);
		port = hostPort(name(store), 3900);
		const garage = (...args: string[]) => sh(['docker', 'exec', name(store), '/garage', ...args]);
		let nodeId = '';
		for (let i = 0; i < 60 && !nodeId; i++) {
			nodeId = sh(['docker', 'exec', name(store), '/garage', 'node', 'id', '-q'], { allowFail: true }).split('@')[0] ?? '';
			if (!nodeId) await sleep(500);
		}
		garage('layout', 'assign', '-z', 'dc1', '-c', '1G', nodeId);
		garage('layout', 'apply', '--version', '1');
		garage('key', 'import', '--yes', '-n', 'yoal-w0', accessKeyId, secretAccessKey);
		garage('bucket', 'create', bucket);
		garage('bucket', 'allow', '--read', '--write', '--owner', bucket, '--key', 'yoal-w0');
	}
	const config: TargetConfig = {
		name: store,
		protocol: 's3',
		endpoint: `http://127.0.0.1:${port}`,
		bucket,
		region,
		accessKeyId,
		secretAccessKey,
		forcePathStyle: true,
		version: digest(store === 'minio' ? IMAGES.minio : IMAGES[store]),
	};
	await ready(config);
	return config;
}

const stores = (process.env.STORES ?? 'minio,garage,rustfs').split(',').map((s) => s.trim()) as Store[];
const scratch = mkdtempSync(join(tmpdir(), 'yoal-w0-s3-'));
const cleanup = () => {
	for (const store of stores) remove(store);
	rmSync(scratch, { recursive: true, force: true });
};
process.on('SIGINT' as never, () => {
	cleanup();
	process.exit(130);
});

const results: (SpikeResult | { target: string; error: string })[] = [];
try {
	for (const store of stores) {
		if (!(store in IMAGES)) throw new Error(`unknown store ${store}`);
		try {
			const config = await start(store, scratch);
			console.error(`[${store}] ${config.version} at ${config.endpoint}`);
			results.push(await runSpike(config));
		} catch (error) {
			console.error(`[${store}] ERROR ${(error as Error).stack}`);
			results.push({ target: store, error: String(error) });
		} finally {
			remove(store);
		}
	}
} finally {
	cleanup();
}
console.log(JSON.stringify(results, null, 2));
for (const result of results)
	console.error(`${result.target}: ${'error' in result ? `ERROR ${result.error}` : result.pass ? 'PASS' : `FAIL (${Object.entries(result.checks).filter(([, c]) => !c.pass).map(([n]) => n).join(', ')})`}`);
