<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import UndoIcon from '@lucide/svelte/icons/undo-2';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import type { SystemSettingArea } from '@yoal/contracts';
	import Panel from '../../_lib/Panel.svelte';
	import ConfigProgress from '../ConfigProgress.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Toggle = (typeof data.toggles)[number];

	const AREAS: { area: SystemSettingArea; title: string }[] = [
		{ area: 'access', title: 'Sign-in and access' },
		{ area: 'workloads', title: 'Workloads' },
		{ area: 'databases', title: 'Databases' },
		{ area: 'backups', title: 'Backups' },
		{ area: 'storage', title: 'Storage' },
		{ area: 'networking', title: 'Networking' },
		{ area: 'queues', title: 'Queues' },
		{ area: 'email', title: 'Email' },
		{ area: 'automation', title: 'Automation' },
		{ area: 'agents', title: 'Agents and MCP' },
		{ area: 'platform', title: 'Platform' }
	];

	const canEdit = $derived(data.availability === 'ready' || data.availability === 'local');
	const ready = $derived(canEdit && !data.inFlight);

	/** The position a person has chosen; starts at what the server runs with. */
	let draft = $state<Record<string, boolean>>({});
	$effect(() => {
		// Reload after a restart: forget choices that now match the running value.
		for (const toggle of data.toggles)
			if (draft[toggle.key] === toggle.value) delete draft[toggle.key];
	});

	const valueOf = (toggle: Toggle) => draft[toggle.key] ?? toggle.value;
	const changed = $derived(data.toggles.filter((toggle) => valueOf(toggle) !== toggle.value));
	const risky = $derived(
		changed.filter(
			(toggle) =>
				(toggle.risky === 'on' && valueOf(toggle)) || (toggle.risky === 'off' && !valueOf(toggle))
		)
	);

	let query = $state('');
	const groups = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		const match = (toggle: Toggle) =>
			!needle ||
			toggle.label.toLowerCase().includes(needle) ||
			toggle.key.toLowerCase().includes(needle) ||
			toggle.description.toLowerCase().includes(needle);
		return AREAS.map(({ area, title }) => ({
			area,
			title,
			toggles: data.toggles.filter((toggle) => toggle.area === area && match(toggle))
		})).filter((group) => group.toggles.length > 0);
	});

	function set(toggle: Toggle, value: boolean) {
		if (value === toggle.value) delete draft[toggle.key];
		else draft[toggle.key] = value;
	}

	function save() {
		const fields = Object.fromEntries(
			changed.map((toggle) => [toggle.key, valueOf(toggle) ? '1' : '0'])
		);
		const list = changed
			.map((toggle) => `${toggle.label}: ${valueOf(toggle) ? 'on' : 'off'}`)
			.join(', ');
		askConfirm({
			title: `Save ${changed.length} ${changed.length === 1 ? 'change' : 'changes'}?`,
			description: [
				`${list}.`,
				risky.length
					? `${risky.map((toggle) => toggle.label).join(', ')} ${risky.length === 1 ? 'weakens' : 'weaken'} sign-in or data safety.`
					: '',
				'The control plane restarts with the new settings, and the previous ones come back if it does not start.'
			]
				.filter(Boolean)
				.join(' '),
			confirmLabel: 'Save and restart',
			tone: risky.length ? 'danger' : 'default',
			action: '?/save',
			fields
		});
	}
</script>

<svelte:head><title>System · Settings · Yoal</title></svelte:head>

<SettingsHeader id="system">
	<p class="text-xs text-muted-foreground">
		Saved to <code class="font-mono">/etc/yoal/yoal.env</code>. Each node's own
		<code class="font-mono">agent.env</code> is not changed here.
	</p>
</SettingsHeader>

<div class="space-y-6 pb-20">
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
			<TriangleAlertIcon />
			<Alert.Title>Read-only here</Alert.Title>
			<Alert.Description>
				{data.availability === 'unmanaged'
					? 'This control plane is not an installed release, so these come from the shell environment.'
					: 'Dashboard settings are not enabled on this host yet. Run `sudo yoal-update-self check` on the server once.'}
			</Alert.Description>
		</Alert.Root>
	{/if}

	<div class="relative max-w-sm">
		<SearchIcon
			class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
		/>
		<Input bind:value={query} placeholder="Filter settings" class="pl-8" aria-label="Filter settings" />
	</div>

	{#each groups as group (group.area)}
		<Panel title={group.title} count={group.toggles.length} flush>
			<ul class="divide-y">
				{#each group.toggles as toggle (toggle.key)}
					{@const on = valueOf(toggle)}
					{@const dirty = on !== toggle.value}
					<li class="flex items-start gap-4 px-6 py-4" class:bg-muted={dirty}>
						<div class="min-w-0 flex-1 space-y-1">
							<div class="flex flex-wrap items-center gap-2">
								<label for={`toggle-${toggle.key}`} class="font-medium">{toggle.label}</label>
								{#if toggle.optIn}<Badge variant="outline">Opt-in</Badge>{/if}
								{#if toggle.value !== toggle.default}
									<Badge variant="secondary">Default {toggle.default ? 'on' : 'off'}</Badge>
								{/if}
								{#if dirty}<Badge>Unsaved</Badge>{/if}
							</div>
							<p class="text-sm text-pretty text-muted-foreground">{toggle.description}</p>
							<p class="font-mono text-xs text-muted-foreground">
								{toggle.key}{toggle.raw !== null ? `=${toggle.raw}` : ' (unset)'}
							</p>
						</div>
						<Switch
							id={`toggle-${toggle.key}`}
							checked={on}
							onCheckedChange={(value) => set(toggle, value)}
							disabled={!ready}
							aria-label={toggle.label}
							class="mt-1"
						/>
					</li>
				{/each}
			</ul>
		</Panel>
	{:else}
		<p class="text-sm text-muted-foreground">No setting matches “{query}”.</p>
	{/each}
</div>

{#if changed.length}
	<div
		class="sticky bottom-4 z-10 mx-auto flex max-w-xl items-center gap-3 rounded-lg border bg-background p-3 shadow-lg"
	>
		{#if risky.length}<TriangleAlertIcon class="size-4 shrink-0 text-destructive" />{/if}
		<p class="flex-1 text-sm">
			{changed.length}
			{changed.length === 1 ? 'unsaved change' : 'unsaved changes'}
		</p>
		<Button variant="ghost" size="sm" onclick={() => (draft = {})}><UndoIcon />Discard</Button>
		<Button size="sm" onclick={save} disabled={!ready}>Save and restart</Button>
	</div>
{/if}
