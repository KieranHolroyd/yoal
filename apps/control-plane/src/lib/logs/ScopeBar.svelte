<script lang="ts">
	/**
	 * Which resources a read covers (docs/LOGS.md §7.2, the CloudWatch "log group"). Empty means
	 * everything the reader may see. On a resource page the scope is locked to that resource.
	 * Platform scopes only reach this list for platform admins (the server decides).
	 */
	import LayersIcon from '@lucide/svelte/icons/layers';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { formatLogScope, type LogCapabilities, type LogScopeRef } from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import Popover from './Popover.svelte';

	type ScopeOption = LogCapabilities['scopes'][number];

	let {
		scopes,
		available,
		locked = false,
		lockedLabel,
		open = $bindable(false),
		onchange
	}: {
		scopes: LogScopeRef[];
		available: ScopeOption[];
		locked?: boolean;
		/** Shown instead of the scope ids when locked (e.g. the database's name). */
		lockedLabel?: string;
		open?: boolean;
		onchange: (scopes: LogScopeRef[]) => void;
	} = $props();

	let search = $state('');

	const KIND_LABEL: Record<string, string> = {
		project: 'Project',
		database: 'Database',
		storage: 'Storage',
		broker: 'Queue',
		k8s: 'Kubernetes',
		pipeline: 'Pipeline',
		function: 'Function',
		edge: 'Edge',
		platform: 'Platform'
	};

	function nameOf(scope: LogScopeRef): string {
		return (
			available.find((option) => option.kind === scope.kind && option.id === scope.id)?.name ??
			scope.id
		);
	}

	const selected = $derived(new Set(scopes.map(formatLogScope)));

	const grouped = $derived.by(() => {
		const needle = search.trim().toLowerCase();
		const groups: Record<string, ScopeOption[]> = {};
		for (const option of available) {
			if (needle && !`${option.kind} ${option.name} ${option.id}`.toLowerCase().includes(needle))
				continue;
			(groups[option.kind] ??= []).push(option);
		}
		return Object.entries(groups).map(([kind, options]) => ({
			kind,
			options: options.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50)
		}));
	});

	function toggle(option: ScopeOption) {
		const key = formatLogScope(option);
		if (selected.has(key)) onchange(scopes.filter((scope) => formatLogScope(scope) !== key));
		else onchange([...scopes, { kind: option.kind, id: option.id }]);
	}
</script>

<div class="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Scope">
	{#if locked}
		<span
			class="inline-flex h-7 max-w-72 items-center gap-1.5 rounded-md border bg-muted/40 px-2 text-xs"
			title="This view is locked to {scopes.map(formatLogScope).join(', ')}"
		>
			<LockIcon class="size-3 shrink-0 text-muted-foreground" />
			{#if lockedLabel}
				<span class="truncate font-medium">{lockedLabel}</span>
			{:else}
				{#each scopes as scope (formatLogScope(scope))}
					<span class="text-muted-foreground">{KIND_LABEL[scope.kind] ?? scope.kind}</span>
					<span class="truncate font-mono">{nameOf(scope)}</span>
				{/each}
			{/if}
		</span>
	{:else}
		{#if scopes.length === 0}
			<span class="inline-flex h-7 items-center gap-1.5 rounded-md border bg-muted/40 px-2 text-xs">
				<LayersIcon class="size-3 text-muted-foreground" />
				All scopes
			</span>
		{/if}
		{#each scopes as scope (formatLogScope(scope))}
			<span
				class="inline-flex h-7 max-w-64 items-center gap-1 rounded-md border bg-muted/40 pr-0.5 pl-2 text-xs"
			>
				<span class="text-muted-foreground">{KIND_LABEL[scope.kind] ?? scope.kind}</span>
				<span class="truncate font-mono">{nameOf(scope)}</span>
				<button
					type="button"
					class="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
					aria-label="Remove {nameOf(scope)}"
					onclick={() =>
						onchange(scopes.filter((item) => formatLogScope(item) !== formatLogScope(scope)))}
				>
					<XIcon class="size-3" />
				</button>
			</span>
		{/each}
		<Popover bind:open align="start" class="w-80 p-0">
			{#snippet trigger({ props })}
				<Button {...props} variant="ghost" size="sm" class="h-7 px-2 text-xs text-muted-foreground">
					<PlusIcon />Scope
				</Button>
			{/snippet}
			<div class="border-b p-2">
				<Input
					bind:value={search}
					placeholder="Find a project, database…"
					class="h-8 text-sm"
					aria-label="Find a scope"
				/>
			</div>
			<div class="max-h-80 overflow-y-auto p-1.5">
				{#if grouped.length === 0}
					<p class="px-2 py-4 text-center text-sm text-muted-foreground">
						{available.length === 0 ? 'No scopes to pick yet.' : 'Nothing matches.'}
					</p>
				{/if}
				{#each grouped as group (group.kind)}
					<p class="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
						{KIND_LABEL[group.kind] ?? group.kind}
					</p>
					<ul>
						{#each group.options as option (formatLogScope(option))}
							{@const on = selected.has(formatLogScope(option))}
							<li>
								<button
									type="button"
									class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted {on
										? 'font-medium'
										: ''}"
									aria-pressed={on}
									onclick={() => toggle(option)}
								>
									<span
										class="size-1.5 shrink-0 rounded-full {on ? 'bg-primary' : 'bg-transparent'}"
									></span>
									<span class="truncate">{option.name}</span>
									{#if option.parent}<span class="ml-auto truncate text-xs text-muted-foreground"
											>{option.parent}</span
										>{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/each}
			</div>
			{#if scopes.length > 0}
				<div class="border-t p-1.5">
					<Button
						variant="ghost"
						size="sm"
						class="w-full justify-start"
						onclick={() => onchange([])}
					>
						Clear: search every scope
					</Button>
				</div>
			{/if}
		</Popover>
	{/if}
</div>
