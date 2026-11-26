<script lang="ts">
	import { richText } from './view.js';

	/** Plain catalog copy with literals (flags, permissions, hostnames) set as inline code. */
	let { text }: { text: string } = $props();

	const segments = $derived(richText(text));
</script>

{#each segments as segment, index (index)}{#if segment.kind === 'code'}<code
			class="rounded-[0.3rem] border bg-muted/60 px-1 py-px font-mono text-[0.85em] break-all text-foreground"
			>{segment.value}</code
		>{:else}{segment.value}{/if}{/each}
