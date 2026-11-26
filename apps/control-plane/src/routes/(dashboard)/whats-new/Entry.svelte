<script lang="ts">
	import type { WhatsNewDecision, WhatsNewItem, WhatsNewItemView } from '@yoal/contracts';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { formatRelative } from '../_lib/format.js';
	import RichText from './RichText.svelte';
	import {
		STATE_LABEL,
		destinationLabel,
		endpointHost,
		itemAnchor,
		itemState,
		paragraphs
	} from './view.js';

	/**
	 * One change, written like a release note and pinned to the page's timeline rail. With `review`
	 * it shows where the change stands and the controls to decide on it; without, it is history.
	 */
	let {
		item,
		review
	}: {
		item: WhatsNewItem | WhatsNewItemView;
		review?: {
			canDecide: boolean;
			/** `<itemId>:<decision>` while a decision is saving. */
			busy: string | null;
			ondecide: (itemId: string, decision: WhatsNewDecision) => void;
		};
	} = $props();

	const live = $derived(review && 'decision' in item ? item : null);
	const status = $derived(live ? itemState(live) : null);
	const pending = $derived(status === 'consent' || status === 'new');
	const consent = $derived(live?.consentState ?? null);
	// Reviewed and historical entries recede to their summary; the detail was read already.
	const body = $derived(pending ? paragraphs(item.body) : []);
	const saving = (decision: WhatsNewDecision) => review?.busy === `${item.id}:${decision}`;
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- catalog hrefs are fixed dashboard paths or external docs -->
<article
	id={itemAnchor(item.id)}
	data-yoal-target={`whats-new.item.${item.id}`}
	class="relative scroll-mt-20"
>
	<!-- Marker on the timeline rail, level with the title. -->
	<span
		aria-hidden="true"
		class="absolute top-[0.4rem] -left-[calc(2rem+5px)] size-[9px] rounded-full ring-4 ring-background sm:-left-[calc(2.5rem+5px)]
			{status === 'consent'
			? 'bg-warning'
			: status === 'new'
				? 'bg-foreground'
				: 'border border-muted-foreground/40 bg-background'}"
	></span>

	<div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
		<h3
			class="text-pretty {pending
				? 'text-[17px] leading-snug font-semibold tracking-tight'
				: 'text-[15px] leading-snug font-medium text-foreground/80'}"
		>
			{item.title}
		</h3>
		{#if status === 'consent'}
			<p class="shrink-0 text-xs font-medium text-warning">Needs your decision</p>
		{:else if status && !pending}
			<p class="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
				<CheckIcon class="size-3" />
				{STATE_LABEL[status]}{#if live?.decidedAt}&nbsp;{formatRelative(live.decidedAt)}{/if}
			</p>
		{/if}
	</div>

	<p
		class="mt-1.5 leading-relaxed text-pretty {pending
			? 'text-[15px]'
			: 'text-sm text-muted-foreground'}"
	>
		<RichText text={item.summary} />
	</p>
	{#each body as paragraph, index (index)}
		<p class="mt-3 text-sm leading-relaxed text-pretty text-muted-foreground">
			<RichText text={paragraph} />
		</p>
	{/each}

	{#if consent && review}
		<div class="mt-5 overflow-hidden rounded-lg border">
			<div class="flex items-center gap-2 bg-muted/40 px-4 py-2 text-xs">
				<span
					aria-hidden="true"
					class="size-1.5 shrink-0 rounded-full {consent.enabled
						? 'bg-success'
						: 'bg-muted-foreground/50'}"
				></span>
				<span class="font-medium">{consent.label} is {consent.enabled ? 'on' : 'off'}</span>
				<span
					class="ml-auto min-w-0 truncate font-mono text-muted-foreground"
					title={consent.endpoint}
				>
					{consent.enabled ? 'sends to' : 'would send to'}
					{endpointHost(consent.endpoint)}
				</span>
			</div>

			{#if status === 'consent'}
				{#if !review.canDecide}
					<p class="border-t px-4 py-3 text-sm text-muted-foreground">
						A platform administrator needs to decide this.
					</p>
				{:else if consent.enabled}
					<div class="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
						<p class="text-sm text-muted-foreground">
							It is already on. Confirm you want to keep it.
						</p>
						<Button
							size="sm"
							disabled={review.busy !== null}
							onclick={() => review.ondecide(item.id, 'enabled')}
						>
							{#if saving('enabled')}<Spinner />{/if}
							{item.consentLabels?.keep ?? 'Keep it on'}
						</Button>
					</div>
				{:else}
					<div class="grid divide-y border-t sm:grid-cols-2 sm:divide-x sm:divide-y-0">
						{@render option(
							'enabled',
							item.consentLabels?.enable ?? 'Enable',
							'Applies now. You can turn it off later in settings.'
						)}
						{@render option(
							'declined',
							item.consentLabels?.decline ?? 'Keep it off',
							'Nothing changes. You can turn it on later in settings.'
						)}
					</div>
				{/if}
			{/if}
		</div>
	{/if}

	{#if (status === 'new' && review?.canDecide) || item.href || item.learnMore}
		<div class="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
			{#if status === 'new' && review?.canDecide}
				<Button
					size="sm"
					variant="outline"
					disabled={review.busy !== null}
					onclick={() => review.ondecide(item.id, 'acknowledged')}
				>
					{#if saving('acknowledged')}<Spinner />{:else}<CheckIcon />{/if}
					Mark as read
				</Button>
			{/if}
			{#if item.href}
				<a
					href={item.href}
					class="group/link inline-flex items-center gap-1 font-medium {pending
						? ''
						: 'text-foreground/80'} hover:text-foreground"
				>
					{destinationLabel(item.href)}
					<span aria-hidden="true" class="transition-transform group-hover/link:translate-x-0.5"
						>→</span
					>
				</a>
			{/if}
			{#if item.learnMore}
				<a
					href={item.learnMore}
					target="_blank"
					rel="noreferrer"
					class="group/link inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
				>
					Documentation
					<span
						aria-hidden="true"
						class="transition-transform group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5"
						>↗</span
					>
				</a>
			{/if}
		</div>
	{/if}
</article>

{#snippet option(decision: WhatsNewDecision, label: string, detail: string)}
	<button
		type="button"
		class="group/option flex flex-col items-start gap-0.5 px-4 py-3.5 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50"
		disabled={review?.busy !== null}
		onclick={() => review?.ondecide(item.id, decision)}
	>
		<span class="flex w-full items-center gap-2 text-sm font-medium">
			{#if saving(decision)}<Spinner class="size-3.5" />{/if}
			{label}
			<span
				aria-hidden="true"
				class="ml-auto text-muted-foreground transition-transform group-hover/option:translate-x-0.5 group-hover/option:text-foreground"
				>→</span
			>
		</span>
		<span class="text-xs text-muted-foreground">{detail}</span>
	</button>
{/snippet}
