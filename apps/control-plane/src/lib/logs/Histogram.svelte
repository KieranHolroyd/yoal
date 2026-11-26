<script lang="ts">
	/**
	 * Stacked time histogram (docs/LOGS.md §7.2): bars stacked by series (severity in the stream
	 * view), deploy/alert/node markers that link out, hover counts, and brush-to-zoom (drag a
	 * region; a plain click zooms to one bucket). Inline SVG, no chart dependency.
	 */
	import type { LogHistogramMarker } from '@yoal/contracts';
	import type { HistogramBucket, HistogramSeries } from './histogram.js';
	import { formatDateTime, type LogTimeZone } from './time.js';

	let {
		buckets,
		series,
		from,
		to,
		intervalMs,
		markers = [],
		tz,
		height = 88,
		loading = false,
		onzoom
	}: {
		buckets: HistogramBucket[];
		/** Bottom of the stack first. */
		series: HistogramSeries[];
		from: number;
		to: number;
		intervalMs: number;
		markers?: LogHistogramMarker[];
		tz: LogTimeZone;
		height?: number;
		loading?: boolean;
		onzoom?: (from: number, to: number) => void;
	} = $props();

	const PAD_LEFT = 34;
	const PAD_BOTTOM = 16;
	const PAD_TOP = 6;

	let width = $state(0);
	let brushStart = $state<number | null>(null);
	let brushEnd = $state<number | null>(null);
	let hoverX = $state<number | null>(null);

	const plotW = $derived(Math.max(1, width - PAD_LEFT - 4));
	const plotH = $derived(Math.max(1, height - PAD_BOTTOM - PAD_TOP));
	const span = $derived(Math.max(1, to - from));
	const max = $derived(Math.max(1, ...buckets.map((bucket) => bucket.total)));

	const xOf = (ts: number) => PAD_LEFT + ((ts - from) / span) * plotW;
	const tsOf = (x: number) =>
		from + ((Math.min(Math.max(x, PAD_LEFT), PAD_LEFT + plotW) - PAD_LEFT) / plotW) * span;

	const barWidth = $derived(
		Math.max(1, (intervalMs / span) * plotW - (intervalMs / span) * plotW * 0.18)
	);

	const bars = $derived(
		buckets.map((bucket) => {
			let y = PAD_TOP + plotH;
			const rects = series
				.map((item) => {
					const count = bucket.values[item.key] ?? 0;
					if (count <= 0) return null;
					const h = Math.max(1, (count / max) * plotH);
					y -= h;
					return { key: item.key, fill: item.fill, y, h };
				})
				.filter((rect): rect is NonNullable<typeof rect> => rect !== null);
			return { bucket, x: xOf(bucket.ts), rects };
		})
	);

	const ticks = $derived.by(() => {
		if (width < 80) return [];
		const count = Math.max(2, Math.min(6, Math.floor(plotW / 110)));
		const showDate = span > 86_400_000;
		return Array.from({ length: count + 1 }, (_, i) => {
			const ts = from + (span * i) / count;
			const label = formatDateTime(ts, tz);
			return {
				x: xOf(ts),
				label: showDate ? label.slice(5, 16) : label.slice(11, span <= 600_000 ? 19 : 16)
			};
		});
	});

	const hovered = $derived.by(() => {
		if (hoverX === null || brushStart !== null) return null;
		const ts = tsOf(hoverX);
		return buckets.find((bucket) => ts >= bucket.ts && ts < bucket.ts + intervalMs) ?? null;
	});

	const visibleMarkers = $derived(
		markers.filter((marker) => marker.ts >= from && marker.ts <= to).slice(0, 50)
	);

	function point(event: PointerEvent): number {
		const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
		return event.clientX - rect.left;
	}

	function down(event: PointerEvent) {
		if (event.button !== 0 || !onzoom) return;
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
		brushStart = point(event);
		brushEnd = brushStart;
	}

	function move(event: PointerEvent) {
		hoverX = point(event);
		if (brushStart !== null) brushEnd = hoverX;
	}

	function up(event: PointerEvent) {
		if (brushStart === null || brushEnd === null || !onzoom) return;
		const a = Math.min(brushStart, brushEnd);
		const b = Math.max(brushStart, brushEnd);
		brushStart = null;
		brushEnd = null;
		(event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
		if (b - a > 4) {
			onzoom(tsOf(a), tsOf(b));
			return;
		}
		const ts = tsOf(a);
		const bucket = buckets.find((item) => ts >= item.ts && ts < item.ts + intervalMs);
		if (bucket && bucket.total > 0) onzoom(bucket.ts, bucket.ts + intervalMs);
	}

	const markerTone: Record<LogHistogramMarker['kind'], string> = {
		deploy: 'stroke-primary fill-primary',
		alert: 'stroke-destructive fill-destructive',
		node: 'stroke-warning fill-warning'
	};
</script>

<div class="relative select-none" bind:clientWidth={width} style="height: {height}px">
	{#if width > 0}
		<svg
			{width}
			{height}
			class="block touch-none {onzoom ? 'cursor-crosshair' : ''}"
			role="img"
			aria-label="Log volume over time{onzoom ? '; drag to zoom' : ''}"
			onpointerdown={down}
			onpointermove={move}
			onpointerup={up}
			onpointerleave={() => (hoverX = null)}
		>
			<!-- grid: max and half -->
			<line
				x1={PAD_LEFT}
				x2={PAD_LEFT + plotW}
				y1={PAD_TOP}
				y2={PAD_TOP}
				class="stroke-border"
				stroke-dasharray="2 3"
			/>
			<line
				x1={PAD_LEFT}
				x2={PAD_LEFT + plotW}
				y1={PAD_TOP + plotH}
				y2={PAD_TOP + plotH}
				class="stroke-border"
			/>
			<text
				x={PAD_LEFT - 4}
				y={PAD_TOP + 8}
				text-anchor="end"
				class="fill-muted-foreground text-[10px] tabular-nums"
				>{max >= 1000 ? `${(max / 1000).toFixed(max >= 10_000 ? 0 : 1)}k` : max}</text
			>
			<text
				x={PAD_LEFT - 4}
				y={PAD_TOP + plotH}
				text-anchor="end"
				class="fill-muted-foreground text-[10px]">0</text
			>

			<g class={loading ? 'opacity-50' : ''}>
				{#each bars as bar (bar.bucket.ts)}
					{#each bar.rects as rect (rect.key)}
						<rect
							x={bar.x}
							y={rect.y}
							width={barWidth}
							height={rect.h}
							class={rect.fill}
							rx="0.5"
						/>
					{/each}
				{/each}
			</g>

			{#each visibleMarkers as marker, index (index)}
				{@const x = xOf(marker.ts)}
				<!-- eslint-disable svelte/no-navigation-without-resolve -- the server builds marker links -->
				<a
					href={marker.href ?? undefined}
					aria-label={marker.label}
					onpointerdown={(event) => event.stopPropagation()}
				>
					<title>{marker.label} · {formatDateTime(marker.ts, tz)}</title>
					<line
						x1={x}
						x2={x}
						y1={PAD_TOP}
						y2={PAD_TOP + plotH}
						class={markerTone[marker.kind]}
						stroke-dasharray="3 2"
						stroke-width="1"
						fill="none"
					/>
					<path
						d="M {x - 4} {PAD_TOP - 4} L {x + 4} {PAD_TOP - 4} L {x} {PAD_TOP + 2} Z"
						class={markerTone[marker.kind]}
					/>
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/each}

			{#if brushStart !== null && brushEnd !== null}
				<rect
					x={Math.min(brushStart, brushEnd)}
					y={PAD_TOP}
					width={Math.abs(brushEnd - brushStart)}
					height={plotH}
					class="fill-primary/15 stroke-primary/50"
				/>
			{/if}
			{#if hoverX !== null && hoverX >= PAD_LEFT && brushStart === null}
				<line
					x1={hoverX}
					x2={hoverX}
					y1={PAD_TOP}
					y2={PAD_TOP + plotH}
					class="stroke-muted-foreground/40"
				/>
			{/if}

			{#each ticks as tick, index (index)}
				<text
					x={tick.x}
					y={height - 3}
					text-anchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'}
					class="fill-muted-foreground text-[10px] tabular-nums">{tick.label}</text
				>
			{/each}
		</svg>
		{#if hovered && hoverX !== null}
			<div
				class="pointer-events-none absolute top-1 z-10 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
				style="left: {Math.min(Math.max(hoverX + 8, 0), Math.max(0, width - 170))}px"
			>
				<p class="font-mono text-[11px] text-muted-foreground">{formatDateTime(hovered.ts, tz)}</p>
				<p class="font-medium tabular-nums">{hovered.total.toLocaleString('en-GB')} lines</p>
				{#each [...series].reverse() as item (item.key)}
					{#if hovered.values[item.key]}
						<p class="flex items-center gap-1.5 tabular-nums">
							<span class="size-2 rounded-sm {item.swatch}"></span>{item.label}
							<span class="ml-auto pl-3">{hovered.values[item.key]?.toLocaleString('en-GB')}</span>
						</p>
					{/if}
				{/each}
			</div>
		{/if}
	{/if}
</div>
