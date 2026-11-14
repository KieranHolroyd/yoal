<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { RelocationView, ScalingView } from '@yoal/contracts';
	import ArrowRightLeftIcon from '@lucide/svelte/icons/arrow-right-left';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import MinusIcon from '@lucide/svelte/icons/minus';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { runAction } from '#lib/actions.js';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import Panel from '../../../_lib/Panel.svelte';
	import { formatDate } from '../../../_lib/format.js';

	/**
	 * Horizontal scaling for one app (docs/SCALING.md): how many copies run and where, the rollout
	 * of a new release across them, and the autoscaling policy. Changing the number of copies takes
	 * effect at once; nothing here needs a deploy.
	 */
	let {
		scaling,
		relocation = null,
		hasVolumes = false,
		canManage
	}: { scaling: ScalingView; relocation?: RelocationView | null; hasVolumes?: boolean; canManage: boolean } = $props();

	let targetNode = $state('');
	const moving = $derived(relocation?.active ?? false);
	const singleCopy = $derived(scaling.deployed && scaling.replicas === 1 && scaling.copies.length === 1);

	let wanted = $state(1);
	let enabled = $state(false);
	let min = $state(1);
	let max = $state(3);
	let metric = $state<'cpu' | 'memory' | 'requests'>('cpu');
	let target = $state(70);
	let scaleDownMinutes = $state(5);
	let busy = $state('');

	// Follow the server whenever it changes (an autoscale, another tab), not while the user edits.
	$effect(() => {
		wanted = scaling.replicas;
	});
	$effect(() => {
		enabled = scaling.policy.enabled;
		min = scaling.policy.min;
		max = scaling.policy.max;
		metric = scaling.policy.metric;
		target = scaling.policy.target;
		scaleDownMinutes = scaling.policy.scaleDownMinutes;
	});

	const ceiling = $derived(Math.min(scaling.limit, Math.max(scaling.capacity, scaling.replicas)));
	const floor = $derived(scaling.policy.enabled ? scaling.policy.min : 1);
	const top = $derived(scaling.policy.enabled ? Math.min(ceiling, scaling.policy.max) : ceiling);
	const unsettled = $derived(
		moving || scaling.rollout?.status === 'rolling' || scaling.copies.some((copy) => copy.status === 'pending' || copy.status === 'starting')
	);

	const MODE: Record<ScalingView['mode'], string> = {
		spread: 'Each copy runs on its own node, and requests are balanced across the copies that are up.',
		stack: 'Copies spread across the nodes first, then share them, so there can be more copies than nodes.',
		node: 'Every copy runs on this app’s one node.',
		single: 'This app runs one copy.'
	};

	const percent = (value: number, of: number) => Math.max(0, Math.min(100, of > 0 ? (value / of) * 100 : 0));
	const mb = (bytes: number) => Math.round(bytes / 1048576);
	const unit = $derived(metric === 'requests' ? 'requests/s per copy' : '% of each copy’s limit');

	async function act(name: string, action: string, fields: Record<string, string> = {}) {
		busy = name;
		try {
			const result = await runAction(action, fields);
			if (result.type === 'success') await invalidateAll();
		} finally {
			busy = '';
		}
	}

	function pickMetric(next: string) {
		const value = next as typeof metric;
		// A percentage and a request rate are different numbers: do not carry one into the other.
		if ((value === 'requests') !== (metric === 'requests')) target = value === 'requests' ? 50 : 70;
		metric = value;
	}

	// Copies starting, or a rollout moving: keep the page current without a manual refresh.
	onMount(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible' && (unsettled || scaling.policy.enabled)) void invalidateAll();
		}, 5_000);
		return () => clearInterval(timer);
	});
</script>

<div class="flex flex-col gap-5">
	{#if scaling.rollout}
		<Notice
			tone={scaling.rollout.status === 'paused' ? 'warning' : 'info'}
			title={scaling.rollout.status === 'paused'
				? `Rollout paused at ${scaling.rollout.updated} of ${scaling.rollout.total} copies`
				: `Rolling out: ${scaling.rollout.updated} of ${scaling.rollout.total} copies on the new release`}
		>
			<div class="flex flex-col gap-3">
				<div class="h-2 w-full max-w-md rounded-full bg-muted" aria-hidden="true">
					<div
						class="h-full rounded-full {scaling.rollout.status === 'paused' ? 'bg-warning' : 'bg-info'}"
						style="width: {percent(scaling.rollout.updated, scaling.rollout.total)}%"
					></div>
				</div>
				{#if scaling.rollout.status === 'paused'}
					<p>{scaling.rollout.message}</p>
					{#if canManage}
						<div>
							<Button size="sm" variant="outline" disabled={busy !== ''} onclick={() => act('resume', '?/resumeRollout')}>
								Retry the rollout
							</Button>
						</div>
					{/if}
				{:else if scaling.rollout.automatic}
					<p>A release failed and the previous one is being put back. The app keeps serving meanwhile.</p>
				{:else if scaling.rollout.surge}
					<p>
						A temporary second copy is starting on another node. Once it is healthy it takes the traffic while this app’s own copy
						restarts on the new release, and then it is removed.
					</p>
				{:else}
					<p>Copies update one at a time; each must be healthy before the next is touched, so the app keeps serving.</p>
				{/if}
			</div>
		</Notice>
	{:else if scaling.lastRollback}
		<Notice tone="warning" title="A release was rolled back automatically">
			<p>{scaling.lastRollback.note}</p>
			<p class="text-xs text-muted-foreground">{formatDate(scaling.lastRollback.at)} · The failed deployment is still in Deployments, with its logs.</p>
		</Notice>
	{/if}

	<Panel title="Copies" icon={LayersIcon} description={MODE[scaling.mode]}>
		<div class="flex flex-col gap-5 p-5">
			{#if scaling.blocker}
				<Notice tone="info" title="This app cannot run on more than one node">
					It stays on one node because {scaling.blocker}.
				</Notice>
			{/if}

			<div class="flex flex-wrap items-end justify-between gap-4">
				<div>
					<div class="text-4xl font-semibold tabular-nums">{scaling.replicas}</div>
					<div class="text-sm text-muted-foreground">
						{scaling.replicas === 1 ? 'copy' : 'copies'} running{scaling.mode !== 'single'
							? ` · this fleet has room for ${scaling.capacity}`
							: ''}
					</div>
				</div>
				{#if canManage && scaling.mode !== 'single'}
					<div class="flex items-center gap-2">
						<Button
							variant="outline"
							size="icon"
							aria-label="One copy fewer"
							disabled={busy !== '' || wanted <= floor}
							onclick={() => (wanted = Math.max(floor, wanted - 1))}
						>
							<MinusIcon class="size-4" />
						</Button>
						<Input
							type="number"
							min={floor}
							max={top}
							bind:value={wanted}
							class="w-20 text-center tabular-nums"
							aria-label="Copies"
						/>
						<Button
							variant="outline"
							size="icon"
							aria-label="One copy more"
							disabled={busy !== '' || wanted >= top}
							onclick={() => (wanted = Math.min(top, wanted + 1))}
						>
							<PlusIcon class="size-4" />
						</Button>
						<Button
							disabled={busy !== '' || wanted === scaling.replicas || !Number.isInteger(wanted) || wanted < 1}
							onclick={() => act('scale', '?/scale', { replicas: String(wanted) })}
						>
							{busy === 'scale' ? 'Scaling…' : wanted === scaling.replicas ? 'Scale' : `Scale to ${wanted}`}
						</Button>
					</div>
				{/if}
			</div>
			{#if canManage && scaling.mode !== 'single'}
				<p class="-mt-2 text-xs text-muted-foreground">
					Takes effect at once, with no deploy. Copies that are running are not restarted.
					{#if scaling.policy.enabled}Autoscaling keeps the number between {scaling.policy.min} and {scaling.policy.max}.{/if}
					{#if scaling.mode === 'spread' && scaling.capacity <= scaling.replicas}
						Every node with room already holds a copy; add a node to run more.
					{/if}
				</p>
			{/if}

			{#if scaling.copies.length > 0}
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead class="text-left text-xs uppercase tracking-wide text-muted-foreground">
							<tr class="border-b">
								<th class="px-2 py-2">Copy</th>
								<th class="px-2 py-2">Node</th>
								<th class="px-2 py-2">Status</th>
								<th class="px-2 py-2">Memory</th>
								<th class="px-2 py-2">CPU</th>
							</tr>
						</thead>
						<tbody>
							{#each scaling.copies as copy (copy.id)}
								<tr class="border-b last:border-0">
									<td class="px-2 py-3 font-mono text-xs">r{copy.index}</td>
									<td class="px-2 py-3">
										<div class="font-medium">{copy.nodeName}</div>
										<div class="text-xs text-muted-foreground">{copy.zone}</div>
									</td>
									<td class="px-2 py-3">
										<div class="flex flex-wrap items-center gap-1.5">
											<StatusBadge status={copy.status} />
											{#if copy.release === 'previous'}<Badge variant="outline">previous release</Badge>{/if}
										</div>
									</td>
									<td class="px-2 py-3">
										{#if copy.memoryBytes !== null}
											<div class="flex items-center gap-2">
												<div class="h-2 w-24 rounded-full bg-muted" aria-hidden="true">
													<div class="h-full rounded-full bg-info" style="width: {percent(mb(copy.memoryBytes), scaling.memoryMb)}%"></div>
												</div>
												<span class="tabular-nums text-xs text-muted-foreground">{mb(copy.memoryBytes)} / {scaling.memoryMb} MB</span>
											</div>
										{:else}
											<span class="text-xs text-muted-foreground">—</span>
										{/if}
									</td>
									<td class="px-2 py-3">
										{#if copy.cpuMillis !== null}
											<div class="flex items-center gap-2">
												<div class="h-2 w-24 rounded-full bg-muted" aria-hidden="true">
													<div class="h-full rounded-full bg-info" style="width: {percent(copy.cpuMillis, scaling.cpuMillis)}%"></div>
												</div>
												<span class="tabular-nums text-xs text-muted-foreground">{Math.round(percent(copy.cpuMillis, scaling.cpuMillis))}%</span>
											</div>
										{:else}
											<span class="text-xs text-muted-foreground">—</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else if !scaling.deployed}
				<p class="text-sm text-muted-foreground">Not deployed yet. The next deploy starts this many copies.</p>
			{/if}

			{#if scaling.sizing.advice === 'raise'}
				<Notice tone="warning" title="Close to its memory limit">
					A copy reached {scaling.sizing.memoryPeakMb} MB of its {scaling.memoryMb} MB. At the limit it is killed and restarted. Consider
					{scaling.sizing.suggestedMemoryMb} MB on the Runtime tab.
				</Notice>
			{:else if scaling.sizing.advice === 'lower'}
				<Notice tone="info" title="Reserves more memory than it uses">
					The busiest copy reached {scaling.sizing.memoryPeakMb} MB over the last day, against {scaling.memoryMb} MB reserved for each copy.
					{scaling.sizing.suggestedMemoryMb} MB would leave a quarter of headroom and free
					{(scaling.memoryMb - (scaling.sizing.suggestedMemoryMb ?? scaling.memoryMb)) * scaling.replicas} MB for other apps. Change it on the Runtime tab.
				</Notice>
			{:else if scaling.sizing.memoryPeakMb !== null}
				<p class="text-xs text-muted-foreground">
					Busiest copy: {scaling.sizing.memoryPeakMb} MB of {scaling.memoryMb} MB{scaling.sizing.cpuPeakMillis !== null
						? `, ${Math.round(percent(scaling.sizing.cpuPeakMillis, scaling.cpuMillis))}% CPU`
						: ''}{scaling.sizing.settled ? ' over the last day.' : ' so far today.'}
				</p>
			{/if}
		</div>
	</Panel>

	{#if scaling.mode !== 'single'}
		<Panel
			title="Autoscaling"
			icon={GaugeIcon}
			description="Let Yoal add copies when the app is busy and remove them when it is quiet."
		>
			<div class="flex flex-col gap-5 p-5">
				{#if canManage}
					<label class="flex items-center gap-3 text-sm font-medium">
						<Switch bind:checked={enabled} />
						{enabled ? 'On' : 'Off'}
					</label>
					<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
						<Field.Field>
							<Field.Label for="scale-min">At least</Field.Label>
							<Input id="scale-min" type="number" min={1} max={scaling.limit} bind:value={min} disabled={!enabled} />
							<Field.Description>Copies kept even when idle. Two or more survive a node going down.</Field.Description>
						</Field.Field>
						<Field.Field>
							<Field.Label for="scale-max">At most</Field.Label>
							<Input id="scale-max" type="number" min={1} max={scaling.limit} bind:value={max} disabled={!enabled} />
							<Field.Description>
								{scaling.mode === 'spread' ? `One per node: this fleet has room for ${scaling.capacity}.` : `Room for ${scaling.capacity} right now.`}
							</Field.Description>
						</Field.Field>
						<Field.Field>
							<Field.Label for="scale-metric">Watch</Field.Label>
							<NativeSelect.Root id="scale-metric" value={metric} onchange={(event) => pickMetric(event.currentTarget.value)} disabled={!enabled} class="w-full">
								<NativeSelect.Option value="cpu">CPU</NativeSelect.Option>
								<NativeSelect.Option value="memory">Memory</NativeSelect.Option>
								<NativeSelect.Option value="requests">Request rate</NativeSelect.Option>
							</NativeSelect.Root>
							<Field.Description>
								{metric === 'requests' ? 'Needs telemetry (Settings → Telemetry).' : 'Averaged over the copies that are up.'}
							</Field.Description>
						</Field.Field>
						<Field.Field>
							<Field.Label for="scale-target">Keep it near</Field.Label>
							<Input id="scale-target" type="number" min={1} bind:value={target} disabled={!enabled} />
							<Field.Description>{unit}</Field.Description>
						</Field.Field>
					</div>
					<div class="flex flex-wrap items-end justify-between gap-4">
						<Field.Field class="max-w-xs">
							<Field.Label for="scale-down">Remove a copy after</Field.Label>
							<Input id="scale-down" type="number" min={1} max={120} bind:value={scaleDownMinutes} disabled={!enabled} />
							<Field.Description>Minutes the load must stay low. Adding copies never waits.</Field.Description>
						</Field.Field>
						<Button
							disabled={busy !== ''}
							onclick={() =>
								act('autoscale', '?/saveAutoscale', {
									enabled: String(enabled),
									min: String(min),
									max: String(max),
									metric,
									target: String(target),
									scaleDownMinutes: String(scaleDownMinutes)
								})}
						>
							{busy === 'autoscale' ? 'Saving…' : 'Save autoscaling'}
						</Button>
					</div>
				{:else}
					<p class="text-sm">
						{scaling.policy.enabled
							? `On: ${scaling.policy.min} to ${scaling.policy.max} copies.`
							: 'Off.'}
					</p>
				{/if}
				{#if scaling.policy.enabled}
					<div class="rounded-lg border p-3 text-sm">
						<div class="font-medium">Last check</div>
						<p class="text-muted-foreground">
							{scaling.autoscale.reason ?? 'Not checked yet; the first check runs within a minute.'}
							{#if scaling.autoscale.evaluatedAt}<span class="whitespace-nowrap"> · {formatDate(scaling.autoscale.evaluatedAt)}</span>{/if}
						</p>
					</div>
				{/if}
			</div>
		</Panel>
	{/if}

	{#if singleCopy || relocation}
		<Panel
			title="Node"
			icon={ArrowRightLeftIcon}
			description="Where this app runs. Yoal picks a node with room unless you name one."
		>
			<div class="flex flex-col gap-4 p-5">
				{#if relocation && (relocation.active || relocation.phase === 'failed')}
					<Notice
						tone={relocation.phase === 'failed' ? 'warning' : 'info'}
						title={relocation.active
							? `Moving from ${relocation.from.name} to ${relocation.to.name}`
							: `The move to ${relocation.to.name} failed`}
					>
						<div class="flex flex-col gap-2">
							<p>{relocation.error ?? relocation.detail}</p>
							{#if relocation.active}
								<ul class="text-sm">
									{#each relocation.volumes as volume (volume.name)}
										<li><span class="font-mono text-xs">{volume.name}</span> · {volume.sizeMb} MB · {volume.state}</li>
									{/each}
								</ul>
								<p class="text-xs text-muted-foreground">
									The app is stopped while its data is copied. Nothing changes on {relocation.from.name} until the copy is complete and checked.
								</p>
								{#if canManage}
									<div>
										<Button size="sm" variant="outline" disabled={busy !== ''} onclick={() => act('cancel', '?/cancelMove')}>
											Cancel and start it again on {relocation.from.name}
										</Button>
									</div>
								{/if}
							{/if}
						</div>
					</Notice>
				{/if}
				{#if singleCopy && !moving}
					<div class="flex flex-wrap items-end justify-between gap-4">
						<div class="text-sm">
							Runs on <span class="font-medium">{scaling.copies[0]?.nodeName}</span>
							<span class="text-muted-foreground">({scaling.copies[0]?.zone})</span>.
							<p class="text-muted-foreground">
								{#if hasVolumes}
									Its app volumes live on that node, so moving it copies them across: the app is stopped for the copy, and the old volumes are kept in the trash afterwards.
								{:else if scaling.blocker}
									It stays there because {scaling.blocker}.
								{:else}
									Moving it starts a new copy first and switches over once that copy is healthy, so there is no downtime.
								{/if}
							</p>
						</div>
						{#if canManage && (hasVolumes || !scaling.blocker)}
							<div class="flex items-end gap-2">
								<Field.Field>
									<Field.Label for="move-node">Move to</Field.Label>
									<Input id="move-node" bind:value={targetNode} placeholder="any node with room" class="w-48" />
								</Field.Field>
								<Button
									variant="outline"
									disabled={busy !== ''}
									onclick={() => act('move', '?/moveNode', { node: targetNode.trim(), withData: String(hasVolumes) })}
								>
									{busy === 'move' ? 'Moving…' : hasVolumes ? 'Move with its data' : 'Move'}
								</Button>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</Panel>
	{/if}

	{#if scaling.events.length > 0}
		<Panel title="History" icon={HistoryIcon} flush>
			<ul class="divide-y text-sm">
				{#each scaling.events as event (event.id)}
					<li class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3">
						<span class="font-medium tabular-nums">{event.from} → {event.to}</span>
						<Badge variant="secondary">{event.reason === 'autoscale' ? 'autoscaling' : event.reason}</Badge>
						{#if event.detail}<span class="text-muted-foreground">{event.detail}</span>{/if}
						<span class="ml-auto text-xs text-muted-foreground">{formatDate(event.at)}</span>
					</li>
				{/each}
			</ul>
		</Panel>
	{/if}
</div>
