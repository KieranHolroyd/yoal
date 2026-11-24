<script lang="ts">
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import NetworkIcon from '@lucide/svelte/icons/network';
	import WaypointsIcon from '@lucide/svelte/icons/waypoints';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { nodeRolloutLimits, nodeRolloutStrategies } from '@yoal/contracts';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatRelative } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	// svelte-ignore state_referenced_locally -- the page intentionally seeds the editor once
	let text = $state(JSON.stringify(data.config, null, 2));
	const result = $derived(form as { success?: string; message?: string; section?: string } | null);

	// Saving a section refreshes `data.config`: refresh the JSON too unless it has unsaved edits,
	// so a later JSON save does not put the old values back.
	// svelte-ignore state_referenced_locally -- the seed is compared, not rendered
	let seeded = text;
	$effect(() => {
		const next = JSON.stringify(data.config, null, 2);
		untrack(() => {
			if (text === seeded) text = next;
			seeded = next;
		});
	});

	// Fleet node updates (docs/CLUSTERING.md §3.11): the defaults the Update fleet dialog and the
	// automatic rollout use.
	// svelte-ignore state_referenced_locally -- seeded once; the form saves the whole section
	const updates = data.config.updates;
	let autoRollout = $state(updates.autoRollout);
	let rolloutStrategy = $state<string>(updates.strategy);
	let rolloutDrain = $state(updates.drain);
	let rolloutCanary = $state(updates.canary === undefined ? '' : String(updates.canary));
	let updatesPending = $state(false);
	// Mesh mode (docs/CLUSTERING.md §4.7, D240).
	// svelte-ignore state_referenced_locally -- seeded once; saving reloads the page data
	let meshOn = $state(data.config.overlay.mode === 'mesh');
	let overlayPending = $state(false);
	const nodeName = (id: string) => data.mesh.names[id] ?? id;
	const pairLabels: Record<string, string> = { direct: 'Direct', probing: 'Probing', relayed: 'Via hub' };

	const strategyLabels: Record<string, string> = {
		availability: 'Availability (recommended): canary, then waves that keep every redundant group up',
		rolling: 'Rolling: a fixed number of nodes at a time',
		parallel: 'Parallel: every node at once'
	};
</script>

<SettingsHeader
	id="clustering"
	description="Advanced cluster tunables. Changes apply to the next join, placement, lease cycle or maintenance sweep."
/>

<Panel
	title="Failover"
	icon={ShieldCheckIcon}
	description="The failover controller as the keys below configure it right now."
	class="mb-5"
>
	{#snippet actions()}
		<Button variant="outline" size="sm" href={resolve('/(dashboard)/settings/high-availability')}>Open high availability</Button>
	{/snippet}
	<div class="flex flex-wrap items-center gap-2 text-sm">
		<Badge variant={data.failover.enabled ? 'success' : 'neutral'}>
			Automatic failover {data.failover.enabled ? 'on' : 'off'}
		</Badge>
		<StatusBadge status={data.failover.lease.state} label="Lease {data.failover.lease.state}" />
		{#if data.failover.lease.epoch}<span class="font-mono text-xs text-muted-foreground">epoch {data.failover.lease.epoch}</span>{/if}
		<span class="text-muted-foreground">
			· {data.failover.counts.inProgress} in progress · {data.failover.counts.queued} waiting
		</span>
	</div>
	<p class="mt-2 text-xs text-muted-foreground">
		{data.failover.enabled
			? `Copies on a node silent for ${data.failover.policy.replicaGraceSeconds}s move to another node, at most ${data.failover.policy.maxPerMinute} a minute.`
			: 'A lost node is reported, not acted on. Set "failover": { "enabled": true } to move replica copies automatically; a drain moves them either way.'}
	</p>
	{#if data.failover.recent.length}
		<ul class="mt-3 space-y-1 text-xs">
			{#each data.failover.recent.slice(0, 5) as event (event.id)}
				<li class="flex gap-2">
					<span class="w-20 shrink-0 text-muted-foreground">{formatRelative(event.detectedAt)}</span>
					<span class="shrink-0 font-medium">{event.kind} · {event.status}</span>
					<span class="truncate text-muted-foreground" title={event.reason}>{event.reason}</span>
				</li>
			{/each}
		</ul>
	{/if}
</Panel>

<form
	method="POST"
	action="?/overlay"
	class="mb-5"
	use:enhance={() => {
		overlayPending = true;
		return async ({ update }) => {
			await update({ reset: false });
			overlayPending = false;
		};
	}}
>
	<Panel
		title="Overlay network"
		icon={WaypointsIcon}
		description="How nodes reach each other's private addresses. Hub mode relays every pair that does not share a private network through an ingress hub."
	>
		<Field.Field orientation="horizontal" class="gap-2">
			<input type="hidden" name="mesh" value={meshOn ? 'true' : ''} />
			<Switch id="overlay-mesh" bind:checked={meshOn} />
			<Field.Content>
				<Field.Label for="overlay-mesh" class="font-normal">Mesh mode</Field.Label>
				<Field.Description>
					Connect every pair of nodes directly, through NAT where it allows it, with the hubs as the
					fallback relay. Each node also gets a name, <span class="font-mono">&lt;node&gt;.yoal.internal</span>,
					in its hosts file. Nodes on an agent from before mesh mode stay on the hubs.
				</Field.Description>
			</Field.Content>
		</Field.Field>
		{#if data.mesh.mode === 'mesh'}
			<div class="mt-4 flex flex-wrap items-center gap-2 text-sm">
				<Badge variant="success">{data.mesh.direct} direct</Badge>
				<Badge variant="neutral">{data.mesh.probing} probing</Badge>
				<Badge variant={data.mesh.relayed ? 'warning' : 'neutral'}>{data.mesh.relayed} via hub</Badge>
			</div>
			{#if data.mesh.pairs.length}
				<ul class="mt-3 space-y-1 text-xs">
					{#each data.mesh.pairs as pair (`${pair.a}|${pair.b}`)}
						<li class="flex gap-2">
							<span class="w-16 shrink-0 font-medium">{pairLabels[pair.state]}</span>
							<span class="truncate">{nodeName(pair.a)} ↔ {nodeName(pair.b)}</span>
							<span class="ml-auto shrink-0 text-muted-foreground">
								{#if pair.state === 'relayed' && pair.retryAt}
									tries again {formatRelative(pair.retryAt)}
								{:else}
									since {formatRelative(pair.since)}
								{/if}
							</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="mt-3 text-xs text-muted-foreground">
					No pairs to connect yet. A pair needs two non-ingress nodes on a current agent, not on the
					same private network, and at least one of them seen on a public address by a hub.
				</p>
			{/if}
		{/if}
		{#if result?.section === 'overlay' && result.message}<p class="mt-3 text-sm text-destructive">{result.message}</p>{/if}
		{#if result?.section === 'overlay' && result.success}<p class="mt-3 text-sm text-success">{result.success}</p>{/if}
		{#snippet footer()}
			<div class="flex justify-end">
				<Button type="submit" size="sm" disabled={overlayPending}>Save overlay</Button>
			</div>
		{/snippet}
	</Panel>
</form>

<form
	method="POST"
	action="?/updates"
	class="mb-5"
	use:enhance={() => {
		updatesPending = true;
		return async ({ update }) => {
			await update({ reset: false });
			updatesPending = false;
		};
	}}
>
	<Panel
		title="Node updates"
		icon={CircleArrowUpIcon}
		description="How the fleet follows the control plane to a new release (Nodes → Update fleet). The target is always the control plane's own version."
	>
		<Field.Group>
			<Field.Field orientation="horizontal" class="gap-2">
				<input type="hidden" name="autoRollout" value={autoRollout ? 'true' : ''} />
				<Switch id="updates-auto" bind:checked={autoRollout} />
				<Field.Content>
					<Field.Label for="updates-auto" class="font-normal">Update nodes automatically</Field.Label>
					<Field.Description>
						After the control plane updates itself, update every node with these settings. One
						rollout per control-plane version; a paused one waits for you on the Nodes page.
					</Field.Description>
				</Field.Content>
			</Field.Field>

			<Field.Field>
				<Field.Label for="updates-strategy">Strategy</Field.Label>
				<NativeSelect.Root id="updates-strategy" name="strategy" bind:value={rolloutStrategy}>
					{#each nodeRolloutStrategies as strategy (strategy)}
						<NativeSelect.Option value={strategy}>{strategyLabels[strategy]}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</Field.Field>

			<div class="grid gap-4 sm:grid-cols-3">
				<Field.Field>
					<Field.Label for="updates-batch">Nodes per wave</Field.Label>
					<Input
						id="updates-batch"
						name="batchSize"
						type="number"
						min="1"
						max={nodeRolloutLimits.maxBatchSize}
						value={updates.batchSize}
					/>
					<Field.Description>Rolling only.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="updates-soak">Soak (seconds)</Field.Label>
					<Input
						id="updates-soak"
						name="soakSeconds"
						type="number"
						min="0"
						max={nodeRolloutLimits.maxSoakSeconds}
						value={updates.soakSeconds}
					/>
					<Field.Description>Each wave stays healthy this long before the next.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="updates-failures">Failures allowed</Field.Label>
					<Input
						id="updates-failures"
						name="maxFailures"
						type="number"
						min="0"
						max={nodeRolloutLimits.maxFailures}
						value={updates.maxFailures}
					/>
					<Field.Description>0 pauses on the first failed node.</Field.Description>
				</Field.Field>
			</div>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="updates-canary">Canary</Field.Label>
					<NativeSelect.Root id="updates-canary" name="canary" bind:value={rolloutCanary}>
						<NativeSelect.Option value="">Strategy default (on, except parallel)</NativeSelect.Option>
						<NativeSelect.Option value="true">Always update one node first</NativeSelect.Option>
						<NativeSelect.Option value="false">No canary</NativeSelect.Option>
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field orientation="horizontal" class="gap-2 self-end">
					<input type="hidden" name="drain" value={rolloutDrain ? 'true' : ''} />
					<Switch id="updates-drain" bind:checked={rolloutDrain} />
					<Field.Content>
						<Field.Label for="updates-drain" class="font-normal">Drain each wave first</Field.Label>
						<Field.Description>
							Move movable workloads off before the agent restarts. An update stops no workload, but
							it blips cross-node endpoints, replication links, mail and running builds.
						</Field.Description>
					</Field.Content>
				</Field.Field>
			</div>
		</Field.Group>
		{#if result?.section === 'updates' && result.message}<p class="mt-3 text-sm text-destructive">{result.message}</p>{/if}
		{#if result?.section === 'updates' && result.success}<p class="mt-3 text-sm text-success">{result.success}</p>{/if}
		{#snippet footer()}
			<div class="flex justify-end">
				<Button type="submit" size="sm" disabled={updatesPending}>Save node updates</Button>
			</div>
		{/snippet}
	</Panel>
</form>

<form method="POST" action="?/save" class="space-y-5">
	<Panel title="Cluster configuration" icon={NetworkIcon} description="Validated against the ClusterConfig schema; unknown keys are rejected.">
		<Field.Field>
			<Field.Label for="cluster-config">JSON</Field.Label>
			<Textarea id="cluster-config" name="config" bind:value={text} rows={26} class="font-mono text-xs" spellcheck="false" />
			<Field.Description>
				Overlay CIDR/MTU/port and mode, endpoint port range and mTLS, replica limits, spread, health-check interval and failover grace, database replica limits and promotion lag limits, storage targets, the failover controller's lease timing, automatic failover, scheduling (packing strategy, memory and CPU overcommit and the memory-pressure limit, automatic rebalance, rolling and surge deploys, automatic rollback, run leases for single workers) and the share mount root.
			</Field.Description>
		</Field.Field>
		{#if !result?.section && result?.message}<p class="text-sm text-destructive">{result.message}</p>{/if}
		{#if !result?.section && result?.success}<p class="text-sm text-success">{result.success}</p>{/if}
	</Panel>
	<div class="flex justify-end">
		<Button type="submit">Save configuration</Button>
	</div>
</form>
