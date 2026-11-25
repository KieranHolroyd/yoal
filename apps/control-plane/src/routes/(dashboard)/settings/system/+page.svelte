<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import { fly } from 'svelte/transition';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SearchXIcon from '@lucide/svelte/icons/search-x';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import ToggleRightIcon from '@lucide/svelte/icons/toggle-right';
	import UndoIcon from '@lucide/svelte/icons/undo-2';
	import XIcon from '@lucide/svelte/icons/x';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import ConfigProgress from '../ConfigProgress.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import ReviewDialog from './ReviewDialog.svelte';
	import ToggleRow from './ToggleRow.svelte';
	import { AREAS } from './_lib/areas.js';
	import { isRisky, pendingChanges, type ToggleView } from './_lib/changes.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const toggles = $derived(data.toggles as ToggleView[]);
	const local = $derived(data.availability === 'local');
	const canEdit = $derived(data.availability === 'ready' || local);
	const ready = $derived(canEdit && !data.inFlight);

	// ------------------------------------------------------------------ draft

	/** Positions a person has chosen but not saved, keyed by env var. */
	let draft = $state<Record<string, boolean>>({});
	$effect(() => {
		// After a save and restart the running values catch up: drop choices that now match.
		for (const toggle of toggles) if (draft[toggle.key] === toggle.value) delete draft[toggle.key];
	});

	const valueOf = (toggle: ToggleView) => draft[toggle.key] ?? toggle.value;
	const changes = $derived(pendingChanges(toggles, draft));
	const riskyChanges = $derived(changes.filter((change) => change.risky));

	function choose(toggle: ToggleView, value: boolean) {
		if (value === toggle.value) delete draft[toggle.key];
		else draft[toggle.key] = value;
	}

	function discard() {
		draft = {};
	}

	// ------------------------------------------------------------------ overview

	const enabled = $derived(toggles.filter((toggle) => toggle.value).length);
	const notDefault = $derived(toggles.filter((toggle) => toggle.value !== toggle.default));
	const optInsOn = $derived(toggles.filter((toggle) => toggle.optIn && toggle.value));
	const lessSafe = $derived(toggles.filter((toggle) => isRisky(toggle, toggle.value)));

	// ------------------------------------------------------------------ filters

	type Filter = 'all' | 'custom' | 'opt-in' | 'risky' | 'unsaved';
	let filter = $state<Filter>('all');
	let query = $state('');
	let search = $state<HTMLInputElement | null>(null);

	/** Filters read the running value, so a row does not vanish the moment it is flipped. */
	function passes(toggle: ToggleView): boolean {
		const dirty = draft[toggle.key] !== undefined;
		switch (filter) {
			case 'custom':
				return dirty || toggle.value !== toggle.default;
			case 'opt-in':
				return toggle.optIn;
			case 'risky':
				return dirty || isRisky(toggle, toggle.value);
			case 'unsaved':
				return dirty;
			default:
				return true;
		}
	}

	function matches(toggle: ToggleView): boolean {
		const needle = query.trim().toLowerCase();
		return (
			!needle ||
			toggle.label.toLowerCase().includes(needle) ||
			toggle.key.toLowerCase().includes(needle) ||
			toggle.description.toLowerCase().includes(needle)
		);
	}

	const groups = $derived(
		AREAS.map((meta) => {
			const all = toggles.filter((toggle) => toggle.area === meta.area);
			return {
				...meta,
				all,
				on: all.filter((toggle) => valueOf(toggle)).length,
				unsaved: all.filter((toggle) => draft[toggle.key] !== undefined).length,
				shown: all.filter((toggle) => passes(toggle) && matches(toggle))
			};
		}).filter((group) => group.all.length > 0)
	);
	const visible = $derived(groups.filter((group) => group.shown.length > 0));
	const shownCount = $derived(visible.reduce((sum, group) => sum + group.shown.length, 0));
	const filtering = $derived(filter !== 'all' || query.trim() !== '');

	function setFilter(next: Filter) {
		filter = filter === next && next !== 'all' ? 'all' : next;
	}

	function clearFilters() {
		filter = 'all';
		query = '';
	}

	function jump(area: string) {
		document.getElementById(`area-${area}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	// ------------------------------------------------------------------ saving

	let reviewing = $state(false);

	function review() {
		if (changes.length && ready) reviewing = true;
	}

	function typing(target: EventTarget | null): boolean {
		const element = target as HTMLElement | null;
		return Boolean(
			element &&
				(element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable)
		);
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === '/' && !typing(event.target) && !reviewing) {
			event.preventDefault();
			search?.focus();
		} else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && changes.length) {
			event.preventDefault();
			review();
		}
	}

	// Unsaved switches are easy to lose: ask before leaving the page.
	beforeNavigate((navigation) => {
		if (!changes.length || navigation.type === 'leave') return;
		if (!confirm(`Leave without saving ${changes.length} ${changes.length === 1 ? 'change' : 'changes'}?`))
			navigation.cancel();
	});

	function onbeforeunload(event: BeforeUnloadEvent) {
		if (changes.length) event.preventDefault();
	}
</script>

<svelte:head><title>System · Settings · Yoal</title></svelte:head>
<svelte:window {onkeydown} {onbeforeunload} />

<SettingsHeader id="system">
	<p class="text-xs text-muted-foreground">
		Writes <code class="font-mono">{local ? '.data/platform-settings.json' : '/etc/yoal/yoal.env'}</code>.
		Each node's own <code class="font-mono">agent.env</code> is not changed here.
	</p>
</SettingsHeader>

<div class="space-y-6">
	<ConfigProgress
		status={data.status}
		pending={data.pending}
		inFlight={data.inFlight}
		availability={data.availability}
		restartPending={data.restartPending}
		sections={['system']}
	/>

	{#if !canEdit}
		<Alert.Root>
			<LockIcon />
			<Alert.Title>Read-only on this host</Alert.Title>
			<Alert.Description>
				{data.availability === 'unmanaged'
					? 'This control plane is not an installed release, so these come from the shell environment. Change them there.'
					: 'Dashboard settings are not enabled on this host yet. Run `sudo yoal-update-self check` on the server once.'}
			</Alert.Description>
		</Alert.Root>
	{/if}

	<!-- Overview: what is on, what differs from a fresh install, and how safe the install is. -->
	<section
		class="grid gap-px overflow-hidden rounded-xl border bg-border shadow-xs sm:grid-cols-2 lg:grid-cols-4"
		aria-label="Overview"
	>
		<div class="space-y-3 bg-card p-4">
			<div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
				<ToggleRightIcon class="size-3.5" />Enabled
			</div>
			<p class="text-2xl font-semibold tabular-nums">
				{enabled}<span class="text-base font-normal text-muted-foreground"> / {toggles.length}</span>
			</p>
			<div class="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted" aria-hidden="true">
				{#each toggles as toggle (toggle.key)}
					<span
						class="flex-1 transition-colors {toggle.value
							? isRisky(toggle, true)
								? 'bg-destructive'
								: 'bg-primary'
							: 'bg-transparent'}"
					></span>
				{/each}
			</div>
		</div>

		{#snippet stat(
			label: string,
			value: number,
			hint: string,
			target: Filter,
			Icon: typeof PenLineIcon,
			tone: string
		)}
			<button
				type="button"
				onclick={() => setFilter(target)}
				aria-pressed={filter === target}
				class="group space-y-3 p-4 text-left transition-colors {filter === target
					? 'bg-muted'
					: 'bg-card hover:bg-muted/50'}"
			>
				<div class="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
					<span class="flex items-center gap-2"><Icon class="size-3.5 {tone}" />{label}</span>
					<ArrowRightIcon
						class="size-3.5 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
					/>
				</div>
				<p class="text-2xl font-semibold tabular-nums {value ? tone : ''}">{value}</p>
				<p class="text-xs text-muted-foreground">{hint}</p>
			</button>
		{/snippet}

		{@render stat(
			'Changed from default',
			notDefault.length,
			notDefault.length ? 'Pinned in the env file' : 'Running exactly as shipped',
			'custom',
			PenLineIcon,
			'text-warning'
		)}
		{@render stat(
			'Opt-ins on',
			optInsOn.length,
			`of ${toggles.filter((toggle) => toggle.optIn).length} off-by-default features`,
			'opt-in',
			FlaskConicalIcon,
			'text-info'
		)}
		{@render stat(
			lessSafe.length ? 'Less safe' : 'Safety',
			lessSafe.length,
			lessSafe.length
				? lessSafe.map((toggle) => toggle.label).join(', ')
				: 'Every safety setting is in its safe position',
			'risky',
			lessSafe.length ? ShieldAlertIcon : ShieldCheckIcon,
			lessSafe.length ? 'text-destructive' : 'text-success'
		)}
	</section>

	<!-- Toolbar: search, quick filters and a jump list of areas. Sticks while scrolling. -->
	<div
		class="sticky top-14 z-10 -mx-1 space-y-3 border-b bg-background/85 px-1 pt-3 pb-3 backdrop-blur supports-[backdrop-filter]:bg-background/70"
	>
		<div class="flex flex-wrap items-center gap-3">
			<div class="relative min-w-56 flex-1">
				<SearchIcon
					class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					bind:ref={search}
					bind:value={query}
					placeholder="Search {toggles.length} settings by name, variable or description"
					class="pr-16 pl-8"
					aria-label="Search settings"
					onkeydown={(event) => {
						if (event.key === 'Escape') {
							query = '';
							search?.blur();
						}
					}}
				/>
				<span class="absolute top-1/2 right-2 -translate-y-1/2">
					{#if query}
						<button
							type="button"
							class="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
							onclick={() => (query = '')}
							aria-label="Clear search"
						>
							<XIcon class="size-3.5" />
						</button>
					{:else}
						<Kbd>/</Kbd>
					{/if}
				</span>
			</div>
			<ToggleGroup.Root
				type="single"
				variant="outline"
				size="sm"
				value={filter}
				onValueChange={(value) => (filter = (value || 'all') as Filter)}
				aria-label="Show"
			>
				<ToggleGroup.Item value="all">All</ToggleGroup.Item>
				<ToggleGroup.Item value="custom">Not default</ToggleGroup.Item>
				<ToggleGroup.Item value="opt-in">Opt-in</ToggleGroup.Item>
				<ToggleGroup.Item value="risky">Less safe</ToggleGroup.Item>
				{#if changes.length}
					<ToggleGroup.Item value="unsaved">Unsaved · {changes.length}</ToggleGroup.Item>
				{/if}
			</ToggleGroup.Root>
		</div>

		<nav class="-mb-1 flex gap-1.5 overflow-x-auto pb-1" aria-label="Areas">
			{#each groups as group (group.area)}
				{@const dimmed = group.shown.length === 0}
				<button
					type="button"
					onclick={() => jump(group.area)}
					disabled={dimmed}
					class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
				>
					<group.icon class="size-3.5 text-muted-foreground" />
					{group.title}
					<span class="text-muted-foreground tabular-nums">{group.on}/{group.all.length}</span>
					{#if group.unsaved}<span class="size-1.5 rounded-full bg-primary" aria-label="Unsaved"></span>{/if}
				</button>
			{/each}
		</nav>
	</div>

	{#if filtering}
		<p class="-mt-2 text-xs text-muted-foreground">
			Showing {shownCount} of {toggles.length}.
			<button type="button" class="font-medium underline-offset-4 hover:text-foreground hover:underline" onclick={clearFilters}
				>Show all</button
			>
		</p>
	{/if}

	{#each visible as group (group.area)}
		<section
			id={`area-${group.area}`}
			class="scroll-mt-48 overflow-hidden rounded-xl border bg-card shadow-xs"
			aria-labelledby={`area-${group.area}-title`}
		>
			<header class="flex items-center gap-3.5 border-b bg-muted/20 px-6 py-4">
				<span
					class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground shadow-xs"
					aria-hidden="true"
				>
					<group.icon class="size-4" />
				</span>
				<div class="min-w-0 flex-1">
					<h3 id={`area-${group.area}-title`} class="text-sm font-semibold">{group.title}</h3>
					<p class="truncate text-xs text-muted-foreground">{group.blurb}</p>
				</div>
				<div class="hidden shrink-0 items-center gap-2.5 sm:flex">
					<span class="text-xs text-muted-foreground tabular-nums">{group.on} of {group.all.length} on</span>
					<span class="flex h-1.5 w-16 gap-px overflow-hidden rounded-full bg-muted" aria-hidden="true">
						{#each group.all as toggle (toggle.key)}
							<span class="flex-1 transition-colors {valueOf(toggle) ? 'bg-primary' : ''}"></span>
						{/each}
					</span>
				</div>
			</header>
			<ul class="divide-y">
				{#each group.shown as toggle (toggle.key)}
					<ToggleRow
						{toggle}
						value={valueOf(toggle)}
						{query}
						disabled={!ready}
						onchange={(value) => choose(toggle, value)}
					/>
				{/each}
			</ul>
		</section>
	{:else}
		<EmptyState
			icon={SearchXIcon}
			title="No setting matches"
			description={query ? `Nothing matches “${query.trim()}” with this filter.` : 'Nothing matches this filter.'}
		>
			<Button variant="outline" size="sm" onclick={clearFilters}>Show all settings</Button>
		</EmptyState>
	{/each}

	{#if changes.length}
		<div
			class="sticky bottom-4 z-10 mx-auto w-full max-w-2xl"
			transition:fly={{ y: 24, duration: 180 }}
		>
			<div
				class="flex flex-wrap items-center gap-3 rounded-xl border bg-popover/95 p-2.5 pl-4 shadow-xl ring-1 ring-black/5 backdrop-blur {riskyChanges.length
					? 'border-destructive/40'
					: ''}"
				role="region"
				aria-label="Unsaved changes"
			>
				<span
					class="flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums {riskyChanges.length
						? 'bg-destructive/10 text-destructive'
						: 'bg-primary/10 text-primary'}"
				>
					{changes.length}
				</span>
				<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs">
					{#each changes.slice(0, 3) as change (change.toggle.key)}
						<span
							class="inline-flex max-w-44 items-center gap-1 truncate rounded-md border px-1.5 py-0.5 {change.risky
								? 'border-destructive/30 text-destructive'
								: ''}"
						>
							<span class="truncate">{change.toggle.label}</span>
							<ArrowRightIcon class="size-3 shrink-0 opacity-60" />
							<span class="font-medium">{change.to ? 'on' : 'off'}</span>
						</span>
					{/each}
					{#if changes.length > 3}
						<span class="text-muted-foreground">+{changes.length - 3} more</span>
					{/if}
				</div>
				<div class="flex shrink-0 items-center gap-1.5">
					<Button variant="ghost" size="sm" onclick={discard}><UndoIcon />Discard</Button>
					<Button
						size="sm"
						variant={riskyChanges.length ? 'destructive' : 'default'}
						onclick={review}
						disabled={!ready}
					>
						Review and save
						<Kbd class="hidden bg-primary-foreground/15 text-current sm:inline-flex">⌘S</Kbd>
					</Button>
				</div>
			</div>
		</div>
	{/if}
</div>

<ReviewDialog bind:open={reviewing} {changes} {local} onsaved={discard} />
