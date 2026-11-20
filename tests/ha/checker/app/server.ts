#!/usr/bin/env bun
/**
 * The checker app (HA-PLAN §4 W1): a tiny HTTP app the lab deploys on Yoal as a process or container
 * app with a Postgres database attached. No dependencies beyond Bun.
 *
 *   POST /w?n=<int>&writer=<id>[&v=<payload>]  insert row n in one transaction; 200 only after commit
 *   GET  /r?n=<int>[&writer=<id>]              the row as JSON, or 404
 *   GET  /healthz[?db=1]                       200 while the process runs (with db=1, also SELECT 1)
 *   GET  /singleton?job=<id>&run=<id>          record a singleton run start (I4; job "release:<id>" for I16)
 *   GET  /singletons[?job=<id>]                every recorded start (additive; the checker reads it at the end)
 *   GET  /whoami                               node and copy id from env
 *
 * Env: PORT (8080), DATABASE_URL (postgres://…), or CHECKER_STORE=memory for tests. The node id is
 * CHECKER_NODE, else YOAL_NODE_ID, else the hostname; the copy id is CHECKER_COPY, else
 * <hostname>:<port>:<pid> (Yoal injects no copy id into a workload today). Every response carries
 * x-checker-node and x-checker-copy so the checker can tell which copy answered.
 */
import { hostname } from 'node:os';

interface Row {
	writer: string;
	n: number;
	v: string;
	node: string;
	copy: string;
	at: string;
}

interface Run {
	job: string;
	run: string;
	node: string;
	copy: string;
	at: number;
}

export interface Store {
	init(): Promise<void>;
	/** Insert, or confirm an identical existing row. 'conflict' when n exists with another payload. */
	write(row: Omit<Row, 'at'>): Promise<'ok' | 'conflict'>;
	read(n: number, writer: string | null): Promise<Row | null>;
	recordRun(run: Omit<Run, 'at'>): Promise<number>;
	runs(job: string | null): Promise<Run[]>;
	ping(): Promise<void>;
	close(): Promise<void>;
}

export function memoryStore(): Store {
	const rows = new Map<string, Row>();
	const runs: Run[] = [];
	return {
		async init() {},
		async write(row) {
			const key = `${row.writer}/${row.n}`;
			const existing = rows.get(key);
			if (existing) return existing.v === row.v ? 'ok' : 'conflict';
			rows.set(key, { ...row, at: new Date().toISOString() });
			return 'ok';
		},
		async read(n, writer) {
			if (writer !== null) return rows.get(`${writer}/${n}`) ?? null;
			for (const row of rows.values()) if (row.n === n) return row;
			return null;
		},
		async recordRun(run) {
			runs.push({ ...run, at: Date.now() });
			return runs.filter((r) => r.job === run.job && r.run === run.run).length;
		},
		async runs(job) {
			return runs.filter((r) => job === null || r.job === job);
		},
		async ping() {},
		async close() {},
	};
}

export function postgresStore(url: string): Store {
	const sql = new Bun.SQL(url, { max: 10, idleTimeout: 30, connectionTimeout: 5 });
	return {
		async init() {
			await sql`CREATE TABLE IF NOT EXISTS checker_rows (
				writer text NOT NULL, n bigint NOT NULL, v text NOT NULL, node text NOT NULL, copy text NOT NULL,
				at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (writer, n))`;
			await sql`CREATE TABLE IF NOT EXISTS checker_singletons (
				id bigserial PRIMARY KEY, job text NOT NULL, run text NOT NULL, node text NOT NULL, copy text NOT NULL,
				at timestamptz NOT NULL DEFAULT now())`;
		},
		async write(row) {
			return sql.begin(async (tx) => {
				const inserted = await tx`INSERT INTO checker_rows (writer, n, v, node, copy)
					VALUES (${row.writer}, ${row.n}, ${row.v}, ${row.node}, ${row.copy})
					ON CONFLICT (writer, n) DO NOTHING RETURNING n`;
				if (inserted.length > 0) return 'ok' as const;
				const [existing] = await tx`SELECT v FROM checker_rows WHERE writer = ${row.writer} AND n = ${row.n}`;
				return existing?.v === row.v ? ('ok' as const) : ('conflict' as const);
			});
		},
		async read(n, writer) {
			const rows =
				writer === null
					? await sql`SELECT writer, n, v, node, copy, at FROM checker_rows WHERE n = ${n} ORDER BY at LIMIT 1`
					: await sql`SELECT writer, n, v, node, copy, at FROM checker_rows WHERE writer = ${writer} AND n = ${n}`;
			const row = rows[0];
			return row ? { ...row, n: Number(row.n), at: new Date(row.at).toISOString() } : null;
		},
		async recordRun(run) {
			return sql.begin(async (tx) => {
				await tx`INSERT INTO checker_singletons (job, run, node, copy) VALUES (${run.job}, ${run.run}, ${run.node}, ${run.copy})`;
				const [count] = await tx`SELECT count(*)::int AS c FROM checker_singletons WHERE job = ${run.job} AND run = ${run.run}`;
				return Number(count?.c ?? 1);
			});
		},
		async runs(job) {
			const rows =
				job === null
					? await sql`SELECT job, run, node, copy, at FROM checker_singletons ORDER BY id`
					: await sql`SELECT job, run, node, copy, at FROM checker_singletons WHERE job = ${job} ORDER BY id`;
			return rows.map((r: Run & { at: Date }) => ({ ...r, at: new Date(r.at).getTime() }));
		},
		async ping() {
			await sql`SELECT 1`;
		},
		async close() {
			await sql.close();
		},
	};
}

const INT = /^-?\d{1,15}$/;
const ID = /^[A-Za-z0-9._:@/-]{1,200}$/;

export function createHandler(store: Store, identity: { node: string; copy: string }) {
	const headers = { 'x-checker-node': identity.node, 'x-checker-copy': identity.copy };
	const json = (status: number, body: unknown) => Response.json(body, { status, headers });
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const q = url.searchParams;
		try {
			if (url.pathname === '/healthz') {
				if (q.get('db') === '1') await store.ping();
				return new Response('ok\n', { headers });
			}
			if (url.pathname === '/whoami') return json(200, { ...identity, pid: process.pid });
			if (url.pathname === '/w') {
				if (request.method !== 'POST') return json(405, { error: 'POST only' });
				const n = q.get('n') ?? '';
				const writer = q.get('writer') ?? '';
				if (!INT.test(n) || !ID.test(writer)) return json(400, { error: 'n must be an integer and writer an id' });
				const v = q.get('v') ?? '';
				if (v.length > 200) return json(400, { error: 'v too long' });
				const outcome = await store.write({ writer, n: Number(n), v, ...identity });
				if (outcome === 'conflict') return json(409, { error: `row ${n} exists with other content` });
				return json(200, { n: Number(n), writer, ...identity });
			}
			if (url.pathname === '/r') {
				const n = q.get('n') ?? '';
				const writer = q.get('writer');
				if (!INT.test(n) || (writer !== null && !ID.test(writer))) return json(400, { error: 'bad n or writer' });
				const row = await store.read(Number(n), writer);
				return row ? json(200, row) : json(404, { error: 'no such row' });
			}
			if (url.pathname === '/singleton') {
				const job = q.get('job') ?? '';
				const run = q.get('run') ?? '';
				if (!ID.test(job) || !ID.test(run)) return json(400, { error: 'job and run are required ids' });
				const starts = await store.recordRun({ job, run, ...identity });
				return json(200, { job, run, starts, ...identity });
			}
			if (url.pathname === '/singletons') {
				const job = q.get('job');
				return json(200, { runs: await store.runs(job) });
			}
			return json(404, { error: 'not found' });
		} catch (error) {
			return json(503, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}

if (import.meta.main) {
	const port = Number(process.env.PORT ?? 8080);
	const store =
		process.env.CHECKER_STORE === 'memory'
			? memoryStore()
			: process.env.DATABASE_URL
				? postgresStore(process.env.DATABASE_URL)
				: (() => {
						console.error('checker-app: set DATABASE_URL (or CHECKER_STORE=memory for tests)');
						process.exit(2);
					})();
	for (let attempt = 1; ; attempt++) {
		try {
			await store.init();
			break;
		} catch (error) {
			if (attempt >= 30) throw error;
			console.error(`checker-app: database not ready (${error instanceof Error ? error.message : error}); retrying`);
			await Bun.sleep(1_000);
		}
	}
	const identity = {
		node: process.env.CHECKER_NODE ?? process.env.YOAL_NODE_ID ?? hostname(),
		copy: process.env.CHECKER_COPY ?? `${hostname()}:${port}:${process.pid}`,
	};
	const server = Bun.serve({ port, hostname: process.env.HOST ?? '0.0.0.0', fetch: createHandler(store, identity) });
	console.error(`checker-app: listening on ${server.hostname}:${server.port} as ${identity.node}/${identity.copy}`);
	const stop = async () => {
		server.stop();
		await store.close();
		process.exit(0);
	};
	const signals = process as unknown as { on(event: string, listener: () => void): void };
	signals.on('SIGTERM', stop);
	signals.on('SIGINT', stop);
}
