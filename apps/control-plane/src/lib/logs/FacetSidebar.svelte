<script lang="ts">
	/**
	 * Facets (docs/LOGS.md §7.2): every built-in field and discovered attribute key with its top
	 * values, a share bar and a sparkline. Click a value to filter to it, alt-click to exclude it
	 * (Loki Drilldown). Which facets are hidden is a per-user preference in localStorage, never
	 * part of the URL or a saved view (Datadog's rule).
	 */
	import { browser } from '$app/env';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import type { LogFieldSummary } from '@yoal/contracts';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import Popover from './Popover.svelte';
	import { hasFilterClause } from './query-text.js';
	import { SEVERITY_TONES } from './record.js';

	let {
		fields,
		loading = false,
		error = null,
		query,
		attributesAvailable = true,
		onfilter
	}: {
		fields: LogFieldSummary[] | undefined;
		loading?: boolean;
		error?: string | null;
		/** The reader's query text, to mark values already filtered or excluded. */
		query: string;
		/** False in lite mode: only built-in fields have values. */
		attributesAvailable?: boolean;
		onfilter: (field: string, value: string, exclude: boolean) => void;
	} = $props();

	const STORAGE_KEY = 'yoal.logs.hiddenFacets';
	const DEFAULT_HIDDEN = ['span', 'pattern', 'trace', 'scope', 'kind'];

	function readHidden(): string[] {
		if (!browser) return DEFAULT_HIDDEN;
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			const parsed = raw ? (JSON.parse(raw) as unknown) : null;
			return Array.isArray(parsed)
				? parsed.filter((item): item is string => typeof item === 'string')
				: DEFAULT_HIDDEN;
		} catch {
			return DEFAULT_HIDDEN;
		}
	}

	let hidden = $state<string[]>(readHidden());
	let collapsed = $state<Record<string, boolean>>({});
	let manageOpen = $state(false);

	function setHidden(name: string, hide: boolean) {
		hidden = hide ? [...new Set([...hidden, name])] : hidden.filter((item) => item !== name);
		if (browser) localStorage.setItem(STORAGE_KEY, JSON.stringify(hidden));
	}

	const shown = $derived((fields ?? []).filter((field) => !hidden.includes(field.name)));

	function sparkPath(values: number[], w = 56, h = 14): string {
		if (values.length < 2) return '';
		const peak = Math.max(1, ...values);
		return values
			.map((value, index) => {
				const x = (index / (values.length - 1)) * w;
				const y = h - (value / peak) * (h - 1) - 0.5;
				return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
			})
			.join(' ');
	}
</script>

<aside class="flex min-h-0 flex-col text-xs" aria-label="Fields">
	<div class="flex items-center justify-between gap-2 border-b px-3 py-2">
		<span class="font-medium text-muted-foreground">Fields</span>
		<Popover bind:open={manageOpen} align="start" class="w-64 p-1.5">
			{#snippet trigger({ props })}
				<Button
					{...props}
					variant="ghost"
					size="icon-sm"
					class="size-6"
					aria-label="Choose which fields show"
					title="Choose fields"
				>
					<SlidersHorizontalIcon class="size-3.5" />
				</Button>
			{/snippet}
			<p class="px-2 pt-1 pb-2 text-xs text-muted-foreground">
				Shown in this sidebar (only for you).
			</p>
			<ul class="max-h-72 overflow-y-auto">
				{#each fields ?? [] as field (field.name)}
					<li>
						<label class="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted">
							<Checkbox
								checked={!hidden.includes(field.name)}
								onCheckedChange={(checked) => setHidden(field.name, !checked)}
							/>
							<span class="truncate font-mono text-xs">{field.name}</span>
						</label>
					</li>
				{/each}
			</ul>
		</Popover>
	</div>
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if error}
			<p class="px-3 py-3 text-destructive">{error}</p>
		{:else if loading && !fields}
			<div class="space-y-3 p-3">
				{#each [0, 1, 2, 3] as index (index)}
					<Skeleton class="h-3 w-20" />
					<Skeleton class="h-3 w-full" />
				{/each}
			</div>
		{:else if shown.length === 0}
			<p class="px-3 py-3 text-muted-foreground">No fields in this window.</p>
		{:else}
			<ul class={loading ? 'opacity-60 transition-opacity' : ''}>
				{#each shown as field (field.name)}
					{@const open = !collapsed[field.name]}
					<li class="border-b last:border-b-0">
						<div class="group flex items-center gap-1 px-2 pt-2 pb-1">
							<button
								type="button"
								class="flex min-w-0 flex-1 items-center gap-1 text-left"
								aria-expanded={open}
								onclick={() => (collapsed = { ...collapsed, [field.name]: open })}
							>
								<ChevronRightIcon
									class="size-3 shrink-0 text-muted-foreground transition-transform {open
										? 'rotate-90'
										: ''}"
								/>
								<span class="truncate font-mono font-medium">{field.name}</span>
							</button>
							{#if field.sparkline && field.sparkline.length > 1}
								<svg width="56" height="14" class="shrink-0 overflow-visible" aria-hidden="true">
									<path
										d={sparkPath(field.sparkline)}
										class="fill-none stroke-muted-foreground/60"
										stroke-width="1"
									/>
								</svg>
							{/if}
							<button
								type="button"
								class="hidden size-5 shrink-0 place-items-center rounded text-muted-foreground group-hover:grid hover:bg-muted"
								aria-label="Hide {field.name}"
								title="Hide this field"
								onclick={() => setHidden(field.name, true)}
							>
								<EyeOffIcon class="size-3" />
							</button>
						</div>
						{#if open}
							<ul class="px-1 pb-2">
								{#each field.topValues as item (item.value)}
									{@const share = field.present > 0 ? item.count / field.present : 0}
									{@const included = hasFilterClause(query, field.name, item.value)}
									{@const excluded = hasFilterClause(query, field.name, item.value, true)}
									<li>
										<button
											type="button"
											class="group/value relative flex w-full items-center gap-2 overflow-hidden rounded px-2 py-0.5 text-left hover:bg-muted {included
												? 'bg-primary/10 font-medium'
												: ''}"
											title="Click to filter, Alt-click to exclude"
											onclick={(event) => onfilter(field.name, item.value, event.altKey)}
										>
											<span
												class="absolute inset-y-0 left-0 bg-muted-foreground/10"
												style="width: {Math.round(share * 100)}%"
												aria-hidden="true"
											></span>
											{#if field.name === 'level' && item.value in SEVERITY_TONES}
												<span
													class="relative size-2 shrink-0 rounded-sm {SEVERITY_TONES[
														item.value as keyof typeof SEVERITY_TONES
													].swatch}"
												></span>
											{/if}
											<span
												class="relative min-w-0 flex-1 truncate font-mono {excluded
													? 'text-muted-foreground line-through'
													: ''}">{item.value === '' ? '(empty)' : item.value}</span
											>
											<span class="relative shrink-0 text-muted-foreground tabular-nums">
												{share >= 0.01 ? `${Math.round(share * 100)}%` : '<1%'}
											</span>
										</button>
									</li>
								{:else}
									<li class="px-2 py-0.5 text-muted-foreground">No values.</li>
								{/each}
							</ul>
						{/if}
					</li>
				{/each}
			</ul>
			{#if !attributesAvailable}
				<p class="px-3 py-3 text-muted-foreground">
					Facets on parsed fields (<span class="font-mono">@attributes</span>) need the telemetry
					store.
				</p>
			{/if}
		{/if}
	</div>
</aside>
