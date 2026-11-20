/**
 * S10 load client: a minimal Postgres wire client (trust auth) so every failure is classified
 * exactly (reset, refused, timeout, early EOF, server error). Runs inside the workload container.
 *
 *   bun load.ts probe <host:port>
 *   bun load.ts short <name=host:port,...> <count> <concurrency>
 *   bun load.ts latency <name=host:port,...> <iterations>
 *   bun load.ts soak <name=host:port,...> <minutes> <idlePerTarget> <shortPerSecond> <out.jsonl>
 */
import { connect, type Socket } from 'node:net';

type Outcome = 'ok' | 'reset' | 'refused' | 'timeout' | 'eof' | 'pgerror' | 'other';

function classify(error: unknown): Outcome {
	const code = (error as { code?: string })?.code ?? '';
	if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
	if (code === 'ECONNREFUSED') return 'refused';
	if (code === 'ETIMEDOUT' || code === 'TIMEOUT') return 'timeout';
	if (code === 'EOF') return 'eof';
	if (code === 'PGERROR') return 'pgerror';
	return 'other';
}

function fail(code: string, message = code): Error {
	return Object.assign(new Error(message), { code });
}

/** One Postgres session: startup, `SELECT 1` on demand, terminate. */
class Pg {
	private socket!: Socket;
	private buffer: Buffer = Buffer.alloc(0);
	private waiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
	private dead: Error | null = null;

	static async open(host: string, port: number, timeoutMs = 5_000): Promise<Pg> {
		const pg = new Pg();
		await pg.start(host, port, timeoutMs);
		return pg;
	}

	private start(host: string, port: number, timeoutMs: number): Promise<void> {
		const ready = this.until(timeoutMs);
		this.socket = connect({ host, port });
		this.socket.setNoDelay(true);
		this.socket.on('connect', () => {
			const params = Buffer.from('user\0postgres\0database\0postgres\0\0');
			const head = Buffer.alloc(8);
			head.writeInt32BE(8 + params.length, 0);
			head.writeInt32BE(196_608, 4);
			this.socket.write(Buffer.concat([head, params]));
		});
		this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
		this.socket.on('error', (error) => this.die(error));
		this.socket.on('close', () => this.die(fail('EOF', 'connection closed')));
		return ready;
	}

	private until(timeoutMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiter = null;
				reject(fail('TIMEOUT'));
				this.socket?.destroy();
			}, timeoutMs);
			this.waiter = {
				resolve: () => (clearTimeout(timer), resolve()),
				reject: (e) => (clearTimeout(timer), reject(e)),
			};
			if (this.dead) this.waiter.reject(this.dead);
		});
	}

	private die(error: Error): void {
		if (!this.dead) this.dead = error;
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.reject(this.dead);
	}

	private onData(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 5) {
			const type = String.fromCharCode(this.buffer[0]!);
			const length = this.buffer.readInt32BE(1);
			if (this.buffer.length < 1 + length) return;
			this.buffer = this.buffer.subarray(1 + length);
			if (type === 'E') this.die(fail('PGERROR', 'server error'));
			else if (type === 'Z') {
				const waiter = this.waiter;
				this.waiter = null;
				waiter?.resolve();
			}
		}
	}

	query(timeoutMs = 5_000): Promise<void> {
		if (this.dead) return Promise.reject(this.dead);
		const done = this.until(timeoutMs);
		const sql = Buffer.from('SELECT 1\0');
		const head = Buffer.alloc(5);
		head.write('Q', 0);
		head.writeInt32BE(4 + sql.length, 1);
		this.socket.write(Buffer.concat([head, sql]));
		return done;
	}

	get alive(): boolean {
		return this.dead === null;
	}

	close(): void {
		if (!this.dead) {
			this.dead = fail('CLOSED');
			const bye = Buffer.alloc(5);
			bye.write('X', 0);
			bye.writeInt32BE(4, 1);
			this.socket.end(bye);
		}
	}
}

function parseTarget(spec: string): { host: string; port: number } {
	const at = spec.lastIndexOf(':');
	return { host: spec.slice(0, at), port: Number(spec.slice(at + 1)) };
}

function parseTargets(spec: string): Array<{ name: string; host: string; port: number }> {
	return spec.split(',').map((item) => {
		const [name, address] = item.split('=') as [string, string];
		return { name, ...parseTarget(address) };
	});
}

async function shortConnection(host: string, port: number): Promise<{ outcome: Outcome; ms: number }> {
	const started = performance.now();
	let pg: Pg | null = null;
	try {
		pg = await Pg.open(host, port);
		await pg.query();
		pg.close();
		return { outcome: 'ok', ms: performance.now() - started };
	} catch (error) {
		pg?.close();
		return { outcome: classify(error), ms: performance.now() - started };
	}
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function summary(values: number[]): Record<string, number> {
	const sorted = [...values].sort((a, b) => a - b);
	const round = (v: number) => Math.round(v * 1000) / 1000;
	return {
		n: sorted.length,
		p50: round(percentile(sorted, 50)),
		p90: round(percentile(sorted, 90)),
		p99: round(percentile(sorted, 99)),
		max: round(sorted.at(-1) ?? Number.NaN),
	};
}

function tally(): Record<Outcome, number> {
	return { ok: 0, reset: 0, refused: 0, timeout: 0, eof: 0, pgerror: 0, other: 0 };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === 'probe') {
		const { host, port } = parseTarget(args[0]!);
		let pg: Pg | null = null;
		try {
			pg = await Pg.open(host, port, 3_000);
			await pg.query(3_000);
			console.log('ok');
		} catch (error) {
			console.log(classify(error));
		} finally {
			pg?.close();
		}
		process.exit(0);
	}

	if (command === 'short') {
		const targets = parseTargets(args[0]!);
		const count = Number(args[1] ?? 100_000);
		const concurrency = Number(args[2] ?? 32);
		for (const target of targets) {
			const counts = tally();
			const times: number[] = [];
			let next = 0;
			const started = performance.now();
			await Promise.all(
				Array.from({ length: concurrency }, async () => {
					while (next < count) {
						next += 1;
						const { outcome, ms } = await shortConnection(target.host, target.port);
						counts[outcome] += 1;
						if (outcome === 'ok') times.push(ms);
					}
				}),
			);
			const seconds = (performance.now() - started) / 1000;
			console.log(JSON.stringify({ test: 'short', target: target.name, count, concurrency, seconds: Math.round(seconds), counts, ms: summary(times) }));
		}
		process.exit(0);
	}

	if (command === 'latency') {
		// Sequential and interleaved, so every target sees the same moment of host noise.
		const targets = parseTargets(args[0]!);
		const iterations = Number(args[1] ?? 5_000);
		const connectMs = new Map(targets.map((t) => [t.name, [] as number[]]));
		const queryMs = new Map(targets.map((t) => [t.name, [] as number[]]));
		const sessions = new Map<string, Pg>();
		for (const t of targets) sessions.set(t.name, await Pg.open(t.host, t.port));
		for (let i = 0; i < 200; i++) for (const t of targets) await sessions.get(t.name)!.query();
		for (let i = 0; i < iterations; i++) {
			for (const t of targets) {
				const q = performance.now();
				await sessions.get(t.name)!.query();
				queryMs.get(t.name)!.push(performance.now() - q);
				const result = await shortConnection(t.host, t.port);
				if (result.outcome === 'ok') connectMs.get(t.name)!.push(result.ms);
			}
		}
		for (const t of targets)
			console.log(JSON.stringify({ test: 'latency', target: t.name, query: summary(queryMs.get(t.name)!), shortConnection: summary(connectMs.get(t.name)!) }));
		process.exit(0);
	}

	if (command === 'soak') {
		const targets = parseTargets(args[0]!);
		const minutes = Number(args[1] ?? 120);
		const idlePerTarget = Number(args[2] ?? 50);
		const perSecond = Number(args[3] ?? 10);
		const out = Bun.file(args[4] ?? '/out/soak.jsonl').writer();
		const idle = new Map<string, Pg[]>();
		for (const t of targets) {
			const list: Pg[] = [];
			for (let i = 0; i < idlePerTarget; i++) list.push(await Pg.open(t.host, t.port));
			idle.set(t.name, list);
		}
		const totals = new Map(targets.map((t) => [t.name, { short: tally(), idleLost: 0, idleChecks: 0 }]));
		let minute = tally();
		const perMinute = new Map(targets.map((t) => [t.name, tally()]));
		const ending = Date.now() + minutes * 60_000;
		let stop = false;
		// Short connections: a steady trickle per target.
		const shortLoops = targets.map(async (t) => {
			while (!stop) {
				const tick = Date.now();
				const { outcome } = await shortConnection(t.host, t.port);
				totals.get(t.name)!.short[outcome] += 1;
				perMinute.get(t.name)![outcome] += 1;
				const wait = 1000 / perSecond - (Date.now() - tick);
				if (wait > 0) await sleep(wait);
			}
		});
		// Idle connections: checked every 30 s; reloads land in between, while they are idle.
		let idleTick = Date.now();
		while (Date.now() < ending) {
			await sleep(5_000);
			if (Date.now() - idleTick < 30_000) continue;
			idleTick = Date.now();
			const row: Record<string, unknown> = { at: new Date().toISOString() };
			for (const t of targets) {
				const list = idle.get(t.name)!;
				let lost = 0;
				await Promise.all(
					list.map(async (pg, index) => {
						try {
							await pg.query();
						} catch {
							lost += 1;
							list[index] = await Pg.open(t.host, t.port).catch(() => pg);
						}
					}),
				);
				const total = totals.get(t.name)!;
				total.idleChecks += list.length;
				total.idleLost += lost;
				row[t.name] = { idleLost: lost, short: perMinute.get(t.name) };
				perMinute.set(t.name, tally());
			}
			out.write(`${JSON.stringify(row)}\n`);
			out.flush();
		}
		stop = true;
		await Promise.all(shortLoops);
		minute = tally();
		void minute;
		const final = { test: 'soak', minutes, targets: Object.fromEntries(totals) };
		out.write(`${JSON.stringify(final)}\n`);
		await out.end();
		console.log(JSON.stringify(final));
		process.exit(0);
	}
	console.error('usage: load.ts probe|short|latency|soak ...');
	process.exit(2);
}

await main();
