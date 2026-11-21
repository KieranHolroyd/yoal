import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MetricBucket, TelemetrySpoolGap, TelemetrySpoolReport } from '@yoal/contracts';

/**
 * The agent's bounded on-disk telemetry spool (HA-PLAN H28/W12).
 *
 * Access-log buckets are pre-aggregated; each completed minute becomes one `MetricBucket`. While
 * the control plane is reachable they never touch the disk. When a POST fails, the batch is
 * written here and retried oldest-first, so a control-plane outage longer than the in-memory cap
 * does not lose traffic history. The spool is bounded by both bucket count and bytes: past the
 * bound the oldest segments are deleted, and the affected minutes are reported as gaps so the
 * dashboard can shade them rather than pretend the traffic was zero.
 *
 * Format: one JSON file per appended batch, `batch-<seq>-<count>-<bytes>.json`, written to a temp
 * file and renamed. A crash replays the segment; ClickHouse replaces the same `(host, bucket)` row,
 * so replay is harmless. The gap record is a separate tiny JSON file, best effort.
 */
export interface TelemetrySpoolOptions {
	maxBuckets?: number;
	maxBytes?: number;
	/** How many gap ranges to remember for reporting. */
	maxGaps?: number;
}

export interface SpoolTake {
	buckets: MetricBucket[];
	/** Segment file names to remove once the batch is acknowledged. */
	segments: string[];
}

interface Segment {
	name: string;
	seq: number;
	count: number;
	bytes: number;
}

interface GapState {
	dropped: number;
	gaps: TelemetrySpoolGap[];
}

const SEGMENT_PATTERN = /^batch-(\d{12})-(\d+)-(\d+)\.json$/;
const STATE_FILE = 'gaps.json';
const MINUTE_MS = 60_000;

function mergeGaps(gaps: readonly TelemetrySpoolGap[]): TelemetrySpoolGap[] {
	const sorted = [...gaps].filter((gap) => gap.to > gap.from).sort((a, b) => a.host.localeCompare(b.host) || a.from - b.from);
	const merged: TelemetrySpoolGap[] = [];
	for (const gap of sorted) {
		const last = merged.at(-1);
		if (last && last.host === gap.host && gap.from <= last.to) {
			last.to = Math.max(last.to, gap.to);
			last.buckets += gap.buckets;
			continue;
		}
		merged.push({ ...gap });
	}
	return merged;
}

function gapsOf(buckets: readonly MetricBucket[]): TelemetrySpoolGap[] {
	const ranges = new Map<string, { from: number; to: number; buckets: number }>();
	for (const bucket of buckets) {
		const minute = Date.parse(bucket.bucket);
		if (!Number.isFinite(minute)) continue;
		const current = ranges.get(bucket.host);
		if (current) {
			current.from = Math.min(current.from, minute);
			current.to = Math.max(current.to, minute + MINUTE_MS);
			current.buckets += 1;
		} else {
			ranges.set(bucket.host, { from: minute, to: minute + MINUTE_MS, buckets: 1 });
		}
	}
	return [...ranges.entries()].map(([host, range]) => ({ host, ...range }));
}

export class TelemetrySpool {
	private readonly maxBuckets: number;
	private readonly maxBytes: number;
	private readonly maxGaps: number;
	private segments: Segment[] = [];
	private sequence = 0;
	private dropped = 0;
	private gaps: TelemetrySpoolGap[] = [];
	private opened = false;

	constructor(
		private readonly dir: string,
		options: TelemetrySpoolOptions = {},
	) {
		this.maxBuckets = options.maxBuckets ?? 5_000;
		this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
		this.maxGaps = options.maxGaps ?? 200;
	}

	async open(): Promise<void> {
		if (this.opened) return;
		await mkdir(this.dir, { recursive: true });
		const names = (await readdir(this.dir)).sort();
		for (const name of names) {
			const match = SEGMENT_PATTERN.exec(name);
			if (!match) continue;
			const file = join(this.dir, name);
			try {
				const info = await stat(file);
				this.segments.push({ name, seq: Number(match[1]), count: Number(match[2]), bytes: info.size });
				this.sequence = Math.max(this.sequence, Number(match[1]));
			} catch {
				// A file removed between listing and stat is simply not ours.
			}
		}
		this.segments.sort((a, b) => a.seq - b.seq);
		try {
			const state = JSON.parse(await readFile(join(this.dir, STATE_FILE), 'utf8')) as Partial<GapState>;
			this.dropped = Number.isFinite(state.dropped) ? Math.max(0, Math.trunc(state.dropped!)) : 0;
			this.gaps = Array.isArray(state.gaps)
				? mergeGaps(
						state.gaps.filter(
							(gap): gap is TelemetrySpoolGap =>
								Boolean(gap) &&
								typeof gap.host === 'string' &&
								Number.isFinite(gap.from) &&
								Number.isFinite(gap.to) &&
								Number.isFinite(gap.buckets),
						),
					).slice(-this.maxGaps)
				: [];
		} catch {
			this.dropped = 0;
			this.gaps = [];
		}
		this.opened = true;
	}

	/**
	 * Persist one batch. A batch larger than the count bound keeps its newest buckets; the rest
	 * become a gap like any other dropped range.
	 */
	async append(buckets: readonly MetricBucket[]): Promise<void> {
		if (buckets.length === 0) return;
		await this.open();
		const overflow = buckets.length > this.maxBuckets ? buckets.slice(0, buckets.length - this.maxBuckets) : [];
		const kept = overflow.length > 0 ? buckets.slice(-this.maxBuckets) : [...buckets];
		if (overflow.length > 0) await this.#recordGaps(gapsOf(overflow));
		const name = `batch-${String(++this.sequence).padStart(12, '0')}-${kept.length}-${Buffer.byteLength(JSON.stringify(kept))}.json`;
		const file = join(this.dir, name);
		const temp = `${file}.tmp`;
		const handle = await open(temp, 'w');
		try {
			await handle.writeFile(JSON.stringify(kept));
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, file);
		const bytes = (await stat(file)).size;
		this.segments.push({ name, seq: this.sequence, count: kept.length, bytes });
		await this.#enforce();
	}

	/** Oldest-first buckets up to `limit`; whole segment files are acknowledged together. */
	async take(limit = 5_000): Promise<SpoolTake> {
		await this.open();
		const buckets: MetricBucket[] = [];
		const segments: string[] = [];
		for (const segment of this.segments) {
			if (buckets.length > 0 && buckets.length + segment.count > limit) break;
			const parsed = await this.#readSegment(segment);
			if (!parsed) continue;
			buckets.push(...parsed);
			segments.push(segment.name);
		}
		return { buckets, segments };
	}

	/** Remove acknowledged segments. Missing files are already gone and are not an error. */
	async ack(segments: readonly string[]): Promise<void> {
		for (const name of segments) {
			await rm(join(this.dir, name), { force: true });
			const segment = this.segments.find((item) => item.name === name);
			if (segment) this.segments = this.segments.filter((item) => item !== segment);
		}
	}

	report(): TelemetrySpoolReport {
		return {
			queued: this.segments.reduce((sum, segment) => sum + segment.count, 0),
			bytes: this.segments.reduce((sum, segment) => sum + segment.bytes, 0),
			dropped: this.dropped,
			gaps: this.gaps.map((gap) => ({ ...gap })),
		};
	}

	async #readSegment(segment: Segment): Promise<MetricBucket[] | null> {
		try {
			const parsed = JSON.parse(await readFile(join(this.dir, segment.name), 'utf8')) as unknown;
			if (!Array.isArray(parsed)) return null;
			return parsed.filter(
				(bucket): bucket is MetricBucket =>
					Boolean(bucket) &&
					typeof bucket === 'object' &&
					typeof (bucket as MetricBucket).host === 'string' &&
					typeof (bucket as MetricBucket).bucket === 'string',
			);
		} catch {
			return null;
		}
	}

	async #enforce(): Promise<void> {
		while (this.segments.length > 0) {
			const overCount = this.segments.reduce((sum, segment) => sum + segment.count, 0) > this.maxBuckets;
			const overBytes = this.segments.reduce((sum, segment) => sum + segment.bytes, 0) > this.maxBytes;
			if (!overCount && !overBytes) return;
			const oldest = this.segments.shift()!;
			const buckets = await this.#readSegment(oldest);
			if (buckets && buckets.length > 0) await this.#recordGaps(gapsOf(buckets));
			await rm(join(this.dir, oldest.name), { force: true });
		}
	}

	async #recordGaps(gaps: readonly TelemetrySpoolGap[]): Promise<void> {
		if (gaps.length === 0) return;
		this.dropped += gaps.reduce((sum, gap) => sum + gap.buckets, 0);
		this.gaps = mergeGaps([...this.gaps, ...gaps]).slice(-this.maxGaps);
		const temp = join(this.dir, `${STATE_FILE}.tmp`);
		try {
			await writeFile(temp, JSON.stringify({ dropped: this.dropped, gaps: this.gaps }));
			await rename(temp, join(this.dir, STATE_FILE));
		} catch {
			// The spool still works; a lost gap record only loses the shaded band.
		}
	}
}
