/**
 * T5: the production `ControlLease` (packages/core/src/ha-lease.ts, unchanged) with three
 * contenders against a real store through the real S3 client. The policy is the default scaled
 * by 1/5 (TTL 6 s, fence 4 s, takeover 8 s) so a few minutes hold many terms.
 *
 * Phase 1 (chaos): every 15 s the primary freezes for 12 s (the stale-leader case) and a
 * contender behind the delay proxy gets random held requests and responses of up to 3.5 s.
 * Phase 2 (late confirm): a renewal's answer arrives 6 s late (> takeover − fence) and the
 * primary then freezes. Checks prefixed `client-` judge the lease client, not the store.
 */
import { ControlLease } from '../../packages/core/src/ha-lease.ts';
import type { ConditionalStore } from '../../packages/core/src/object-store.ts';
import { DelayProxy, delayingFetch } from './proxy.ts';
import type { CasTarget } from './targets.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const POLICY = { ttlMs: 6_000, fenceAfterMs: 4_000, takeoverAfterMs: 8_000, skewToleranceMs: 5_000 };

interface Contender {
	name: string;
	lease: ControlLease;
	paused: boolean;
	fencedAt: number | null;
	/** Phase 2 hook: hold the answer to the next write this long. */
	holdNextWriteAnswer: number;
}

export async function runLease(
	target: CasTarget,
	options: { seconds: number; key: string; log: (line: string) => void },
) {
	const endpoint = new URL(target.config.endpoint);
	let proxy: DelayProxy | null = null;
	let viaProxy: CasTarget;
	let armProxy: (direction: 'request' | 'response', ms: number) => void;
	if (endpoint.protocol === 'http:') {
		proxy = new DelayProxy(endpoint.hostname, Number(endpoint.port || 80)).start();
		const via = new URL(target.config.endpoint);
		via.hostname = '127.0.0.1';
		via.port = String(proxy.port);
		viaProxy = target.withFetch(fetch, via.toString());
		armProxy = (direction, ms) => (direction === 'request' ? proxy!.delayNextRequest(ms) : proxy!.delayNextResponse(ms));
	} else {
		// The production client has no deadline, so the fetch-layer variant never times out here.
		const control = delayingFetch(fetch, 3_600_000);
		viaProxy = target.withFetch(control.fetch);
		armProxy = control.arm;
	}

	const contenders: Contender[] = [];
	const make = (name: string, store: CasTarget): Contender => {
		const contender: Contender = { name, lease: null!, paused: false, fencedAt: null, holdNextWriteAnswer: 0 };
		const wrapped: ConditionalStore = {
			readVersioned: (key) => store.readVersioned(key),
			writeConditional: async (key, body, condition) => {
				const result = await store.writeConditional(key, body, condition);
				const hold = contender.holdNextWriteAnswer;
				if (hold) {
					contender.holdNextWriteAnswer = 0;
					await sleep(hold);
				}
				return result;
			},
		};
		contender.lease = new ControlLease({ store: wrapped, nodeId: name, version: 'spike', key: options.key, policy: POLICY });
		contenders.push(contender);
		return contender;
	};
	const a = make('node-a', target.withFetch(fetch));
	const b = make('node-b', target.withFetch(fetch));
	const c = make('node-c', viaProxy);

	// Observations.
	let phase: 'chaos' | 'late-confirm' = 'chaos';
	const overlaps: Record<string, { count: number; totalMs: number; maxMs: number }> = {
		chaos: { count: 0, totalMs: 0, maxMs: 0 },
		'late-confirm': { count: 0, totalMs: 0, maxMs: 0 },
	};
	let overlapSince: number | null = null;
	let noHolderMs = 0;
	let lastSample = performance.now();
	const sampler = setInterval(() => {
		const now = performance.now();
		const holders = contenders.filter((x) => x.lease.holds()).length;
		if (holders === 0) noHolderMs += now - lastSample;
		lastSample = now;
		if (holders > 1 && overlapSince === null) {
			overlapSince = now;
			overlaps[phase]!.count++;
			options.log(`OVERLAP: ${contenders.filter((x) => x.lease.holds()).map((x) => `${x.name}@${x.lease.status().epoch}`).join(' + ')}`);
		} else if (holders <= 1 && overlapSince !== null) {
			const ms = now - overlapSince;
			overlaps[phase]!.totalMs += ms;
			overlaps[phase]!.maxMs = Math.max(overlaps[phase]!.maxMs, ms);
			overlapSince = null;
		}
	}, 10);
	const holderOfEpoch = new Map<number, Set<string>>();
	const storeEpochs: number[] = [];
	let storeEpochDecreased = 0;
	let fences = 0;

	// Tick loops: every 1 s, all willing to take over.
	let running = true;
	const loops = contenders.map(async (x) => {
		while (running) {
			if (!x.paused) {
				const status = await x.lease.tick({ mayTakeOver: true });
				if (status.role === 'primary') {
					const set = holderOfEpoch.get(status.epoch) ?? new Set<string>();
					set.add(x.name);
					holderOfEpoch.set(status.epoch, set);
				}
				if (status.role === 'fenced' && x.fencedAt === null) {
					x.fencedAt = performance.now();
					fences++;
					options.log(`${x.name} fenced: ${status.reason}`);
				}
				// Re-seed a fenced node after 6 s so it can contend again (§6.6, by hand in production).
				if (x.fencedAt !== null && performance.now() - x.fencedAt > 6_000) {
					x.lease.resetAfterReseed();
					x.fencedAt = null;
				}
			}
			await sleep(1_000);
		}
	});
	const observer = (async () => {
		while (running) {
			const read = await target.readVersioned(options.key).catch(() => null);
			if (read?.status === 200 && read.body) {
				const epoch = (JSON.parse(read.body) as { epoch: number }).epoch;
				if (storeEpochs.length && epoch < storeEpochs.at(-1)!) storeEpochDecreased++;
				if (epoch !== storeEpochs.at(-1)) storeEpochs.push(epoch);
			}
			await sleep(250);
		}
	})();

	await a.lease.bootstrap(1);
	const started = Date.now();
	const chaosEnd = started + Math.max(30, options.seconds - 50) * 1000;
	let held = 0;
	let frozen = 0;
	for (let round = 1; Date.now() < chaosEnd; round++) {
		await sleep(5_000);
		// Random held request/response on node-c (≤ 3.5 s, inside takeover − fence).
		if (Math.random() < 0.7) {
			armProxy(Math.random() < 0.5 ? 'request' : 'response', 1_000 + Math.floor(Math.random() * 2_500));
			held++;
		}
		if (round % 3 === 0) {
			const primary = contenders.find((x) => x.lease.holds());
			if (primary) {
				primary.paused = true;
				frozen++;
				options.log(`froze ${primary.name} (epoch ${primary.lease.status().epoch}) for 12 s`);
				setTimeout(() => (primary.paused = false), 12_000);
			}
		}
	}
	await sleep(13_000);

	// Phase 2: make node-c primary, then hold one renewal's answer 6 s and freeze it afterwards.
	phase = 'late-confirm';
	let lateConfirm = 'not reached: node-c never became primary';
	a.paused = b.paused = true;
	const deadline = Date.now() + 40_000;
	while (!c.lease.holds() && Date.now() < deadline) await sleep(200);
	if (c.lease.holds()) {
		a.paused = b.paused = false;
		c.holdNextWriteAnswer = 6_000;
		const before = c.lease.status().lastConfirmedAt;
		while (c.lease.status().lastConfirmedAt === before) await sleep(20);
		c.paused = true;
		await sleep(15_000);
		c.paused = false;
		await sleep(3_000);
		lateConfirm = `node-c renewal answered 6 s late, then froze 15 s: ${overlaps['late-confirm']!.count} overlap(s), longest ${Math.round(overlaps['late-confirm']!.maxMs)} ms`;
	}

	running = false;
	await Promise.all([...loops, observer]);
	clearInterval(sampler);
	proxy?.stop();

	const doubleEpochs = [...holderOfEpoch.entries()].filter(([, who]) => who.size > 1);
	const terms = holderOfEpoch.size;
	const numbers = {
		policy: POLICY,
		seconds: Math.round((Date.now() - started) / 1000),
		terms,
		storeEpochs: storeEpochs.length ? `${storeEpochs[0]}→${storeEpochs.at(-1)}` : 'none',
		frozen,
		heldRequestsOrResponses: held,
		fences,
		noHolderSeconds: Math.round(noHolderMs / 100) / 10,
		overlaps,
	};
	const chaos = overlaps.chaos!;
	return {
		numbers,
		checks: {
			'lease-single-holder': {
				criterion: 'T5: never two contenders passing holds() at once (chaos phase)',
				pass: chaos.count === 0 && doubleEpochs.length === 0,
				detail: `${terms} terms, ${frozen} freezes, ${held} held requests/responses, ${fences} fences; ${chaos.count} overlaps; ${doubleEpochs.length} epochs with two primaries`,
			},
			'lease-epochs-rise': {
				criterion: 'T5: the stored epoch only rises',
				pass: storeEpochDecreased === 0 && storeEpochs.length > 1,
				detail: `stored epochs ${numbers.storeEpochs}, ${storeEpochDecreased} decreases`,
			},
			'lease-takeovers-happened': {
				criterion: 'T5: the run exercised takeovers (≥ 3 terms)',
				pass: terms >= 3,
				detail: `${terms} terms`,
			},
			'client-late-confirm': {
				criterion: 'client: a renewal answered late must not extend holds() past a successor’s takeover',
				pass: overlaps['late-confirm']!.count === 0 && lateConfirm.startsWith('node-c'),
				detail: lateConfirm,
			},
		},
	};
}
