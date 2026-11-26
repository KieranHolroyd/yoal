<script lang="ts">
	/** A pattern template with its masked placeholders (`<NUM>`, `<UUID>`, `<*>`…) highlighted. */
	import { templateParts } from './analysis.js';

	let { template }: { template: string } = $props();
</script>

{#each templateParts(template) as part, index (index)}{#if part.placeholder}<span
			class="rounded bg-info/10 px-0.5 text-info">{part.text}</span
		>{:else}{part.text}{/if}{/each}
