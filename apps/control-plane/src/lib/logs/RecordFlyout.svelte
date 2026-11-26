<script lang="ts" module>
	export type FlyoutTab = 'fields' | 'raw' | 'context';
</script>

<script lang="ts">
	/**
	 * One record, expanded (docs/LOGS.md §7.2): every field with "filter to" / "exclude" / copy,
	 * the body pretty-printed when it is JSON, the raw record, pivots (§9.3), and context: the
	 * lines before and after it in the same stream, with this one pinned (`grep -C`).
	 */
	import { createQuery } from '@tanstack/svelte-query';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CrosshairIcon from '@lucide/svelte/icons/crosshair';
	import FilterIcon from '@lucide/svelte/icons/filter';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import { formatLogScope, type LogRecord } from '@yoal/contracts';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { errorText } from '#lib/query.js';
	import { contextLogs, logKeys } from './api.js';
	import LogBody from './LogBody.svelte';
	import { SEVERITY_TONES, jsonBody, recordFields, recordPivots, serviceLabel } from './record.js';
	import { formatClock, formatDateTime, type LogTimeZone } from './time.js';

	let {
		record,
		open = $bindable(false),
		tab = $bindable<FlyoutTab>('fields'),
		tz,
		terms = [],
		onfilter,
		onpivot,
		onaround,
		onopenchange
	}: {
		record: LogRecord | null;
		open?: boolean;
		tab?: FlyoutTab;
		tz: LogTimeZone;
		terms?: readonly string[];
		onfilter: (field: string, value: string, exclude: boolean) => void;
		/** Replace the filter with a pivot clause (`request:req_1`). */
		onpivot: (clause: string) => void;
		/** Show ±5 minutes around this record in the stream. */
		onaround: (record: LogRecord) => void;
		onopenchange?: (open: boolean) => void;
	} = $props();

	const CONTEXT = 30;

	const context = createQuery(() => ({
		queryKey: logKeys.context(record?.id ?? '', CONTEXT, CONTEXT),
		queryFn: ({ signal }) =>
			contextLogs({ id: record!.id, before: CONTEXT, after: CONTEXT }, signal),
		enabled: open && tab === 'context' && record !== null,
		staleTime: 30_000
	}));

	const contextLines = $derived.by(() => {
		const data = context.data;
		if (!data) return [];
		const byTime = (a: LogRecord, b: LogRecord) => a.ts - b.ts || a.id.localeCompare(b.id);
		const anchor = data.anchor ?? record;
		return [
			...[...data.before].sort(byTime).map((line) => ({ line, pinned: false })),
			...(anchor ? [{ line: anchor, pinned: true }] : []),
			...[...data.after].sort(byTime).map((line) => ({ line, pinned: false }))
		];
	});

	const fields = $derived(record ? recordFields(record) : []);
	const pivots = $derived(record ? recordPivots(record) : []);
	const parsed = $derived(record ? jsonBody(record.body) : null);
	const raw = $derived(record ? JSON.stringify(record, null, 2) : '');

	const groups = $derived([
		{ id: 'record', label: 'Record', items: fields.filter((field) => field.group === 'record') },
		{
			id: 'attribute',
			label: 'Attributes',
			items: fields.filter((field) => field.group === 'attribute')
		},
		{
			id: 'resource',
			label: 'Resource',
			items: fields.filter((field) => field.group === 'resource')
		}
	]);
</script>

<Sheet.Root bind:open onOpenChange={(next) => onopenchange?.(next)}>
	<Sheet.Content side="right" class="w-full gap-0 p-0 sm:max-w-2xl">
		{#if record}
			{@const tone = SEVERITY_TONES[record.severity]}
			<Sheet.Header class="border-b px-5 py-4 pr-12">
				<Sheet.Title class="flex flex-wrap items-center gap-2 text-base">
					<span
						class="inline-flex h-5 items-center rounded-sm px-1.5 font-mono text-[11px] font-semibold {tone.chip}"
						>{tone.short}</span
					>
					<span class="font-mono text-sm">{formatDateTime(record.ts, tz, true)}</span>
					<span class="text-xs font-normal text-muted-foreground uppercase"
						>{tz === 'utc' ? 'UTC' : 'local'}</span
					>
				</Sheet.Title>
				<Sheet.Description class="flex flex-wrap items-center gap-x-2 font-mono text-xs">
					<span>{serviceLabel(record)}</span>
					{#if record.stream}<span>· {record.stream}</span>{/if}
					<span>· {record.source}</span>
				</Sheet.Description>
			</Sheet.Header>

			<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col gap-0">
				<div class="flex items-center justify-between gap-2 border-b px-5 py-2">
					<Tabs.List>
						<Tabs.Trigger value="fields">Fields</Tabs.Trigger>
						<Tabs.Trigger value="context">Context</Tabs.Trigger>
						<Tabs.Trigger value="raw">Raw</Tabs.Trigger>
					</Tabs.List>
					<Button
						variant="outline"
						size="sm"
						onclick={() => onaround(record)}
						title="Show ±5 minutes around this line"
					>
						<CrosshairIcon />Around this time
					</Button>
				</div>

				<Tabs.Content value="fields" class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
					<section class="space-y-2">
						<div class="flex items-center justify-between">
							<h3 class="text-xs font-medium text-muted-foreground">Message</h3>
							<CopyButton value={record.body} label="Copy message" size="xs" variant="ghost" />
						</div>
						{#if parsed !== null}
							<pre
								class="max-h-80 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-5">{JSON.stringify(
									parsed,
									null,
									2
								)}</pre>
						{:else}
							<div
								class="max-h-80 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-5 {tone.text}"
							>
								<LogBody body={record.body} ansi={record.ansi} {terms} wrap />
							</div>
						{/if}
					</section>

					{#if pivots.length > 0}
						<section class="mt-5 space-y-2">
							<h3 class="text-xs font-medium text-muted-foreground">Pivot</h3>
							<div class="flex flex-wrap gap-1.5">
								{#each pivots as pivot (pivot.label)}
									{#if pivot.href}
										<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- built from record ids -->
										<Button variant="outline" size="xs" href={pivot.href}>
											<ArrowUpRightIcon />{pivot.label}
										</Button>
									{:else if pivot.query}
										<Button
											variant="outline"
											size="xs"
											onclick={() => onpivot(pivot.query!)}
											title={pivot.query}
										>
											<FilterIcon />{pivot.label}
										</Button>
									{/if}
								{/each}
							</div>
						</section>
					{/if}

					{#each groups as group (group.id)}
						{#if group.items.length > 0}
							<section class="mt-5">
								<h3 class="mb-1.5 text-xs font-medium text-muted-foreground">{group.label}</h3>
								<dl class="divide-y rounded-lg border text-xs">
									{#each group.items as field (field.field)}
										<div
											class="group grid grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)_auto] items-start gap-3 px-3 py-1.5"
										>
											<dt class="truncate font-mono text-muted-foreground" title={field.field}>
												{field.field}
											</dt>
											<dd class="font-mono break-all">{field.value}</dd>
											<div class="flex gap-0.5 opacity-60 group-hover:opacity-100">
												<Button
													variant="ghost"
													size="icon-sm"
													class="size-6"
													aria-label="Filter to {field.field}:{field.value}"
													title="Filter to this value (f)"
													onclick={() => onfilter(field.field, field.value, false)}
												>
													<FilterIcon class="size-3.5" />
												</Button>
												<Button
													variant="ghost"
													size="icon-sm"
													class="size-6"
													aria-label="Exclude {field.field}:{field.value}"
													title="Exclude this value (x)"
													onclick={() => onfilter(field.field, field.value, true)}
												>
													<FilterXIcon class="size-3.5" />
												</Button>
												<CopyButton
													value={field.value}
													iconOnly
													size="icon-sm"
													variant="ghost"
													class="size-6"
													label="Copy value"
												/>
											</div>
										</div>
									{/each}
								</dl>
							</section>
						{/if}
					{/each}
				</Tabs.Content>

				<Tabs.Content value="context" class="min-h-0 flex-1 overflow-y-auto">
					{#if context.isPending}
						<div class="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
							<Spinner />Reading the lines around it…
						</div>
					{:else if context.isError}
						<p class="px-5 py-6 text-sm text-destructive">
							{errorText(context.error, 'Could not read the context.')}
						</p>
					{:else}
						<p class="border-b px-5 py-2 text-xs text-muted-foreground">
							{CONTEXT} lines either side in the same stream ({record.stream ??
								formatLogScope(record.scope)}).
						</p>
						<ol class="bg-muted/25 py-1 font-mono text-xs leading-5">
							{#each contextLines as item (item.line.id)}
								{@const lineTone = SEVERITY_TONES[item.line.severity]}
								<li
									class="flex gap-2.5 px-4 py-px {item.pinned
										? 'bg-primary/10 shadow-[inset_2px_0_0] shadow-primary'
										: ''}"
								>
									<span class="w-[6.4rem] shrink-0 text-muted-foreground tabular-nums"
										>{formatClock(item.line.ts, tz)}</span
									>
									<span
										class="w-8 shrink-0 text-[10px] font-semibold {lineTone.chip} inline-flex h-4 items-center justify-center rounded-sm"
										>{lineTone.short}</span
									>
									<span class="min-w-0 flex-1 {lineTone.text}"
										><LogBody
											body={item.line.body}
											ansi={item.line.ansi}
											terms={item.pinned ? terms : []}
											wrap
										/></span
									>
								</li>
							{:else}
								<li class="px-5 py-6 text-muted-foreground">No other lines in this stream.</li>
							{/each}
						</ol>
					{/if}
				</Tabs.Content>

				<Tabs.Content value="raw" class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
					<div class="mb-2 flex justify-end">
						<CopyButton value={raw} label="Copy JSON" size="xs" />
					</div>
					<pre
						class="overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-5">{raw}</pre>
				</Tabs.Content>
			</Tabs.Root>
		{:else}
			<Sheet.Header class="px-5 py-4">
				<Sheet.Title>Log line</Sheet.Title>
				<Sheet.Description>Loading the line…</Sheet.Description>
			</Sheet.Header>
		{/if}
	</Sheet.Content>
</Sheet.Root>
