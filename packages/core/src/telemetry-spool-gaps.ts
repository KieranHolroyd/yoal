import type { TelemetrySpoolGap, TelemetrySpoolReport } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { parseJson } from './util.ts';

/**
 * The dashboard's record of what each agent's bounded telemetry spool could not keep (HA-PLAN
 * H28/W12). The spool itself is on the node; the control plane keeps only the gap ranges it was
 * told about, so a traffic chart can shade minutes that are genuinely missing instead of drawing
 * them as zero requests.
 *
 * One `settings` row, no migration: this is small, telemetry-only state and never part of desired
 * state. Gaps older than `RETENTION_MS` are pruned; a node's last report is kept even when it is
 * healthy (all counters zero) so the HA page can show the spool is working.
 */
const SETTINGS_KEY = 'telemetry.spool_gaps';
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_GAPS = 500;

interface NodeSpoolState {
	/** When the control plane last heard from the node. */
	at: number;
	queued: number;
	bytes: number;
	dropped: number;
	gaps: TelemetrySpoolGap[];
}

interface Stored {
	nodes: Record<string, NodeSpoolState>;
}

export interface TelemetrySpoolNodeView extends NodeSpoolState {
	nodeId: string;
}

/**
 * The pair of epoch-ms bounds the traffic chart asks for. Matching is overlap, so a range that
 * starts before the window still shades the visible part of the loss.
 */
function overlaps(gap: TelemetrySpoolGap, fromMs: number, toMs: number): boolean {
	return gap.from < toMs && gap.to > fromMs;
}

/** Merge overlapping/adjacent ranges per host. Buckets add; an un-attributed `*` stays separate. */
export function mergeTelemetryGaps(gaps: readonly TelemetrySpoolGap[]): TelemetrySpoolGap[] {
	const sorted = [...gaps]
		.filter((gap) => gap.to > gap.from && gap.host.length > 0)
		.sort((a, b) => a.host.localeCompare(b.host) || a.from - b.from || a.to - b.to);
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

export class TelemetrySpoolGapService {
	constructor(private readonly ctx: CoreContext) {}

	/** Record one agent report. Called from the telemetry ingest route, never on the request path. */
	record(nodeId: string, report: TelemetrySpoolReport): void {
		const stored = this.#read();
		const previous = stored.nodes[nodeId];
		const now = this.ctx.now();
		// The agent replays its cumulative gap list on every flush: replacing, not merging with the
		// previous list, keeps `buckets` from being counted once per POST.
		const gaps = mergeTelemetryGaps(report.gaps.filter((gap) => gap.to <= now + 60_000))
			.filter((gap) => gap.to >= now - RETENTION_MS)
			.slice(-MAX_GAPS);
		stored.nodes[nodeId] = {
			at: now,
			queued: report.queued,
			bytes: report.bytes,
			// The agent's counter is since its spool was created; keep the largest seen so a
			// restart cannot make the dashboard forget earlier loss.
			dropped: Math.max(previous?.dropped ?? 0, report.dropped),
			gaps,
		};
		this.#prune(stored, now);
		this.#write(stored);
	}

	/**
	 * Gap ranges for a set of hosts and a window, merged across nodes. A null host list means the
	 * fleet (the overview chart), which is the only caller that may see every host.
	 */
	gapsFor(hosts: readonly string[] | null, fromMs: number, toMs: number): TelemetrySpoolGap[] {
		if (toMs <= fromMs) return [];
		const wanted = hosts ? new Set(hosts) : null;
		const stored = this.#read();
		const gaps: TelemetrySpoolGap[] = [];
		for (const state of Object.values(stored.nodes)) {
			for (const gap of state.gaps) {
				if (!overlaps(gap, fromMs, toMs)) continue;
				if (wanted && gap.host !== '*' && !wanted.has(gap.host)) continue;
				gaps.push({
					host: gap.host,
					from: Math.max(gap.from, fromMs),
					to: Math.min(gap.to, toMs),
					buckets: gap.buckets,
				});
			}
		}
		return mergeTelemetryGaps(gaps).sort((a, b) => a.from - b.from || a.host.localeCompare(b.host));
	}

	/** Every node's last spool report, newest first (the HA status page). */
	nodes(): TelemetrySpoolNodeView[] {
		const stored = this.#read();
		return Object.entries(stored.nodes)
			.map(([nodeId, state]) => ({ nodeId, ...state, gaps: [...state.gaps] }))
			.sort((a, b) => b.at - a.at);
	}

	#read(): Stored {
		try {
			const row = this.ctx.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
			const parsed = parseJson<Partial<Stored>>(row?.value, {});
			return { nodes: parsed.nodes && typeof parsed.nodes === 'object' ? parsed.nodes : {} };
		} catch {
			return { nodes: {} };
		}
	}

	#write(stored: Stored): void {
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
			[SETTINGS_KEY, JSON.stringify(stored), now],
		);
	}

	#prune(stored: Stored, now: number): void {
		for (const [nodeId, state] of Object.entries(stored.nodes)) {
			const gaps = state.gaps.filter((gap) => gap.to >= now - RETENTION_MS).slice(-MAX_GAPS);
			// A node that has not reported for the retention window is no longer useful state.
			if (state.at < now - RETENTION_MS) delete stored.nodes[nodeId];
			else stored.nodes[nodeId] = { ...state, gaps };
		}
	}
}
