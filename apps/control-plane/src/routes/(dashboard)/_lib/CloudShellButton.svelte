<script lang="ts">
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { cloudShell } from '#lib/cloud-shell/cloud-shell.svelte.js';

	const label = $derived(
		cloudShell.running
			? 'Cloud shell (running)'
			: cloudShell.starting
				? 'Cloud shell (starting)'
				: 'Cloud shell'
	);
</script>

<Button
	variant={cloudShell.open ? 'secondary' : 'outline'}
	size="sm"
	class="relative gap-1.5"
	onclick={() => cloudShell.toggle()}
	aria-pressed={cloudShell.open}
	aria-label={label}
	aria-keyshortcuts="Control+`"
	title={`${cloudShell.open ? 'Hide' : 'Open'} the cloud shell (Ctrl+\`)`}
	data-yoal-target="header.cloud-shell"
>
	<SquareTerminalIcon />
	<span class="hidden lg:inline">Cloud shell</span>
	<Kbd class="hidden xl:inline-flex">⌃`</Kbd>
	{#if cloudShell.running || cloudShell.starting}
		<span
			class="absolute -top-0.5 -right-0.5 size-2 rounded-full border border-background {cloudShell.running
				? 'bg-success'
				: 'animate-pulse bg-warning'}"
		></span>
	{/if}
</Button>
