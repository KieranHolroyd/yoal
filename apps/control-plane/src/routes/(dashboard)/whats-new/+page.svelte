<script lang="ts">
	import type { WhatsNewDecision, WhatsNewItem } from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { runAction } from '#lib/actions.js';
	import PageHeader from '../_lib/PageHeader.svelte';
	import Entry from './Entry.svelte';
	import { groupByRelease, itemAnchor, itemState, releaseAnchor } from './view.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const view = $derived(data.whatsNew);
	const total = $derived(view.items.length);
	const reviewed = $derived(total - view.pending);
	const groups = $derived(groupByRelease(view.items));
	const earlier = $derived(groupByRelease(view.earlier));
	const firstConsent = $derived(view.items.find((item) => itemState(item) === 'consent'));

	let busy = $state<string | null>(null);

	async function decide(itemId: string, decision: WhatsNewDecision) {
		busy = `${itemId}:${decision}`;
		try {
			await runAction('?/decide', { itemId, decision });
		} finally {
			busy = null;
		}
	}

	async function finish() {
		busy = 'acknowledge';
		try {
			await runAction('?/acknowledge');
		} finally {
			busy = null;
		}
	}

	const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

	const description = $derived.by(() => {
		if (total === 0) return 'You have reviewed every change up to the version this install runs.';
		const lead = `${plural(total, 'change')} since you last reviewed this install.`;
		if (view.attention === 0) return `${lead} None of them need a decision.`;
		return `${lead} ${view.attention === 1 ? 'One needs' : `${view.attention} need`} a decision before ${view.attention === 1 ? 'it applies' : 'they apply'}.`;
	});
</script>

<svelte:head>
	<title>What’s new · Yoal</title>
</svelte:head>

<PageHeader title="What’s new" {description} target="whats-new.header">
	{#snippet meta()}
		<p class="text-xs text-muted-foreground">
			Running <span class="font-mono text-foreground">{view.currentVersion}</span>
			{#if view.lastSeenVersion !== view.currentVersion}
				<span class="px-1">·</span>last reviewed
				<span class="font-mono text-foreground">{view.lastSeenVersion}</span>
			{/if}
		</p>
	{/snippet}
	{#if total > 0 && view.canDecide}
		<Button
			disabled={busy !== null || view.attention > 0}
			onclick={finish}
			data-yoal-target="whats-new.finish"
		>
			{#if busy === 'acknowledge'}<Spinner />{/if}
			{view.pending > 0 && view.attention === 0
				? `Mark ${view.pending} as read and finish`
				: 'Finish review'}
		</Button>
	{/if}
</PageHeader>

{#if total > 0}
	<div class="mt-6 max-w-2xl">
		<div class="flex items-center gap-4">
			<div
				class="h-1 flex-1 overflow-hidden rounded-full bg-muted"
				role="progressbar"
				aria-label="Review progress"
				aria-valuemin={0}
				aria-valuemax={total}
				aria-valuenow={reviewed}
			>
				<div
					class="h-full rounded-full transition-[width] duration-500 ease-out {view.pending === 0
						? 'bg-success'
						: 'bg-foreground'}"
					style:width={`${(reviewed / total) * 100}%`}
				></div>
			</div>
			<p class="shrink-0 text-xs text-muted-foreground tabular-nums">
				{reviewed} of {total} reviewed
			</p>
		</div>
		{#if view.canDecide && firstConsent}
			<p class="mt-2 text-xs text-muted-foreground">
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- in-page anchor -->
				<a
					href={`#${itemAnchor(firstConsent.id)}`}
					class="text-foreground underline decoration-warning underline-offset-4"
					>{firstConsent.title}</a
				>{view.attention > 1 ? ` and ${view.attention - 1} more` : ''}
				{view.attention > 1 ? 'need' : 'needs'} an answer before you can finish. Consent is never assumed.
			</p>
		{:else if view.canDecide && view.pending === 0}
			<p class="mt-2 text-xs text-muted-foreground">
				Finishing clears this page so the next update starts from
				<span class="font-mono">{view.currentVersion}</span>. Your decisions stay in effect.
			</p>
		{/if}
	</div>

	<ol class="mt-12">
		{#each groups as group (group.version)}
			{@render release(group.version, group.items, true)}
		{/each}
	</ol>
{/if}

{#if earlier.length > 0}
	{#if total > 0}
		<div class="mt-20 grid gap-x-12 border-t pt-8 md:grid-cols-[9rem_minmax(0,1fr)]">
			<h2 class="text-sm font-semibold tracking-tight">Earlier releases</h2>
			<p class="text-sm text-muted-foreground">Already reviewed on this install.</p>
		</div>
	{/if}
	<ol class="mt-10" aria-label="Earlier releases">
		{#each earlier as group (group.version)}
			{@render release(group.version, group.items, false)}
		{/each}
	</ol>
{/if}

{#snippet release(version: string, items: WhatsNewItem[], live: boolean)}
	<li
		id={releaseAnchor(version)}
		class="group/release grid scroll-mt-20 gap-x-12 gap-y-4 md:grid-cols-[9rem_minmax(0,1fr)]"
	>
		<header class="md:sticky md:top-20 md:self-start md:pb-14">
			<h2 class="font-mono text-base font-semibold tracking-tight">{version}</h2>
			<p class="mt-0.5 text-xs text-muted-foreground">
				{version === view.currentVersion ? 'Running now' : plural(items.length, 'change')}
			</p>
		</header>
		<div
			class="max-w-[70ch] space-y-10 border-l pb-14 pl-8 group-last/release:pb-2 sm:pl-10 {live
				? ''
				: 'border-dashed'}"
		>
			{#each items as item (item.id)}
				{#if live}
					<Entry {item} review={{ canDecide: view.canDecide, busy, ondecide: decide }} />
				{:else}
					<Entry {item} />
				{/if}
			{/each}
		</div>
	</li>
{/snippet}
