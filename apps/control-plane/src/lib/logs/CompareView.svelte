<script lang="ts">
	/**
	 * The Compare tab (docs/LOGS.md §8.2): the current filter's patterns against a baseline window,
	 * from `/api/v1/logs/compare`. The baseline picker offers the previous window, the same time
	 * yesterday or last week, "before a deploy" (deploys from the histogram markers) and a custom
	 * range; the choice lives in the URL (`baseline=…`). Rows come grouped as new, rising, falling,
	 * gone, with steady ones folded away.
	 */
	import type { LogCompareBaseline, LogCompareRow, LogScopeRef } from '@yoal/contracts';
	import { untrack } from 'svelte';
	import { browser } from '$app/env';
	import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FilterIcon from '@lucide/svelte/icons/funnel';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ScanSearchIcon from '@lucide/svelte/icons/scan-search';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { errorText } from '#lib/query.js';
	import {
		BASELINE_PRESETS,
		baselineKey,
		baselineLabel,
		compareGroups,
		deployIdOf,
		ratioLabel
	} from './analysis.js';
	import { compareLogs, histogramLogs, logKeys } from './api.js';
	import Popover from './Popover.svelte';
	import Template from './Template.svelte';
	import { formatDateTime, parseDateTimeInput, type LogTimeZone } from './time.js';

	let {
		q,
		scopes,
		from,
		to,
		baseline = $bindable<LogCompareBaseline>({ kind: 'previous' }),
		tz,
		enabled = true,
		onfilter,
		onsample
	}: {
		/** The filter being compared (pipes are ignored by the server). */
		q: string;
		scopes: LogScopeRef[];
		from: number;
		to: number;
		baseline?: LogCompareBaseline;
		tz: LogTimeZone;
		enabled?: boolean;
		onfilter?: (field: string, value: string, exclude: boolean) => void;
		onsample?: (id: string) => void;
	} = $props();

	let customOpen = $state(false);
	let customFrom = $state('');
	let customTo = $state('');
	let customError = $state<string | null>(null);
	let showSteady = $state(false);

	const input = $derived({ q, scopes, from, to, baseline, limit: 500 });
	const compare = createQuery(() => ({
		queryKey: logKeys.compare(input),
		queryFn: ({ signal }) => compareLogs(input, signal),
		enabled: browser && enabled,
		placeholderData: keepPreviousData,
		staleTime: 30_000,
		retry: false
	}));

	// Deploys to compare against: the markers of the window (and the day before it).
	const markerInput = $derived({ q: '', scopes, from: from - 86_400_000, to, buckets: 10 });
	const markersQuery = createQuery(() => ({
		queryKey: logKeys.histogram(markerInput),
		queryFn: ({ signal }) => histogramLogs(markerInput, signal),
		enabled: browser && enabled,
		staleTime: 60_000,
		retry: false
	}));
	const deploys = $derived(
		(markersQuery.data?.markers ?? [])
			.filter((marker) => marker.kind === 'deploy' && deployIdOf(marker))
			.sort((a, b) => b.ts - a.ts)
			.slice(0, 20)
	);

	const result = $derived(compare.data);
	const groups = $derived(result ? compareGroups(result) : []);
	const changed = $derived(groups.filter((group) => group.change !== 'steady'));
	const steady = $derived(groups.find((group) => group.change === 'steady'));
	const label = $derived(baselineLabel(baseline, tz, markersQuery.data?.markers ?? []));
	const current = $derived(baselineKey(baseline));

	const tone: Record<string, string> = {
		new: 'bg-info/10 text-info',
		rising: 'bg-warning/10 text-warning',
		falling: 'bg-success/10 text-success',
		gone: 'bg-muted text-muted-foreground',
		steady: 'text-muted-foreground'
	};

	// Seed the custom fields each time the popover opens: the current range, else the previous window.
	$effect(() => {
		if (!customOpen) return;
		untrack(() => {
			const start = baseline.kind === 'range' ? baseline.from : from - (to - from);
			const end = baseline.kind === 'range' ? baseline.to : from;
			customFrom = formatDateTime(start, tz);
			customTo = formatDateTime(end, tz);
			customError = null;
		});
	});

	function applyCustom() {
		const a = parseDateTimeInput(customFrom, tz);
		const b = parseDateTimeInput(customTo, tz);
		if (a === null || b === null || a === b) {
			customError = 'Enter two different times, e.g. 2026-11-25 14:00.';
			return;
		}
		baseline = { kind: 'range', from: Math.min(a, b), to: Math.max(a, b) };
		customOpen = false;
	}

	function span(window: { from: number; to: number }): string {
		const a = formatDateTime(window.from, tz);
		const b = formatDateTime(window.to, tz);
		return `${a} → ${a.slice(0, 10) === b.slice(0, 10) ? b.slice(11) : b}`;
	}
</script>

<div class="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
	<span class="text-muted-foreground">Compare with</span>
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="outline" size="sm" class="text-xs"
					>{label}<ChevronDownIcon /></Button
				>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="w-72">
			{#each BASELINE_PRESETS as preset (preset.key)}
				<DropdownMenu.CheckboxItem
					checked={current === preset.key}
					onCheckedChange={() => (baseline = preset.baseline)}
				>
					{preset.label}
				</DropdownMenu.CheckboxItem>
			{/each}
			<DropdownMenu.Separator />
			<DropdownMenu.Label class="text-xs font-normal text-muted-foreground"
				>Before and after a deploy</DropdownMenu.Label
			>
			{#each deploys as marker (marker.href)}
				{@const id = deployIdOf(marker)!}
				<DropdownMenu.CheckboxItem
					checked={baseline.kind === 'deploy' && baseline.deploymentId === id}
					onCheckedChange={() => (baseline = { kind: 'deploy', deploymentId: id })}
				>
					<RocketIcon class="text-primary" />
					<span class="truncate">{marker.label}</span>
					<span class="ml-auto font-mono text-[10px] text-muted-foreground"
						>{formatDateTime(marker.ts, tz).slice(5, 16)}</span
					>
				</DropdownMenu.CheckboxItem>
			{:else}
				<DropdownMenu.Item disabled class="text-xs"
					>No deploys in or just before this window</DropdownMenu.Item
				>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
	<Popover bind:open={customOpen} align="start" class="w-80">
		{#snippet trigger({ props })}
			<Button
				{...props}
				variant={baseline.kind === 'range' ? 'secondary' : 'ghost'}
				size="sm"
				class="text-xs"
				title="Compare with a window you choose">Custom…</Button
			>
		{/snippet}
		<form
			class="flex flex-col gap-2 text-xs"
			onsubmit={(event) => {
				event.preventDefault();
				applyCustom();
			}}
		>
			<p class="font-medium">Baseline window ({tz === 'utc' ? 'UTC' : 'local time'})</p>
			<Input bind:value={customFrom} aria-label="Baseline from" class="h-8 font-mono text-xs" />
			<Input bind:value={customTo} aria-label="Baseline to" class="h-8 font-mono text-xs" />
			{#if customError}<p class="text-destructive">{customError}</p>{/if}
			<Button type="submit" size="sm">Compare</Button>
		</form>
	</Popover>
	{#if result}
		<span class="ml-auto font-mono text-[11px] text-muted-foreground">
			now {span(result.current)} · {result.current.total.toLocaleString('en-GB')} lines — baseline {span(
				result.baseline
			)} · {result.baseline.total.toLocaleString('en-GB')} lines
		</span>
	{/if}
</div>

{#each result?.warnings ?? [] as warning (warning.code + warning.message)}
	<div
		class="flex items-center gap-2 border-b bg-warning/5 px-3 py-1.5 text-xs text-warning"
		role="status"
	>
		<TriangleAlertIcon class="size-3.5 shrink-0" />{warning.message}
	</div>
{/each}

{#if compare.isPending && !result}
	<div class="flex items-center justify-center gap-2 px-6 py-16 text-sm text-muted-foreground">
		<Spinner />Comparing…
	</div>
{:else if compare.isError}
	<p class="px-4 py-6 text-sm text-destructive">
		{errorText(compare.error, 'The comparison failed.')}
	</p>
{:else if result}
	{#snippet rows(list: LogCompareRow[])}
		{#each list as row (row.patternId)}
			<Table.Row>
				<Table.Cell class="max-w-[40rem] font-mono whitespace-normal"
					><Template template={row.template} /></Table.Cell
				>
				<Table.Cell class="text-right tabular-nums"
					>{row.current.toLocaleString('en-GB')}</Table.Cell
				>
				<Table.Cell class="text-right text-muted-foreground tabular-nums"
					>{row.baseline.toLocaleString('en-GB')}</Table.Cell
				>
				<Table.Cell class="text-right">
					<span
						class="rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums {tone[row.change]}"
						>{ratioLabel(row)}</span
					>
				</Table.Cell>
				<Table.Cell class="text-right whitespace-nowrap">
					{#if row.sampleId && onsample}
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Open an example line"
							title="Open an example line"
							onclick={() => onsample(row.sampleId!)}><ScanSearchIcon /></Button
						>
					{/if}
					{#if onfilter}
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Only this pattern"
							title="Only this pattern"
							onclick={() => onfilter('pattern', row.patternId, false)}><FilterIcon /></Button
						>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Hide this pattern"
							title="Hide this pattern"
							onclick={() => onfilter('pattern', row.patternId, true)}><EyeOffIcon /></Button
						>
					{/if}
				</Table.Cell>
			</Table.Row>
		{/each}
	{/snippet}
	<Table.Root class="text-xs">
		<Table.Header>
			<Table.Row>
				<Table.Head>Pattern</Table.Head>
				<Table.Head class="text-right">Now</Table.Head>
				<Table.Head class="text-right">Baseline</Table.Head>
				<Table.Head class="text-right" title="Change in lines per minute">Change</Table.Head>
				<Table.Head></Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each changed as group (group.change)}
				<Table.Row class="bg-muted/40 hover:bg-muted/40">
					<Table.Cell colspan={5} class="py-1 text-[11px] font-medium">
						<span class="rounded px-1.5 py-0.5 {tone[group.change]}">{group.label}</span>
						<span class="ml-1 text-muted-foreground"
							>{group.rows.length.toLocaleString('en-GB')}</span
						>
					</Table.Cell>
				</Table.Row>
				{@render rows(group.rows)}
			{/each}
			{#if steady}
				<Table.Row class="bg-muted/40 hover:bg-muted/40">
					<Table.Cell colspan={5} class="py-1 text-[11px]">
						<button
							type="button"
							class="inline-flex items-center gap-1 font-medium text-muted-foreground"
							onclick={() => (showSteady = !showSteady)}
						>
							{#if showSteady}<ChevronDownIcon class="size-3" />{:else}<ChevronRightIcon
									class="size-3"
								/>{/if}
							Steady {steady.rows.length.toLocaleString('en-GB')}
						</button>
					</Table.Cell>
				</Table.Row>
				{#if showSteady}{@render rows(steady.rows)}{/if}
			{/if}
			{#if groups.length === 0}
				<Table.Row>
					<Table.Cell colspan={5} class="py-6 text-center text-muted-foreground"
						>No patterns in either window.</Table.Cell
					>
				</Table.Row>
			{:else if changed.length === 0}
				<Table.Row>
					<Table.Cell colspan={5} class="py-4 text-center text-muted-foreground"
						>Nothing changed: every pattern is steady.</Table.Cell
					>
				</Table.Row>
			{/if}
		</Table.Body>
	</Table.Root>
{/if}
