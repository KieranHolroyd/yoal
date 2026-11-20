/**
 * Spike S3 (CLUSTERING §15.2, HA-PLAN W2): does a store honour `If-Match` / `If-None-Match: *` on
 * PUT strongly enough to be the only arbiter of one primary? Criteria and fallback: README.md.
 *
 *   S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… [S3_REGION=auto] \
 *   [S3_NAME=r2] [WRITERS=200] [ATTEMPTS=10000] [SECONDS=60] [FLOOD_SECONDS=15] \
 *   [LEASE_SECONDS=240] bun spikes/s3-cas/spike.ts
 *
 * Writes only under `yoal/spikes/s3-cas/<run>/` and deletes what it wrote. Prints one JSON result.
 */
import { runLease } from './lease-run.ts';
import { DelayProxy, delayingFetch, withTimeout } from './proxy.ts';
import { openTarget, targetFromEnv, type CasTarget, type TargetConfig } from './targets.ts';

export interface Check {
	pass: boolean;
	criterion: string;
	detail: string;
}
export interface SpikeResult {
	spike: 'S3';
	target: string;
	version?: string;
	at: string;
	pass: boolean;
	checks: Record<string, Check>;
	/** Status (and S3 error code) the store returned for each condition. */
	codes: Record<string, string>;
	numbers: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pct = (sorted: number[], q: number) =>
	sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 10) / 10 : NaN;
const refused = (status: number) => status === 409 || status === 412;
const code = (r: { status: number; code?: string | null }) => `${r.status}${r.code ? ` ${r.code}` : ''}`;

/** NTP offset of this host (true − local, ms) from `sntp`; 0 with a note if unavailable. */
async function ntpOffset(): Promise<{ offsetMs: number; source: string }> {
	try {
		const out = await new Response(Bun.spawn(['sntp', '-t', '3', 'time.apple.com'], { stdout: 'pipe', stderr: 'ignore' }).stdout).text();
		const match = out.match(/([+-]\d+\.\d+) \+\/- (\d+\.\d+)/);
		if (match) return { offsetMs: Number(match[1]) * 1000, source: `sntp time.apple.com ±${Math.round(Number(match[2]) * 1000)} ms` };
	} catch {}
	return { offsetMs: 0, source: 'no sntp; local clock taken as true' };
}

export async function runSpike(config: TargetConfig, env: Record<string, string | undefined> = process.env): Promise<SpikeResult> {
	const writers = Number(env.WRITERS ?? 200);
	const attempts = Number(env.ATTEMPTS ?? 10_000);
	const seconds = Number(env.SECONDS ?? 60);
	const floodSeconds = Number(env.FLOOD_SECONDS ?? 15);
	const leaseSeconds = Number(env.LEASE_SECONDS ?? 240);
	const target = openTarget(config);
	const run = `yoal/spikes/s3-cas/${new Date().toISOString().replace(/[:.]/g, '-')}`;
	const checks: Record<string, Check> = {};
	const codes: Record<string, string> = {};
	const numbers: Record<string, unknown> = {};
	const written = new Set<string>();
	const log = (line: string) => console.error(`[${config.name}] ${line}`);
	const check = (name: string, criterion: string, pass: boolean, detail: string) => {
		checks[name] = { pass, criterion, detail };
		log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
	};
	const key = (name: string) => {
		const k = `${run}/${name}`;
		written.add(k);
		return k;
	};

	// ── Clock: the lease trusts only the store's Date header (1 s resolution, truncated). ──
	{
		const ntp = await ntpOffset();
		const skews: number[] = [];
		for (let i = 0; i < 20; i++) {
			const before = Date.now();
			const read = await target.readVersioned(key('clock'));
			const after = Date.now();
			if (read.serverDate !== null) skews.push(read.serverDate - ((before + after) / 2 + ntp.offsetMs));
			await sleep(137);
		}
		skews.sort((a, b) => a - b);
		const worst = skews.length ? Math.max(Math.abs(skews[0]!), Math.abs(skews.at(-1)!)) : NaN;
		numbers.clock = { ntp: ntp.source, ntpOffsetMs: Math.round(ntp.offsetMs), samples: skews.length, minMs: Math.round(skews[0] ?? NaN), maxMs: Math.round(skews.at(-1) ?? NaN) };
		check('store-clock', 'store time within 5 s of true time', skews.length === 20 && worst <= 5_000, skews.length ? `store − true ∈ [${Math.round(skews[0]!)}, ${Math.round(skews.at(-1)!)}] ms over ${skews.length} reads (${ntp.source}; Date truncates to 1 s)` : 'no Date header');
	}

	// ── Conditions on one key, and what the store answers to each. ──
	{
		const k = key('single');
		const absentIfMatch = await target.putRaw(k, '{"epoch":0}', { 'if-match': '"00000000000000000000000000000000"' });
		codes['If-Match on absent key'] = code(absentIfMatch);
		const created = await target.writeConditional(k, '{"epoch":1}', { ifNoneMatch: '*' });
		codes['If-None-Match: * on absent key'] = String(created.status);
		check('create-if-none-match', 'If-None-Match: * creates', created.status === 200 && Boolean(created.etag), `status ${created.status}, etag ${created.etag}`);
		const again = await target.putRaw(k, '{"epoch":1}', { 'if-none-match': '*' });
		codes['If-None-Match: * on existing key'] = code(again);
		check('create-refused-when-present', 'T1: 409/412 for If-None-Match: * on an existing key', refused(again.status), code(again));

		const etags = new Set<string>([created.etag!]);
		let current = created.etag!;
		let repeated = 0;
		for (let i = 0; i < 50; i++) {
			const same = await target.writeConditional(k, '{"epoch":1}', { ifMatch: current });
			if (same.status !== 200 || !same.etag) break;
			repeated++;
			etags.add(same.etag);
			current = same.etag;
		}
		codes['If-Match current ETag'] = repeated ? '200' : 'failed';
		check('etag-changes-on-identical-body', 'the ETag changes on every write', repeated === 50 && etags.size === 51, `${repeated}/50 identical-body writes, ${etags.size} distinct ETags`);

		// Stale: the ETag of an earlier, different body.
		const before = current;
		const moved = await target.writeConditional(k, '{"epoch":2}', { ifMatch: current });
		if (moved.status !== 200 || !moved.etag) throw new Error(`write epoch 2: ${moved.status}`);
		current = moved.etag;
		const stale = await target.putRaw(k, '{"epoch":"stale"}', { 'if-match': before });
		codes['If-Match stale ETag'] = code(stale);
		const bogus = await target.putRaw(k, '{"epoch":"bogus"}', { 'if-match': '"00000000000000000000000000000000"' });
		codes['If-Match unknown ETag'] = code(bogus);
		check('stale-if-match-refused', '409/412, never 200, for a stale If-Match', refused(stale.status) && refused(bogus.status) && absentIfMatch.status !== 200, `stale ${code(stale)}, unknown ${code(bogus)}, absent key ${code(absentIfMatch)}`);
		// ABA: the object went X → Y → X. An If-Match taken at the first X is stale (the object was
		// written twice since); a content-hash ETag makes it match again.
		const back = await target.writeConditional(k, '{"epoch":1}', { ifMatch: current });
		if (back.status !== 200 || !back.etag) throw new Error(`write back: ${back.status}`);
		current = back.etag;
		const aba = await target.putRaw(k, '{"epoch":"aba"}', { 'if-match': before });
		codes['If-Match stale ETag, body since restored (ABA)'] = code(aba);
		if (aba.status === 200) current = (await target.readVersioned(k)).etag ?? current;
		check('stale-if-match-aba', '409/412, never 200, for a stale If-Match (object rewritten with an earlier body)', refused(aba.status), `${code(aba)}; ETag before ${before}, after X→Y→X ${back.etag}`);

		// Conditions the lease does not use: a store must not silently ignore them.
		const unsupported = await target.putUnsupportedCondition(k, '{"epoch":"unsupported"}', current);
		codes['If-None-Match: <current ETag> (unsupported on PUT)'] = code(unsupported);
		const afterUnsupported = await target.readVersioned(k);
		const silent = unsupported.status >= 200 && unsupported.status < 300;
		check('unsupported-condition-refused', '501 for an unsupported condition, never silent success', !silent && afterUnsupported.etag === current, `${code(unsupported)}; object ${afterUnsupported.etag === current ? 'unchanged' : 'REPLACED'}`);
		if (silent && afterUnsupported.etag) current = afterUnsupported.etag;
		const mismatch = await target.putUnsupportedConditionMismatch(k, '{"epoch":"mismatch"}');
		codes['If-None-Match: <other ETag> (unsupported on PUT)'] = code(mismatch);
		if (mismatch.status === 200) current = (await target.readVersioned(k)).etag ?? current;
		const weak = await target.putRaw(k, '{"epoch":3}', { 'if-match': `W/${current}` });
		codes['If-Match: W/<current ETag>'] = code(weak);
		if (weak.status === 200) current = (await target.readVersioned(k)).etag ?? current;
		const star = await target.putRaw(k, '{"epoch":3}', { 'if-match': '*' });
		codes['If-Match: * on existing key'] = code(star);
		if (star.status === 200) current = (await target.readVersioned(k)).etag ?? current;
		const both = await target.putRaw(k, '{"epoch":3}', { 'if-match': current, 'if-none-match': '*' });
		codes['If-Match current + If-None-Match: *'] = code(both);
		if (both.status === 200) current = (await target.readVersioned(k)).etag ?? current;

		// T2: an unconditional PUT lands while a holder keeps an If-Match view.
		const held = (await target.readVersioned(k)).etag!;
		const plain = await target.putUnconditional(k, '{"epoch":"unconditional"}');
		codes['PUT without condition on existing key'] = code(plain);
		const holder = await target.putRaw(k, '{"epoch":4}', { 'if-match': held });
		codes['If-Match after an unconditional PUT replaced it'] = code(holder);
		check('unconditional-put-breaks-held-if-match', 'T2: the holder’s If-Match fails after an unconditional PUT', plain.status === 200 ? refused(holder.status) : true, `unconditional ${code(plain)}, holder’s CAS ${code(holder)}`);

		// T3: read-after-write, sequential.
		let etag = (await target.readVersioned(k)).etag!;
		let staleGet = 0;
		let staleHead = 0;
		const latencies: number[] = [];
		for (let i = 0; i < 200; i++) {
			const started = performance.now();
			const write = await target.writeConditional(k, JSON.stringify({ epoch: 10 + i }), { ifMatch: etag });
			latencies.push(performance.now() - started);
			if (write.status !== 200 || !write.etag) throw new Error(`sequential write ${i}: ${write.status}`);
			etag = write.etag;
			const get = await target.readVersioned(k);
			const head = await target.head(k);
			if (get.etag !== etag || get.body !== JSON.stringify({ epoch: 10 + i })) staleGet++;
			if (head.etag !== etag) staleHead++;
		}
		latencies.sort((a, b) => a - b);
		numbers.sequentialPut = { n: 200, p50: pct(latencies, 0.5), p99: pct(latencies, 0.99) };
		check('read-after-write-sequential', 'T3: GET and HEAD return the ETag just written', staleGet === 0 && staleHead === 0, `200 writes: ${staleGet} stale GET, ${staleHead} stale HEAD`);
	}

	// ── Contention: `writers` read → CAS(epoch + 1) in lock-step rounds; `attempts` in total. ──
	const race = async (label: string, mode: 'rounds' | 'flood', durationS: number) => {
		const k = key(`race-${label}`);
		const first = await target.writeConditional(k, JSON.stringify({ epoch: 0, writer: 'init' }), { ifNoneMatch: '*' });
		if (first.status !== 200 || !first.etag) throw new Error(`could not create ${k}: ${first.status}`);
		const wins: { epoch: number; writer: string; ifMatch: string; etag: string; seenAfter: string[] }[] = [];
		const latencies: number[] = [];
		const statuses: Record<string, number> = {};
		let tries = 0;
		let errors = 0;
		const errorKinds: Record<string, number> = {};
		const attempt = async (writer: string) => {
			try {
				const read = await target.readVersioned(k);
				if (read.status !== 200 || !read.etag || !read.body) {
					statuses[`read ${read.status}`] = (statuses[`read ${read.status}`] ?? 0) + 1;
					return;
				}
				const epoch = (JSON.parse(read.body) as { epoch: number }).epoch + 1;
				const started = performance.now();
				const write = await target.writeConditional(k, JSON.stringify({ epoch, writer }), { ifMatch: read.etag });
				latencies.push(performance.now() - started);
				tries++;
				statuses[write.status] = (statuses[write.status] ?? 0) + 1;
				if (write.status === 200 && write.etag) {
					const win = { epoch, writer, ifMatch: read.etag, etag: write.etag, seenAfter: [] as string[] };
					wins.push(win);
					const [get, head] = await Promise.all([target.readVersioned(k), target.head(k)]);
					win.seenAfter.push(get.etag ?? 'none', head.etag ?? 'none');
				}
			} catch (error) {
				errors++;
				const kind = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 80) : String(error);
				errorKinds[kind] = (errorKinds[kind] ?? 0) + 1;
			}
		};
		const started = Date.now();
		if (mode === 'rounds') {
			const rounds = Math.ceil(attempts / writers);
			const interval = (durationS * 1000) / rounds;
			for (let r = 0; r < rounds; r++) {
				const at = started + r * interval;
				await sleep(Math.max(0, at - Date.now()));
				// Not awaited as a barrier: a slow round overlaps the next, as real contenders would.
				void Promise.all(Array.from({ length: writers }, (_, i) => attempt(`w${i}`)));
			}
			const settle = Date.now() + 30_000;
			while (tries + errors < rounds * writers && Date.now() < settle) await sleep(100);
		} else {
			const deadline = started + durationS * 1000;
			await Promise.all(
				Array.from({ length: writers }, async (_, i) => {
					while (Date.now() < deadline) await attempt(`w${i}`);
				}),
			);
		}
		const elapsed = (Date.now() - started) / 1000;
		const final = await target.readVersioned(k);
		const finalEpoch = (JSON.parse(final.body ?? '{"epoch":-1}') as { epoch: number }).epoch;

		// One winner per epoch; the wins form one chain of ETags from the first, each consumed once.
		const byEpoch = new Map<number, number>();
		for (const win of wins) byEpoch.set(win.epoch, (byEpoch.get(win.epoch) ?? 0) + 1);
		const doubled = [...byEpoch.entries()].filter(([, n]) => n > 1);
		const byIfMatch = new Map<string, number>();
		for (const win of wins) byIfMatch.set(win.ifMatch, (byIfMatch.get(win.ifMatch) ?? 0) + 1);
		const reused = [...byIfMatch.values()].filter((n) => n > 1).length;
		const next = new Map(wins.map((win) => [win.ifMatch, win]));
		const position = new Map<string, number>([[first.etag, 0]]);
		let cursor = first.etag;
		let length = 0;
		while (next.has(cursor) && length <= wins.length) {
			cursor = next.get(cursor)!.etag;
			position.set(cursor, ++length);
		}
		const distinct = new Set(wins.map((win) => win.etag)).size;
		const staleAfterWin = wins.filter((win) => win.seenAfter.some((seen) => (position.get(seen) ?? -1) < (position.get(win.etag) ?? Infinity))).length;
		latencies.sort((a, b) => a - b);
		const result = {
			mode,
			writers,
			seconds: Math.round(elapsed * 10) / 10,
			attempts: tries,
			transportErrors: errors,
			errorKinds,
			wins: wins.length,
			statuses,
			putP50: pct(latencies, 0.5),
			putP99: pct(latencies, 0.99),
			putMax: Math.round(latencies.at(-1) ?? NaN),
		};
		numbers[`race-${label}`] = result;
		const tag = mode === 'rounds' ? '' : `-${label}`;
		check(`one-winner-per-epoch${tag}`, 'exactly one 200 per epoch, never two holders', doubled.length === 0 && reused === 0, `${wins.length} wins over ${byEpoch.size} epochs; ${doubled.length} epochs with two 200s; ${reused} ETags consumed twice`);
		check(`cas-chain${tag}`, 'every 200 extends the one chain of ETags; final object = last win', length === wins.length && cursor === final.etag && finalEpoch === wins.length, `chain ${length}/${wins.length}, final epoch ${finalEpoch}, final ETag ${cursor === final.etag ? 'is' : 'is NOT'} the chain’s end`);
		check(`etag-unique${tag}`, 'the ETag changes on every write', distinct === wins.length, `${distinct} distinct ETags for ${wins.length} wins`);
		check(`only-200-409-412${tag}`, 'losers get 409 or 412, nothing else', Object.keys(statuses).every((s) => ['200', '409', '412'].includes(s)) && errors === 0, `${JSON.stringify(statuses)}, ${errors} transport errors`);
		check(`read-after-win${tag}`, 'T3: after a 200, GET and HEAD show that write or a later one', staleAfterWin === 0, `${staleAfterWin} of ${wins.length} winners read an older ETag`);
		if (mode === 'rounds') {
			check('attempts-10000', 'method: 10,000 CAS attempts by 200 writers over 60 s', tries + errors >= attempts && writers >= 200, `${tries + errors} attempts issued (${tries} answered), ${writers} writers, ${result.seconds} s`);
			check('put-p99-under-300ms', 'p99 PUT ≤ 300 ms', result.putP99 <= 300, `p50 ${result.putP50} ms, p99 ${result.putP99} ms, max ${result.putMax} ms`);
		}
	};
	await race('rounds', 'rounds', seconds);
	if (floodSeconds > 0) await race('flood', 'flood', floodSeconds);

	// ── T4: one request or response held 5 s; the client gives up after 2 s and retries. ──
	{
		const endpoint = new URL(config.endpoint);
		const plainHttp = endpoint.protocol === 'http:';
		let proxy: DelayProxy | null = null;
		let delayed: CasTarget;
		let arm: (direction: 'request' | 'response', ms: number) => void;
		if (plainHttp) {
			proxy = new DelayProxy(endpoint.hostname, Number(endpoint.port || 80)).start();
			const via = new URL(config.endpoint);
			via.hostname = '127.0.0.1';
			via.port = String(proxy.port);
			delayed = target.withFetch(withTimeout(fetch, 2_000), via.toString());
			arm = (direction, ms) => (direction === 'request' ? proxy!.delayNextRequest(ms) : proxy!.delayNextResponse(ms));
		} else {
			// TLS endpoints: the same two cases at the fetch layer (bytes really sent late / answer discarded).
			const control = delayingFetch(fetch, 2_000);
			delayed = target.withFetch(control.fetch);
			arm = control.arm;
		}
		numbers.delayMethod = plainHttp ? 'TCP proxy, client timeout 2 s' : 'fetch-layer delay, client timeout 2 s';
		const body = (epoch: number, who: string) => JSON.stringify({ epoch, writer: who });
		const scenarios: Record<string, string> = {};
		let ok = true;

		// (a) Response held: the write applied, the client timed out. What does a retry see?
		{
			const k = key('delay-response');
			const e0 = (await target.writeConditional(k, body(0, 'init'), { ifNoneMatch: '*' })).etag!;
			arm('response', 5_000);
			const first = await delayed.writeConditional(k, body(1, 'A'), { ifMatch: e0 }).then((r) => String(r.status), (e) => `error ${(e as Error).name}`);
			const during = await target.readVersioned(k);
			const retry = await delayed.writeConditional(k, body(1, 'A'), { ifMatch: e0 }).then((r) => r, () => null);
			await sleep(4_000);
			const after = await target.readVersioned(k);
			const applied = during.body === body(1, 'A');
			const pass = first.startsWith('error') && applied && retry !== null && refused(retry.status) && after.etag === during.etag;
			ok &&= pass;
			codes['Retry of an applied If-Match after a client timeout'] = retry ? String(retry.status) : 'error';
			scenarios.responseHeld = `first PUT ${first}; write ${applied ? 'applied' : 'NOT applied'} (read during the hold); retry with the same If-Match ${retry?.status ?? 'error'}; object afterwards ${after.etag === during.etag ? 'unchanged' : 'CHANGED'}`;
		}
		// (b) Request held: the client gives up, a competitor wins, then the stale write arrives.
		{
			const k = key('delay-request-competitor');
			const e0 = (await target.writeConditional(k, body(0, 'init'), { ifNoneMatch: '*' })).etag!;
			arm('request', 5_000);
			const first = await delayed.writeConditional(k, body(1, 'A'), { ifMatch: e0 }).then((r) => String(r.status), (e) => `error ${(e as Error).name}`);
			const competitor = await target.writeConditional(k, body(1, 'B'), { ifMatch: e0 });
			await sleep(7_000);
			const after = await target.readVersioned(k);
			const pass = first.startsWith('error') && competitor.status === 200 && after.etag === competitor.etag && after.body === body(1, 'B');
			ok &&= pass;
			scenarios.requestHeldCompetitor = `first PUT ${first}; competitor ${competitor.status}; after the late write arrived the object is ${after.body === body(1, 'B') ? 'still B’s' : `REPLACED by ${after.body}`}`;
		}
		// (c) Request held, the same client retries before it lands: the late copy must lose.
		{
			const k = key('delay-request-retry');
			const e0 = (await target.writeConditional(k, body(0, 'init'), { ifNoneMatch: '*' })).etag!;
			arm('request', 5_000);
			const first = await delayed.writeConditional(k, body(1, 'A-first'), { ifMatch: e0 }).then((r) => String(r.status), (e) => `error ${(e as Error).name}`);
			const retry = await target.writeConditional(k, body(1, 'A-retry'), { ifMatch: e0 });
			await sleep(7_000);
			const after = await target.readVersioned(k);
			const pass = first.startsWith('error') && retry.status === 200 && after.etag === retry.etag && after.body === body(1, 'A-retry');
			ok &&= pass;
			scenarios.requestHeldRetry = `first PUT ${first}; retry ${retry.status}; after the late copy arrived the object is ${after.body === body(1, 'A-retry') ? 'the retry' : `REPLACED by ${after.body}`}`;
		}
		// (d) Response held, client waits: the 200 arrives late and is still the truth.
		{
			const k = key('delay-wait');
			const e0 = (await target.writeConditional(k, body(0, 'init'), { ifNoneMatch: '*' })).etag!;
			const patient = plainHttp ? target.withFetch(withTimeout(fetch, 10_000), delayed.config.endpoint) : target.withFetch(delayingFetch(fetch, 10_000).fetch);
			arm('response', 5_000);
			const started = performance.now();
			const write = await patient.writeConditional(k, body(1, 'A'), { ifMatch: e0 }).catch(() => null);
			const took = Math.round(performance.now() - started);
			const after = await target.readVersioned(k);
			const pass = plainHttp ? write?.status === 200 && write.etag === after.etag && took >= 4_500 : true;
			ok &&= pass;
			scenarios.responseHeldWaited = plainHttp ? `200 after ${took} ms; ETag ${write?.etag === after.etag ? 'matches' : 'does NOT match'} a fresh read` : 'not run at the fetch layer';
		}
		proxy?.stop();
		numbers.delay = scenarios;
		check('delayed-response', 'T4: a held request or response never yields a second 200 or a lost winner', ok, Object.values(scenarios).join(' | '));
	}

	// ── T5: the real ControlLease, three contenders, through the real S3 client. ──
	if (leaseSeconds > 0) {
		const lease = await runLease(target, { seconds: leaseSeconds, key: key('control-lease.json'), log });
		numbers.lease = lease.numbers;
		for (const [name, entry] of Object.entries(lease.checks)) check(name, entry.criterion, entry.pass, entry.detail);
	}

	for (const k of written) await target.delete(k).catch(() => undefined);
	const storeChecks = Object.entries(checks).filter(([name]) => !name.startsWith('client-'));
	return {
		spike: 'S3',
		target: config.name,
		...(config.version ? { version: config.version } : {}),
		at: new Date().toISOString(),
		pass: storeChecks.every(([, entry]) => entry.pass),
		checks,
		codes,
		numbers,
	};
}

if (import.meta.main) {
	const result = await runSpike(targetFromEnv());
	console.log(JSON.stringify(result, null, 2));
	process.exit(result.pass ? 0 : 1);
}
