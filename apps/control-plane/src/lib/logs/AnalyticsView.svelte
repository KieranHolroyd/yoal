<script lang="ts">
	/**
	 * The Analytics tab (docs/LOGS.md §8.4): a `| stats` answer drawn with the D101 dashboard panel
	 * renderers. Grouped by `bin()` it is a time series (lines or stacked bars), otherwise a bar
	 * chart by category when it is small enough, and always the table underneath.
	 */
	import type { LogTableResult } from '@yoal/contracts';
	import type { Snippet } from 'svelte';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import PanelViz from '../../routes/(dashboard)/dashboards/_lib/viz/PanelViz.svelte';
	import { analyticsShape, toQueryResult } from './analysis.js';
	import { formatDateTime, type LogTimeZone } from './time.js';

	let {
		result,
		from,
		to,
		tz,
		onzoom,
		actions
	}: {
		result: LogTableResult;
		from: number;
		to: number;
		tz: LogTimeZone;
		/** Drag across a time series to zoom the Explorer's window. */
		onzoom?: (from: number, to: number) => void;
		/** Extra controls next to the chart switch (e.g. "Add to dashboard"). */
		actions?: Snippet;
	} = $props();

	let draw = $state<'line' | 'bars'>('bars');

	const shape = $derived(analyticsShape(result));
	const queryResult = $derived(toQueryResult(result));
	// The chart's x domain follows the bins when they spill past the window (a bin that started
	// before `from`), so no bar is clipped.
	const range = $derived.by(() => {
		const timeIndex = result.columns.findIndex((column) => column.type === 'time');
		if (timeIndex < 0) return { from, to };
		const times = result.rows.map((row) => Number(row[timeIndex])).filter(Number.isFinite);
		if (times.length === 0) return { from, to };
		return {
			from: Math.min(from, ...times),
			to: Math.max(to, Math.max(...times) + queryResult.intervalSeconds * 1_000)
		};
	});
	const panel = $derived({
		title: 'Log analytics',
		viz:
			shape === 'time'
				? draw === 'bars'
					? ('bar' as const)
					: ('timeseries' as const)
				: ('bar' as const),
		options: {
			legend: 'bottom' as const,
			draw: draw === 'bars' ? ('stacked' as const) : ('line' as const)
		}
	});

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
</script>

{#if shape !== 'table' || actions}
	<div class="border-b px-3 pt-2 pb-1">
		<div class="flex items-center gap-2 pb-1">
			{#if shape === 'time'}
				<ToggleGroup.Root
					type="single"
					size="sm"
					variant="outline"
					value={draw}
					onValueChange={(value) => value && (draw = value as 'line' | 'bars')}
					aria-label="Chart style"
				>
					<ToggleGroup.Item value="bars" class="px-2 text-xs">Bars</ToggleGroup.Item>
					<ToggleGroup.Item value="line" class="px-2 text-xs">Lines</ToggleGroup.Item>
				</ToggleGroup.Root>
			{/if}
			<div class="ml-auto flex items-center gap-1">{@render actions?.()}</div>
		</div>
		{#if shape !== 'table'}
			<div class="h-56">
				<PanelViz {panel} result={queryResult} {range} {onzoom} />
			</div>
		{/if}
	</div>
{/if}
<Table.Root class="text-xs">
	<Table.Header>
		<Table.Row>
			{#each result.columns as column (column.name)}
				<Table.Head class={column.type === 'number' ? 'text-right' : ''}>{column.name}</Table.Head>
			{/each}
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each result.rows.slice(0, 1_000) as row, r (r)}
			<Table.Row>
				{#each result.columns as column, c (column.name)}
					<Table.Cell
						class={column.type === 'number'
							? 'text-right tabular-nums'
							: 'max-w-[40rem] font-mono whitespace-normal'}
					>
						{cell(row[c] ?? null, column.type)}
					</Table.Cell>
				{/each}
			</Table.Row>
		{:else}
			<Table.Row>
				<Table.Cell
					colspan={Math.max(1, result.columns.length)}
					class="py-6 text-center text-muted-foreground">No rows.</Table.Cell
				>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
