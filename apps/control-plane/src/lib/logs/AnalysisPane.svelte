<script lang="ts">
	/**
	 * The Explorer's non-stream modes (docs/LOGS.md §8): Patterns and Analytics run the current
	 * filter through `/table` (`| patterns`, or the user's `| stats`, else a count by bin and level);
	 * Compare calls `/compare`. The Explorer owns the filter, scope, window and URL state; this pane
	 * owns the reads.
	 */
	import type { LogCapabilities, LogCompareBaseline, LogScopeRef } from '@yoal/contracts';
	import { browser } from '$app/env';
	import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
	import ChartNoAxesColumnIcon from '@lucide/svelte/icons/chart-no-axes-column';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText } from '#lib/query.js';
	import AnalyticsView from './AnalyticsView.svelte';
	import { logKeys, tableLogs } from './api.js';
	import CompareView from './CompareView.svelte';
	import PatternsView from './PatternsView.svelte';
	import { analysisQueryText } from './query-text.js';
	import { binFor, type LogTimeZone } from './time.js';

	let {
		mode,
		q,
		baseQuery = '',
		streamQuery,
		scopes,
		from,
		to,
		features,
		tz,
		baseline = $bindable<LogCompareBaseline>({ kind: 'previous' }),
		enabled = true,
		onfilter,
		onsample,
		onzoom,
		analyticsActions
	}: {
		mode: 'patterns' | 'analytics' | 'compare';
		/** The query as run, pipes included. */
		q: string;
		/** The page's preset filter, ANDed in. */
		baseQuery?: string;
		/** The filter (base + user, no pipes). */
		streamQuery: string;
		scopes: LogScopeRef[];
		from: number;
		to: number;
		features: LogCapabilities['features'] | undefined;
		tz: LogTimeZone;
		baseline?: LogCompareBaseline;
		enabled?: boolean;
		onfilter?: (field: string, value: string, exclude: boolean) => void;
		onsample?: (id: string) => void;
		onzoom?: (from: number, to: number) => void;
		/** Extra Analytics controls ("Add to dashboard"). */
		analyticsActions?: Snippet<[{ query: string }]>;
	} = $props();

	const LITE_REASON =
		'This needs the telemetry store (ClickHouse). Lite mode searches the SQLite hot tail only.';

	const span = $derived(to - from);
	const tableQueryText = $derived(
		analysisQueryText({ mode, q, baseQuery, streamQuery, bin: binFor(span) })
	);
	const unavailable = $derived.by(() => {
		if (!features) return null;
		if (mode === 'patterns' && !features.patterns) return LITE_REASON;
		if (mode === 'compare' && !features.compare) return LITE_REASON;
		return null;
	});
	const tableInput = $derived({ q: tableQueryText, scopes, from, to });
	const table = createQuery(() => ({
		queryKey: logKeys.table(tableInput),
		queryFn: ({ signal }) => tableLogs(tableInput, signal),
		enabled: browser && enabled && mode !== 'compare' && !unavailable && tableQueryText !== '',
		placeholderData: keepPreviousData,
		retry: false
	}));
	const result = $derived(table.data);
</script>

{#snippet actions()}{@render analyticsActions?.({ query: tableQueryText })}{/snippet}

<div class="min-h-80 overflow-auto">
	{#if unavailable}
		<div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
			<ChartNoAxesColumnIcon class="size-6 text-muted-foreground" />
			<p class="text-sm font-medium">Not available in lite mode</p>
			<p class="max-w-md text-sm text-muted-foreground">{unavailable}</p>
		</div>
	{:else if mode === 'compare'}
		<CompareView
			q={streamQuery}
			{scopes}
			{from}
			{to}
			bind:baseline
			{tz}
			{enabled}
			{onfilter}
			{onsample}
		/>
	{:else if table.isPending && !result}
		<div class="flex items-center justify-center gap-2 px-6 py-16 text-sm text-muted-foreground">
			<Spinner />Running…
		</div>
	{:else if table.isError}
		<p class="px-4 py-6 text-sm text-destructive">{errorText(table.error, 'The query failed.')}</p>
	{:else if result}
		<div
			class="flex items-center gap-2 border-b px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
		>
			<span class="min-w-0 flex-1 truncate" title={tableQueryText}>{tableQueryText}</span>
			{#if table.isFetching}<Spinner class="size-3" />{/if}
		</div>
		{#each result.warnings as warning (warning.code + warning.message)}
			<div
				class="flex items-center gap-2 border-b bg-warning/5 px-3 py-1.5 text-xs text-warning"
				role="status"
			>
				<TriangleAlertIcon class="size-3.5 shrink-0" />{warning.message}
			</div>
		{/each}
		{#if mode === 'patterns'}
			<PatternsView {result} windowFrom={from} {tz} {onfilter} {onsample} />
		{:else}
			<AnalyticsView
				{result}
				{from}
				{to}
				{tz}
				{onzoom}
				actions={analyticsActions ? actions : undefined}
			/>
		{/if}
	{/if}
</div>
