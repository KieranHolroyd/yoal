<script lang="ts">
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import type { SelfUpdateLog, SelfUpdateLogLevel } from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';

	/** The updater's log as a terminal. While `running` it follows the tail until the reader scrolls up. */
	let { log, running = false }: { log: SelfUpdateLog; running?: boolean } = $props();

	let scroller = $state<HTMLDivElement | null>(null);
	let pinned = $state(true);

	const lines = $derived(log.lines);
	const text = $derived(
		lines.map((line) => `${line.at} ${line.level.padEnd(7)} ${line.text}`).join('\n')
	);

	const levelClass: Record<SelfUpdateLogLevel, string> = {
		info: 'text-sidebar-foreground/90',
		phase: 'text-brand',
		command: 'text-muted-foreground',
		output: 'text-sidebar-foreground/70',
		warn: 'text-warning',
		error: 'text-destructive'
	};

	$effect(() => {
		const count = lines.length;
		if (!scroller || !pinned || (count === 0 && !running)) return;
		scroller.scrollTop = scroller.scrollHeight;
	});

	function onscroll() {
		if (scroller) pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
	}
</script>

<div class="group relative">
	<div
		bind:this={scroller}
		{onscroll}
		role="log"
		aria-label="Update log"
		aria-live="off"
		class="max-h-80 min-h-20 overflow-auto rounded-lg border border-sidebar-border bg-sidebar p-3 font-mono text-xs leading-relaxed text-sidebar-foreground"
	>
		{#each lines as line, index (index)}
			<div class="flex gap-3">
				<span class="shrink-0 text-muted-foreground/60 tabular-nums select-none"
					>{line.at.slice(11, 19)}</span
				>
				<span class="min-w-0 break-words whitespace-pre-wrap {levelClass[line.level]}"
					>{line.text}</span
				>
			</div>
		{:else}
			<p class="text-muted-foreground">
				{running ? 'Waiting for the first line…' : 'The updater did not write a log for this run.'}
			</p>
		{/each}
	</div>
	{#if lines.length > 0}
		<div
			class="absolute top-2 right-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
		>
			<CopyButton value={text} label="Copy log" iconOnly size="icon-xs" variant="secondary" />
		</div>
	{/if}
	{#if !pinned && lines.length > 0}
		<Button
			type="button"
			variant="secondary"
			size="xs"
			class="absolute right-3 bottom-3 shadow-xs"
			onclick={() => {
				pinned = true;
				if (scroller) scroller.scrollTop = scroller.scrollHeight;
			}}
		>
			<ArrowDownIcon />
			Latest
		</Button>
	{/if}
</div>
<p class="mt-2 text-xs text-muted-foreground">
	Times are UTC.{#if log.truncated}
		Showing the newest {lines.length} lines; the rest is in
		<code>journalctl -u yoal-update-self</code>.{/if}
</p>
