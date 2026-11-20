/**
 * The checker's load: numbered writes and read-backs through the public route, open-loop at a fixed
 * rate, then a final sweep that reads every acknowledged row back. Deterministic for a seed except
 * for timing and the writer id (which carries the start time so two runs never share rows).
 */
import { Rng, fnv1a } from '../sim/rng.ts';
import type { CheckerLog, RequestKind, RequestRecord, SingletonRun } from './log.ts';

export interface CheckerOptions {
	url: string;
	host?: string;
	durationS: number;
	rate: number;
	seed: number;
	timeoutMs?: number;
	maxInFlight?: number;
	/** How long the final verification keeps retrying rows that answer neither 200 nor 404. */
	verifyBudgetMs?: number;
	onProgress?: (line: string) => void;
}

/**
 * The app's table outlives one checker run. Keep a (job, run) only when one of its starts is recent
 * (from a minute before this run began, for clock slack), so an old duplicate is not blamed on this run.
 */
export function singletonsOfRun(runs: SingletonRun[], startedAt: number, slackMs = 60_000): SingletonRun[] {
	const recent = new Set(runs.filter((r) => r.at >= startedAt - slackMs).map((r) => `${r.job}\u0000${r.run}`));
	return runs.filter((r) => recent.has(`${r.job}\u0000${r.run}`));
}

export function payloadFor(writer: string, n: number, seed: number): string {
	return fnv1a(`${writer}:${n}:${seed}`) + fnv1a(`${seed}:${n}:${writer}`);
}

export async function runChecker(options: CheckerOptions): Promise<CheckerLog> {
	const base = options.url.replace(/\/+$/, '');
	const timeoutMs = options.timeoutMs ?? 5_000;
	const maxInFlight = options.maxInFlight ?? 256;
	const rng = new Rng(options.seed, 7);
	const startedAt = Date.now();
	const writer = `chk-${options.seed}-${startedAt.toString(36)}`;
	const requests: RequestRecord[] = [];
	const acked: number[] = [];
	let nextId = 0;
	let nextN = 1;
	let inFlight = 0;

	const send = async (kind: RequestKind, n: number, method: 'GET' | 'POST', path: string): Promise<RequestRecord> => {
		const record: RequestRecord = { id: nextId++, kind, n, startedAt: Date.now(), endedAt: 0, status: 0 };
		inFlight++;
		try {
			const response = await fetch(`${base}${path}`, {
				method,
				headers: options.host ? { host: options.host } : {},
				signal: AbortSignal.timeout(timeoutMs),
			});
			record.status = response.status;
			record.node = response.headers.get('x-checker-node') ?? undefined;
			record.copy = response.headers.get('x-checker-copy') ?? undefined;
			if (response.status === 200 && kind !== 'write') {
				const body = (await response.json().catch(() => null)) as { v?: string } | null;
				record.match = body?.v === payloadFor(writer, n, options.seed);
			} else await response.body?.cancel().catch(() => undefined);
		} catch (error) {
			record.error = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network';
		} finally {
			record.endedAt = Date.now();
			inFlight--;
		}
		requests.push(record);
		return record;
	};

	const write = async (n: number) => {
		const r = await send('write', n, 'POST', `/w?n=${n}&writer=${encodeURIComponent(writer)}&v=${payloadFor(writer, n, options.seed)}`);
		if (r.status === 200) acked.push(n);
	};
	const read = (kind: 'read' | 'verify', n: number) => send(kind, n, 'GET', `/r?n=${n}&writer=${encodeURIComponent(writer)}`);

	const pending: Promise<unknown>[] = [];
	const interval = 1000 / options.rate;
	const end = startedAt + options.durationS * 1000;
	let op = 0;
	let lastProgress = startedAt;
	while (Date.now() < end) {
		const due = startedAt + op * interval;
		const wait = due - Date.now();
		if (wait > 0) await Bun.sleep(wait);
		if (inFlight < maxInFlight) {
			// Two writes, then a read of the newest acknowledged row or (one time in four) an older one.
			if (op % 3 !== 2 || acked.length === 0) pending.push(write(nextN++));
			else {
				const latest = acked.at(-1) as number;
				const n = rng.chance(0.25) ? (acked[rng.int(0, acked.length - 1)] as number) : latest;
				pending.push(read('read', n));
			}
		}
		op++;
		if (options.onProgress && Date.now() - lastProgress >= 5_000) {
			lastProgress = Date.now();
			const failed = requests.filter((r) => r.status !== 200).length;
			options.onProgress(`${Math.round((Date.now() - startedAt) / 1000)} s: ${requests.length} requests, ${acked.length} writes acknowledged, ${failed} failed`);
		}
	}
	await Promise.all(pending);
	const endedAt = Date.now();

	// Final verification: every acknowledged row, retried while the answer is neither 200 nor 404.
	const budgetEnd = Date.now() + (options.verifyBudgetMs ?? 30_000);
	let todo = [...acked];
	while (todo.length > 0) {
		const retry: number[] = [];
		for (let i = 0; i < todo.length; i += 32) {
			const batch = todo.slice(i, i + 32);
			const results = await Promise.all(batch.map((n) => read('verify', n)));
			for (const r of results) if (r.status !== 200 && r.status !== 404) retry.push(r.n);
		}
		if (retry.length === 0 || Date.now() > budgetEnd) break;
		todo = retry;
		await Bun.sleep(1_000);
	}

	let singletonRuns: SingletonRun[] = [];
	try {
		const response = await fetch(`${base}/singletons`, {
			headers: options.host ? { host: options.host } : {},
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (response.ok) singletonRuns = singletonsOfRun(((await response.json()) as { runs: SingletonRun[] }).runs, startedAt);
	} catch {
		// An app without /singletons, or unreachable: I4 then rests on observations alone.
	}

	return { seed: options.seed, writer, startedAt, endedAt, requests: requests.sort((a, b) => a.id - b.id), singletonRuns };
}
