<script lang="ts">
	/**
	 * The Patterns, Analytics and Compare tabs (docs/LOGS.md §8), Wave 1 minimal: they run the
	 * current filter through `/table` with `| patterns` or `| stats`, and render the answer as a
	 * table (with a stacked chart when it is a time series). Wave 2 finishes them.
	 */
	import type { LogTableResult } from '@yoal/contracts';
	import ChartNoAxesColumnIcon from '@lucide/svelte/icons/chart-no-axes-column';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import Histogram from './Histogram.svelte';
	import { comparePatterns, tableToSeries, templateParts } from './table.js';
	import { formatDateTime, type LogTimeZone } from './time.js';

	let {
		mode,
		result,
		previous,
		loading = false,
		error = null,
		unavailable = null,
		tz,
		query,
		compareLabel = 'previous window',
		onfilter
	}: {
		mode: 'patterns' | 'analytics' | 'compare';
		result: LogTableResult | undefined;
		/** Compare: the earlier window. */
		previous?: LogTableResult;
		loading?: boolean;
		error?: string | null;
		/** Why this tab cannot run here (lite mode), if it cannot. */
		unavailable?: string | null;
		tz: LogTimeZone;
		/** The pipe query this tab ran, shown so it can be copied into the editor. */
		query: string;
		compareLabel?: string;
		onfilter?: (field: string, value: string, exclude: boolean) => void;
	} = $props();

	const chart = $derived(mode === 'analytics' && result ? tableToSeries(result) : null);
	const compared = $derived(
		mode === 'compare' && result && previous ? comparePatterns(result, previous) : []
	);
	const patternIdIndex = $derived(
		result?.columns.findIndex((column) => /^(pattern|pattern_id|patternId)$/.test(column.name)) ??
			-1
	);
	const templateIndex = $derived(
		result?.columns.findIndex(
			(column) => /template|pattern/.test(column.name) && column.type === 'string'
		) ?? -1
	);

	function cell(value: string | number | null, type: 'string' | 'number' | 'time'): string {
		if (value === null || value === undefined) return '—';
		if (type === 'time') {
			const ms = typeof value === 'number' ? value : Date.parse(String(value));
			return Number.isFinite(ms) ? formatDateTime(ms, tz) : String(value);
		}
		if (type === 'number' && typeof value === 'number')
			return value.toLocaleString('en-GB', { maximumFractionDigits: 3 });
		return String(value);
	}

	const changeTone: Record<string, string> = {
		new: 'bg-info/10 text-info',
		rising: 'bg-warning/10 text-warning',
		gone: 'bg-muted text-muted-foreground',
		falling: 'bg-success/10 text-success',
		steady: 'text-muted-foreground'
	};
</script>

<div class="min-h-80 overflow-auto">
	{#if unavailable}
		<div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
			<ChartNoAxesColumnIcon class="size-6 text-muted-foreground" />
			<p class="text-sm font-medium">Not available in lite mode</p>
			<p class="max-w-md text-sm text-muted-foreground">{unavailable}</p>
		</div>
	{:else if loading && !result}
		<div class="flex items-center justify-center gap-2 px-6 py-16 text-sm text-muted-foreground">
			<Spinner />Running…
		</div>
	{:else if error}
		<p class="px-4 py-6 text-sm text-destructive">{error}</p>
	{:else if result}
		<div class="border-b px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{query}</div>
		{#if chart}
			<div class="border-b px-3 pt-2 pb-1">
				<Histogram
					buckets={chart.buckets}
					series={chart.series}
					from={chart.from}
					to={chart.to}
					intervalMs={chart.intervalMs}
					{tz}
					height={140}
				/>
				<div class="flex flex-wrap gap-x-3 gap-y-1 py-1 text-xs text-muted-foreground">
					{#each chart.series.slice(0, 8) as item (item.key)}
						<span class="inline-flex items-center gap-1.5"
							><span class="size-2 rounded-sm {item.swatch}"></span>{item.label}</span
						>
					{/each}
				</div>
			</div>
		{/if}
		{#if mode === 'compare'}
			<Table.Root class="text-xs">
				<Table.Header>
					<Table.Row>
						<Table.Head>Pattern</Table.Head>
						<Table.Head class="text-right">Now</Table.Head>
						<Table.Head class="text-right">{compareLabel}</Table.Head>
						<Table.Head class="text-right">Change</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each compared.slice(0, 200) as row (row.key)}
						<Table.Row>
							<Table.Cell class="max-w-[40rem] font-mono whitespace-normal">
								{#each templateParts(row.key) as part, index (index)}{#if part.placeholder}<span
											class="rounded bg-info/10 px-0.5 text-info">{part.text}</span
										>{:else}{part.text}{/if}{/each}
							</Table.Cell>
							<Table.Cell class="text-right tabular-nums"
								>{row.current.toLocaleString('en-GB')}</Table.Cell
							>
							<Table.Cell class="text-right text-muted-foreground tabular-nums"
								>{row.previous.toLocaleString('en-GB')}</Table.Cell
							>
							<Table.Cell class="text-right">
								<span class="rounded px-1.5 py-0.5 text-[11px] font-medium {changeTone[row.change]}"
									>{row.change}</span
								>
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row
							><Table.Cell colspan={4} class="py-6 text-center text-muted-foreground"
								>No patterns in either window.</Table.Cell
							></Table.Row
						>
					{/each}
				</Table.Body>
			</Table.Root>
		{:else}
			<Table.Root class="text-xs">
				<Table.Header>
					<Table.Row>
						{#each result.columns as column (column.name)}
							<Table.Head class={column.type === 'number' ? 'text-right' : ''}
								>{column.name}</Table.Head
							>
						{/each}
						{#if mode === 'patterns' && patternIdIndex >= 0 && onfilter}<Table.Head
							></Table.Head>{/if}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each result.rows.slice(0, 1_000) as row, r (r)}
						<Table.Row>
							{#each result.columns as column, c (column.name)}
								<Table.Cell
									class="{column.type === 'number' ? 'text-right tabular-nums' : 'font-mono'} {c ===
									templateIndex
										? 'max-w-[40rem] whitespace-normal'
										: ''}"
								>
									{#if mode === 'patterns' && c === templateIndex}
										{#each templateParts(String(row[c] ?? '')) as part, index (index)}{#if part.placeholder}<span
													class="rounded bg-info/10 px-0.5 text-info">{part.text}</span
												>{:else}{part.text}{/if}{/each}
									{:else}
										{cell(row[c] ?? null, column.type)}
									{/if}
								</Table.Cell>
							{/each}
							{#if mode === 'patterns' && patternIdIndex >= 0 && onfilter}
								{@const id = String(row[patternIdIndex] ?? '')}
								<Table.Cell class="text-right whitespace-nowrap">
									<Button variant="ghost" size="xs" onclick={() => onfilter('pattern', id, false)}
										>Only this</Button
									>
									<Button variant="ghost" size="xs" onclick={() => onfilter('pattern', id, true)}
										>Hide</Button
									>
								</Table.Cell>
							{/if}
						</Table.Row>
					{:else}
						<Table.Row>
							<Table.Cell
								colspan={result.columns.length + 1}
								class="py-6 text-center text-muted-foreground">No rows.</Table.Cell
							>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	{/if}
</div>
