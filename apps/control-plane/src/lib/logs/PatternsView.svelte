<script lang="ts">
	/**
	 * The Patterns tab (docs/LOGS.md §8.1): `| patterns` over the current filter. Each template has
	 * its placeholders highlighted, a count and share, a sparkline over the window, first seen (with
	 * a "new" badge when that is inside the window), and "only this" / "hide" actions that add
	 * `pattern:<id>` / `-pattern:<id>` to the query.
	 */
	import type { LogTableResult } from '@yoal/contracts';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FilterIcon from '@lucide/svelte/icons/funnel';
	import ScanSearchIcon from '@lucide/svelte/icons/scan-search';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { patternRows, percent } from './analysis.js';
	import Sparkline from './Sparkline.svelte';
	import Template from './Template.svelte';
	import { formatDateTime, type LogTimeZone } from './time.js';

	let {
		result,
		windowFrom,
		tz,
		onfilter,
		onsample
	}: {
		result: LogTableResult;
		/** Start of the window read, so first-seen inside it is flagged new. */
		windowFrom: number;
		tz: LogTimeZone;
		onfilter?: (field: string, value: string, exclude: boolean) => void;
		/** Open one example line in the record flyout. */
		onsample?: (id: string) => void;
	} = $props();

	const rows = $derived(patternRows(result, windowFrom));
	const fresh = $derived(rows.filter((row) => row.isNew).length);
</script>

<div class="flex items-center gap-3 border-b px-3 py-1.5 text-xs text-muted-foreground">
	<span>{rows.length.toLocaleString('en-GB')} pattern{rows.length === 1 ? '' : 's'}</span>
	{#if fresh > 0}
		<span class="rounded bg-info/10 px-1.5 py-0.5 font-medium text-info"
			>{fresh.toLocaleString('en-GB')} first seen in this window</span
		>
	{/if}
</div>
<Table.Root class="text-xs">
	<Table.Header>
		<Table.Row>
			<Table.Head class="w-20">Volume</Table.Head>
			<Table.Head>Template</Table.Head>
			<Table.Head class="text-right">Count</Table.Head>
			<Table.Head class="text-right">Share</Table.Head>
			<Table.Head>First seen</Table.Head>
			<Table.Head></Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each rows.slice(0, 1_000) as row, index (row.id || index)}
			<Table.Row>
				<Table.Cell class="py-1"><Sparkline values={row.sparkline} /></Table.Cell>
				<Table.Cell class="max-w-[40rem] font-mono whitespace-normal">
					<Template template={row.template} />
				</Table.Cell>
				<Table.Cell class="text-right tabular-nums">{row.count.toLocaleString('en-GB')}</Table.Cell>
				<Table.Cell class="text-right text-muted-foreground tabular-nums"
					>{percent(row.share)}</Table.Cell
				>
				<Table.Cell class="font-mono whitespace-nowrap text-muted-foreground">
					{#if row.firstSeen !== null}{formatDateTime(row.firstSeen, tz)}{:else}—{/if}
					{#if row.isNew}<span
							class="ml-1 rounded bg-info/10 px-1 font-sans text-[10px] font-medium text-info"
							>new</span
						>{/if}
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
					{#if row.id && onfilter}
						<Button
							variant="ghost"
							size="xs"
							title="Only lines with this pattern (pattern:{row.id})"
							onclick={() => onfilter('pattern', row.id, false)}><FilterIcon />Only this</Button
						>
						<Button
							variant="ghost"
							size="xs"
							title="Hide this pattern (-pattern:{row.id})"
							onclick={() => onfilter('pattern', row.id, true)}><EyeOffIcon />Hide</Button
						>
					{/if}
				</Table.Cell>
			</Table.Row>
		{:else}
			<Table.Row>
				<Table.Cell colspan={6} class="py-6 text-center text-muted-foreground"
					>No patterns in this window.</Table.Cell
				>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
