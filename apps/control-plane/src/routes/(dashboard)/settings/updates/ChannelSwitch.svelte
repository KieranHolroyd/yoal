<script lang="ts">
	import { resolve } from '$app/paths';
	import type { SelfUpdateChannel } from '@yoal/contracts';

	/**
	 * Canary or stable (docs/OPS.md §4.1). Picking one previews it through `?channel=`; the host
	 * only moves when an update is requested on it.
	 */
	let {
		selected,
		hostChannel,
		latest
	}: {
		selected: SelfUpdateChannel;
		hostChannel: SelfUpdateChannel;
		/** Newest version on each channel; null when unknown or none promoted yet. */
		latest: Record<SelfUpdateChannel, string | null>;
	} = $props();

	const options = [
		{ value: 'canary', label: 'Canary', hint: 'Every release, as soon as CI publishes it.' },
		{ value: 'stable', label: 'Stable', hint: 'Only releases promoted after running on canary.' }
	] as const;
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved route plus a ?channel= query -->
<nav aria-label="Release channel" class="inline-flex rounded-md border bg-background p-0.5">
	{#each options as option (option.value)}
		{@const active = option.value === selected}
		<a
			href={`${resolve('/(dashboard)/settings/updates')}?channel=${option.value}`}
			data-sveltekit-noscroll
			data-sveltekit-replacestate
			aria-current={active ? 'true' : undefined}
			title="{option.hint}{option.value === hostChannel ? ' This host follows it.' : ''}"
			class="flex items-center gap-1.5 rounded-[5px] px-2 py-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none {active
				? 'bg-foreground text-background'
				: 'hover:text-foreground'}"
		>
			{option.label}
			<span class="font-mono tabular-nums opacity-60">
				{latest[option.value] ? `v${latest[option.value]}` : 'none'}
			</span>
			{#if option.value === hostChannel && !active}
				<span class="size-1 rounded-full bg-current" aria-label="(this host)"></span>
			{/if}
		</a>
	{/each}
</nav>
