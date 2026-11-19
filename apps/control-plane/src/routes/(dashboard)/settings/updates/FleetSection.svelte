<script lang="ts">
	import { resolve } from '$app/paths';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import ShieldOffIcon from '@lucide/svelte/icons/shield-off';
	import { Button } from '#lib/components/ui/button/index.js';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import StatusDot from '#lib/components/yoal/StatusDot.svelte';
	import { formatRelative, plural } from '../../_lib/format.js';
	import RolloutPanel from '../../nodes/_components/RolloutPanel.svelte';
	import UpdateFleetDialog from '../../nodes/_components/UpdateFleetDialog.svelte';
	import { strategyCopy } from '../../nodes/_components/rollout.js';
	import FleetBar from './FleetBar.svelte';
	import { fleetStateCopy, fleetSummary, type FleetNodeState, type FleetView } from './fleet-ui.js';

	/**
	 * The nodes follow the control plane's release (CLUSTERING §3.11). One card: how much of the
	 * fleet is on it, the button that rolls the rest, and only the nodes that need a look. The
	 * Nodes page has the full list and rollout history.
	 */
	let {
		fleet,
		controlTarget,
		controlRunning
	}: {
		fleet: FleetView;
		/** A newer release the control plane could install; nodes get it only after it does. */
		controlTarget: string | null;
		controlRunning: boolean;
	} = $props();

	let dialogOpen = $state(false);

	const summary = $derived(fleetSummary(fleet));
	const total = $derived(fleet.nodes.length);
	const target = $derived(fleet.targetVersion);
	const updatable = $derived(fleet.counts.behind + fleet.counts.failed);
	const unguarded = $derived(fleet.nodes.filter((node) => !node.guarded).length);
	const auto = $derived(fleet.defaults.autoRollout);

	const blocked = $derived(
		!target
			? 'The control plane is not on a release version, so there is nothing to install.'
			: controlRunning
				? 'The control plane is updating. Roll the fleet once it has finished.'
				: updatable === 0
					? 'No node can be updated from here right now.'
					: ''
	);

	const rank: Record<FleetNodeState, number> = {
		failed: 0,
		updating: 1,
		behind: 2,
		manual: 3,
		current: 4
	};
	/** Only the nodes that are not on the release, trouble first. */
	const attention = $derived(
		fleet.nodes
			.filter((node) => node.state !== 'current')
			.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
	);

	const defaults = $derived(
		`${strategyCopy[fleet.defaults.strategy].label}${fleet.defaults.strategy === 'rolling' ? `, ${fleet.defaults.batchSize} at a time` : ''}`
	);
	const clusteringHref = `${resolve('/(dashboard)/settings/clustering')}#updates-auto`;
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- the clustering link is a resolved route plus a fragment -->
<section class="rounded-xl border bg-card text-sm shadow-xs" aria-labelledby="fleet-title">
	<div class="flex flex-wrap items-center gap-x-6 gap-y-4 p-5 sm:px-6">
		<div class="min-w-0 flex-1 basis-64 space-y-3">
			<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
				<h3 id="fleet-title" class="font-medium">Nodes</h3>
				<StatusBadge
					status={summary.live ? 'running' : summary.tone}
					label={summary.label}
					tone={summary.tone}
				/>
			</div>
			{#if fleet.readable && total > 0}
				<p class="flex flex-wrap items-baseline gap-x-2">
					<span class="font-mono text-2xl font-semibold tracking-tight tabular-nums"
						>{fleet.counts.current}<span class="text-muted-foreground">/{total}</span></span
					>
					<span class="text-muted-foreground">
						on <span class="font-mono">{target ? `v${target}` : 'this build'}</span>
					</span>
				</p>
				<FleetBar counts={fleet.counts} class="h-1.5 max-w-md" />
			{:else}
				<p class="text-muted-foreground">
					{fleet.readable
						? 'No nodes enrolled yet. Nodes you enrol install the control plane’s release and follow it from here.'
						: 'Your role can’t see nodes. Their versions need platform read access.'}
				</p>
			{/if}
		</div>
		{#if fleet.canUpdate && total > 0 && !fleet.active}
			<span title={blocked || undefined}>
				<Button
					variant={updatable > 0 ? 'default' : 'outline'}
					disabled={blocked !== ''}
					onclick={() => (dialogOpen = true)}
				>
					<CircleArrowUpIcon aria-hidden="true" />
					Update {updatable || ''}
					{plural(updatable, 'node')}
				</Button>
			</span>
		{/if}
	</div>

	{#if fleet.readable && total > 0}
		{#if controlTarget && !controlRunning}
			<p class="border-t px-5 py-3 text-xs text-pretty text-muted-foreground sm:px-6">
				v{controlTarget} reaches the nodes after the control plane installs it; {auto
					? 'they then follow on their own.'
					: 'roll them from here afterwards.'}
			</p>
		{/if}

		{#if attention.length > 0 && !fleet.active}
			<ul class="divide-y border-t">
				{#each attention as node (node.id)}
					<li class="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 sm:px-6">
						<span class="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
							<StatusDot status={node.status} />
							<span class="sr-only">{node.status}</span>
							<span class="truncate font-medium">{node.name}</span>
							{#if !node.guarded}
								<ShieldOffIcon
									class="size-3.5 shrink-0 text-warning"
									aria-label="No rollback guard"
								/>
							{/if}
						</span>
						<span class="font-mono text-xs text-muted-foreground tabular-nums">
							{node.version ? `v${node.version}` : 'not reported'}
						</span>
						<StatusBadge
							status={node.state === 'updating' ? 'updating' : node.state}
							label={fleetStateCopy[node.state].label}
							tone={fleetStateCopy[node.state].tone}
						/>
						{#if node.error}
							<p class="basis-full text-xs break-words text-destructive">{node.error}</p>
						{:else if node.status !== 'online'}
							<p class="basis-full text-xs text-muted-foreground">
								Offline{node.lastHeartbeatAt
									? `, last seen ${formatRelative(node.lastHeartbeatAt)}`
									: ''}; left out of rollouts.
							</p>
						{:else if node.state === 'manual'}
							<p class="basis-full text-xs text-muted-foreground">
								Predates dashboard updates. Update it by hand once; later releases install from
								here.
							</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<div
			class="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t bg-muted/30 px-5 py-3 text-xs text-muted-foreground sm:px-6"
		>
			<span>
				After a control plane update:
				<a
					href={clusteringHref}
					class="font-medium text-foreground underline-offset-4 hover:underline"
					>{auto ? 'rolls out automatically' : 'waits for you'}</a
				>
				· {defaults}
			</span>
			{#if unguarded > 0}
				<span
					class="inline-flex items-center gap-1 text-warning"
					title="These agents predate node-update-guard, so a broken release is not rolled back on its own. Their next update installs the guard."
				>
					<ShieldOffIcon class="size-3" aria-hidden="true" />
					{unguarded} without rollback guard
				</span>
			{/if}
			<a href={resolve('/(dashboard)/nodes')} class="ml-auto font-medium hover:text-foreground"
				>All nodes →</a
			>
		</div>
	{/if}
</section>

{#if fleet.active}
	<RolloutPanel rollout={fleet.active} canUpdate={fleet.canUpdate} />
{/if}

{#if fleet.canUpdate}
	<UpdateFleetDialog bind:open={dialogOpen} defaults={fleet.defaults} targetVersion={target} />
{/if}
