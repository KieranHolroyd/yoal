<script lang="ts">
	/**
	 * The Logs panel (docs/LOGS.md §9.2): a scoped log query's newest lines over the dashboard's
	 * range, read through `/api/v1/logs/search` with the viewer's own log access, with a link to the
	 * same view in the Explorer. Refreshes with the dashboard (the range changes) and on focus.
	 */
	import { builderLogsOf, logExplorerHref, logsBuilderOf, type PanelQuery } from '@yoal/contracts';
	import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
	import { browser } from '$app/env';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { errorText } from '#lib/query.js';
	import { logKeys, searchLogs } from '#lib/logs/api.js';
	import LogBody from '#lib/logs/LogBody.svelte';
	import { SEVERITY_TONES, serviceLabel } from '#lib/logs/record.js';
	import { formatClock } from '#lib/logs/time.js';
	import type { ResolvedRange } from '../time.js';

	let {
		query,
		range,
		limit = 100
	}: {
		query: PanelQuery | undefined;
		range: ResolvedRange | null;
		limit?: number;
	} = $props();

	const logs = $derived.by(() => {
		const builder = logsBuilderOf(query);
		return builder ? builderLogsOf(builder) : null;
	});
	const input = $derived(
		logs && range
			? {
					q: logs.q,
					scopes: logs.scopes,
					from: Math.floor(range.from),
					to: Math.floor(range.to),
					limit,
					order: 'desc' as const
				}
			: null
	);
	const data = createQuery(() => ({
		queryKey: [...logKeys.all, 'panel', input],
		queryFn: ({ signal }) => searchLogs(input!, signal),
		enabled: browser && input !== null,
		placeholderData: keepPreviousData,
		staleTime: 15_000,
		retry: false
	}));
	const records = $derived(data.data?.records ?? []);
	const explorer = $derived(
		logs && range
			? logExplorerHref({ q: logs.q, scopes: logs.scopes, from: range.from, to: range.to })
			: null
	);
</script>

{#if !logs}
	<p class="grid size-full place-items-center px-3 text-center text-xs text-muted-foreground">
		A Logs panel needs a log query: pick the Logs dataset.
	</p>
{:else if data.error && !data.data}
	<div
		class="flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center"
		role="alert"
	>
		<CircleAlertIcon class="size-4 text-destructive" />
		<p class="max-w-md text-xs break-words text-destructive">
			{errorText(data.error, 'Could not read the logs.')}
		</p>
	</div>
{:else if !data.data}
	<Skeleton class="size-full rounded-md" />
{:else}
	<div class="flex size-full min-h-0 flex-col">
		<ol class="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-5" aria-label="Log lines">
			{#each records as record (record.id)}
				{@const tone = SEVERITY_TONES[record.severity]}
				<li class="flex gap-2 border-b border-border/40 px-1 last:border-0 {tone.text}">
					<span class="shrink-0 text-muted-foreground" title={new Date(record.ts).toISOString()}
						>{formatClock(record.ts, 'utc')}</span
					>
					<span class="w-8 shrink-0 rounded px-0.5 text-center {tone.chip}">{tone.short}</span>
					<span class="w-20 shrink-0 truncate text-muted-foreground" title={serviceLabel(record)}
						>{serviceLabel(record)}</span
					>
					<LogBody
						body={record.body}
						ansi={record.ansi}
						wrap={false}
						class="min-w-0 flex-1 truncate"
					/>
				</li>
			{:else}
				<li class="grid h-full place-items-center py-6 text-sm text-muted-foreground">
					No lines in this range
				</li>
			{/each}
		</ol>
		{#if explorer}
			<!-- eslint-disable svelte/no-navigation-without-resolve -- /logs plus its query string -->
			<a
				href={explorer}
				class="mt-1 inline-flex shrink-0 items-center gap-1 self-end text-xs text-muted-foreground hover:text-foreground hover:underline"
				><ScrollTextIcon class="size-3.5" />Open in the Explorer</a
			>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
	</div>
{/if}
