<script lang="ts">
	import type { NodeRolloutView } from '@yoal/contracts';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import { statusTone, strategyCopy } from './rollout.js';

	/** Finished fleet updates, newest first (CLUSTERING §3.11). */
	let { rollouts }: { rollouts: NodeRolloutView[] } = $props();
</script>

<Panel title="Recent fleet updates" icon={ClockIcon} count={rollouts.length} flush>
	<ul class="divide-y">
		{#each rollouts as rollout (rollout.id)}
			<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
				<StatusBadge status={rollout.status} tone={statusTone[rollout.status]} />
				<span class="font-mono text-xs">{rollout.targetVersion}</span>
				<Badge variant="outline">{strategyCopy[rollout.options.strategy].label}</Badge>
				<Badge variant={rollout.trigger === 'auto' ? 'brand' : 'neutral'}>{rollout.trigger}</Badge>
				<span class="text-xs text-muted-foreground tabular-nums">
					{rollout.counts.done}/{rollout.nodes.length} updated{rollout.counts.failed
						? ` · ${rollout.counts.failed} failed`
						: ''}{rollout.counts.skipped ? ` · ${rollout.counts.skipped} skipped` : ''}
				</span>
				{#if rollout.error}
					<span class="min-w-0 flex-1 truncate text-xs text-destructive" title={rollout.error}>
						{rollout.error}
					</span>
				{/if}
				<time
					class="ml-auto text-xs text-muted-foreground"
					datetime={rollout.createdAt}
					title={formatDateTime(rollout.createdAt)}
				>
					{formatRelative(rollout.createdAt)}
				</time>
			</li>
		{/each}
	</ul>
</Panel>
