<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import type { FailoverEventView, FailoverStatusView } from '@yoal/contracts';
	import { createQuery } from '@tanstack/svelte-query';
	import { resolve } from '$app/paths';
	import { fetchJson } from '#lib/query.js';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import StatusDot from '#lib/components/yoal/StatusDot.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import type { Tone } from '#lib/status.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import PolicyPanel from '../_lib/PolicyPanel.svelte';
	import AdminActions from './_AdminActions.svelte';
	import DisasterDrill from './_DisasterDrill.svelte';
	import DrillCatalogue from './_DrillCatalogue.svelte';
	import GuidedSetup from './_GuidedSetup.svelte';
	import StatusCards from './_StatusCards.svelte';
	import { databaseFailoverState, type StatusCardsInput } from './_lib/ha-setup.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// The controller ticks every few seconds; refresh the view while the page is open.
	const live = createQuery(() => ({
		queryKey: ['ha-status'] as const,
		queryFn: ({ signal }) =>
			fetchJson<FailoverStatusView>('/api/v1/ha/status', { signal, cache: 'no-store' }),
		initialData: data.failover,
		refetchInterval: 10_000,
		staleTime: 5_000
	}));
	const failover = $derived(live.data ?? data.failover);
	const ingressById = $derived(new Map(failover.ingress.nodes.map((node) => [node.id, node])));
	const proberToken = $derived((form as { proberToken?: string } | null)?.proberToken ?? null);
	const proberName = $derived((form as { proberName?: string } | null)?.proberName ?? null);

	const leaseTone: Record<FailoverStatusView['lease']['state'], Tone> = {
		holder: 'success',
		standby: 'neutral',
		fenced: 'danger',
		idle: 'warning'
	};
	const eventTone: Record<FailoverEventView['status'], Tone> = {
		queued: 'neutral',
		'in-progress': 'info',
		completed: 'success',
		failed: 'danger',
		blocked: 'warning',
		expired: 'warning',
		cancelled: 'neutral',
		manual: 'warning'
	};
	const kindLabel: Record<FailoverEventView['kind'], string> = {
		replica: 'Replica copy',
		ingress: 'Ingress',
		database: 'Database',
		lease: 'Lease'
	};

	const statusInput = $derived<StatusCardsInput>({
		profile: data.ha.profile,
		steering: { driver: data.steering.driver, stacked: data.steering.stacked, flag: !!data.flags.STEERING },
		ingress: {
			nodes: data.status.nodes.length,
			ready: data.status.nodes.filter((node) => node.ready).length,
			inRotation: failover.ingress.rotates ? failover.ingress.nodes.filter((node) => node.inRotation).length : null,
			setFlag: !!data.flags.INGRESS_SET
		},
		arbiter: {
			kind: data.ha.dependencies.platformStore.kind,
			detail: data.ha.dependencies.platformStore.detail,
			external: data.ha.dependencies.platformStore.survivesNodeLoss
		},
		control: {
			flag: !!data.flags.CONTROL_STANDBY,
			members: (failover.controlPlane ?? []).map((member) => ({
				name: member.name,
				role: member.role,
				canPromote: member.canPromote,
				lagSeconds: member.replicationLagSeconds
			}))
		},
		databases: failover.databases.map((database) => {
			const seen = data.databaseDurability[database.id] ?? null;
			return {
				id: database.id,
				name: database.name,
				durability: seen ? { configured: seen.configured, effective: seen.effective } : null,
				standbyRegion: seen?.standbyRegion ?? null,
				automatic: database.automatic
			};
		}),
		failover: data.databaseFailover,
		regionsFlag: !!data.flags.REGIONS,
		regions: data.regions,
		recentDrills: [
			...data.drills.recent.map((drill) => ({
				id: drill.id,
				at: drill.startedAt,
				label: `node-offline on ${drill.nodeName}`,
				status: drill.status,
				detail: drill.observations?.backOnlineAfterMs ? `back after ${Math.round(drill.observations.backOnlineAfterMs / 1000)} s` : null
			})),
			...data.timeline.items
				.filter((item) => item.kind === 'drill')
				.map((item) => ({
					id: item.id,
					at: item.startedAt,
					label: `database-failover on ${item.databaseName ?? item.databaseId}`,
					status: item.status,
					detail: item.timeToWritableMs === null ? null : `writable after ${(item.timeToWritableMs / 1000).toFixed(1)} s`
				}))
		]
	});

	function seconds(value: number): string {
		return value >= 120 && value % 60 === 0 ? `${value / 60} min` : `${value}s`;
	}
</script>

<SettingsHeader
	id="high-availability"
	description="Set up high availability step by step, see what is in force, run drills, and watch the failover controller and its history."
/>

<div class="space-y-6">
	{#if form?.success}
		<div class="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm">
			{form.success}
		</div>
	{/if}
	{#if form?.message}
		<div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
			{form.message}
		</div>
	{/if}

	<GuidedSetup currentProfile={data.ha.profile} canApply={data.canEditPolicies} />

	<StatusCards input={statusInput} />

	<Panel
		title="Platform dependencies"
		icon={ShieldCheckIcon}
		description="What the request path and a failover need besides your apps. The checks above say which of them still live on one node."
	>
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Platform object store</p>
				<p class="mt-1 text-sm font-medium">{data.ha.dependencies.platformStore.kind}</p>
				<p class="mt-1 text-xs text-muted-foreground">{data.ha.dependencies.platformStore.detail}</p>
			</div>
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Registry blobs</p>
				<p class="mt-1 text-sm font-medium">
					{data.ha.dependencies.registry.enabled ? data.ha.dependencies.registry.mode : 'registry off'}
				</p>
				<p class="mt-1 text-xs text-muted-foreground">{data.ha.dependencies.registry.detail}</p>
				{#if data.canEditPolicies && data.ha.dependencies.registry.enabled}
					<Button variant="ghost" size="sm" class="mt-2 h-7 px-2 text-xs" href={resolve('/(dashboard)/settings/registry')}>
						Registry storage
					</Button>
				{/if}
			</div>
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Identity</p>
				<p class="mt-1 text-sm font-medium">{data.ha.dependencies.identity.nodeName ?? 'No capable node'}</p>
				<p class="mt-1 text-xs text-muted-foreground">{data.ha.dependencies.identity.detail}</p>
				{#if data.canEditPolicies}
					<form method="POST" action="?/moveDependency" class="mt-2 flex items-center gap-2">
						<select name="identityNode" class="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs">
							<option value="">Automatic (first capable node)</option>
							{#each data.ha.nodes.filter((node) => node.identity) as node (node.id)}
								<option value={node.id} selected={node.id === data.ha.dependencies.identity.nodeId}>
									{node.name}{node.online ? '' : ' (offline)'}
								</option>
							{/each}
						</select>
						<Button type="submit" size="sm" variant="outline" class="h-8">Move</Button>
					</form>
				{/if}
			</div>
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Mail</p>
				<p class="mt-1 text-sm font-medium">{data.ha.dependencies.mail.nodeName ?? 'No mail node'}</p>
				<p class="mt-1 text-xs text-muted-foreground">{data.ha.dependencies.mail.detail}</p>
				{#if data.canEditPolicies}
					<form method="POST" action="?/moveDependency" class="mt-2 flex items-center gap-2">
						<select name="mailNode" class="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs">
							<option value="">No mail node</option>
							{#each data.ha.nodes.filter((node) => node.mail) as node (node.id)}
								<option value={node.id} selected={node.id === data.ha.dependencies.mail.nodeId}>
									{node.name}{node.online ? '' : ' (offline)'}
								</option>
							{/each}
						</select>
						<Button type="submit" size="sm" variant="outline" class="h-8">Move</Button>
					</form>
				{/if}
			</div>
		</div>

		{#if data.ha.dependencies.telemetrySpool.length > 0}
			<p class="mt-3 text-xs text-muted-foreground">
				Telemetry spool:
				{#each data.ha.dependencies.telemetrySpool as spool (spool.nodeId)}
					<span class="ml-1 font-mono">{spool.nodeName ?? spool.nodeId}: {spool.queued} queued, {spool.dropped} dropped</span>
				{/each}
			</p>
		{/if}
	</Panel>

	<Panel
		title="Failover controller"
		icon={ShieldCheckIcon}
		description="Moves replica copies off a lost or draining node, tracks the ingress record set and decides database failovers. Only the holder of the lease acts."
	>
		{#snippet actions()}
			<Button variant="outline" size="sm" href={resolve('/(dashboard)/settings/clustering')}>Edit policy</Button>
		{/snippet}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Failover controller</p>
				<p class="mt-1">
					<Badge variant={failover.enabled ? 'success' : 'neutral'}>{failover.enabled ? 'On' : 'Off'}</Badge>
				</p>
				<p class="mt-1 text-xs text-muted-foreground">
					{failover.enabled
						? 'Lost nodes are acted on. Database promotion is shown under Databases.'
						: 'Lost nodes are reported only. Drains still move copies.'}
				</p>
			</div>
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Lease</p>
				<p class="mt-1 flex items-center gap-2">
					<StatusBadge status={failover.lease.state} tone={leaseTone[failover.lease.state]} />
					{#if failover.lease.epoch}<span class="font-mono text-xs">epoch {failover.lease.epoch}</span>{/if}
				</p>
				<p class="mt-1 truncate font-mono text-xs text-muted-foreground" title={failover.lease.holderId ?? ''}>
					{failover.lease.self ? 'This control plane' : (failover.lease.holderId ?? 'Nobody holds it')}
				</p>
			</div>
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Last tick</p>
				<p class="mt-1 text-sm">{failover.lastTickAt ? formatRelative(failover.lastTickAt) : 'Not on this process'}</p>
				<p class="mt-1 text-xs text-muted-foreground">Every {seconds(failover.policy.tickSeconds)}, lease TTL {seconds(failover.policy.leaseTtlSeconds)}</p>
			</div>
			<div class="rounded-lg border p-3">
				<p class="text-xs text-muted-foreground">Actions</p>
				<p class="mt-1 text-sm tabular-nums">
					{failover.counts.lastMinute} in the last minute · {failover.counts.inProgress} in progress · {failover.counts.queued} waiting
				</p>
				<p class="mt-1 text-xs text-muted-foreground">
					At most {failover.policy.maxPerMinute}/min fleet-wide, {failover.policy.perTargetPerMinute}/min per target node
				</p>
			</div>
		</div>
		<dl class="mt-4 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
			<div><dt class="inline">Node lost after</dt> <dd class="inline font-medium text-foreground">{seconds(failover.policy.graceSeconds)} silent</dd></div>
			<div><dt class="inline">Replica copies move after</dt> <dd class="inline font-medium text-foreground">{seconds(failover.policy.replicaGraceSeconds)} silent</dd></div>
			<div><dt class="inline">Waiting moves expire after</dt> <dd class="inline font-medium text-foreground">{seconds(failover.policy.queueExpirySeconds)}</dd></div>
			<div><dt class="inline">A failover source is not a target for</dt> <dd class="inline font-medium text-foreground">{seconds(failover.policy.flapWindowSeconds)}</dd></div>
		</dl>
	</Panel>

	<Panel title="Nodes" icon={ServerIcon} description="How long each node has been silent, and the replica copies the controller would move." flush>
		<Table.Root>
			<Table.Header class="bg-muted/45">
				<Table.Row>
					<Table.Head class="pl-4">Node</Table.Head>
					<Table.Head>Last heartbeat</Table.Head>
					<Table.Head class="text-right">Copies</Table.Head>
					<Table.Head class="pr-4">Failover</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each failover.nodes as node (node.id)}
					<Table.Row>
						<Table.Cell class="pl-4">
							<div class="flex items-center gap-2">
								<StatusDot status={node.status} />
								<span class="font-medium">{node.name}</span>
								<Badge variant="outline" class="font-mono text-[10px]">{node.zone}</Badge>
							</div>
						</Table.Cell>
						<Table.Cell class="text-sm">
							{node.lastHeartbeatAt ? formatRelative(node.lastHeartbeatAt) : 'Never'}
						</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{node.copies}</Table.Cell>
						<Table.Cell class="pr-4 text-sm">
							{#if node.status === 'draining'}
								<Badge variant="info">Draining: copies move</Badge>
							{:else if node.lost}
								<Badge variant="danger">Lost</Badge>
							{:else}
								<span class="text-muted-foreground">Healthy</span>
							{/if}
							{#if node.replicaFailoverAt && node.copies > 0}
								<p class="mt-0.5 text-xs text-muted-foreground">Copies move {formatRelative(node.replicaFailoverAt)}</p>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Panel>

	{#if failover.databases.length}
		<Panel title="Database primaries" icon={DatabaseIcon} description="Databases with replicas, and the replica a promotion would pick under the lag limits." flush>
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Database</Table.Head>
						<Table.Head>Primary</Table.Head>
						<Table.Head>Candidate</Table.Head>
						<Table.Head class="pr-4">Promotion</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each failover.databases as database (database.id)}
						<Table.Row>
							<Table.Cell class="pl-4 font-mono text-sm">{database.name}</Table.Cell>
							<Table.Cell class="text-sm">
								{database.nodeName ?? database.nodeId ?? '—'}
								{#if database.primaryLost}<Badge variant="danger" class="ml-1">Lost</Badge>{/if}
							</Table.Cell>
							<Table.Cell class="text-sm">
								{#if database.candidate}
									{database.candidate.nodeName ?? database.candidate.nodeId}
								{:else}
									<span class="text-muted-foreground">None</span>
								{/if}
								{#each database.refusals as refusal (refusal)}
									<p class="text-xs text-muted-foreground">{refusal}</p>
								{/each}
							</Table.Cell>
							<Table.Cell class="max-w-72 pr-4 whitespace-normal">
								{@const state = databaseFailoverState(data.databaseFailover, database)}
								<Badge variant={state.tone}>{state.label}</Badge>
								{#if state.label !== 'Automatic'}<p class="mt-0.5 text-xs text-muted-foreground">{state.reason}</p>{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Panel>
	{/if}

	<Panel
		title="Effective HA levels"
		icon={ShieldCheckIcon}
		description="A project is only as redundant as its weakest live resource. Declaring a target makes drift visible as ha.effective_below_target."
	>
		{#if data.targets.targets.length === 0}
			<EmptyState icon={ShieldCheckIcon} compact title="No projects" description="Create a project to declare a target." />
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Project</Table.Head>
						<Table.Head>Declared</Table.Head>
						<Table.Head>Effective</Table.Head>
						<Table.Head>Gap</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.targets.targets as target (target.projectId)}
						<Table.Row>
							<Table.Cell class="pl-4">
								<p class="text-sm font-medium">{target.name}</p>
								<p class="font-mono text-xs text-muted-foreground">{target.slug}</p>
							</Table.Cell>
							<Table.Cell><Badge variant={target.declared ? 'outline' : 'neutral'}>{target.declared ?? 'undeclared'}</Badge></Table.Cell>
							<Table.Cell><Badge variant={target.belowTarget ? 'warning' : 'neutral'}>{target.effective ?? 'not placed'}</Badge></Table.Cell>
							<Table.Cell class="text-xs">
								{#if target.belowTarget}
									<span class="text-destructive">Below target</span>
									{#each target.blockers as blocker (blocker)}
										<p class="text-muted-foreground">{blocker}</p>
									{/each}
								{:else}
									<span class="text-muted-foreground">No gap</span>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
		{#if data.canEditPolicies}
			<form method="POST" action="?/saveHaTarget" class="mt-4 flex flex-wrap items-end gap-2">
				<label class="text-xs">
					<span class="mb-1 block text-muted-foreground">Project</span>
					<select name="slug" class="h-9 min-w-44 rounded-md border bg-background px-2 text-sm" required>
						{#each data.targets.targets.filter((target) => data.editableSlugs.includes(target.slug)) as target (target.projectId)}
							<option value={target.slug}>{target.name}</option>
						{/each}
					</select>
				</label>
				<label class="text-xs">
					<span class="mb-1 block text-muted-foreground">Declared target</span>
					<select name="target" class="h-9 rounded-md border bg-background px-2 text-sm">
						<option value="">No target</option>
						<option value="L0">L0 single</option>
						<option value="L1">L1 recoverable</option>
						<option value="L2">L2 failover</option>
						<option value="L3">L3 active</option>
					</select>
				</label>
				<Button type="submit" size="sm" variant="outline">Save target</Button>
			</form>
		{/if}
	</Panel>

	{#if data.canEditPolicies}
		<PolicyPanel group="ingress" policies={data.policies} defaults={data.policyDefaults} {form}>
			<div class="mb-5 grid gap-4 sm:grid-cols-3">
				<div class="rounded-lg border p-3">
					<p class="text-xs text-muted-foreground">Driver in use</p>
					<p class="font-mono text-sm">{data.status.driver}</p>
					<p class="mt-1 text-xs text-muted-foreground">
						{failover.ingress.rotates ? 'The controller tracks the record set.' : 'No record set to rotate.'}
					</p>
				</div>
				<div class="rounded-lg border p-3">
					<p class="text-xs text-muted-foreground">Withdraw after</p>
					<p class="text-sm">{seconds(failover.policy.ingressHoldDownSeconds)}</p>
					<p class="mt-1 text-xs text-muted-foreground">Twice the hold-down ({data.status.policy.holdDownSeconds}s), at least 120 s</p>
				</div>
				<div class="rounded-lg border p-3">
					<p class="text-xs text-muted-foreground">Re-add after</p>
					<p class="text-sm">{seconds(data.status.policy.readdSeconds)} healthy</p>
					<p class="mt-1 text-xs text-muted-foreground">At most once per 10 min; withdrawn twice in 30 min pins it out</p>
				</div>
			</div>
		</PolicyPanel>
	{/if}

	<Panel title="Ingress nodes" icon={ActivityIcon} description="Every node holding the ingress role, with readiness and its place in the record set.">
		{#if data.status.nodes.length === 0}
			<p class="text-sm text-muted-foreground">No ingress nodes.</p>
		{:else}
			<div class="space-y-2">
				{#each data.status.nodes as node (node.id)}
					{@const rotation = ingressById.get(node.id)}
					<div class="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
						<div class="flex items-center gap-2">
							<StatusDot status={node.status} />
							<span class="font-medium">{node.name}</span>
							<Badge variant="outline" class="font-mono text-[10px]">{node.zone}</Badge>
						</div>
						<div class="flex flex-wrap items-center gap-1.5">
							{#if rotation?.pinned}
								<Badge variant="warning" title={rotation.pinnedUntil ? `Until ${formatDateTime(rotation.pinnedUntil)}` : undefined}>Pinned out</Badge>
							{/if}
							{#if failover.ingress.rotates && rotation}
								<Badge variant={rotation.inRotation ? 'success' : 'secondary'}>{rotation.inRotation ? 'In rotation' : 'Withdrawn'}</Badge>
							{/if}
							<Badge variant={node.ready ? 'success' : 'secondary'}>{node.ready ? 'ready' : 'not ready'}</Badge>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</Panel>

	<DrillCatalogue flags={data.flags} canRun={data.canEditPolicies} />

	<DisasterDrill initial={data.drills} />

	<AdminActions isAdmin={data.canEditPolicies} />

	<Panel title="Failover history" icon={HistoryIcon} description="Every action the controller decided on, newest first. The epoch is the lease it acted under." count={failover.recent.length} flush>
		{#if failover.recent.length === 0}
			<div class="p-4">
				<EmptyState icon={HistoryIcon} compact title="No failover events" description="Moves, ingress withdrawals, database decisions and lease changes appear here." />
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">When</Table.Head>
						<Table.Head>What</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="hidden lg:table-cell">Reason</Table.Head>
						<Table.Head class="pr-4 text-right">Epoch</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each failover.recent as event (event.id)}
						<Table.Row>
							<Table.Cell class="pl-4 text-sm whitespace-nowrap" title={formatDateTime(event.detectedAt)}>
								{formatRelative(event.detectedAt)}
							</Table.Cell>
							<Table.Cell class="max-w-72">
								<p class="text-sm">
									<span class="text-muted-foreground">{kindLabel[event.kind]}</span>
									<span class="font-mono">{event.subjectName ?? event.subjectId}</span>
								</p>
								{#if event.fromNodeId || event.toNodeId}
									<p class="text-xs text-muted-foreground">
										{event.fromNodeName ?? event.fromNodeId ?? '—'} → {event.toNodeName ?? event.toNodeId ?? '—'}
									</p>
								{/if}
							</Table.Cell>
							<Table.Cell>
								<StatusBadge status={event.status} tone={eventTone[event.status]} />
								<p class="mt-0.5 text-xs text-muted-foreground">{event.stage}</p>
							</Table.Cell>
							<Table.Cell class="hidden max-w-md text-xs whitespace-normal text-muted-foreground lg:table-cell">{event.reason}</Table.Cell>
							<Table.Cell class="pr-4 text-right font-mono text-xs">{event.epoch}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>

	<Panel
		title="Failover and drill timeline"
		icon={HistoryIcon}
		description="Every failover, switchover and drill, newest first, with the measured time to writable and the commits a drill lost."
		count={data.timeline.items.length}
		flush
	>
		{#if data.timeline.items.length === 0}
			<div class="p-4">
				<EmptyState icon={HistoryIcon} compact title="No failovers or drills" description="Promotions and drills appear here with their measured result." />
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">When</Table.Head>
						<Table.Head>What</Table.Head>
						<Table.Head>Database</Table.Head>
						<Table.Head>Result</Table.Head>
						<Table.Head class="text-right">Time to writable</Table.Head>
						<Table.Head class="pr-4 text-right">Lost commits</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.timeline.items as item (item.id)}
						<Table.Row>
							<Table.Cell class="pl-4 text-sm whitespace-nowrap" title={formatDateTime(item.startedAt)}>
								{formatRelative(item.startedAt)}
							</Table.Cell>
							<Table.Cell>
								<Badge variant={item.kind === 'drill' ? 'outline' : item.kind === 'switchover' ? 'info' : 'warning'}>
									{item.kind}
								</Badge>
								{#if item.promotionSource}<p class="mt-0.5 text-xs text-muted-foreground">{item.promotionSource}</p>{/if}
							</Table.Cell>
							<Table.Cell class="text-sm">
								<span class="font-mono">{item.databaseName ?? item.databaseId}</span>
								{#if item.durability}<Badge variant="outline" class="ml-1">{item.durability}</Badge>{/if}
								<p class="mt-0.5 text-xs text-muted-foreground">
									{item.fromNodeName ?? item.fromNodeId ?? '—'} → {item.toNodeName ?? item.toNodeId ?? '—'}
								</p>
							</Table.Cell>
							<Table.Cell>
								<Badge variant={item.status === 'completed' || item.status === 'passed' ? 'success' : item.status === 'failed' ? 'danger' : 'neutral'}>
									{item.status}
								</Badge>
								{#if item.arbiterTested !== null}
									<p class="mt-0.5 text-xs text-muted-foreground">arbiter {item.arbiterTested ? 'tested' : 'not tested'}</p>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-right font-mono text-xs">
								{item.timeToWritableMs === null ? '—' : `${(item.timeToWritableMs / 1000).toFixed(1)} s`}
							</Table.Cell>
							<Table.Cell class="pr-4 text-right font-mono text-xs">{item.lostCommits ?? '—'}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>

	<Panel
		title="External prober"
		icon={ActivityIcon}
		description="A tiny agent outside the fleet observes the public surface and posts what it saw. An outage that hides the control plane is still visible from here."
	>
		{#if !data.probers.enabled}
			<p class="text-sm text-muted-foreground">Off. Enable <code class="font-mono">EXTERNAL_PROBER</code> to register a prober.</p>
		{:else if data.probers.probers.length === 0}
			<EmptyState icon={ActivityIcon} compact title="No probers registered" description="Register one below and run scripts/external-prober.ts outside the fleet." />
		{:else}
			<ul class="space-y-2">
				{#each data.probers.probers as prober (prober.proberId)}
					<li class="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
						<div>
							<p class="flex items-center gap-2 text-sm font-medium">
								{prober.name}
								{#if prober.revokedAt}<Badge variant="neutral">revoked</Badge>
								{:else if prober.stale}<Badge variant="warning">stale</Badge>
								{:else}<Badge variant="success">reporting</Badge>{/if}
							</p>
							<p class="text-xs text-muted-foreground">
								{prober.lastReportAt ? `Last report ${formatRelative(prober.lastReportAt)}` : 'Never reported'} · every {prober.intervalSeconds}s ·
								{prober.counts.up} up / {prober.counts.degraded} degraded / {prober.counts.down} down
							</p>
						</div>
						{#if data.canEditPolicies && !prober.revokedAt}
							<form method="POST" action="?/revokeProber">
								<input type="hidden" name="proberId" value={prober.proberId} />
								<Button type="submit" size="sm" variant="outline">Revoke</Button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if data.canEditPolicies && data.probers.enabled}
			<form method="POST" action="?/registerProber" class="mt-4 flex flex-wrap items-end gap-2">
				<label class="text-xs">
					<span class="mb-1 block text-muted-foreground">Name</span>
					<input name="name" required maxlength="100" class="h-9 rounded-md border bg-background px-2 text-sm" placeholder="london-1" />
				</label>
				<label class="text-xs">
					<span class="mb-1 block text-muted-foreground">Every (seconds)</span>
					<input name="intervalSeconds" type="number" min="10" max="3600" value="60" class="h-9 w-28 rounded-md border bg-background px-2 text-sm" />
				</label>
				<label class="text-xs">
					<span class="mb-1 block text-muted-foreground">Install id (optional)</span>
					<input name="installId" maxlength="100" class="h-9 rounded-md border bg-background px-2 text-sm" placeholder="ins_…" />
				</label>
				<Button type="submit" size="sm" variant="outline">Register prober</Button>
			</form>
			{#if proberToken}
				<p class="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
					Token for {proberName ?? 'the new prober'} (shown once):
					<code class="mt-1 block break-all font-mono">{proberToken}</code>
				</p>
			{/if}
		{/if}
	</Panel>
</div>
