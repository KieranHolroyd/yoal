<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ServerIcon from '@lucide/svelte/icons/server';
	import WaypointsIcon from '@lucide/svelte/icons/waypoints';
	import type { Tone } from '#lib/status.js';
	import FleetBar from './FleetBar.svelte';
	import { fleetSummary, type FleetView, type UpdateStage } from './fleet-ui.js';

	/**
	 * A release reaches a cluster in two steps: the control plane installs it, then the nodes follow
	 * (CLUSTERING §3.11). These two cards show where each step stands and pick which one the rest of
	 * the page details.
	 */
	let {
		selected,
		onselect,
		control,
		fleet
	}: {
		selected: UpdateStage;
		onselect: (stage: UpdateStage) => void;
		control: { tone: Tone; label: string; version: string; target: string | null; live: boolean };
		fleet: FleetView;
	} = $props();

	const summary = $derived(fleetSummary(fleet));
	const onTarget = $derived(fleet.counts.current);

	const pill: Record<Tone, string> = {
		success: 'text-success',
		warning: 'text-warning',
		danger: 'text-destructive',
		info: 'text-info',
		brand: 'text-brand',
		neutral: 'text-muted-foreground'
	};
	const dot: Record<Tone, string> = {
		success: 'bg-success',
		warning: 'bg-warning',
		danger: 'bg-destructive',
		info: 'bg-info',
		brand: 'bg-brand',
		neutral: 'bg-muted-foreground'
	};

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		const next = selected === 'control' ? 'fleet' : 'control';
		onselect(next);
		document.getElementById(`updates-tab-${next}`)?.focus();
	}
</script>

{#snippet status(tone: Tone, label: string, live: boolean)}
	<span class="ml-auto inline-flex min-w-0 items-center gap-1.5 text-xs font-medium {pill[tone]}">
		<span class="relative grid size-1.5 shrink-0 place-items-center" aria-hidden="true">
			{#if live}
				<span class="absolute size-full animate-ping rounded-full opacity-60 {dot[tone]}"></span>
			{/if}
			<span class="relative size-1.5 rounded-full {dot[tone]}"></span>
		</span>
		<span class="truncate">{label}</span>
	</span>
{/snippet}

{#snippet heading(step: number, title: string, Icon: typeof ServerIcon, active: boolean)}
	<span
		class="flex size-6 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold tabular-nums transition-colors {active
			? 'bg-foreground text-background'
			: 'border bg-background text-muted-foreground'}"
		aria-hidden="true">{step}</span
	>
	<span class="flex items-center gap-1.5 text-sm font-medium">
		<Icon class="size-3.5 text-muted-foreground" aria-hidden="true" />
		{title}
	</span>
{/snippet}

<div
	class="grid items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
	role="tablist"
	aria-label="Update stage"
	tabindex="-1"
	{onkeydown}
>
	<button
		type="button"
		role="tab"
		id="updates-tab-control"
		aria-selected={selected === 'control'}
		aria-controls="updates-panel-control"
		tabindex={selected === 'control' ? 0 : -1}
		onclick={() => onselect('control')}
		class="group flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-[border-color,box-shadow,background-color] hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none {selected ===
		'control'
			? 'border-foreground/40 ring-1 ring-foreground/10'
			: 'bg-card/60'}"
	>
		<span class="flex w-full items-center gap-2.5">
			{@render heading(1, 'Control plane', ServerIcon, selected === 'control')}
			{@render status(control.tone, control.label, control.live)}
		</span>
		<span class="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono tabular-nums">
			<span
				class={control.target
					? 'text-sm text-muted-foreground'
					: 'text-xl font-semibold tracking-tight'}>v{control.version}</span
			>
			{#if control.target}
				<ArrowRightIcon class="size-3.5 self-center text-muted-foreground" aria-label="to" />
				<span class="text-xl font-semibold tracking-tight">v{control.target}</span>
			{/if}
		</span>
		<span class="text-xs text-muted-foreground">This host: dashboard, API and scheduler.</span>
	</button>

	<span class="hidden items-center text-muted-foreground/60 sm:flex" aria-hidden="true">
		<ChevronRightIcon class="size-4" />
	</span>

	<button
		type="button"
		role="tab"
		id="updates-tab-fleet"
		aria-selected={selected === 'fleet'}
		aria-controls="updates-panel-fleet"
		tabindex={selected === 'fleet' ? 0 : -1}
		onclick={() => onselect('fleet')}
		class="group flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-[border-color,box-shadow,background-color] hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none {selected ===
		'fleet'
			? 'border-foreground/40 ring-1 ring-foreground/10'
			: 'bg-card/60'}"
	>
		<span class="flex w-full items-center gap-2.5">
			{@render heading(2, 'Fleet', WaypointsIcon, selected === 'fleet')}
			{@render status(summary.tone, summary.label, summary.live)}
		</span>
		{#if fleet.readable && fleet.nodes.length > 0}
			<span class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
				<span class="font-mono text-xl font-semibold tracking-tight tabular-nums"
					>{onTarget}<span class="text-muted-foreground">/{fleet.nodes.length}</span></span
				>
				<span class="text-sm text-muted-foreground">
					nodes on
					<span class="font-mono tabular-nums"
						>{fleet.targetVersion ? `v${fleet.targetVersion}` : 'this build'}</span
					>
				</span>
			</span>
			<FleetBar counts={fleet.counts} />
		{:else}
			<span class="text-xl font-semibold tracking-tight text-muted-foreground">—</span>
			<span class="text-xs text-muted-foreground">
				{fleet.readable
					? 'Nodes follow the control plane once they are enrolled.'
					: 'Nodes follow the control plane.'}
			</span>
		{/if}
	</button>
</div>
