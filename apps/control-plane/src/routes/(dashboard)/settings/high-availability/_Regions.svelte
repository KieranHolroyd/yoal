<script lang="ts">
	import type { RegionPromotionView, RegionsView } from '@yoal/contracts';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import * as Table from '#lib/components/ui/table/index.js';
	import type { Tone } from '#lib/status.js';
	import { formatDateTime } from '../../_lib/format.js';

	/**
	 * Regions (HA-PLAN H26, W13), read-only: the detail under the Regions status card. Zones that
	 * name two regions, the open or last region promotion with each step's fence, and the notes.
	 * Promoting a region is `yoal ha region promote` on the control plane in that region; nothing
	 * here changes anything.
	 */
	let {
		view,
		promotion,
		running
	}: { view: RegionsView; promotion: RegionPromotionView | null; running: boolean } = $props();

	const stageTone: Record<RegionPromotionView['stage'], Tone> = {
		'control-plane': 'info',
		databases: 'info',
		steering: 'info',
		completed: 'success',
		failed: 'danger',
		cancelled: 'neutral'
	};
	const stepTone: Record<RegionPromotionView['steps'][number]['status'], Tone> = {
		pending: 'neutral',
		running: 'info',
		done: 'success',
		skipped: 'warning',
		failed: 'danger'
	};
</script>

<div class="mt-3 divide-y rounded-lg border" data-section="region-detail">
	{#each view.conflicts as conflict (conflict.zone)}
		<p class="px-4 py-2 text-sm text-destructive">
			Zone {conflict.zone} names regions {conflict.regions.join(', ')} (nodes {conflict.nodes.join(
				', '
			)}). A zone belongs to exactly one region.
		</p>
	{/each}

	{#if promotion}
		<div class="space-y-2 px-4 py-3">
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<span class="font-medium">{running ? 'Region promotion in progress' : 'Last region promotion'}:</span>
				<span>{promotion.fromRegion} → {promotion.toRegion}</span>
				<StatusBadge status={promotion.stage} tone={stageTone[promotion.stage]} />
				<span class="text-muted-foreground"
					>by {promotion.confirmedBy}, {formatDateTime(promotion.confirmedAt)}</span
				>
			</div>
			{#if promotion.error}<p class="text-sm text-destructive">{promotion.error}</p>{/if}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Step</Table.Head>
						<Table.Head>Resource</Table.Head>
						<Table.Head>Fence</Table.Head>
						<Table.Head>Lag</Table.Head>
						<Table.Head>Status</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each promotion.steps as step (step.position)}
						<Table.Row>
							<Table.Cell>{step.kind}</Table.Cell>
							<Table.Cell class="text-xs">
								{step.name}
								{#if step.message}<span class="block text-muted-foreground">{step.message}</span>{/if}
							</Table.Cell>
							<Table.Cell class="font-mono text-xs tabular-nums">
								{step.fencedGeneration === null
									? `at ${step.expectedGeneration}`
									: `${step.expectedGeneration} → ${step.fencedGeneration}`}
							</Table.Cell>
							<Table.Cell class="tabular-nums"
								>{step.lagSeconds === null ? '–' : `${step.lagSeconds} s`}</Table.Cell
							>
							<Table.Cell><StatusBadge status={step.status} tone={stepTone[step.status]} /></Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}

	{#each view.notes as note (note)}
		<p class="px-4 py-2 text-xs text-muted-foreground">{note}</p>
	{/each}
</div>
