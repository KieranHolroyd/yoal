import type { LogHistogramResult } from '@yoal/contracts';
import { SEVERITY_ORDER, SEVERITY_TONES } from './record.js';

/** One bar of the stacked histogram: counts per series key. */
export interface HistogramBucket {
	ts: number;
	values: Record<string, number>;
	total: number;
}

export interface HistogramSeries {
	key: string;
	label: string;
	/** SVG fill class, e.g. `fill-destructive/80`. */
	fill: string;
	/** Legend swatch class. */
	swatch: string;
}

/** Severity series, least severe at the bottom of the stack so errors sit on top. */
export const SEVERITY_SERIES: HistogramSeries[] = [...SEVERITY_ORDER].reverse().map((severity) => ({
	key: severity,
	label: severity,
	fill: SEVERITY_TONES[severity].fill,
	swatch: SEVERITY_TONES[severity].swatch
}));

export function histogramBuckets(result: LogHistogramResult): HistogramBucket[] {
	return result.buckets.map((bucket) => ({
		ts: bucket.ts,
		total: bucket.total,
		values: { ...bucket.counts } as Record<string, number>
	}));
}
