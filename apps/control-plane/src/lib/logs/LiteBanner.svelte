<script lang="ts">
	/**
	 * Lite mode (docs/LOGS.md §0, §15.1): without ClickHouse the Explorer still searches the SQLite
	 * hot tail. Say what that means once, calmly, with the way to Settings → Telemetry. Embedded
	 * explorers can dismiss it (remembered per browser).
	 */
	import { browser } from '$app/env';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import FeatherIcon from '@lucide/svelte/icons/feather';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';

	let { dismissible = false, installed = false }: { dismissible?: boolean; installed?: boolean } =
		$props();

	const KEY = 'yoal.logs.liteBannerDismissed';
	let dismissed = $state(browser && localStorage.getItem(KEY) === '1');

	const canInstall = $derived(
		(page.data as { can?: { configurePlatform?: boolean; manageNodes?: boolean } }).can
			?.manageNodes === true
	);

	function dismiss() {
		dismissed = true;
		if (browser) localStorage.setItem(KEY, '1');
	}
</script>

{#if !(dismissible && dismissed)}
	<div
		class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-3 py-2 text-xs"
		role="status"
	>
		<FeatherIcon class="size-3.5 shrink-0 text-muted-foreground" />
		<p class="min-w-0 flex-1 text-muted-foreground">
			<span class="font-medium text-foreground">Lite mode.</span>
			{installed
				? 'The telemetry store is not answering, so search runs over the recent hot tail.'
				: 'Search runs over the recent hot tail in SQLite.'}
			Facets on parsed fields, patterns, stats and compare need the telemetry store (ClickHouse).
		</p>
		{#if canInstall}
			<Button href={resolve('/(dashboard)/settings/telemetry')} variant="outline" size="xs"
				>Settings → Telemetry</Button
			>
		{/if}
		{#if dismissible}
			<Button variant="ghost" size="icon-sm" class="size-6" aria-label="Dismiss" onclick={dismiss}>
				<XIcon class="size-3.5" />
			</Button>
		{/if}
	</div>
{/if}
