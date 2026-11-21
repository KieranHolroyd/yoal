<script lang="ts">
	import { onMount } from 'svelte';
	import SirenIcon from '@lucide/svelte/icons/siren';
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import type { NodeDrillListView, NodeDrillView } from '@yoal/contracts';
	import { createQuery } from '@tanstack/svelte-query';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { fetchJson } from '#lib/query.js';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import type { Tone } from '#lib/status.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime, formatDuration, formatRelative } from '../../_lib/format.js';

	/**
	 * Disaster drill (D235): take a random node (or a named one) off the control plane for a few
	 * minutes so the failover controller, alerts and steering run for real, then read back how long
	 * detection and recovery took and what the controller did.
	 */
	let { initial }: { initial: NodeDrillListView } = $props();

	const live = createQuery(() => ({
		queryKey: ['ha-drills'] as const,
		queryFn: ({ signal }) => fetchJson<NodeDrillListView>('/api/v1/ha/drills', { signal, cache: 'no-store' }),
		initialData: initial,
		// Fast while a drill runs (the countdown and the offline mark), slow otherwise.
		refetchInterval: (query) => (query.state.data?.running || waitingForReturn(query.state.data) ? 3_000 : 20_000),
		staleTime: 2_000
	}));
	const drills = $derived(live.data ?? initial);
	const running = $derived(drills.running);

	let target = $state('');
	// `nodeDrillLimits.defaultSeconds` is five minutes.
	let minutes = $state('5');
	let includeControl = $state(false);

	const usable = $derived(drills.candidates.filter((node) => node.eligible || (includeControl && node.needsControlOptIn)));
	const blocked = $derived(drills.candidates.filter((node) => !(node.eligible || (includeControl && node.needsControlOptIn))));
	const durations = $derived(
		[1, 2, 5, 10, 15, 30].filter((value) => value * 60 >= drills.limits.minSeconds && value * 60 <= drills.limits.maxSeconds)
	);
	// A named target that stops being usable falls back to random rather than failing on submit.
	$effect(() => {
		if (target && !usable.some((node) => node.nodeId === target)) target = '';
	});

	let now = $state(Date.now());
	onMount(() => {
		const timer = setInterval(() => (now = Date.now()), 1_000);
		return () => clearInterval(timer);
	});

	function waitingForReturn(view: NodeDrillListView | undefined): boolean {
		return (view?.recent ?? []).some((drill) => drill.restoredAt === null && drill.status !== 'running' && drill.finishedAt === null);
	}

	const statusTone: Record<NodeDrillView['status'], Tone> = {
		running: 'warning',
		completed: 'success',
		cancelled: 'neutral',
		failed: 'danger'
	};

	function ms(value: number | null | undefined): string {
		if (value === null || value === undefined) return '—';
		return value < 120_000 ? `${Math.round(value / 1000)} s` : formatDuration(Math.round(value / 1000));
	}

	function start() {
		const node = drills.candidates.find((candidate) => candidate.nodeId === target);
		const who = node ? node.nodeName : `a random node (one of ${usable.map((candidate) => candidate.nodeName).join(', ')})`;
		askConfirm({
			title: node ? `Take ${node.nodeName} offline for ${minutes} min?` : `Take a random node offline for ${minutes} min?`,
			description: `${who} stops heartbeating, stops taking new desired state and fails its ingress health probe. The failover controller, alerts and DNS steering react exactly as for a real loss: copies may move, a database may fail over and you will get a “Node offline” alert after 2 minutes. Its workloads keep running unless their run lease fences them. It comes back by itself when the time is up; Cancel brings it back within 5 s.`,
			confirmLabel: 'Start drill',
			tone: 'danger',
			// A destructive drill needs the target typed back (HA-PLAN §10); a random pick types "random".
			typeToConfirm: node ? node.nodeName : 'random',
			action: '?/startDrill',
			fields: {
				node: target,
				durationSeconds: String(Number(minutes) * 60),
				includeControlNode: includeControl ? 'true' : ''
			},
			onResult: () => void live.refetch()
		});
	}

	function cancel(drill: NodeDrillView) {
		askConfirm({
			title: `End the drill on ${drill.nodeName} now?`,
			description: 'The node resumes heartbeats on its next poll, within about 5 s. The drill is recorded as cancelled with what was measured so far.',
			confirmLabel: 'End drill',
			action: '?/cancelDrill',
			fields: { id: drill.id },
			onResult: () => void live.refetch()
		});
	}
</script>

<Panel
	title="Disaster drill"
	icon={SirenIcon}
	description="Pull a node off the control plane for a few minutes to prove the HA logic on demand: detection, failover, alerting and recovery, measured."
>
	{#if running}
		{@const left = Math.max(0, running.endsAt - now)}
		<div class="flex flex-wrap items-start justify-between gap-4 rounded-md border border-warning/40 bg-warning/10 p-3">
			<div class="space-y-1 text-sm">
				<p class="font-medium">
					<span class="font-mono">{running.nodeName}</span> is offline for a drill
					{#if running.random}<Badge variant="outline" class="ml-1"><ShuffleIcon class="size-3" /> random</Badge>{/if}
				</p>
				<p class="text-muted-foreground">
					{#if left > 0}
						Comes back in {ms(left)} ({formatDateTime(running.endsAt)}).
					{:else}
						Time is up; waiting for its first heartbeat.
					{/if}
					{#if running.offlineAt}
						Marked offline {ms(running.offlineAt - running.startedAt)} after the start.
					{:else}
						Not marked offline yet (expected about 30 s after the start).
					{/if}
				</p>
				<p class="text-xs text-muted-foreground">
					Watch the nodes and failover history below react. Started {formatRelative(running.startedAt)} by {running.createdBy}.
				</p>
			</div>
			<Button variant="outline" size="sm" onclick={() => cancel(running)}>End drill now</Button>
		</div>
	{:else}
		<div class="flex flex-wrap items-end gap-3">
			<label class="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
				Node
				<select bind:value={target} class="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
					<option value="">Random eligible node</option>
					{#each usable as node (node.nodeId)}
						<option value={node.nodeId}>{node.nodeName}{node.controlNode ? ' (control plane)' : ''}</option>
					{/each}
				</select>
			</label>
			<label class="flex w-32 flex-col gap-1 text-xs text-muted-foreground">
				Offline for
				<select bind:value={minutes} class="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
					{#each durations as value (value)}
						<option value={String(value)}>{value} min</option>
					{/each}
				</select>
			</label>
			<label class="flex h-9 items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={includeControl} class="size-4 rounded border" />
				Allow the control-plane node
			</label>
			<Button variant="destructive" disabled={usable.length === 0} onclick={start}>
				<SirenIcon class="size-4" /> Run disaster drill
			</Button>
		</div>
		{#if usable.length === 0}
			<p class="mt-3 text-sm text-muted-foreground">No node can be drilled right now.</p>
		{/if}
		{#if blocked.length > 0}
			<ul class="mt-3 space-y-0.5 text-xs text-muted-foreground">
				{#each blocked as node (node.nodeId)}
					<li><span class="font-mono">{node.nodeName}</span>: {node.reason}</li>
				{/each}
			</ul>
		{/if}
		<p class="mt-3 text-xs text-muted-foreground">
			Pick a duration longer than the failover grace so copies actually move. Also from the CLI:
			<code class="font-mono">yoal ha drill node-offline</code>.
		</p>
	{/if}

	{#if drills.recent.length === 0}
		<div class="mt-4">
			<EmptyState icon={SirenIcon} compact title="No drills yet" description="Each drill records when the node was marked offline, when it came back and every failover action in between." />
		</div>
	{:else}
		<div class="mt-4 overflow-x-auto rounded-md border">
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">When</Table.Head>
						<Table.Head>Node</Table.Head>
						<Table.Head>Result</Table.Head>
						<Table.Head class="text-right">Detected</Table.Head>
						<Table.Head class="text-right">Back after</Table.Head>
						<Table.Head class="hidden pr-4 lg:table-cell">Failover actions</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each drills.recent as drill (drill.id)}
						{@const events = drill.observations?.events ?? []}
						<Table.Row>
							<Table.Cell class="pl-4 text-sm whitespace-nowrap" title={formatDateTime(drill.startedAt)}>
								{formatRelative(drill.startedAt)}
								<p class="text-xs text-muted-foreground">{ms(drill.durationSeconds * 1000)} planned</p>
							</Table.Cell>
							<Table.Cell>
								<span class="font-mono text-sm">{drill.nodeName}</span>
								{#if drill.random}<ShuffleIcon class="ml-1 inline size-3 text-muted-foreground" aria-label="picked at random" />{/if}
							</Table.Cell>
							<Table.Cell class="max-w-64 whitespace-normal">
								<StatusBadge status={drill.status} tone={statusTone[drill.status]} />
								{#if drill.message}<p class="mt-0.5 text-xs text-muted-foreground">{drill.message}</p>{/if}
							</Table.Cell>
							<Table.Cell class="text-right font-mono text-xs">
								{drill.offlineAt ? ms(drill.offlineAt - drill.startedAt) : '—'}
							</Table.Cell>
							<Table.Cell class="text-right font-mono text-xs">{ms(drill.observations?.backOnlineAfterMs)}</Table.Cell>
							<Table.Cell class="hidden max-w-md pr-4 text-xs whitespace-normal text-muted-foreground lg:table-cell">
								{#if events.length === 0}
									{drill.status === 'running' ? 'In progress' : 'None'}
								{:else}
									<ul class="space-y-0.5">
										{#each events.slice(0, 4) as event, index (index)}
											<li>
												<span class="text-foreground">{event.kind}</span>
												<span class="font-mono">{event.subject}</span>
												{#if event.fromNode || event.toNode}{event.fromNode ?? '—'} → {event.toNode ?? '—'}{/if}
												· {event.status}
											</li>
										{/each}
										{#if events.length + (drill.observations?.moreEvents ?? 0) > 4}
											<li>and {events.length + (drill.observations?.moreEvents ?? 0) - 4} more</li>
										{/if}
									</ul>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</Panel>
