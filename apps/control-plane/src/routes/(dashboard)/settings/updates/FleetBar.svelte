<script lang="ts">
	import { fleetStateCopy, fleetStateOrder, type FleetView } from './fleet-ui.js';

	/** Node versions as one segmented bar: how much of the fleet is on the target release. */
	let { counts, class: className = 'h-1.5' }: { counts: FleetView['counts']; class?: string } =
		$props();

	const total = $derived(fleetStateOrder.reduce((sum, state) => sum + counts[state], 0));
	const segments = $derived(fleetStateOrder.filter((state) => counts[state] > 0));
	const label = $derived(
		segments
			.map((state) => `${counts[state]} ${fleetStateCopy[state].label.toLowerCase()}`)
			.join(', ')
	);
</script>

<div
	class="flex w-full gap-0.5 overflow-hidden rounded-full {className}"
	role="img"
	aria-label={total ? `Nodes: ${label}` : 'No nodes'}
>
	{#each segments as state (state)}
		<span
			class="min-w-1.5 rounded-full transition-[flex-grow] duration-500 {fleetStateCopy[state]
				.bar} {state === 'updating' ? 'animate-pulse' : ''}"
			style:flex-grow={counts[state]}
			style:flex-basis="0"
		></span>
	{:else}
		<span class="flex-1 rounded-full bg-muted"></span>
	{/each}
</div>
