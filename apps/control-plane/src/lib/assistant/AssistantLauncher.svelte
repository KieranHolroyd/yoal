<script lang="ts">
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import { assistant } from '#lib/assistant/assistant.svelte.js';
	import AssistantPanel from '#lib/assistant/AssistantPanel.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { AssistantStatus } from '@yoal/contracts';

	let { status, userId }: { status: AssistantStatus; userId: string } = $props();

	// Conversations are per user, per browser.
	$effect(() => assistant.init(userId));

	function keydown(event: KeyboardEvent) {
		if (assistant.tour) return;
		if (
			(event.metaKey || event.ctrlKey) &&
			!event.shiftKey &&
			!event.altKey &&
			event.key.toLowerCase() === 'i'
		) {
			event.preventDefault();
			assistant.toggle();
		}
	}
</script>

<svelte:window onkeydown={keydown} />

<div id="yoal-assistant">
	{#if !assistant.open}
		<!-- Lifted above the cloud shell drawer while it is open (--yoal-cloud-shell-height). -->
		<div
			class="fixed right-4 bottom-[calc(1rem+var(--yoal-cloud-shell-height,0px))] z-40 transition-[bottom] duration-200 md:right-6 md:bottom-[calc(1.5rem+var(--yoal-cloud-shell-height,0px))]"
		>
			<Button
				size="lg"
				class="relative h-11 gap-2 rounded-full px-4 shadow-lg shadow-brand/20"
				onclick={() => assistant.show()}
				aria-label={assistant.unread ? 'Open Yoal assistant (new reply)' : 'Open Yoal assistant'}
				title="Yoal assistant (⌘I)"
			>
				<SparklesIcon class="size-4 {assistant.sending ? 'animate-pulse' : ''}" />
				<span class="hidden sm:inline">{assistant.sending ? 'Working…' : 'Ask Yoal'}</span>
				{#if assistant.unread}
					<span class="absolute -top-0.5 -right-0.5 flex size-3">
						<span class="absolute size-full animate-ping rounded-full bg-brand opacity-60"></span>
						<span class="relative size-3 rounded-full border-2 border-background bg-brand"></span>
					</span>
				{/if}
			</Button>
		</div>
	{/if}
	<AssistantPanel {status} />
</div>
