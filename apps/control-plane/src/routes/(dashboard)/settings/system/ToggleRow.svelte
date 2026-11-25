<script lang="ts">
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { highlight, isRisky, type ToggleView } from './_lib/changes.js';

	/**
	 * One System setting: what it does, what yoal.env holds, and a switch. A pending change is shown
	 * in place (accent bar, "was" marker) until it is saved or discarded.
	 */
	let {
		toggle,
		value,
		query = '',
		disabled = false,
		onchange
	}: {
		toggle: ToggleView;
		/** The position on screen (the draft, else the running value). */
		value: boolean;
		query?: string;
		disabled?: boolean;
		onchange: (value: boolean) => void;
	} = $props();

	const id = $derived(`toggle-${toggle.key}`);
	const dirty = $derived(value !== toggle.value);
	const atDefault = $derived(value === toggle.default);
	const riskyNow = $derived(isRisky(toggle, value));
	const long = $derived(toggle.description.length > 150);
	let expanded = $state(false);

	const riskText = $derived(
		toggle.risky === 'off'
			? `Turning this off weakens ${toggle.area === 'access' ? 'sign-in' : 'a safety net'}.`
			: 'Turning this on widens access or changes data. Leave it off unless you mean it.'
	);
</script>

{#snippet marked(text: string)}
	{#each highlight(text, query) as part, index (index)}
		{#if part.match}<mark class="rounded-sm bg-warning/25 px-px text-foreground">{part.text}</mark
			>{:else}{part.text}{/if}
	{/each}
{/snippet}

<li
	class="group/row relative flex items-start gap-4 py-4 pr-5 pl-6 transition-colors {dirty
		? 'bg-primary/[0.04]'
		: riskyNow
			? 'bg-destructive/[0.03]'
			: 'hover:bg-muted/30'}"
	data-key={toggle.key}
>
	<span
		class="absolute inset-y-0 left-0 w-0.5 transition-colors {dirty
			? 'bg-primary'
			: riskyNow
				? 'bg-destructive/60'
				: 'bg-transparent'}"
		aria-hidden="true"
	></span>

	<div class="min-w-0 flex-1 space-y-1.5">
		<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
			<label for={id} class="cursor-pointer text-sm font-medium">{@render marked(toggle.label)}</label>
			{#if toggle.risky}
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<span
								{...props}
								class="inline-flex {riskyNow ? 'text-destructive' : 'text-muted-foreground/70'}"
								aria-label={riskText}
							>
								<ShieldAlertIcon class="size-3.5" />
							</span>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content class="max-w-xs">{riskText}</Tooltip.Content>
				</Tooltip.Root>
			{/if}
			{#if toggle.optIn}
				<Badge variant="info">Opt-in</Badge>
			{:else if toggle.area !== 'access' && toggle.key.startsWith('YOAL_FEATURE_')}
				<Badge variant="neutral">Kill switch</Badge>
			{/if}
			{#if riskyNow && !dirty}
				<Badge variant="danger">{value ? 'On' : 'Off'} — less safe</Badge>
			{:else if !atDefault && !dirty}
				<Badge variant="warning">Not default</Badge>
			{/if}
			{#if dirty}
				<Badge variant="default">Unsaved</Badge>
			{/if}
		</div>

		<p
			class="max-w-prose text-sm text-pretty text-muted-foreground {long && !expanded
				? 'line-clamp-2'
				: ''}"
		>
			{@render marked(toggle.description)}
		</p>
		{#if long}
			<button
				type="button"
				class="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				onclick={() => (expanded = !expanded)}
				aria-expanded={expanded}
			>
				{expanded ? 'Show less' : 'Show more'}
			</button>
		{/if}

		<div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
			<span class="inline-flex items-center gap-0.5">
				<code
					class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
					title={toggle.raw === null ? 'Not set in yoal.env' : `yoal.env holds ${toggle.key}=${toggle.raw}`}
				>
					{@render marked(toggle.key)}{#if toggle.raw !== null}<span class="text-foreground/70"
							>={toggle.raw}</span
						>{/if}
				</code>
				<span class="opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
					<CopyButton value={toggle.key} label="Copy variable name" variant="ghost" size="icon-xs" iconOnly />
				</span>
			</span>
			<span class="text-xs text-muted-foreground">
				{toggle.raw === null ? 'Unset · default' : 'Pinned · default'}
				{toggle.default ? 'on' : 'off'}
			</span>
			{#if !atDefault && !disabled}
				<button
					type="button"
					class="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
					onclick={() => onchange(toggle.default)}
				>
					<RotateCcwIcon class="size-3" />Reset to default
				</button>
			{/if}
		</div>
	</div>

	<div class="flex w-14 shrink-0 flex-col items-center gap-1.5 pt-0.5">
		<Switch
			{id}
			checked={value}
			onCheckedChange={onchange}
			{disabled}
			aria-label={toggle.label}
			class={riskyNow ? 'data-checked:bg-destructive' : ''}
		/>
		<span class="text-[11px] font-medium tabular-nums {value ? 'text-foreground' : 'text-muted-foreground'}">
			{value ? 'On' : 'Off'}
		</span>
		{#if dirty}
			<span class="text-[10px] text-muted-foreground line-through">{toggle.value ? 'On' : 'Off'}</span>
		{/if}
	</div>
</li>
