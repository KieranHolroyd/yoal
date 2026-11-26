<script lang="ts">
	/**
	 * Saved queries and the Explorer palette (docs/LOGS.md §7.2–7.3, ⌘K): personal or org views
	 * with a query, scopes, time and columns. The palette also jumps to a scope on `/logs`.
	 * Personal views are visible to their owner only; the server enforces that and who may edit.
	 */
	import { page } from '$app/state';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import BookmarkIcon from '@lucide/svelte/icons/bookmark';
	import BookmarkPlusIcon from '@lucide/svelte/icons/bookmark-plus';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { toast } from 'svelte-sonner';
	import {
		formatLogScope,
		type LogCapabilities,
		type LogSavedQuery,
		type LogSavedQueryInput,
		type LogScopeRef
	} from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { errorText } from '#lib/query.js';
	import { createSavedQuery, deleteSavedQuery, listSavedQueries, logKeys } from './api.js';
	import Popover from './Popover.svelte';

	let {
		open = $bindable(false),
		scopeOptions = [],
		allowScopes = true,
		current,
		onapply,
		onscope
	}: {
		open?: boolean;
		scopeOptions?: LogCapabilities['scopes'];
		/** False when the explorer is locked to a scope: saved scopes are ignored and not offered. */
		allowScopes?: boolean;
		/** What "Save" stores. */
		current: () => Omit<LogSavedQueryInput, 'name' | 'visibility'>;
		onapply: (saved: LogSavedQuery) => void;
		onscope?: (scope: LogScopeRef) => void;
	} = $props();

	const client = useQueryClient();
	let search = $state('');
	let saveOpen = $state(false);
	let name = $state('');
	let visibility = $state<'personal' | 'org'>('personal');

	const saved = createQuery(() => ({
		queryKey: logKeys.saved,
		queryFn: ({ signal }) => listSavedQueries(signal),
		enabled: open || saveOpen,
		staleTime: 30_000,
		retry: false
	}));

	const userId = $derived((page.data as { user?: { id?: string } }).user?.id ?? null);

	const filtered = $derived.by(() => {
		const needle = search.trim().toLowerCase();
		const list = saved.data ?? [];
		const match = (item: LogSavedQuery) =>
			!needle || `${item.name} ${item.q}`.toLowerCase().includes(needle);
		return {
			personal: list.filter((item) => item.visibility === 'personal' && match(item)),
			org: list.filter((item) => item.visibility === 'org' && match(item))
		};
	});

	const scopeMatches = $derived.by(() => {
		const needle = search.trim().toLowerCase();
		if (!allowScopes || !onscope || !needle) return [];
		return scopeOptions
			.filter((option) =>
				`${option.kind} ${option.name} ${option.id}`.toLowerCase().includes(needle)
			)
			.slice(0, 8);
	});

	const create = createMutation(() => ({
		mutationFn: (input: LogSavedQueryInput) => createSavedQuery(input),
		onSuccess: (query) => {
			toast.success(`Saved “${query.name}”.`);
			saveOpen = false;
			name = '';
			void client.invalidateQueries({ queryKey: logKeys.saved });
		},
		onError: (error) => toast.error(errorText(error, 'Could not save the query.'))
	}));

	const remove = createMutation(() => ({
		mutationFn: (id: string) => deleteSavedQuery(id),
		onSuccess: () => void client.invalidateQueries({ queryKey: logKeys.saved }),
		onError: (error) => toast.error(errorText(error, 'Could not delete the saved query.'))
	}));

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim()) return;
		const base = current();
		create.mutate({
			...base,
			scopes: allowScopes ? base.scopes : [],
			name: name.trim(),
			visibility
		});
	}

	export function openSave(): void {
		saveOpen = true;
	}

	function rangeText(item: LogSavedQuery): string {
		return 'relative' in item.range ? item.range.relative : 'fixed window';
	}
</script>

{#snippet savedRow(item: LogSavedQuery)}
	<li class="group flex items-center gap-1">
		<button
			type="button"
			class="flex min-w-0 flex-1 flex-col rounded-md px-2 py-1 text-left hover:bg-muted"
			onclick={() => {
				open = false;
				onapply(item);
			}}
		>
			<span class="truncate text-sm">{item.name}</span>
			<span class="truncate font-mono text-[11px] text-muted-foreground">
				{item.q || '(everything)'} · {rangeText(item)}{allowScopes && item.scopes.length > 0
					? ` · ${item.scopes.map(formatLogScope).join(', ')}`
					: ''}
			</span>
		</button>
		{#if item.ownerId === userId}
			<Button
				variant="ghost"
				size="icon-sm"
				class="size-6 opacity-0 group-hover:opacity-100"
				aria-label="Delete {item.name}"
				onclick={() => remove.mutate(item.id)}
			>
				<TrashIcon class="size-3.5" />
			</Button>
		{/if}
	</li>
{/snippet}

<Popover bind:open align="end" class="w-[min(26rem,calc(100vw-2rem))] p-0">
	{#snippet trigger({ props })}
		<Button {...props} variant="outline" size="sm" title="Saved queries (⌘K)">
			<BookmarkIcon />Saved
		</Button>
	{/snippet}
	<div class="border-b p-2">
		<Input
			bind:value={search}
			placeholder={allowScopes && onscope ? 'Saved queries and scopes…' : 'Saved queries…'}
			class="h-8 text-sm"
			aria-label="Search saved queries"
		/>
	</div>
	<div class="max-h-96 overflow-y-auto p-1.5">
		{#if saved.isPending}
			<p class="px-2 py-3 text-sm text-muted-foreground">Loading saved queries…</p>
		{:else if saved.isError}
			<p class="px-2 py-3 text-sm text-destructive">
				{errorText(saved.error, 'Could not load saved queries.')}
			</p>
		{:else}
			{#if filtered.personal.length > 0}
				<p class="px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground">Yours</p>
				<ul>
					{#each filtered.personal as item (item.id)}{@render savedRow(item)}{/each}
				</ul>
			{/if}
			{#if filtered.org.length > 0}
				<p class="flex items-center gap-1 px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
					<UsersIcon class="size-3" />Shared with the organisation
				</p>
				<ul>
					{#each filtered.org as item (item.id)}{@render savedRow(item)}{/each}
				</ul>
			{/if}
			{#if filtered.personal.length === 0 && filtered.org.length === 0}
				<p class="px-2 py-3 text-sm text-muted-foreground">
					{search ? 'No saved query matches.' : 'No saved queries yet. Save the current one below.'}
				</p>
			{/if}
		{/if}
		{#if scopeMatches.length > 0}
			<p class="flex items-center gap-1 px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
				<LayersIcon class="size-3" />Scopes
			</p>
			<ul>
				{#each scopeMatches as option (formatLogScope(option))}
					<li>
						<button
							type="button"
							class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
							onclick={() => {
								open = false;
								onscope?.({ kind: option.kind, id: option.id });
							}}
						>
							<span class="text-xs text-muted-foreground">{option.kind}</span>
							<span class="truncate">{option.name}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
	<div class="border-t p-1.5">
		<Button
			variant="ghost"
			size="sm"
			class="w-full justify-start"
			onclick={() => {
				open = false;
				saveOpen = true;
			}}
		>
			<BookmarkPlusIcon />Save the current query…
		</Button>
	</div>
</Popover>

<Dialog.Root bind:open={saveOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Save query</Dialog.Title>
			<Dialog.Description>
				Keeps the query, {allowScopes ? 'scopes, ' : ''}time window and columns. Saved queries can
				later become alerts and dashboard panels.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit}>
			<div class="space-y-1.5">
				<Label for="log-saved-name">Name</Label>
				<Input
					id="log-saved-name"
					bind:value={name}
					maxlength={120}
					placeholder="API 5xx after deploys"
					required
				/>
			</div>
			<div class="space-y-1.5">
				<Label>Visible to</Label>
				<ToggleGroup.Root
					type="single"
					variant="outline"
					size="sm"
					value={visibility}
					onValueChange={(next) => next && (visibility = next as 'personal' | 'org')}
				>
					<ToggleGroup.Item value="personal">Only me</ToggleGroup.Item>
					<ToggleGroup.Item value="org">The organisation</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>
			<pre
				class="max-h-24 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">{current()
					.q || '(everything)'}</pre>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (saveOpen = false)}>Cancel</Button>
				<Button type="submit" disabled={create.isPending || !name.trim()}>Save</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
