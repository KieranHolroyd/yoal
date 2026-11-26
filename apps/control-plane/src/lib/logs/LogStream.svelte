<script lang="ts" module>
	/** Columns the stream can show besides the body; `@key` adds an attribute column. */
	export const STREAM_COLUMNS = [
		'time',
		'level',
		'service',
		'replica',
		'stream',
		'source',
		'node'
	] as const;
	export type StreamColumn = (typeof STREAM_COLUMNS)[number] | `@${string}`;
	export type StreamOrder = 'newest-first' | 'oldest-first';
</script>

<script lang="ts">
	/**
	 * The virtualised record stream (docs/LOGS.md §7.2). Records arrive oldest-first; `order` picks
	 * whether the newest line sits at the top (the Explorer) or the bottom (a terminal-style tail on
	 * a resource page). Only rows on screen are in the DOM. The parent owns paging and the tail;
	 * this reports whether the reader is at the live edge and which value the pointer is over.
	 */
	import { untrack, type Snippet } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import type { LogRecord } from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import LogBody from './LogBody.svelte';
	import { SEVERITY_TONES, serviceLabel } from './record.js';
	import { formatClock, formatDateTime, type LogTimeZone } from './time.js';

	let {
		records,
		order,
		columns,
		wrap,
		tz,
		showDate = false,
		terms = [],
		selectedId = null,
		focusedIndex = $bindable(-1),
		hasOlder = false,
		loadingOlder = false,
		hasNewer = false,
		loadingNewer = false,
		autoLoadOlder = true,
		heightClass = 'h-[min(40rem,calc(100dvh-24rem))] min-h-80',
		onloadolder,
		onloadnewer,
		onselect,
		onhover,
		onedge,
		empty
	}: {
		records: LogRecord[];
		order: StreamOrder;
		columns: StreamColumn[];
		wrap: boolean;
		tz: LogTimeZone;
		showDate?: boolean;
		terms?: readonly string[];
		selectedId?: string | null;
		/** Display index of the keyboard-focused row (`j`/`k`). */
		focusedIndex?: number;
		hasOlder?: boolean;
		loadingOlder?: boolean;
		hasNewer?: boolean;
		loadingNewer?: boolean;
		/** Newest-first only: fetch the next older page when the reader nears the end. */
		autoLoadOlder?: boolean;
		heightClass?: string;
		onloadolder?: () => void;
		onloadnewer?: () => void;
		onselect: (record: LogRecord) => void;
		onhover?: (value: { field: string; value: string } | null) => void;
		onedge?: (atEdge: boolean) => void;
		empty?: Snippet;
	} = $props();

	let viewport = $state<HTMLDivElement | null>(null);
	let atEdge = true;

	const count = $derived(records.length);
	function at(index: number): LogRecord | undefined {
		return order === 'newest-first' ? records[records.length - 1 - index] : records[index];
	}

	const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => viewport,
		estimateSize: () => 20,
		overscan: 24,
		paddingStart: 2,
		paddingEnd: 2
	});

	// `setOptions` writes the store, so it must not be read reactively here or the effect loops.
	$effect(() => {
		const size = count;
		const element = viewport;
		void order;
		void wrap;
		void records;
		untrack(() =>
			$virtualizer.setOptions({
				count: size,
				getScrollElement: () => element,
				getItemKey: (index) => at(index)?.id ?? index
			})
		);
	});

	/** Jump to the live edge (top for newest-first, bottom for oldest-first). */
	export function scrollToEdge(): void {
		if (!viewport || count === 0) return;
		if (order === 'newest-first') viewport.scrollTop = 0;
		else $virtualizer.scrollToIndex(count - 1, { align: 'end' });
		setEdge(true);
	}

	export function scrollToIndex(index: number): void {
		if (index >= 0 && index < count) $virtualizer.scrollToIndex(index, { align: 'auto' });
	}

	function setEdge(next: boolean) {
		if (next === atEdge) return;
		atEdge = next;
		onedge?.(next);
	}

	function onscroll() {
		if (!viewport) return;
		const fromTop = viewport.scrollTop;
		const fromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
		setEdge(order === 'newest-first' ? fromTop < 24 : fromBottom < 24);
		if (order === 'newest-first' && autoLoadOlder && hasOlder && !loadingOlder && fromBottom < 400)
			onloadolder?.();
	}

	function pointer(event: PointerEvent) {
		const target = (event.target as HTMLElement | null)?.closest?.(
			'[data-field]'
		) as HTMLElement | null;
		if (!target) return onhover?.(null);
		onhover?.({ field: target.dataset.field ?? '', value: target.dataset.value ?? '' });
	}

	const timeWidth = $derived(showDate ? 'w-[10.5rem]' : 'w-[6.4rem]');
</script>

{#snippet edgeBar(kind: 'older' | 'newer')}
	{@const has = kind === 'older' ? hasOlder : hasNewer}
	{@const loading = kind === 'older' ? loadingOlder : loadingNewer}
	{#if has || loading}
		<div
			class="flex items-center justify-center border-y bg-muted/20 py-1 text-xs text-muted-foreground"
		>
			{#if loading}
				<Spinner class="size-3" /><span class="ml-2">Loading {kind} lines…</span>
			{:else}
				<Button
					variant="ghost"
					size="xs"
					class="h-5 text-xs"
					onclick={() => (kind === 'older' ? onloadolder?.() : onloadnewer?.())}
				>
					Load {kind} lines
				</Button>
			{/if}
		</div>
	{/if}
{/snippet}

<div class="flex min-h-0 flex-col">
	{@render edgeBar(order === 'newest-first' ? 'newer' : 'older')}
	<div
		bind:this={viewport}
		{onscroll}
		onpointerover={pointer}
		onpointerleave={() => onhover?.(null)}
		class="relative overflow-auto overscroll-contain bg-muted/25 font-mono text-xs leading-5 {heightClass}"
		role="log"
		aria-live="off"
		aria-label="Log lines"
	>
		{#if count === 0}
			<div class="grid h-full place-items-center p-6">
				{@render empty?.()}
			</div>
		{:else}
			<div class="relative w-full" style="height: {$virtualizer.getTotalSize()}px">
				{#each $virtualizer.getVirtualItems() as row (row.key)}
					{@const record = at(row.index)!}
					{@const tone = SEVERITY_TONES[record.severity]}
					<div
						data-index={row.index}
						{@attach (node) => untrack(() => $virtualizer.measureElement(node))}
						class="group absolute top-0 left-0 flex w-full cursor-default items-start gap-2.5 px-3 py-px hover:bg-muted/70 {record.id ===
						selectedId
							? 'bg-primary/10 hover:bg-primary/15'
							: ''} {row.index === focusedIndex ? 'shadow-[inset_2px_0_0] shadow-primary' : ''}"
						style="transform: translateY({row.start}px)"
						role="row"
						tabindex="-1"
						aria-selected={record.id === selectedId}
						onclick={(event) => {
							// Keep text selection possible: a drag-select is not a click on the row.
							if (window.getSelection()?.toString()) return;
							if ((event.target as HTMLElement).closest('a, button')) return;
							focusedIndex = row.index;
							onselect(record);
						}}
						onkeydown={(event) => {
							if (event.key === 'Enter') onselect(record);
						}}
					>
						{#each columns as column (column)}
							{#if column === 'time'}
								<span
									class="{timeWidth} shrink-0 text-muted-foreground tabular-nums select-none"
									title={formatDateTime(record.ts, tz, true)}
									>{showDate
										? formatDateTime(record.ts, tz, true).slice(5)
										: formatClock(record.ts, tz)}</span
								>
							{:else if column === 'level'}
								<span
									class="mt-0.5 inline-flex h-4 w-8 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold select-none {tone.chip}"
									data-field="level"
									data-value={record.severity}>{tone.short}</span
								>
							{:else if column === 'service'}
								<span
									class="w-24 shrink-0 truncate text-muted-foreground"
									data-field={record.scopeName ? 'service' : 'scope'}
									data-value={record.scopeName ?? `${record.scope.kind}:${record.scope.id}`}
									title="{record.scope.kind}:{record.scope.id}">{serviceLabel(record)}</span
								>
							{:else if column === 'replica'}
								<span
									class="w-6 shrink-0 text-muted-foreground/80 tabular-nums"
									data-field={record.replica === null ? undefined : 'replica'}
									data-value={record.replica ?? undefined}
									>{record.replica === null ? '' : `r${record.replica}`}</span
								>
							{:else if column === 'stream'}
								<span
									class="w-36 shrink-0 truncate text-muted-foreground"
									data-field={record.stream ? 'stream' : undefined}
									data-value={record.stream ?? undefined}
									title={record.stream ?? ''}>{record.stream ?? ''}</span
								>
							{:else if column === 'source'}
								<span
									class="w-14 shrink-0 truncate text-muted-foreground"
									data-field="source"
									data-value={record.source}>{record.source}</span
								>
							{:else if column === 'node'}
								<span
									class="w-24 shrink-0 truncate text-muted-foreground"
									data-field={record.nodeId ? 'node' : undefined}
									data-value={record.nodeId ?? undefined}>{record.nodeId ?? ''}</span
								>
							{:else}
								{@const key = column.slice(1)}
								<span
									class="w-28 shrink-0 truncate text-muted-foreground"
									data-field={record.attributes[key] !== undefined ? column : undefined}
									data-value={record.attributes[key]}
									title="{column}={record.attributes[key] ?? ''}"
									>{record.attributes[key] ?? ''}</span
								>
							{/if}
						{/each}
						<span class="flex min-w-0 flex-1 {tone.text}">
							{#if record.channel === 'stderr'}<span
									class="mr-1.5 h-4 shrink-0 rounded bg-destructive/10 px-1 text-[10px] leading-4 font-semibold text-destructive select-none"
									>err</span
								>{/if}<LogBody body={record.body} ansi={record.ansi} {terms} {wrap} />
						</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
	{@render edgeBar(order === 'newest-first' ? 'older' : 'newer')}
</div>
