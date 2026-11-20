/**
 * W3 managed-data e2e: a real `pg_dump -Fc` artifact goes through every object-store backend and
 * restores into Postgres (HA-PLAN §4 W3 exit criterion; Wave 1 lane E).
 *
 *   bun tests/object-store/managed-data.e2e.ts [minio] [azurite] [gcs] [--keep]
 *
 * Starts the pinned emulators (`emulators.ts`) and one disposable Postgres 17 container, seeds a
 * deterministic fixture, dumps it, streams the dump into each backend with `putStream`, streams it
 * back with `getStream` (sha256 compared), then `pg_restore`s those bytes into the same server and
 * checks the row checksum. No cloud credentials and no cloud spend; everything runs on 127.0.0.1.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConformanceSubject } from '../../packages/core/src/object-store/conformance.ts';
import { bodyToAsyncIterable } from '../../packages/core/src/object-store.ts';
import { ContainerRuntime, detectEngine, freePort, waitFor, type Engine } from '../e2e/lib/containers.ts';
import { readEmulatorState, startEmulators, stopEmulators, type EmulatorName } from './emulators.ts';
import { azuriteSubject } from './subjects/azurite.ts';
import { gcsSubject } from './subjects/gcs.ts';
import { minioSubject } from './subjects/minio.ts';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const all: EmulatorName[] = ['minio', 'azurite', 'gcs'];
const picked = all.filter((name) => args.includes(name));
const names = picked.length ? picked : all;

const POSTGRES_IMAGE = 'postgres:17-alpine';
const PG_USER = 'yoal';
const PG_PASSWORD = 'yoal-object-store-e2e';
const PG_DATABASE = 'yoal_managed';
const FIXTURE_SQL = `
	CREATE TABLE widgets (
		id integer PRIMARY KEY,
		name text NOT NULL,
		payload text NOT NULL
	);
	INSERT INTO widgets (id, name, payload)
		SELECT g, 'widget-' || g, repeat('x', 256) FROM generate_series(1, 250) AS g;
`;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function subjectFor(name: EmulatorName, endpoint: string): Promise<ConformanceSubject> {
	if (name === 'minio') return minioSubject(endpoint);
	if (name === 'azurite') return azuriteSubject(endpoint);
	return gcsSubject(endpoint);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of bodyToAsyncIterable(stream)) {
		chunks.push(chunk);
		total += chunk.byteLength;
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function main(): Promise<void> {
	let engine: Engine | null;
	try {
		engine = await detectEngine();
	} catch (error) {
		console.log(`SKIP  no container engine: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!engine) {
		console.log('SKIP  no container engine (podman/docker); nothing was proven.');
		return;
	}

	const tempDir = await mkdtemp(join(tmpdir(), 'yoal-w3-managed-'));
	const runtime = new ContainerRuntime(engine, tempDir);
	let postgres = '';
	const startedEmulators: EmulatorName[] = [];
	try {
		const network = `yoal-w3-managed-${process.pid}`;
		await runtime.createNetwork(network);
		const pgPort = await freePort();
		postgres = `yoal-w3-pg-${process.pid}`;
		await runtime.runContainer({
			name: postgres,
			image: POSTGRES_IMAGE,
			network,
			ports: [[pgPort, 5432]],
			env: { POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DATABASE },
		});

		await waitFor('Postgres TCP SELECT 1', async () => {
			const result = await runtime.exec(['exec', '-e', `PGPASSWORD=${PG_PASSWORD}`, postgres, 'psql', '-tAc', 'SELECT 1', '-U', PG_USER, '-d', PG_DATABASE], { check: false });
			return result.code === 0 && result.stdout.trim() === '1';
		});
		check('Postgres 17 starts', true);

		const seeded = await runtime.exec(['exec', '-e', `PGPASSWORD=${PG_PASSWORD}`, postgres, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', PG_USER, '-d', PG_DATABASE, '-c', FIXTURE_SQL]);
		assert(seeded.code === 0, `fixture SQL failed: ${seeded.stderr}`);
		const expected = (
			await runtime.exec([
				'exec', '-e', `PGPASSWORD=${PG_PASSWORD}`, postgres, 'psql', '-tAc',
				"SELECT count(*)::text || ':' || sum(id)::text || ':' || md5(string_agg(name || ':' || payload, '|' ORDER BY id)) FROM widgets",
				'-U', PG_USER, '-d', PG_DATABASE,
			])
		).stdout.trim();
		check('deterministic fixture seeded', expected.startsWith('250:31375:'), expected);

		// `pg_dump -Fc` onto stdout; the harness pipes the exact bytes the platform would upload.
		const dumpResult = await runtime.execBytes([
			'exec', '-e', `PGPASSWORD=${PG_PASSWORD}`, postgres, 'pg_dump', '-Fc', '--no-owner', '-U', PG_USER, PG_DATABASE,
		]);
		const dumpSha = sha256(dumpResult);
		check('pg_dump -Fc produced an artifact', dumpResult.byteLength > 2_000, `${dumpResult.byteLength} bytes, sha256 ${dumpSha.slice(0, 16)}…`);

		const existing = readEmulatorState();
		const toStart = names.filter((name) => !existing[name]);
		const endpoints = toStart.length ? await startEmulators(toStart) : existing;
		startedEmulators.push(...toStart);

		for (const name of names) {
			const subject = await subjectFor(name, endpoints[name]!);
			const store = subject.open({ prefix: 'managed-data' });
			const key = `dumps/${dumpSha}.dump`;
			try {
				const started = performance.now();
				await store.putStream(
					key,
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(dumpResult);
							controller.close();
						},
					}),
					'application/octet-stream',
					dumpResult.byteLength,
				);
				const uploadMs = Math.round(performance.now() - started);
				const streamed = await store.getStream(key);
				const downloaded = await readAll(streamed.body);
				assert(sha256(downloaded) === dumpSha, `${name}: the download differs from the dump`);
				assert(downloaded.byteLength === dumpResult.byteLength, `${name}: size changed`);
				check(`${subject.name}: dump uploaded and downloaded intact`, true, `${uploadMs} ms, ${downloaded.byteLength} bytes`);

				const database = `restore_${name.replace(/[^a-z]/g, '')}`;
				await runtime.exec(['exec', '-e', `PGPASSWORD=${PG_PASSWORD}`, postgres, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', PG_USER, '-d', PG_DATABASE, '-c', `DROP DATABASE IF EXISTS ${database}`]);
				await runtime.exec(['exec', '-e', `PGPASSWORD=${PG_PASSWORD}`, postgres, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', PG_USER, '-d', PG_DATABASE, '-c', `CREATE DATABASE ${database}`]);
				const restored = await runtime.exec(
					['exec', '-i', '-e', `PGPASSWORD=${PG_PASSWORD}`, postgres, 'pg_restore', '--no-owner', '--exit-on-error', '-U', PG_USER, '-d', database],
					{ stdin: downloaded },
				);
				assert(restored.code === 0, `${name}: pg_restore failed: ${restored.stderr}`);
				const actual = (
					await runtime.exec([
						'exec', '-e', `PGPASSWORD=${PG_PASSWORD}`, postgres, 'psql', '-tAc',
						"SELECT count(*)::text || ':' || sum(id)::text || ':' || md5(string_agg(name || ':' || payload, '|' ORDER BY id)) FROM widgets",
						'-U', PG_USER, '-d', database,
					])
				).stdout.trim();
				assert(actual === expected, `${name}: restored data differs (${actual} !== ${expected})`);
				check(`${subject.name}: pg_restore from the store reproduces the data`, true);
				await store.delete(key);
			} catch (error) {
				check(`${subject.name}: managed-data round trip`, false, error instanceof Error ? error.message : String(error));
			}
		}
	} finally {
		if (startedEmulators.length && !keep) await stopEmulators(startedEmulators);
		await runtime.cleanup();
		await rm(tempDir, { recursive: true, force: true });
	}
}

await main();
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${names.join(', ')} managed-data e2e`);
process.exit(failures === 0 ? 0 : 1);
