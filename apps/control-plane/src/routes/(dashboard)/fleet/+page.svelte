<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import type { LinkMapView, SchedulingView } from '@yoal/contracts';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import ServerIcon from '@lucide/svelte/icons/server';
	import { runAction } from '#lib/actions.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { formatBps, formatRtt, layoutNodes, pairEdges, pathLabels, sparkline, type MapEdge } from './_links.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const scheduling = $derived(data.scheduling as SchedulingView | null);
	const links = $derived(data.links as LinkMapView | null);

	// ------------------------------------------------------------------ capacity

	const afterByNode = $derived(new Map((scheduling?.plan.after ?? []).map((entry) => [entry.nodeId, entry.percent])));
	const pinned = $derived((scheduling?.units ?? []).filter((unit) => unit.blocker));
	const nodeName = $derived(new Map((scheduling?.nodes ?? []).map((node) => [node.id, node.name])));
	let busy = $state('');
	let showPinned = $state(false);

	async function act(name: string, action: string, fields: Record<string, string> = {}) {
		busy = name;
		try {
			await runAction(action, fields);
		} finally {
			busy = '';
		}
	}

	const clamp = (value: number) => Math.max(0, Math.min(100, value));

	// ------------------------------------------------------------------ links

	const WIDTH = 640;
	const HEIGHT = 380;
	const mapNodes = $derived((links?.nodes ?? []).filter((node) => node.privateAddress));
	const points = $derived(layoutNodes(mapNodes, WIDTH, HEIGHT));
	const pointById = $derived(new Map(points.map((point) => [point.id, point])));
	const edges = $derived(links ? pairEdges({ ...links, nodes: mapNodes }) : []);
	const active = $derived((links?.running ?? 0) + (links?.queued ?? 0));
	let hovered = $state<string | null>(null);
	let selected = $state<string | null>(null);
	const focus = $derived(edges.find((edge) => edge.key === (hovered ?? selected)) ?? null);
	const linkName = $derived(new Map((links?.nodes ?? []).map((node) => [node.id, node.name])));

	/** Path is drawn, not coloured: thick for a private network, thin for public, dashed for relayed. */
	const strokeWidth = (edge: MapEdge) => (edge.path === 'private' ? 3.5 : 1.75);
	const dash = (edge: MapEdge) => (edge.path === 'relayed' ? '6 5' : undefined);
	/** Colour is state only, and always comes with a word in the label. */
	const strokeClass = (edge: MapEdge) =>
		edge.state === 'down'
			? 'stroke-destructive'
			: edge.state === 'lossy'
				? 'stroke-warning'
				: edge.state === 'unknown'
					? 'stroke-muted-foreground/40'
					: 'stroke-foreground/55';
	const edgeLabel = (edge: MapEdge) =>
		edge.state === 'down' ? 'unreachable' : edge.state === 'unknown' ? 'no sample yet' : `${formatRtt(edge.rttMs)}${edge.state === 'lossy' ? ` · ${edge.lossPercent}% loss` : ''}`;
	const midpoint = (edge: MapEdge) => {
		const a = pointById.get(edge.a)!;
		const b = pointById.get(edge.b)!;
		return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	};

	// Refresh while tests run, and slowly otherwise so the latency samples stay current.
	onMount(() => {
		let timer: ReturnType<typeof setTimeout>;
		const tick = () => {
			timer = setTimeout(
				async () => {
					if (document.visibilityState === 'visible') await invalidate('yoal:fleet');
					tick();
				},
				active > 0 || (scheduling?.units ?? []).some((unit) => unit.blocker === 'it is already moving') ? 3_000 : 20_000,
			);
		};
		tick();
		return () => clearTimeout(timer);
	});
</script>

<PageHeader
	title="Fleet"
	description="How full each node is, what could move to even it out, and how well the nodes are connected."
>
	{#if scheduling}
		<Badge variant="outline"><GaugeIcon class="size-3.5" /> {scheduling.strategy}</Badge>
		{#if scheduling.autoRebalance}<Badge variant="success">Automatic rebalance on</Badge>{/if}
	{/if}
</PageHeader>

{#if data.denied}
	<EmptyState
		icon={ServerIcon}
		title="Platform admin required"
		description="The fleet view names every node and workload on this install."
	/>
{:else if scheduling && links}
	<div class="flex flex-col gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title>Capacity</Card.Title>
				<Card.Description>
					Memory reserved by what is placed on each node, against the most it will admit{scheduling.memoryOvercommitPercent > 100
						? ` (${scheduling.memoryOvercommitPercent}% of its workload budget)`
						: ''}. The thin bar underneath is what the host reports in use right now.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-5">
				<div class="flex flex-col gap-4" role="table" aria-label="Memory reserved per node">
					{#each scheduling.nodes as node (node.id)}
						{@const after = afterByNode.get(node.id)}
						{@const moves = after !== undefined && Math.abs(after - node.reservedPercent) >= 0.1}
						<div class="grid grid-cols-[minmax(7rem,12rem)_1fr_auto] items-center gap-x-4 gap-y-1" role="row">
							<div role="cell">
								<div class="truncate text-sm font-medium">{node.name}</div>
								<div class="text-xs text-muted-foreground">
									{node.zone} · {node.eligible ? node.status : `${node.status}, takes no new work`}
								</div>
							</div>
							<div class="flex flex-col gap-1" role="cell">
								<div
									class="relative h-3 rounded-full bg-muted"
									title="{node.reservedMb} MB reserved of {node.capacityMb} MB"
								>
									<div class="h-full rounded-full bg-info" style="width: {clamp(node.reservedPercent)}%"></div>
									{#if moves}
										<!-- Where the reservation lands after the planned moves. -->
										<div
											class="absolute -top-1 h-5 w-0.5 rounded bg-foreground"
											style="left: calc({clamp(after ?? 0)}% - 1px)"
											title="After rebalancing: {after}%"
										></div>
									{/if}
								</div>
								{#if node.usedMemoryMb !== null && node.totalMemoryMb}
									<div
										class="h-1 rounded-full bg-muted"
										title="{node.usedMemoryMb} MB in use of {node.totalMemoryMb} MB on the host"
									>
										<div
											class="h-full rounded-full bg-muted-foreground/60"
											style="width: {clamp((node.usedMemoryMb / node.totalMemoryMb) * 100)}%"
										></div>
									</div>
								{/if}
							</div>
							<div class="text-right text-sm tabular-nums" role="cell">
								<div>
									{node.reservedPercent}%{#if moves}<span class="text-muted-foreground"> → {after}%</span>{/if}
								</div>
								<div class="text-xs text-muted-foreground">
									{node.reservedMb} / {node.capacityMb} MB · {node.copies} cop{node.copies === 1 ? 'y' : 'ies'}{node.cpuPercent !== null
										? ` · CPU ${node.cpuPercent}%`
										: ''}
								</div>
							</div>
						</div>
					{/each}
				</div>

				<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
					<span class="flex items-center gap-1.5"><span class="h-2 w-4 rounded-full bg-info"></span> Reserved</span>
					<span class="flex items-center gap-1.5"><span class="h-1 w-4 rounded-full bg-muted-foreground/60"></span> In use on the host</span>
					{#if scheduling.plan.moves.length > 0}
						<span class="flex items-center gap-1.5"><span class="h-3 w-0.5 rounded bg-foreground"></span> After rebalancing</span>
					{/if}
				</div>

				<div class="rounded-lg border p-4">
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div class="min-w-0">
							<div class="text-sm font-medium">Rebalance</div>
							<p class="text-sm text-muted-foreground">{scheduling.plan.summary}</p>
						</div>
						<div class="flex flex-wrap gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={busy !== ''}
								onclick={() =>
									act('strategy', '?/strategy', {
										strategy: scheduling.strategy === 'spread' ? 'pack' : 'spread',
										autoRebalance: String(scheduling.autoRebalance),
									})}
							>
								Switch to {scheduling.strategy === 'spread' ? 'pack' : 'spread'}
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={busy !== ''}
								onclick={() =>
									act('strategy', '?/strategy', {
										strategy: scheduling.strategy,
										autoRebalance: String(!scheduling.autoRebalance),
									})}
							>
								Turn automatic rebalance {scheduling.autoRebalance ? 'off' : 'on'}
							</Button>
							<Button
								size="sm"
								disabled={busy !== '' || scheduling.plan.moves.length === 0}
								onclick={() => act('rebalance', '?/rebalance', { strategy: scheduling.strategy })}
							>
								{busy === 'rebalance' ? 'Moving…' : `Make ${scheduling.plan.moves.length || 'no'} move${scheduling.plan.moves.length === 1 ? '' : 's'}`}
							</Button>
						</div>
					</div>
					{#if scheduling.plan.moves.length > 0}
						<ul class="mt-3 flex flex-col gap-1.5 text-sm">
							{#each scheduling.plan.moves as move (move.unitId)}
								<li class="flex flex-wrap items-center gap-2">
									<span class="font-medium">{move.label}</span>
									<span class="text-muted-foreground">{move.memoryMb} MB</span>
									<span class="font-mono text-xs">{move.fromNodeName}</span>
									<ArrowRightIcon class="size-3.5 text-muted-foreground" />
									<span class="font-mono text-xs">{move.toNodeName}</span>
								</li>
							{/each}
						</ul>
					{/if}
					<p class="mt-3 text-xs text-muted-foreground">
						<span class="font-medium text-foreground">{scheduling.strategy === 'spread' ? 'Spread' : 'Pack'}</span>
						{scheduling.strategy === 'spread'
							? 'keeps headroom on every node. Pack fills nodes one at a time, so a node can be freed.'
							: 'fills nodes one at a time, so a node can be freed. Spread keeps headroom on every node.'}
						An app with nothing attached moves without downtime: the old copy serves until the new one is up.
					</p>
				</div>

				{#if pinned.length > 0}
					<div>
						<button class="text-sm text-muted-foreground underline-offset-4 hover:underline" onclick={() => (showPinned = !showPinned)}>
							{showPinned ? 'Hide' : 'Show'} the {pinned.length} workload{pinned.length === 1 ? '' : 's'} that cannot move
						</button>
						{#if showPinned}
							<table class="mt-2 w-full text-sm">
								<thead class="text-left text-xs uppercase tracking-wide text-muted-foreground">
									<tr class="border-b"><th class="px-2 py-2">Workload</th><th class="px-2 py-2">Node</th><th class="px-2 py-2">Why it stays</th></tr>
								</thead>
								<tbody>
									{#each pinned as unit (unit.id)}
										<tr class="border-b last:border-0">
											<td class="px-2 py-2 font-medium">{unit.label}</td>
											<td class="px-2 py-2 font-mono text-xs">{nodeName.get(unit.nodeId) ?? unit.nodeId}</td>
											<td class="px-2 py-2 text-muted-foreground">{unit.blocker}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						{/if}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div>
						<Card.Title>Links between nodes</Card.Title>
						<Card.Description>
							Latency is sampled all the time. A link test also pushes and pulls data for a few seconds
							in each direction, so it loads the link while it runs.
						</Card.Description>
					</div>
					<div class="flex items-center gap-2">
						{#if active > 0}
							<Badge variant="info"><ActivityIcon class="size-3.5" /> {links.running} running · {links.queued} waiting</Badge>
						{/if}
						<Button size="sm" disabled={busy !== '' || mapNodes.length < 2} onclick={() => act('links', '?/linkTest')}>
							{busy === 'links' ? 'Queuing…' : 'Test every link'}
						</Button>
					</div>
				</div>
			</Card.Header>
			<Card.Content class="flex flex-col gap-5">
				{#if mapNodes.length < 2}
					<p class="text-sm text-muted-foreground">
						Links appear once two nodes are on the managed overlay. Join a second node, or move an existing one onto the overlay from the Nodes page.
					</p>
				{:else}
					<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
						<svg
							viewBox="0 0 {WIDTH} {HEIGHT}"
							class="h-auto w-full rounded-lg border bg-card"
							role="img"
							aria-label="Map of the links between nodes; the table below lists the same links"
						>
							{#each edges as edge (edge.key)}
								{@const a = pointById.get(edge.a)!}
								{@const b = pointById.get(edge.b)!}
								{@const mid = midpoint(edge)}
								{@const lit = focus?.key === edge.key}
								<g
									role="button"
									tabindex="0"
									aria-label="{linkName.get(edge.a)} to {linkName.get(edge.b)}: {edgeLabel(edge)}, {pathLabels[edge.path]}"
									class="cursor-pointer outline-none"
									onmouseenter={() => (hovered = edge.key)}
									onmouseleave={() => (hovered = null)}
									onfocus={() => (hovered = edge.key)}
									onblur={() => (hovered = null)}
									onclick={() => (selected = selected === edge.key ? null : edge.key)}
									onkeydown={(event) => {
										if (event.key === 'Enter' || event.key === ' ') selected = selected === edge.key ? null : edge.key;
									}}
								>
									<!-- A wide invisible stroke, so the link is easy to point at. -->
									<line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" stroke-width="18" />
									<line
										x1={a.x}
										y1={a.y}
										x2={b.x}
										y2={b.y}
										class={strokeClass(edge)}
										stroke-width={strokeWidth(edge) + (lit ? 1.5 : 0)}
										stroke-dasharray={dash(edge)}
										stroke-linecap="round"
									/>
									<g transform="translate({mid.x} {mid.y})">
										<rect x="-46" y={edge.forwardBps !== null ? -19 : -11} width="92" height={edge.forwardBps !== null ? 38 : 22} rx="6" class="fill-card stroke-border" />
										<text text-anchor="middle" y={edge.forwardBps !== null ? -4 : 4} class="fill-foreground text-[11px] font-medium tabular-nums">
											{edgeLabel(edge)}
										</text>
										{#if edge.forwardBps !== null}
											<text text-anchor="middle" y="11" class="fill-muted-foreground text-[10px] tabular-nums">
												{formatBps(Math.min(edge.forwardBps, edge.reverseBps ?? edge.forwardBps))}
											</text>
										{/if}
									</g>
								</g>
							{/each}
							{#each points as point (point.id)}
								{@const node = mapNodes.find((entry) => entry.id === point.id)!}
								<g>
									<circle cx={point.x} cy={point.y} r="13" class="fill-card stroke-foreground" stroke-width="2" />
									<circle cx={point.x} cy={point.y} r="5" class={node.status === 'online' ? 'fill-success' : 'fill-muted-foreground'} />
									<text
										x={point.x + (point.anchor === 'start' ? 20 : point.anchor === 'end' ? -20 : 0)}
										y={point.y + point.labelDy}
										text-anchor={point.anchor}
										class="fill-foreground text-[13px] font-medium"
									>
										{point.name}
									</text>
									<text
										x={point.x + (point.anchor === 'start' ? 20 : point.anchor === 'end' ? -20 : 0)}
										y={point.y + point.labelDy + 14}
										text-anchor={point.anchor}
										class="fill-muted-foreground text-[11px]"
									>
										{point.zone}{node.privateNetwork ? ` · ${node.privateNetwork}` : ''}{node.status === 'online' ? '' : ` · ${node.status}`}
									</text>
								</g>
							{/each}
						</svg>

						<div class="flex flex-col gap-3">
							<div class="rounded-lg border p-3 text-sm">
								{#if focus}
									<div class="font-medium">{linkName.get(focus.a)} ↔ {linkName.get(focus.b)}</div>
									<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
										<dt class="text-muted-foreground">Path</dt>
										<dd>{pathLabels[focus.path]}</dd>
										<dt class="text-muted-foreground">Latency</dt>
										<dd class="tabular-nums">{edgeLabel(focus)}</dd>
										<dt class="text-muted-foreground">{linkName.get(focus.a)} → {linkName.get(focus.b)}</dt>
										<dd class="tabular-nums">{formatBps(focus.forwardBps)}</dd>
										<dt class="text-muted-foreground">{linkName.get(focus.b)} → {linkName.get(focus.a)}</dt>
										<dd class="tabular-nums">{formatBps(focus.reverseBps)}</dd>
										{#if focus.testStatus && focus.testStatus !== 'ok'}
											<dt class="text-muted-foreground">Test</dt>
											<dd>{focus.testStatus}{focus.testError ? `: ${focus.testError}` : ''}</dd>
										{/if}
									</dl>
									{#if focus.history.length > 1}
										{@const line = sparkline(focus.history, 220, 36)}
										<div class="mt-3">
											<div class="flex items-baseline justify-between text-xs text-muted-foreground">
												<span>Latency, last {focus.history.length} min</span>
												{#if line.min !== null}<span class="tabular-nums">{formatRtt(line.min)} – {formatRtt(line.max)}</span>{/if}
											</div>
											<svg viewBox="0 0 220 36" class="mt-1 h-9 w-full" role="img" aria-label="Latency over the last {focus.history.length} minutes; gaps are minutes with no answer">
												{#each line.segments as points (points)}
													{#if points.includes(' ')}
														<polyline {points} fill="none" class="stroke-foreground/70" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
													{:else}
														<circle cx={points.split(',')[0]} cy={points.split(',')[1]} r="2" class="fill-foreground/70" />
													{/if}
												{/each}
											</svg>
											{#if focus.downSince}
												<p class="text-xs text-destructive">No answer since {new Date(focus.downSince).toLocaleTimeString()}.</p>
											{/if}
										</div>
									{/if}
									<Button
										class="mt-3"
										variant="outline"
										size="sm"
										disabled={busy !== ''}
										onclick={() => act('links', '?/linkTest', { from: focus.a, to: focus.b })}
									>
										Test this link
									</Button>
								{:else}
									<p class="text-muted-foreground">Point at a link for its numbers, or select it to test just that one.</p>
								{/if}
							</div>
							<div class="flex flex-col gap-1.5 text-xs text-muted-foreground">
								<span class="flex items-center gap-2"><svg width="28" height="6" aria-hidden="true"><line x1="1" y1="3" x2="27" y2="3" class="stroke-foreground/55" stroke-width="3.5" stroke-linecap="round" /></svg> Private network</span>
								<span class="flex items-center gap-2"><svg width="28" height="6" aria-hidden="true"><line x1="1" y1="3" x2="27" y2="3" class="stroke-foreground/55" stroke-width="1.75" stroke-linecap="round" /></svg> Public endpoint</span>
								<span class="flex items-center gap-2"><svg width="28" height="6" aria-hidden="true"><line x1="1" y1="3" x2="27" y2="3" class="stroke-foreground/55" stroke-width="1.75" stroke-dasharray="6 5" stroke-linecap="round" /></svg> Relayed through a hub</span>
								<span class="flex items-center gap-2"><svg width="28" height="6" aria-hidden="true"><line x1="1" y1="3" x2="27" y2="3" class="stroke-warning" stroke-width="1.75" stroke-linecap="round" /></svg> Losing packets</span>
								<span class="flex items-center gap-2"><svg width="28" height="6" aria-hidden="true"><line x1="1" y1="3" x2="27" y2="3" class="stroke-destructive" stroke-width="1.75" stroke-linecap="round" /></svg> Unreachable</span>
							</div>
						</div>
					</div>

					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead class="text-left text-xs uppercase tracking-wide text-muted-foreground">
								<tr class="border-b">
									<th class="px-2 py-2">Link</th>
									<th class="px-2 py-2">Path</th>
									<th class="px-2 py-2 text-right">Latency</th>
									<th class="px-2 py-2 text-right">Loss</th>
									<th class="px-2 py-2 text-right">Forward</th>
									<th class="px-2 py-2 text-right">Back</th>
									<th class="px-2 py-2">Last test</th>
								</tr>
							</thead>
							<tbody>
								{#each edges as edge (edge.key)}
									<tr class="border-b last:border-0">
										<td class="px-2 py-2 font-medium">{linkName.get(edge.a)} ↔ {linkName.get(edge.b)}</td>
										<td class="px-2 py-2 text-muted-foreground">{pathLabels[edge.path]}</td>
										<td class="px-2 py-2 text-right tabular-nums">{edge.state === 'down' ? 'unreachable' : formatRtt(edge.rttMs)}</td>
										<td class="px-2 py-2 text-right tabular-nums">{edge.lossPercent === null ? '—' : `${edge.lossPercent}%`}</td>
										<td class="px-2 py-2 text-right tabular-nums">{formatBps(edge.forwardBps)}</td>
										<td class="px-2 py-2 text-right tabular-nums">{formatBps(edge.reverseBps)}</td>
										<td class="px-2 py-2 text-muted-foreground">
											{edge.testStatus === null ? 'never' : edge.testStatus === 'failed' ? `failed: ${edge.testError ?? ''}` : edge.testStatus}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if links.nodes.some((node) => node.privateAddress && !node.capable)}
						<p class="text-xs text-muted-foreground">
							{links.nodes.filter((node) => node.privateAddress && !node.capable).map((node) => node.name).join(', ')}
							run{links.nodes.filter((node) => node.privateAddress && !node.capable).length === 1 ? 's' : ''} an agent that predates link sampling; update the node to see its links.
						</p>
					{/if}
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
{/if}
