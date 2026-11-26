<script lang="ts">
	/** A tiny inline SVG sparkline (pattern volume over the window, docs/LOGS.md §8.1). */
	import { sparklinePoints } from './analysis.js';

	let {
		values,
		width = 72,
		height = 18,
		class: className = 'stroke-primary'
	}: { values: readonly number[]; width?: number; height?: number; class?: string } = $props();

	const points = $derived(sparklinePoints(values, width, height));
</script>

{#if points}
	<svg
		{width}
		{height}
		viewBox="0 0 {width} {height}"
		class="block overflow-visible"
		aria-hidden="true"
	>
		<polyline {points} fill="none" class={className} stroke-width="1.25" stroke-linejoin="round" />
	</svg>
{:else}
	<span class="block" style="width: {width}px; height: {height}px"></span>
{/if}
