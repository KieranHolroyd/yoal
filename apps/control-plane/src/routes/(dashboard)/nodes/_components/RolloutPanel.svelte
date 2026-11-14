<script lang="ts">
	import type { NodeRolloutView } from '@yoal/contracts';
	import BanIcon from '@lucide/svelte/icons/ban';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import RefreshCcwIcon from '@lucide/svelte/icons/refresh-ccw';
	import ShieldOffIcon from '@lucide/svelte/icons/shield-off';
	import SkipForwardIcon from '@lucide/svelte/icons/skip-forward';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { formatRelative } from '../../_lib/format.js';
	import {
		busyStates,
		nodeStateTone,
		phaseLabel,
		settledCount,
		statusTone,
		strategyCopy,
		wavesOf
	} from './rollout.js';

	/** The running or paused fleet update (CLUSTERING §3.11), with its waves and node states. */
	let { rollout, canUpdate }: { rollout: NodeRolloutView; canUpdate: boolean } = $props();

	const waves = $derived(wavesOf(rollout));
	const settled = $derived(settledCount(rollout));
	const percent = $derived(rollout.nodes.length ? (settled / rollout.nodes.length) * 100 : 0);
	const paused = $derived(rollout.status === 'paused');
	const unguarded = $derived(rollout.nodes.filter((node) => !node.guarded).length);
	let busy = $state('');

	async function resume(retryFailed: boolean) {
		busy = retryFailed ? 'retry' : 'skip';
		try {
			await runAction('?/resumeRollout', {
				rolloutId: rollout.id,
				retryFailed: String(retryFailed)
			});
		} finally {
			busy = '';
		}
	}

	function cancel() {
		askConfirm({
			title: `Cancel the fleet update to ${rollout.targetVersion}?`,
			description:
				'No further waves start and the rollout lifts any cordons it set. A node that is already installing finishes on its own, so the fleet may end up on mixed versions until you update the rest.',
			confirmLabel: 'Cancel rollout',
			tone: 'danger',
			action: '?/cancelRollout',
			fields: { rolloutId: rollout.id }
		});
	}

	function waveState(index: number): 'done' | 'current' | 'next' {
		if (index < rollout.currentWave) return 'done';
		return index === rollout.currentWave ? 'current' : 'next';
	}
</script>

<Card.Root class="gap-4 border-info/40" aria-live="polite">
	<Card.Header>
		<Card.Title class="flex flex-wrap items-center gap-2">
			{#if !paused}<LoaderCircleIcon class="size-4 animate-spin text-info" />{/if}
			Fleet update to <span class="font-mono">{rollout.targetVersion}</span>
			<StatusBadge status={rollout.status} tone={statusTone[rollout.status]} />
			{#if rollout.phase && rollout.phase !== 'paused'}
				<Badge variant="outline">{phaseLabel[rollout.phase]}</Badge>
			{/if}
		</Card.Title>
		<Card.Description class="space-y-1">
			<span class="block">
				{strategyCopy[rollout.options.strategy].label}{rollout.options.strategy === 'rolling'
					? ` · ${rollout.options.batchSize} at a time`
					: ''}
				· {rollout.options.canary ? 'canary first' : 'no canary'}
				· {rollout.options.drain ? 'drain each wave' : 'no drain'}
				· soak {rollout.options.soakSeconds}s · {rollout.options.maxFailures === 0
					? 'pause on the first failure'
					: `pause after ${rollout.options.maxFailures} failures`}
				· {rollout.trigger === 'auto' ? 'started automatically' : 'started'}
				{formatRelative(rollout.createdAt)}
			</span>
			{#if rollout.detail}<span class="block text-foreground">{rollout.detail}</span>{/if}
			{#if rollout.error}<span class="block text-destructive">{rollout.error}</span>{/if}
		</Card.Description>
		{#if canUpdate}
			<Card.Action class="flex flex-wrap justify-end gap-2">
				{#if paused}
					<Button size="sm" disabled={busy !== ''} onclick={() => resume(true)}>
						<RefreshCcwIcon />{busy === 'retry' ? 'Resuming…' : 'Retry failed and continue'}
					</Button>
					<Button size="sm" variant="outline" disabled={busy !== ''} onclick={() => resume(false)}>
						<SkipForwardIcon />{busy === 'skip' ? 'Resuming…' : 'Skip failed and continue'}
					</Button>
				{/if}
				<Button size="sm" variant="ghost" class="text-destructive" onclick={cancel}>
					<BanIcon />Cancel rollout
				</Button>
			</Card.Action>
		{/if}
	</Card.Header>
	<Card.Content class="space-y-4">
		<div class="space-y-1.5">
			<div
				class="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground"
			>
				<span>
					Wave <span class="font-mono text-foreground"
						>{Math.min(rollout.currentWave + 1, rollout.waves)}</span
					>
					of <span class="font-mono text-foreground">{rollout.waves}</span>
				</span>
				<span class="font-mono tabular-nums">
					{rollout.counts.done} done · {rollout.counts.failed} failed{rollout.counts.skipped
						? ` · ${rollout.counts.skipped} skipped`
						: ''} · {rollout.nodes.length} nodes
				</span>
			</div>
			<Progress value={percent} aria-label="Nodes finished in this rollout" class="h-1.5" />
		</div>

		<ol class="space-y-2">
			{#each waves as wave (wave.index)}
				{@const state = waveState(wave.index)}
				<li
					class="flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-md border px-3 py-2 {state ===
					'current'
						? 'border-info/50 bg-info/5'
						: state === 'done'
							? 'opacity-80'
							: ''}"
				>
					<span class="flex w-20 shrink-0 items-center gap-1.5 pt-0.5 text-xs font-medium">
						<LayersIcon class="size-3.5 text-muted-foreground" />
						Wave {wave.index + 1}
					</span>
					<div class="flex min-w-0 flex-1 flex-wrap gap-1.5">
						{#each wave.nodes as node (node.nodeId)}
							<span
								class="inline-flex max-w-full flex-col gap-0.5 rounded-md border bg-background px-2 py-1 text-xs"
								title={node.error ?? undefined}
							>
								<span class="flex items-center gap-1.5">
									{#if busyStates.has(node.state)}
										<LoaderCircleIcon class="size-3 animate-spin text-info" />
									{/if}
									<span class="font-medium">{node.name}</span>
									<StatusBadge status={node.state} tone={nodeStateTone[node.state]} />
									{#if !node.guarded}
										<span
											class="inline-flex items-center text-warning"
											title="No rollback guard: this agent predates node-update-guard, so a broken release is not rolled back on its own."
										>
											<ShieldOffIcon class="size-3" />
											<span class="sr-only">No rollback guard</span>
										</span>
									{/if}
									{#if node.attempts > 1}
										<span class="text-muted-foreground">try {node.attempts}</span>
									{/if}
								</span>
								<span class="font-mono text-[11px] text-muted-foreground">
									{node.version ?? node.fromVersion ?? 'unknown'}
								</span>
								{#if node.state === 'failed' && node.error}
									<span class="max-w-72 text-[11px] break-words text-destructive">{node.error}</span
									>
								{/if}
							</span>
						{/each}
					</div>
				</li>
			{/each}
		</ol>

		{#if unguarded > 0}
			<p class="flex items-start gap-1.5 text-xs text-muted-foreground">
				<ShieldOffIcon class="mt-px size-3.5 shrink-0 text-warning" />
				{unguarded} node{unguarded === 1 ? ' has' : 's have'} no rollback guard yet: an agent from before
				node-update-guard cannot restore its previous version if the new one never reports in. Watch them,
				or fix them by hand from <code class="font-mono">journalctl -u yoal-agent</code>.
			</p>
		{/if}
	</Card.Content>
</Card.Root>
