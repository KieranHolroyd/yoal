<script lang="ts">
	import { resolve } from '$app/paths';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CodeIcon from '@lucide/svelte/icons/code';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldOffIcon from '@lucide/svelte/icons/shield-off';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import StatusDot from '#lib/components/yoal/StatusDot.svelte';
	import type { Tone } from '#lib/status.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime, formatRelative, plural } from '../../_lib/format.js';
	import RecentRollouts from '../../nodes/_components/RecentRollouts.svelte';
	import RolloutPanel from '../../nodes/_components/RolloutPanel.svelte';
	import UpdateFleetDialog from '../../nodes/_components/UpdateFleetDialog.svelte';
	import { busyStates, nodeStateTone, strategyCopy } from '../../nodes/_components/rollout.js';
	import FleetBar from './FleetBar.svelte';
	import {
		fleetStateCopy,
		fleetStateOrder,
		fleetSummary,
		rolloutNodeLabel,
		type FleetNodeState,
		type FleetView
	} from './fleet-ui.js';
	import { toneTile } from './update-ui.js';

	/**
	 * Step two of an update: the nodes (CLUSTERING §3.11). Shows how much of the fleet runs the
	 * control plane's release, the rollout moving the rest there, and each node's own state.
	 */
	let {
		fleet,
		controlTarget,
		controlRunning,
		onshowcontrol
	}: {
		fleet: FleetView;
		/** A newer release the control plane could install; the fleet then trails it too. */
		controlTarget: string | null;
		/** The control plane is installing an update right now. */
		controlRunning: boolean;
		onshowcontrol: () => void;
	} = $props();

	let dialogOpen = $state(false);

	const summary = $derived(fleetSummary(fleet));
	const total = $derived(fleet.nodes.length);
	const target = $derived(fleet.targetVersion);
	/** Nodes a rollout would pick up now. */
	const updatable = $derived(fleet.counts.behind + fleet.counts.failed);
	const trailing = $derived(updatable + fleet.counts.manual);
	const unguarded = $derived(fleet.nodes.filter((node) => !node.guarded).length);
	const auto = $derived(fleet.defaults.autoRollout);

	const blocked = $derived(
		!target
			? 'The control plane is not on a release version, so there is nothing to install.'
			: fleet.active
				? 'A fleet update is already running. Finish or cancel it first.'
				: controlRunning
					? 'The control plane is updating. Roll the fleet once it has finished.'
					: updatable === 0
						? fleet.counts.updating > 0
							? 'The remaining nodes are already updating.'
							: `Every node that can update already runs v${target}.`
						: ''
	);

	const hero = $derived.by(
		(): {
			tone: Tone;
			icon: typeof ServerIcon;
			spin?: boolean;
			title: string;
			description: string;
		} => {
			if (!fleet.readable)
				return {
					tone: 'neutral',
					icon: EyeOffIcon,
					title: "Your role can't see the nodes",
					description:
						'Node versions and fleet updates need platform read access. The control plane tab still works.'
				};
			if (total === 0)
				return {
					tone: 'neutral',
					icon: ServerIcon,
					title: 'No nodes to update',
					description:
						'Nodes you enrol install the same signed release as the control plane, and are kept on it from here.'
				};
			if (fleet.active) {
				const paused = fleet.active.status === 'paused';
				return {
					tone: paused ? 'warning' : 'info',
					icon: paused ? PauseIcon : LoaderCircleIcon,
					spin: !paused,
					title: `${paused ? 'Fleet update paused on the way' : 'Updating the fleet'} to v${fleet.active.targetVersion}`,
					description:
						fleet.active.detail ??
						(paused
							? 'A node failed. Retry it or skip it to carry on, or cancel the rollout.'
							: 'Each wave must stay healthy on the new version before the next starts.')
				};
			}
			if (!target)
				return {
					tone: 'neutral',
					icon: CodeIcon,
					title: 'No release to roll out',
					description:
						'The control plane is not running a release version, so there is no signed release for nodes to install.'
				};
			if (fleet.counts.failed > 0)
				return {
					tone: 'danger',
					icon: TriangleAlertIcon,
					title: `${fleet.counts.failed} ${plural(fleet.counts.failed, 'node')} didn't update to v${target}`,
					description:
						'Each failed node kept or restored its previous version. Read its error below, then start a rollout to try again.'
				};
			if (trailing > 0)
				return {
					tone: 'warning',
					icon: CircleArrowUpIcon,
					title: `${trailing} of ${total} ${plural(total, 'node')} ${trailing === 1 ? 'is' : 'are'} behind v${target}`,
					description:
						updatable === 0
							? 'Their agents predate dashboard updates. Update each by hand once; after that they follow from here.'
							: 'A rollout installs the signed release in waves and checks each wave before the next. Workloads keep running.'
				};
			if (fleet.counts.updating > 0)
				return {
					tone: 'info',
					icon: LoaderCircleIcon,
					spin: true,
					title: `${fleet.counts.updating} ${plural(fleet.counts.updating, 'node')} updating to v${target}`,
					description: 'The agent restarts on the new version within a minute or two.'
				};
			return {
				tone: 'success',
				icon: CircleCheckIcon,
				title: total === 1 ? `The node runs v${target}` : `All ${total} nodes run v${target}`,
				description: 'The fleet matches the control plane.'
			};
		}
	);

	const rolloutNodes = $derived(
		new Map((fleet.active?.nodes ?? []).map((node) => [node.nodeId, node]))
	);
	/** Trouble first, then work in progress, then the nodes that are fine. */
	const rank: Record<FleetNodeState, number> = {
		failed: 0,
		updating: 1,
		behind: 2,
		manual: 3,
		current: 4
	};
	const nodes = $derived(
		[...fleet.nodes].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
	);

	const eyebrowTone: Record<Tone, string> = {
		success: 'text-success',
		warning: 'text-warning',
		danger: 'text-destructive',
		info: 'text-info',
		brand: 'text-brand',
		neutral: 'text-muted-foreground'
	};
	const dot: Record<FleetNodeState, string> = {
		current: 'bg-success',
		updating: 'bg-info',
		behind: 'bg-warning',
		manual: 'bg-warning/50',
		failed: 'bg-destructive'
	};
	const clusteringHref = `${resolve('/(dashboard)/settings/clustering')}#updates-auto`;
</script>

<div class="space-y-6">
	<section
		class="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs"
		aria-labelledby="fleet-hero-title"
	>
		<div class="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:gap-6 sm:p-6">
			<div class="flex min-w-0 flex-1 items-start gap-4">
				<span
					class="flex size-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset {toneTile[
						hero.tone
					]}"
					aria-hidden="true"
				>
					<hero.icon class="size-5 {hero.spin ? 'animate-spin' : ''}" />
				</span>
				<div class="min-w-0 space-y-1">
					<p class="text-xs font-medium tracking-wide uppercase {eyebrowTone[summary.tone]}">
						{summary.label}
					</p>
					<h3 id="fleet-hero-title" class="text-xl leading-tight font-semibold tracking-tight">
						{hero.title}
					</h3>
					<p class="max-w-prose text-sm text-pretty text-muted-foreground" aria-live="polite">
						{hero.description}
					</p>
				</div>
			</div>
			{#if fleet.canUpdate && total > 0 && !fleet.active}
				<span class="shrink-0 self-start sm:self-center" title={blocked || undefined}>
					<Button disabled={blocked !== ''} onclick={() => (dialogOpen = true)}>
						<CircleArrowUpIcon aria-hidden="true" />
						Update fleet{updatable > 0 ? ` (${updatable})` : ''}
					</Button>
				</span>
			{/if}
		</div>

		{#if total > 0}
			<div class="space-y-2.5 border-t px-5 py-4 sm:px-6">
				<FleetBar counts={fleet.counts} class="h-2" />
				<ul class="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
					{#each fleetStateOrder.filter((state) => fleet.counts[state] > 0) as state (state)}
						<li class="flex items-center gap-1.5">
							<span class="size-2 rounded-full {dot[state]}" aria-hidden="true"></span>
							<span class="font-mono font-medium text-foreground tabular-nums"
								>{fleet.counts[state]}</span
							>
							{fleetStateCopy[state].label.toLowerCase()}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<dl
			class="grid divide-y border-t bg-muted/30 text-sm sm:grid-cols-[auto_auto_minmax(0,1fr)] sm:divide-x sm:divide-y-0"
		>
			<div
				class="flex items-baseline justify-between gap-3 px-5 py-3 sm:block sm:space-y-0.5 sm:pr-8"
			>
				<dt class="text-xs text-muted-foreground">Target</dt>
				<dd class="font-mono font-medium tabular-nums">{target ? `v${target}` : 'None'}</dd>
			</div>
			<div
				class="flex items-baseline justify-between gap-3 px-5 py-3 sm:block sm:space-y-0.5 sm:pr-8"
			>
				<dt class="text-xs text-muted-foreground">After a control plane update</dt>
				<dd>
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route plus a fragment -->
					<a href={clusteringHref} class="font-medium underline-offset-4 hover:underline">
						{auto ? 'Rolls out automatically' : 'Waits for you'}
					</a>
				</dd>
			</div>
			<div
				class="flex min-w-0 items-baseline justify-between gap-3 px-5 py-3 sm:block sm:space-y-0.5"
			>
				<dt class="text-xs text-muted-foreground">Default rollout</dt>
				<dd class="truncate">
					{strategyCopy[fleet.defaults.strategy].label}{fleet.defaults.strategy === 'rolling'
						? `, ${fleet.defaults.batchSize} at a time`
						: ''}
					<span class="text-muted-foreground">
						· soak {fleet.defaults.soakSeconds}s · {fleet.defaults.drain ? 'drains' : 'no drain'}
					</span>
				</dd>
			</div>
		</dl>
	</section>

	{#if controlTarget && !controlRunning && fleet.readable && total > 0}
		<Notice tone="info" title="The control plane goes first">
			Nodes install the release the control plane runs, so v{controlTarget} reaches them only after the
			control plane has it.
			{auto ? 'The fleet then follows on its own.' : 'Come back here afterwards to roll the fleet.'}
			<button type="button" class="font-medium underline underline-offset-4" onclick={onshowcontrol}
				>Update the control plane</button
			>
		</Notice>
	{/if}

	{#if fleet.active}
		<RolloutPanel rollout={fleet.active} canUpdate={fleet.canUpdate} />
	{/if}

	{#if total > 0}
		<Panel
			title="Nodes"
			icon={ServerIcon}
			count={total}
			description={target ? `Each agent against v${target}.` : undefined}
			flush
		>
			{#snippet actions()}
				<Button href={resolve('/(dashboard)/nodes')} variant="ghost" size="sm">Manage nodes</Button>
			{/snippet}
			<ul class="divide-y">
				{#each nodes as node (node.id)}
					{@const inRollout = rolloutNodes.get(node.id)}
					<li class="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 text-sm">
						<div class="flex min-w-0 flex-1 basis-56 items-center gap-2.5">
							<StatusDot status={node.status} />
							<span class="sr-only">{node.status}</span>
							<span class="truncate font-medium">{node.name}</span>
							{#if node.zone}
								<Badge variant="outline" class="font-mono text-[10px]">{node.zone}</Badge>
							{/if}
							{#each node.roles as role (role)}
								<Badge variant="neutral" class="hidden text-[10px] md:inline-flex">{role}</Badge>
							{/each}
						</div>

						<div class="flex items-center gap-2 font-mono text-xs tabular-nums">
							<span class={node.state === 'current' ? '' : 'text-muted-foreground'}>
								{node.version ? `v${node.version}` : 'not reported'}
							</span>
							{#if node.state !== 'current' && target}
								<span class="text-muted-foreground" aria-label="to">→</span>
								<span class="font-medium">v{target}</span>
							{/if}
						</div>

						<div class="flex w-44 items-center justify-end gap-2">
							{#if !node.guarded}
								<span
									class="inline-flex items-center text-warning"
									title="No rollback guard: this agent predates node-update-guard, so a broken release is not rolled back on its own."
								>
									<ShieldOffIcon class="size-3.5" />
									<span class="sr-only">No rollback guard</span>
								</span>
							{/if}
							{#if inRollout && inRollout.state !== 'done'}
								{#if busyStates.has(inRollout.state)}
									<LoaderCircleIcon class="size-3.5 animate-spin text-info" aria-hidden="true" />
								{/if}
								<StatusBadge
									status={inRollout.state}
									label={`${rolloutNodeLabel[inRollout.state]} · wave ${inRollout.wave + 1}`}
									tone={nodeStateTone[inRollout.state]}
								/>
							{:else}
								<StatusBadge
									status={node.state}
									label={fleetStateCopy[node.state].label}
									tone={fleetStateCopy[node.state].tone}
								/>
							{/if}
						</div>

						{#if node.error ?? inRollout?.error}
							<p class="basis-full text-xs break-words text-destructive">
								{node.error ?? inRollout?.error}
							</p>
						{:else if node.status !== 'online'}
							<p class="basis-full text-xs text-muted-foreground">
								{node.lastHeartbeatAt ? 'Last seen' : 'Never reported in'}
								{#if node.lastHeartbeatAt}
									<time datetime={node.lastHeartbeatAt} title={formatDateTime(node.lastHeartbeatAt)}
										>{formatRelative(node.lastHeartbeatAt)}</time
									>{/if}. An offline node is left out of a rollout.
							</p>
						{:else if node.state === 'manual'}
							<p class="basis-full text-xs text-muted-foreground">
								This agent predates dashboard updates. Update it by hand once; later releases
								install from here.
							</p>
						{/if}
					</li>
				{/each}
			</ul>
			{#snippet footer()}
				{#if unguarded > 0}
					<span class="flex items-start gap-1.5">
						<ShieldOffIcon class="mt-px size-3.5 shrink-0 text-warning" aria-hidden="true" />
						{unguarded}
						{plural(unguarded, 'node')} without a rollback guard: an agent from before node-update-guard
						cannot restore its previous version by itself. Its first update installs the guard.
					</span>
				{:else}
					Every node rolls itself back if its new agent never reports a healthy heartbeat.
				{/if}
			{/snippet}
		</Panel>
	{/if}

	{#if fleet.recent.length > 0}
		<RecentRollouts rollouts={fleet.recent} />
	{/if}
</div>

{#if fleet.canUpdate}
	<UpdateFleetDialog bind:open={dialogOpen} defaults={fleet.defaults} targetVersion={target} />
{/if}
