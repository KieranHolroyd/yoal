<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import { createQuery } from '@tanstack/svelte-query';
	import { errorText } from '#lib/query.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatRelative } from '../../_lib/format.js';
	import { NotAvailableError, haKeys, listDrillRuns, loadRegions } from './_lib/ha-api.js';
	import { databaseFailoverState, type StatusCardsInput } from './_lib/ha-setup.js';

	/** One card per part of the HA stack, each saying what is in force now (not what is configured). */
	let { input }: { input: StatusCardsInput } = $props();

	const regions = createQuery(() => ({
		queryKey: haKeys.regions,
		queryFn: ({ signal }) => loadRegions(signal),
		enabled: input.regionsFlag,
		retry: (count: number, error: Error) => !(error instanceof NotAvailableError) && count < 1
	}));
	const runs = createQuery(() => ({
		queryKey: haKeys.drillRuns,
		queryFn: ({ signal }) => listDrillRuns(signal),
		retry: (count: number, error: Error) => !(error instanceof NotAvailableError) && count < 1
	}));

	const fleetFailover = $derived(databaseFailoverState(input.failover));
	const drills = $derived(
		[
			...input.recentDrills,
			...(runs.data ?? []).map((run) => ({
				id: run.id,
				at: run.startedAt ?? '',
				label: `${run.scenario} on ${run.resource.name}`,
				status: run.status,
				detail:
					run.measured.rtoMs !== null ? `RTO ${(run.measured.rtoMs / 1000).toFixed(1)} s` : null
			}))
		]
			.filter((drill) => drill.at !== '')
			.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
			.slice(0, 4)
	);
	const statusVariant = (status: string) =>
		status === 'passed' || status === 'completed'
			? 'success'
			: status === 'failed'
				? 'danger'
				: status === 'running'
					? 'warning'
					: 'neutral';
</script>

<Panel
	id="ha-status"
	title="What is in force"
	icon={ActivityIcon}
	description="The profile and each part of the HA stack as the control plane sees it now."
>
	<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
		<div class="rounded-lg border p-3" data-card="profile">
			<p class="text-xs text-muted-foreground">Profile</p>
			<p class="mt-1">
				<Badge variant={input.profile === 'single' ? 'neutral' : 'success'}>{input.profile}</Badge>
			</p>
			<p class="mt-1 text-xs text-muted-foreground">
				{input.profile === 'single'
					? 'One edge; recovery is by hand.'
					: 'Set by the guided setup above or yoal ha init.'}
			</p>
		</div>

		<div class="rounded-lg border p-3" data-card="ingress">
			<p class="text-xs text-muted-foreground">Ingress and steering</p>
			<p class="mt-1 text-sm font-medium">
				<span class="font-mono">{input.steering.driver}</span>
				{#if input.steering.stacked.length}<span class="text-muted-foreground">
						+ {input.steering.stacked.join(', ')}</span
					>{/if}
			</p>
			<p class="mt-1 text-xs text-muted-foreground">
				{input.ingress.ready} of {input.ingress.nodes} ingress node{input.ingress.nodes === 1
					? ''
					: 's'} ready{input.ingress.inRotation !== null
					? `, ${input.ingress.inRotation} in rotation`
					: ''}.
				{#if !input.ingress.setFlag}The ingress set is off: one node is the edge.{/if}
				{#if !input.steering.flag && input.steering.driver !== 'direct'}Steering is off, so the
					driver changes nothing yet.{/if}
			</p>
		</div>

		<div class="rounded-lg border p-3" data-card="arbiter">
			<p class="text-xs text-muted-foreground">Arbiter and control-plane standby</p>
			<p class="mt-1 flex flex-wrap items-center gap-1.5 text-sm font-medium">
				<span class="font-mono">{input.arbiter.kind}</span>
				<Badge variant={input.arbiter.external ? 'success' : 'warning'}
					>{input.arbiter.external ? 'off-node' : 'on one node'}</Badge
				>
			</p>
			<p class="mt-1 text-xs text-muted-foreground">{input.arbiter.detail}</p>
			{#if !input.control.flag}
				<p class="mt-1 text-xs text-muted-foreground">
					No standby: the control-plane standby flag is off.
				</p>
			{:else if input.control.members.length === 0}
				<p class="mt-1 text-xs text-muted-foreground">
					No standby enrolled. Run <code class="font-mono">yoal ha control enrol</code> on a second control
					node.
				</p>
			{:else}
				<ul class="mt-1 space-y-0.5 text-xs">
					{#each input.control.members as member (member.name)}
						<li>
							<span class="font-mono">{member.name}</span>
							{member.role}{member.lagSeconds !== null
								? `, ${member.lagSeconds} s behind`
								: ''}{member.canPromote ? ', can promote' : ''}
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="rounded-lg border p-3" data-card="databases">
			<p class="text-xs text-muted-foreground">Databases</p>
			<p class="mt-1 flex flex-wrap items-center gap-1.5 text-sm font-medium">
				Automatic failover
				<Badge variant={fleetFailover.tone} data-testid="db-failover-state"
					>{fleetFailover.label}</Badge
				>
			</p>
			<p class="mt-1 text-xs text-muted-foreground">{fleetFailover.reason}</p>
			{#if input.databases.length === 0}
				<p class="mt-1 text-xs text-muted-foreground">No database has a replica.</p>
			{:else}
				<ul class="mt-1.5 space-y-0.5 text-xs">
					{#each input.databases.slice(0, 5) as database (database.id)}
						<li>
							<span class="font-mono">{database.name}</span>:
							{database.durability
								? database.durability.effective
								: 'durability not visible to you'}{database.durability &&
							database.durability.configured !== database.durability.effective
								? ` (configured ${database.durability.configured})`
								: ''},
							{databaseFailoverState(input.failover, database).label.toLowerCase()} failover{database.standbyRegion
								? `, standby in ${database.standbyRegion}`
								: ''}
						</li>
					{/each}
					{#if input.databases.length > 5}<li class="text-muted-foreground">
							and {input.databases.length - 5} more below
						</li>{/if}
				</ul>
			{/if}
		</div>

		<div class="rounded-lg border p-3" data-card="regions">
			<p class="text-xs text-muted-foreground">Regions</p>
			{#if !input.regionsFlag}
				<p class="mt-1 text-sm font-medium">One region</p>
				<p class="mt-1 text-xs text-muted-foreground">
					Regions are off. The HA with disaster recovery profile turns them on.
				</p>
			{:else if regions.isError}
				<p class="mt-1 text-xs text-muted-foreground">
					{regions.error instanceof NotAvailableError
						? 'Region status is not available on this control plane yet.'
						: errorText(regions.error)}
				</p>
			{:else if !regions.data}
				<p class="mt-1 text-xs text-muted-foreground">Loading…</p>
			{:else}
				<ul class="mt-1 space-y-0.5 text-xs">
					{#each regions.data.regions as region (region.name)}
						<li>
							<span class="font-mono font-medium">{region.name}</span>
							{#if region.primary}<Badge variant="success" class="ml-1">primary</Badge>{/if}
							<span class="text-muted-foreground">
								{region.nodes.filter((node) => node.online).length}/{region.nodes.length} nodes online,
								{region.zones.length} zone{region.zones.length === 1 ? '' : 's'},
								{region.databases.primaries} primar{region.databases.primaries === 1 ? 'y' : 'ies'}, {region
									.databases.standbys} standby
							</span>
						</li>
					{/each}
				</ul>
				{#if regions.data.active}<p class="mt-1 text-xs text-warning">
						A region promotion is running: {regions.data.active.stage}.
					</p>{/if}
				<p class="mt-1 text-xs text-muted-foreground">
					Read-only here. Promote a region with <code class="font-mono">yoal ha region promote</code
					>.
				</p>
			{/if}
		</div>

		<div class="rounded-lg border p-3" data-card="drills">
			<p class="text-xs text-muted-foreground">Recent drills</p>
			{#if drills.length === 0}
				<p class="mt-1 text-sm font-medium">None yet</p>
				<p class="mt-1 text-xs text-muted-foreground">
					Run one below to prove the setup before a real outage.
				</p>
			{:else}
				<ul class="mt-1 space-y-1 text-xs">
					{#each drills as drill (drill.id)}
						<li class="flex flex-wrap items-center gap-1.5">
							<Badge variant={statusVariant(drill.status)}>{drill.status}</Badge>
							<span class="font-mono">{drill.label}</span>
							<span class="text-muted-foreground"
								>{formatRelative(drill.at)}{drill.detail ? `, ${drill.detail}` : ''}</span
							>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</Panel>
