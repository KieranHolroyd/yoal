<script lang="ts">
	/**
	 * The Explorer's time window (docs/LOGS.md §7.2): relative presets, an absolute range (an empty
	 * "To" means until now, so it can still tail), "around a time ±5 m", a UTC/local toggle, and
	 * `[`/`]` buttons that move the window by its own length.
	 */
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as ButtonGroup from '#lib/components/ui/button-group/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import Popover from './Popover.svelte';
	import {
		RELATIVE_PRESETS,
		aroundLogTime,
		formatDateTime,
		logTimeLabel,
		parseDateTimeInput,
		resolveLogTime,
		shiftLogTime,
		type LogTime,
		type LogTimeZone
	} from './time.js';

	let {
		value,
		tz,
		open = $bindable(false),
		compact = false,
		onchange,
		ontzchange
	}: {
		value: LogTime;
		tz: LogTimeZone;
		open?: boolean;
		compact?: boolean;
		onchange: (time: LogTime) => void;
		ontzchange: (tz: LogTimeZone) => void;
	} = $props();

	let from = $state('');
	let to = $state('');
	let around = $state('');
	let error = $state<string | null>(null);

	// Fill the custom fields from the current window each time the picker opens.
	$effect(() => {
		if (!open) return;
		const resolved = resolveLogTime(value, Date.now());
		from = formatDateTime(resolved.from, tz);
		to = value.kind === 'absolute' && value.to !== null ? formatDateTime(value.to, tz) : '';
		around = '';
		error = null;
	});

	const label = $derived(logTimeLabel(value, tz));

	function pick(next: LogTime) {
		open = false;
		onchange(next);
	}

	function apply(event: SubmitEvent) {
		event.preventDefault();
		const start = parseDateTimeInput(from, tz);
		const end = to.trim() ? parseDateTimeInput(to, tz) : null;
		if (start === null || (to.trim() && end === null)) {
			error = 'Use YYYY-MM-DD HH:mm:ss, or leave To empty for "until now".';
			return;
		}
		if (end !== null && end <= start) {
			error = 'From must be before To.';
			return;
		}
		pick({ kind: 'absolute', from: start, to: end });
	}

	function applyAround(event: SubmitEvent) {
		event.preventDefault();
		const at = parseDateTimeInput(around, tz);
		if (at === null) {
			error = 'Use YYYY-MM-DD HH:mm:ss for the moment to look around.';
			return;
		}
		pick(aroundLogTime(at));
	}
</script>

<ButtonGroup.Root aria-label="Time range">
	<Button
		variant="outline"
		size="icon-sm"
		aria-label="Previous time window"
		title="Previous window ([)"
		onclick={() => onchange(shiftLogTime(value, -1, Date.now()))}
	>
		<ChevronLeftIcon />
	</Button>
	<Popover bind:open class="w-[min(36rem,calc(100vw-2rem))] p-0">
		{#snippet trigger({ props })}
			<Button
				{...props}
				variant="outline"
				size="sm"
				class="font-normal {compact ? 'max-w-48' : 'max-w-80'}"
				aria-label="Time range: {label}"
				title="Time range (t)"
			>
				<ClockIcon />
				<span class="truncate">{label}</span>
				<span class="text-xs text-muted-foreground uppercase">{tz === 'utc' ? 'UTC' : 'local'}</span
				>
			</Button>
		{/snippet}
		<div class="grid sm:grid-cols-[1fr_12rem]">
			<div class="space-y-4 border-b p-3 sm:border-r sm:border-b-0">
				<form class="space-y-3" onsubmit={apply}>
					<p class="text-sm font-medium">Absolute range</p>
					<label class="block space-y-1 text-xs text-muted-foreground">
						<span>From</span>
						<Input
							bind:value={from}
							class="h-8 font-mono text-xs"
							placeholder="2026-11-25 14:00:00"
							autocomplete="off"
							spellcheck="false"
						/>
					</label>
					<label class="block space-y-1 text-xs text-muted-foreground">
						<span>To <span class="text-muted-foreground/70">(empty = now)</span></span>
						<Input
							bind:value={to}
							class="h-8 font-mono text-xs"
							placeholder="now"
							autocomplete="off"
							spellcheck="false"
						/>
					</label>
					<Button type="submit" size="sm">Apply range</Button>
				</form>
				<form class="space-y-2 border-t pt-3" onsubmit={applyAround}>
					<p class="text-sm font-medium">Around a moment (±5 min)</p>
					<div class="flex gap-2">
						<Input
							bind:value={around}
							class="h-8 font-mono text-xs"
							placeholder="2026-11-25 14:02:11"
							autocomplete="off"
							spellcheck="false"
							aria-label="Moment"
						/>
						<Button type="submit" size="sm" variant="outline">Go</Button>
					</div>
				</form>
				{#if error}<p class="text-xs text-destructive" role="alert">{error}</p>{/if}
				<div class="flex items-center justify-between gap-2 border-t pt-3">
					<span class="text-xs text-muted-foreground">Show times in</span>
					<ToggleGroup.Root
						type="single"
						size="sm"
						variant="outline"
						value={tz}
						onValueChange={(next) => next && ontzchange(next as LogTimeZone)}
						aria-label="Time zone"
					>
						<ToggleGroup.Item value="utc" class="px-2 text-xs">UTC</ToggleGroup.Item>
						<ToggleGroup.Item value="local" class="px-2 text-xs">Local</ToggleGroup.Item>
					</ToggleGroup.Root>
				</div>
			</div>
			<div class="max-h-96 overflow-y-auto p-1.5">
				<ul class="space-y-0.5">
					{#each RELATIVE_PRESETS as preset (preset.value)}
						{@const active = value.kind === 'relative' && value.value === preset.value}
						<li>
							<button
								type="button"
								class="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none {active
									? 'bg-muted font-medium text-foreground'
									: 'text-muted-foreground'}"
								onclick={() => pick({ kind: 'relative', value: preset.value })}
							>
								{preset.label}
								<span class="font-mono text-xs text-muted-foreground/70">{preset.value}</span>
							</button>
						</li>
					{/each}
				</ul>
			</div>
		</div>
	</Popover>
	<Button
		variant="outline"
		size="icon-sm"
		aria-label="Next time window"
		title="Next window (])"
		onclick={() => onchange(shiftLogTime(value, 1, Date.now()))}
	>
		<ChevronRightIcon />
	</Button>
</ButtonGroup.Root>
