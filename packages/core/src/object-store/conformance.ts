import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { ConditionalStore, ObjectStore } from '../object-store.ts';
import { bodyToAsyncIterable } from '../object-store.ts';
import { probeConditionalWrites } from './probe.ts';

/**
 * One conformance suite every object-store backend passes (HA-PLAN W3, G17; Wave 0 S7's
 * criterion). It is a library, not a test file, so the same cases run three ways:
 *
 * - `bun test` against the in-memory reference store (`conformance.test.ts`), which keeps the suite
 *   itself honest;
 * - `bun test` against each backend with a scripted fake fetch (unit tests per backend);
 * - `bun tests/object-store/conformance.e2e.ts` against MinIO, Azurite and fake-gcs-server, which
 *   prints the numbers the lane's exit criteria ask for (conditional-write p50/p99, winners per
 *   generation under 200 contending writers).
 *
 * Every case uses keys under a fresh random prefix and deletes what it wrote.
 */

export type ConformanceStore = ObjectStore &
	ConditionalStore &
	Required<Pick<ObjectStore, 'list' | 'size' | 'testConnection'>>;

export interface ConformanceOpenOptions {
	/** Key prefix the store owns (`prefix` / `pathPrefix`). */
	prefix?: string;
	/** Replace the backend endpoint, keeping everything else (the timeout cases use this). */
	endpoint?: string;
	timeoutMs?: number;
}

export interface ConformanceSubject {
	/** `minio`, `azurite`, `fake-gcs-server`, `memory`, … */
	name: string;
	open(options?: ConformanceOpenOptions): ConformanceStore;
	/**
	 * Whether presigned GET/PUT URLs can be exercised with a plain `fetch` (the object is reported
	 * as skipped when false). Azure's presigned PUT also needs `x-ms-blob-type`, which no URL can
	 * carry, so a subject can name headers the caller must add.
	 */
	presign?: boolean | { putHeaders?: Record<string, string> };
	/** Whether `putStream` without a size is supported (true for every production backend). */
	unknownSizeStreams?: boolean;
	/**
	 * A store whose bucket or container is configured immutable (object lock, immutability
	 * policy, retention policy), and what `testConnection` must report for it. Omit when the
	 * backend or emulator cannot configure one; the case is then reported as skipped.
	 */
	immutable?: { open(): ConformanceStore; expectObjectLock: boolean };
	/** Whether `open({ endpoint })` can be pointed at an arbitrary HTTP server (false skips the timeout cases). */
	endpointOverride?: boolean;
}

export interface ConformanceOptions {
	/** Contending writers per generation. S7's criterion is 200. */
	writers?: number;
	/** Generations in the contention case (the first is a create, the rest replace). */
	generations?: number;
	/** Bytes in the large-object case. */
	largeObjectBytes?: number;
	/** The timeout used by the timeout cases, in ms. */
	timeoutMs?: number;
	/** Run only the cases whose name contains one of these. */
	only?: string[];
	log?: (line: string) => void;
}

export interface ConformanceCaseResult {
	name: string;
	ok: boolean;
	skipped?: boolean;
	ms: number;
	detail?: string;
}

export interface LatencySummary {
	count: number;
	p50Ms: number;
	p99Ms: number;
	maxMs: number;
}

export interface ConformanceReport {
	subject: string;
	ok: boolean;
	cases: ConformanceCaseResult[];
	metrics: {
		/** Every conditional write the suite made, including the contending ones. */
		conditionalWrites: LatencySummary;
		contention: {
			writers: number;
			generations: number;
			/** Writers that got 200, per generation. Must be all ones. */
			winnersPerGeneration: number[];
			/** Statuses of the losing writes, e.g. `{ "412": 995 }`. */
			loserStatuses: Record<string, number>;
			/**
			 * Throttled answers (429/503) that were retried with the same condition until the store
			 * decided. A throttle decides nothing, so it is neither a win nor a loss.
			 */
			throttledRetries: number;
		} | null;
	};
}

class ConformanceFailure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new ConformanceFailure(message);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<{ bytes: number; sha256: string; data: Uint8Array | null }> {
	const hash = createHash('sha256');
	let bytes = 0;
	const chunks: Uint8Array[] = [];
	for await (const chunk of bodyToAsyncIterable(stream)) {
		hash.update(chunk);
		bytes += chunk.byteLength;
		if (bytes <= 1 << 20) chunks.push(chunk);
	}
	const data = bytes <= 1 << 20 ? Buffer.concat(chunks) : null;
	return { bytes, sha256: hash.digest('hex'), data: data ? new Uint8Array(data) : null };
}

/** Deterministic pseudo-random bytes in chunks, so large uploads never sit in memory at once. */
function* patternChunks(total: number, chunkSize = 1 << 20, seed = 7): Generator<Uint8Array> {
	let state = seed;
	let sent = 0;
	while (sent < total) {
		const size = Math.min(chunkSize, total - sent);
		const chunk = new Uint8Array(size);
		for (let i = 0; i < size; i++) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			chunk[i] = state >>> 16;
		}
		sent += size;
		yield chunk;
	}
}

async function* asyncChunks(total: number): AsyncIterable<Uint8Array> {
	for (const chunk of patternChunks(total)) yield chunk;
}

function sha256Of(total: number): string {
	const hash = createHash('sha256');
	for (const chunk of patternChunks(total)) hash.update(chunk);
	return hash.digest('hex');
}

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index]!;
}

export function summarize(samples: number[]): LatencySummary {
	const sorted = [...samples].sort((a, b) => a - b);
	const round = (value: number) => Math.round(value * 100) / 100;
	return {
		count: sorted.length,
		p50Ms: round(percentile(sorted, 50)),
		p99Ms: round(percentile(sorted, 99)),
		maxMs: round(sorted.at(-1) ?? 0),
	};
}

/**
 * A TCP server for the timeout cases. `hold` accepts and never answers or reads. `stall-body`
 * answers every request with headers and a few body bytes, then stops.
 */
async function blackhole(mode: 'hold' | 'stall-body'): Promise<{ url: string; close(): Promise<void> }> {
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on('error', () => undefined);
		socket.on('close', () => sockets.delete(socket));
		if (mode === 'hold') {
			socket.pause();
			return;
		}
		let answered = false;
		socket.on('data', () => {
			if (answered) return;
			answered = true;
			socket.write(
				'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 1048576\r\nETag: "x"\r\nx-goog-generation: 1\r\n\r\n',
			);
			socket.write(Buffer.alloc(16, 1));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('blackhole server has no port');
	return {
		url: `http://127.0.0.1:${address.port}`,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function expectTimeout(label: string, budgetMs: number, run: () => Promise<unknown>): Promise<string> {
	const started = performance.now();
	let error: unknown = null;
	try {
		await run();
	} catch (caught) {
		error = caught;
	}
	const elapsed = performance.now() - started;
	assert(error !== null, `${label} resolved against a server that never answers`);
	assert(
		error instanceof Error && error.name === 'ObjectStoreTimeoutError',
		`${label} failed with ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)} instead of a timeout`,
	);
	assert(elapsed <= budgetMs, `${label} took ${Math.round(elapsed)} ms, over its ${budgetMs} ms budget`);
	return `${label} ${Math.round(elapsed)} ms`;
}

export async function runObjectStoreConformance(
	subject: ConformanceSubject,
	options: ConformanceOptions = {},
): Promise<ConformanceReport> {
	const writers = options.writers ?? 200;
	const generations = options.generations ?? 5;
	const largeBytes = options.largeObjectBytes ?? 16 * 1024 * 1024;
	const timeoutMs = options.timeoutMs ?? 750;
	const log = options.log ?? (() => undefined);
	const run = `conformance/${randomUUID()}`;
	const store = subject.open({ prefix: run });
	const conditionalLatencies: number[] = [];
	const cases: ConformanceCaseResult[] = [];
	let contention: ConformanceReport['metrics']['contention'] = null;

	const timedWrite: ConditionalStore['writeConditional'] = async (key, body, condition) => {
		const started = performance.now();
		try {
			return await store.writeConditional(key, body, condition);
		} finally {
			conditionalLatencies.push(performance.now() - started);
		}
	};

	async function step(name: string, fn: () => Promise<string | void>, skip?: string): Promise<void> {
		if (options.only && !options.only.some((part) => name.includes(part))) return;
		if (skip) {
			cases.push({ name, ok: true, skipped: true, ms: 0, detail: skip });
			log(`SKIP  ${subject.name}: ${name} (${skip})`);
			return;
		}
		const started = performance.now();
		try {
			const detail = (await fn()) ?? undefined;
			const ms = Math.round(performance.now() - started);
			cases.push({ name, ok: true, ms, ...(detail ? { detail } : {}) });
			log(`PASS  ${subject.name}: ${name} (${ms} ms)${detail ? ` — ${detail}` : ''}`);
		} catch (error) {
			const ms = Math.round(performance.now() - started);
			const detail = error instanceof Error ? error.message : String(error);
			cases.push({ name, ok: false, ms, detail });
			log(`FAIL  ${subject.name}: ${name} (${ms} ms) — ${detail}`);
		}
	}

	await step('put/get/exists/size round trip', async () => {
		const data = new TextEncoder().encode('hello conformance\n');
		await store.put('basic/hello.txt', data, 'text/plain');
		assert(equalBytes(await store.get('basic/hello.txt'), data), 'get returned different bytes');
		assert((await store.exists('basic/hello.txt')) === true, 'exists is false for a stored object');
		assert((await store.size('basic/hello.txt')) === data.byteLength, 'size is wrong');
		await store.put('basic/hello.txt', new TextEncoder().encode('replaced'), 'text/plain');
		assert(new TextDecoder().decode(await store.get('basic/hello.txt')) === 'replaced', 'an unconditional put did not replace the object');
		await store.put('basic/empty.bin', new Uint8Array(0));
		assert((await store.get('basic/empty.bin')).byteLength === 0, 'an empty object did not round-trip');
		assert((await store.size('basic/empty.bin')) === 0, 'an empty object has a non-zero size');
	});

	await step('missing objects', async () => {
		assert((await store.exists('missing/none.bin')) === false, 'exists is true for a missing object');
		assert((await store.size('missing/none.bin')) === null, 'size is not null for a missing object');
		let threw = false;
		try {
			await store.get('missing/none.bin');
		} catch {
			threw = true;
		}
		assert(threw, 'get of a missing object did not throw');
		threw = false;
		try {
			await store.getStream('missing/none.bin');
		} catch {
			threw = true;
		}
		assert(threw, 'getStream of a missing object did not throw');
		const read = await store.readVersioned('missing/none.bin');
		assert(read.status === 404 && read.etag === null && read.body === null, `readVersioned of a missing object answered ${read.status}`);
		await store.delete('missing/none.bin');
	});

	await step('keys with spaces, unicode and reserved characters', async () => {
		const keys = ['odd/space name.txt', 'odd/ünïcødé-ключ.txt', 'odd/plus+percent%25&amp=x;y,z.txt', 'odd/a#b?c.txt'];
		for (const [index, key] of keys.entries()) await store.put(key, new TextEncoder().encode(String(index)));
		for (const [index, key] of keys.entries())
			assert(new TextDecoder().decode(await store.get(key)) === String(index), `${key} did not round-trip`);
		const listed = new Set<string>();
		for await (const object of store.list('odd/')) listed.add(object.key);
		for (const key of keys) assert(listed.has(key), `list did not return ${key} (got ${[...listed].join(', ')})`);
	});

	await step('stream with a known size', async () => {
		const total = 3 * 1024 * 1024 + 17;
		await store.putStream('stream/known.bin', asyncChunks(total), 'application/octet-stream', total);
		const read = await store.getStream('stream/known.bin');
		assert(read.size === total, `getStream reported size ${read.size}, expected ${total}`);
		const back = await readAll(read.body);
		assert(back.bytes === total && back.sha256 === sha256Of(total), 'the streamed object came back different');
	});

	await step(
		'stream without a size',
		async () => {
			const total = 2 * 1024 * 1024 + 5;
			await store.putStream('stream/unknown.bin', asyncChunks(total), 'application/octet-stream');
			const back = await readAll((await store.getStream('stream/unknown.bin')).body);
			assert(back.bytes === total && back.sha256 === sha256Of(total), 'the streamed object came back different');
		},
		subject.unknownSizeStreams === false ? 'the backend needs a size for streamed uploads' : undefined,
	);

	await step(`large object (${Math.round(largeBytes / 1024 / 1024)} MiB, streamed both ways)`, async () => {
		const started = performance.now();
		await store.putStream('large/object.bin', asyncChunks(largeBytes), 'application/octet-stream', largeBytes);
		const putMs = performance.now() - started;
		assert((await store.size('large/object.bin')) === largeBytes, 'the large object has the wrong size');
		const read = await store.getStream('large/object.bin');
		const back = await readAll(read.body);
		assert(back.bytes === largeBytes, `read ${back.bytes} bytes, expected ${largeBytes}`);
		assert(back.sha256 === sha256Of(largeBytes), 'the large object came back different');
		await store.delete('large/object.bin');
		return `put ${Math.round(putMs)} ms`;
	});

	await step('list: prefixes, sizes and pagination', async () => {
		const keys = ['list/a/1.txt', 'list/a/2.txt', 'list/a/b/3.txt', 'list/b/1.txt'];
		for (const key of keys) await store.put(key, new TextEncoder().encode(key));
		const under = new Map<string, number>();
		for await (const object of store.list('list/a/')) under.set(object.key, object.size);
		assert(
			JSON.stringify([...under.keys()].sort()) === JSON.stringify(['list/a/1.txt', 'list/a/2.txt', 'list/a/b/3.txt']),
			`list('list/a/') returned ${[...under.keys()].join(', ')}`,
		);
		assert(under.get('list/a/b/3.txt') === 'list/a/b/3.txt'.length, 'list reported the wrong size');
		for await (const object of store.list('list/')) assert(Number.isFinite(object.lastModified) && object.lastModified > 0, 'list returned no lastModified');
		// More than one page on every backend (S3 and Azure page at 1000 by default; GCS too).
		const many = 1_005;
		const batch = 50;
		for (let i = 0; i < many; i += batch)
			await Promise.all(
				Array.from({ length: Math.min(batch, many - i) }, (_unused, j) => store.put(`page/${String(i + j).padStart(5, '0')}`, new Uint8Array([1]))),
			);
		let count = 0;
		for await (const _object of store.list('page/')) count++;
		assert(count === many, `listed ${count} objects across pages, expected ${many}`);
	});

	await step('delete', async () => {
		await store.put('delete/me.txt', new TextEncoder().encode('x'));
		await store.delete('delete/me.txt');
		assert((await store.exists('delete/me.txt')) === false, 'the object still exists after delete');
		await store.delete('delete/me.txt');
	});

	await step('prefix scoping', async () => {
		const inner = subject.open({ prefix: `${run}/scoped` });
		await inner.put('k.txt', new TextEncoder().encode('scoped'));
		assert(new TextDecoder().decode(await store.get('scoped/k.txt')) === 'scoped', 'a prefixed store wrote outside its prefix');
		const listed: string[] = [];
		for await (const object of inner.list('')) listed.push(object.key);
		assert(JSON.stringify(listed) === JSON.stringify(['k.txt']), `a prefixed store listed ${listed.join(', ')}`);
	});

	await step(
		'presigned GET and PUT',
		async () => {
			const put = await store.presignPut('presign/up.txt', 300, 'text/plain');
			const putHeaders = typeof subject.presign === 'object' ? (subject.presign.putHeaders ?? {}) : {};
			const uploaded = await fetch(put, {
				method: 'PUT',
				body: 'via presigned put',
				headers: { 'content-type': 'text/plain', ...putHeaders },
			});
			assert(uploaded.ok, `presigned PUT answered ${uploaded.status}: ${(await uploaded.text()).slice(0, 200)}`);
			const get = await store.presignGet('presign/up.txt', 300);
			const downloaded = await fetch(get);
			assert(downloaded.ok, `presigned GET answered ${downloaded.status}`);
			assert((await downloaded.text()) === 'via presigned put', 'presigned GET returned different bytes');
		},
		subject.presign === false ? 'the emulator does not serve presigned URLs' : undefined,
	);

	await step('conditional create: exactly one create wins', async () => {
		const first = await timedWrite('cas/create.json', '{"n":1}', { ifNoneMatch: '*' });
		assert(first.status === 200 && first.etag, `the first create answered ${first.status} with version ${first.etag}`);
		const second = await timedWrite('cas/create.json', '{"n":2}', { ifNoneMatch: '*' });
		assert(second.status === 412 || second.status === 409, `a second create answered ${second.status}`);
		const read = await store.readVersioned('cas/create.json');
		assert(read.status === 200 && read.body === '{"n":1}', 'the losing create changed the object');
		assert(read.etag === first.etag, `the read version ${read.etag} is not the created version ${first.etag}`);
		assert(read.serverDate !== null, 'the store sent no Date header; the lease needs the store clock');
	});

	await step('conditional replace: current version wins, stale version loses', async () => {
		const created = await timedWrite('cas/replace.json', '{"n":1}', { ifNoneMatch: '*' });
		assert(created.status === 200 && created.etag, `create answered ${created.status}`);
		const replaced = await timedWrite('cas/replace.json', '{"n":2}', { ifMatch: created.etag });
		assert(replaced.status === 200 && replaced.etag && replaced.etag !== created.etag, `replace answered ${replaced.status}`);
		const stale = await timedWrite('cas/replace.json', '{"n":3}', { ifMatch: created.etag });
		assert(stale.status === 412 || stale.status === 409, `a stale replace answered ${stale.status}`);
		const missing = await timedWrite('cas/never-created.json', '{"n":1}', { ifMatch: created.etag });
		assert(missing.status === 412 || missing.status === 409 || missing.status === 404, `a replace of a missing object answered ${missing.status}`);
		const read = await store.readVersioned('cas/replace.json');
		assert(read.body === '{"n":2}' && read.etag === replaced.etag, 'the read is not the winning replace');
		const unconditional = await store.readVersioned('cas/replace.json');
		assert(unconditional.etag === read.etag, 'two reads of an unchanged object returned different versions');
	});

	await step('active conditional-write probe', async () => {
		const result = await probeConditionalWrites(store);
		assert(result.support === 'supported', `probe reported ${result.support}: ${result.detail}`);
	});

	await step(`contention: ${writers} writers, ${generations} generations, one winner each`, async () => {
		const key = 'cas/contention.json';
		const winnersPerGeneration: number[] = [];
		const loserStatuses: Record<string, number> = {};
		let throttledRetries = 0;
		let version: string | null = null;
		for (let generation = 0; generation < generations; generation++) {
			const condition = generation === 0 ? ({ ifNoneMatch: '*' } as const) : { ifMatch: version! };
			const attempt = async (writer: number) => {
				for (let tries = 0; ; tries++) {
					const write = await timedWrite(key, JSON.stringify({ generation, writer }), condition);
					if ((write.status !== 429 && write.status !== 503) || tries >= 30) return write;
					throttledRetries++;
					await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 180));
				}
			};
			const results = await Promise.all(
				Array.from({ length: writers }, (_unused, writer) =>
					attempt(writer).then(
						(write) => ({ writer, write, error: null as string | null }),
						(error: unknown) => ({ writer, write: null, error: error instanceof Error ? error.message : String(error) }),
					),
				),
			);
			const errors = results.filter((result) => result.error !== null);
			assert(errors.length === 0, `generation ${generation}: ${errors.length} writes threw (${errors[0]?.error})`);
			const winners = results.filter((result) => result.write!.status === 200);
			for (const result of results)
				if (result.write!.status !== 200) loserStatuses[result.write!.status] = (loserStatuses[result.write!.status] ?? 0) + 1;
			winnersPerGeneration.push(winners.length);
			const odd = results.filter((result) => ![200, 409, 412].includes(result.write!.status));
			assert(odd.length === 0, `generation ${generation}: unexpected statuses ${odd.map((result) => result.write!.status).join(', ')}`);
			assert(winners.length === 1, `generation ${generation}: ${winners.length} writers won`);
			const read = await store.readVersioned(key);
			const body = JSON.parse(read.body ?? '{}') as { generation?: number; writer?: number };
			assert(
				body.generation === generation && body.writer === winners[0]!.writer,
				`generation ${generation}: the stored body is not the winner's`,
			);
			assert(read.etag === winners[0]!.write!.etag, `generation ${generation}: the stored version is not the winner's`);
			version = read.etag;
		}
		contention = { writers, generations, winnersPerGeneration, loserStatuses, throttledRetries };
		return `winners ${winnersPerGeneration.join('/')}, losers ${JSON.stringify(loserStatuses)}, throttled retries ${throttledRetries}`;
	});

	await step('connection check (testConnection)', async () => {
		const result = await store.testConnection();
		assert(result.ok, `testConnection failed: ${result.error}`);
		assert(result.checks.head && result.checks.put && result.checks.list && result.checks.delete, `checks ${JSON.stringify(result.checks)}`);
		assert(result.conditionalWrites === 'supported', `testConnection reported conditional writes ${result.conditionalWrites}: ${result.conditionalDetail}`);
		return `${result.latencyMs} ms`;
	});

	await step(
		'immutability is reported',
		async () => {
			const immutable = subject.immutable!;
			const result = await immutable.open().testConnection();
			assert(result.ok, `testConnection on the immutable target failed: ${result.error}`);
			assert(result.objectLock === immutable.expectObjectLock, `objectLock reported ${result.objectLock}, expected ${immutable.expectObjectLock}`);
		},
		subject.immutable ? undefined : 'the emulator cannot configure an immutable container or bucket',
	);

	const budget = timeoutMs * 3 + 1_000;
	await step(
		`timeouts: a store that never answers (${timeoutMs} ms)`,
		async () => {
			const hole = await blackhole('hold');
			try {
				const dead = subject.open({ endpoint: hole.url, timeoutMs, prefix: run });
				const lines = [
					await expectTimeout('get', budget, () => dead.get('k')),
					await expectTimeout('exists', budget, () => dead.exists('k')),
					await expectTimeout('size', budget, () => dead.size('k')),
					await expectTimeout('delete', budget, () => dead.delete('k')),
					await expectTimeout('put', budget, () => dead.put('k', new Uint8Array([1]))),
					await expectTimeout('readVersioned', budget, () => dead.readVersioned('k')),
					await expectTimeout('writeConditional', budget, () => dead.writeConditional('k', '{}', { ifNoneMatch: '*' })),
					await expectTimeout('list', budget, async () => {
						for await (const _object of dead.list('')) break;
					}),
					await expectTimeout('getStream', budget, () => dead.getStream('k')),
				];
				return lines.join(', ');
			} finally {
				await hole.close();
			}
		},
		subject.endpointOverride === false ? 'the subject cannot be pointed at another endpoint' : undefined,
	);

	await step(
		'timeouts: a body that stalls mid-stream',
		async () => {
			const hole = await blackhole('stall-body');
			try {
				const dead = subject.open({ endpoint: hole.url, timeoutMs, prefix: run });
				return await expectTimeout('getStream body', budget, async () => {
					const stream = await dead.getStream('k');
					await readAll(stream.body);
				});
			} finally {
				await hole.close();
			}
		},
		subject.endpointOverride === false ? 'the subject cannot be pointed at another endpoint' : undefined,
	);

	await step(
		'timeouts: an upload the store stops reading',
		async () => {
			const hole = await blackhole('hold');
			try {
				const dead = subject.open({ endpoint: hole.url, timeoutMs, prefix: run });
				const total = 64 * 1024 * 1024;
				return await expectTimeout('putStream', budget + timeoutMs * 4, () =>
					dead.putStream('k', asyncChunks(total), 'application/octet-stream', total),
				);
			} finally {
				await hole.close();
			}
		},
		subject.endpointOverride === false ? 'the subject cannot be pointed at another endpoint' : undefined,
	);

	// Clean up everything the run wrote.
	try {
		const keys: string[] = [];
		for await (const object of store.list('')) keys.push(object.key);
		for (let i = 0; i < keys.length; i += 50) await Promise.all(keys.slice(i, i + 50).map((key) => store.delete(key)));
	} catch (error) {
		log(`WARN  ${subject.name}: cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	return {
		subject: subject.name,
		ok: cases.every((result) => result.ok),
		cases,
		metrics: { conditionalWrites: summarize(conditionalLatencies), contention },
	};
}
