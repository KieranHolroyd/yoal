<script lang="ts">
	/**
	 * Why? (docs/LOGS.md §8.3): opened from a histogram brush. Asks `/api/v1/logs/why` which field
	 * values are over-represented in the selection against the rest of the window, and lists them
	 * ranked by lift with share bars (selection vs the rest). Click a row to filter to the value,
	 * alt-click to exclude it.
	 */
	import type { LogScopeRef } from '@yoal/contracts';
	import { browser } from '$app/env';
	import { createQuery } from '@tanstack/svelte-query';
	import LightbulbIcon from '@lucide/svelte/icons/lightbulb';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import ZoomInIcon from '@lucide/svelte/icons/zoom-in';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText } from '#lib/query.js';
	import { percent } from './analysis.js';
	import { logKeys, whyLogs } from './api.js';
	import { formatDateTime, type LogTimeZone } from './time.js';

	let {
		q,
		scopes,
		from,
		to,
		selection,
		tz,
		onfilter,
		onzoom,
		onclose
	}: {
		q: string;
		scopes: LogScopeRef[];
		from: number;
		to: number;
		selection: { from: number; to: number };
		tz: LogTimeZone;
		onfilter: (field: string, value: string, exclude: boolean) => void;
		onzoom?: (from: number, to: number) => void;
		onclose: () => void;
	} = $props();

	const input = $derived({ q, scopes, from, to, selection, limit: 25 });
	const why = createQuery(() => ({
		queryKey: logKeys.why(input),
		queryFn: ({ signal }) => whyLogs(input, signal),
		enabled: browser,
		staleTime: 60_000,
		retry: false
	}));
	const result = $derived(why.data);

	function span(window: { from: number; to: number }): string {
		const a = formatDateTime(window.from, tz);
		const b = formatDateTime(window.to, tz);
		return `${a.slice(11, 16)}–${a.slice(0, 10) === b.slice(0, 10) ? b.slice(11, 16) : b.slice(0, 16)}`;
	}
</script>

<section class="border-b bg-muted/20" aria-label="Why? field differences">
	<header class="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
		<LightbulbIcon class="size-3.5 text-primary" />
		<span class="font-medium">Why?</span>
		<span class="text-muted-foreground">
			What is different about {span(selection)}{#if result}
				({result.selection.total.toLocaleString('en-GB')} lines) vs the rest of the window ({result.baseline.total.toLocaleString(
					'en-GB'
				)} lines){/if}
		</span>
		<div class="ml-auto flex items-center gap-1">
			{#if onzoom}
				<Button variant="ghost" size="xs" onclick={() => onzoom(selection.from, selection.to)}
					><ZoomInIcon />Zoom in</Button
				>
			{/if}
			<Button variant="ghost" size="icon-xs" aria-label="Close Why?" onclick={onclose}
				><XIcon /></Button
			>
		</div>
	</header>
	{#each result?.warnings ?? [] as warning (warning.code + warning.message)}
		<p class="flex items-center gap-2 px-3 pb-1 text-xs text-warning" role="status">
			<TriangleAlertIcon class="size-3.5 shrink-0" />{warning.message}
		</p>
	{/each}
	<div class="max-h-64 overflow-auto px-3 pb-2">
		{#if why.isPending}
			<p class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
				<Spinner />Comparing fields…
			</p>
		{:else if why.isError}
			<p class="py-3 text-xs text-destructive">
				{errorText(why.error, 'Could not explain the selection.')}
			</p>
		{:else if result && result.rows.length === 0}
			<p class="py-3 text-xs text-muted-foreground">
				No field value stands out: the selection looks like the rest of the window.
			</p>
		{:else if result}
			<ul class="flex flex-col gap-0.5">
				{#each result.rows as row (row.field + '\u0000' + row.value)}
					<li>
						<button
							type="button"
							class="grid w-full grid-cols-[minmax(0,1fr)_9rem_4rem] items-center gap-3 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent"
							title="Click: only {row.field}={row.value} · Alt-click: exclude it"
							onclick={(event) => onfilter(row.field, row.value, event.altKey)}
						>
							<span class="truncate font-mono">
								<span class="text-muted-foreground">{row.field}</span> =
								<span class="font-medium">{row.value}</span>
							</span>
							<span class="flex flex-col gap-0.5" aria-hidden="true">
								<span
									class="h-1.5 rounded-full bg-primary/80"
									style="width: {Math.max(2, row.selectionShare * 100)}%"
								></span>
								<span
									class="h-1.5 rounded-full bg-muted-foreground/40"
									style="width: {Math.max(2, row.baselineShare * 100)}%"
								></span>
							</span>
							<span class="text-right font-mono text-[11px] tabular-nums">
								{percent(row.selectionShare)}<span class="text-muted-foreground">
									vs {percent(row.baselineShare)}</span
								>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>
