<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { HaCheck, HaProfile } from '@yoal/contracts';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import {
		checkRowKey,
		checkStatusLabel,
		checkStatusTone,
		fixKindLabel,
		groupChecks
	} from './_lib/ha-setup.js';

	/**
	 * Every preflight check with its status, what was seen and the exact fix (the same list as `yoal
	 * ha preflight`): the platform-level entries and the per-node (zone, database, ingress) ones.
	 * `blockers` are the plan's, so an entry the server excuses is not shown as blocking.
	 */
	let {
		profile,
		checks,
		blockers
	}: { profile: HaProfile; checks: readonly HaCheck[]; blockers?: readonly string[] } = $props();

	const groups = $derived(groupChecks(profile, checks, blockers));
	const icons = {
		pass: CircleCheckIcon,
		warn: TriangleAlertIcon,
		fail: CircleXIcon,
		skip: CircleDashedIcon
	};
	const iconClass = {
		pass: 'text-success',
		warn: 'text-warning',
		fail: 'text-destructive',
		skip: 'text-muted-foreground'
	};
</script>

<div class="space-y-4">
	{#each groups as group (group.area)}
		<section>
			<h4 class="mb-1.5 text-xs font-medium text-muted-foreground">{group.label}</h4>
			<ul class="divide-y rounded-md border">
				{#each group.rows as row, index (checkRowKey(row, index))}
					{@const Icon = icons[row.check.status]}
					<li
						class="flex items-start gap-2.5 px-3 py-2"
						data-check={row.check.id}
						data-status={row.check.status}
						data-subject={row.check.subject?.kind ?? 'platform'}
					>
						<Icon class="mt-0.5 size-4 shrink-0 {iconClass[row.check.status]}" aria-hidden="true" />
						<div class="min-w-0 flex-1">
							<p class="flex flex-wrap items-center gap-1.5 text-sm font-medium">
								{row.check.title}
								{#if row.check.subject}<span
										class="font-mono text-xs font-normal text-muted-foreground"
										>{row.check.subject.name}</span
									>{/if}
								<Badge variant={checkStatusTone[row.check.status]}
									>{checkStatusLabel[row.check.status]}</Badge
								>
								{#if row.blocks}
									<Badge variant="outline">Blocks apply</Badge>
								{:else if row.clearedByApply}
									<Badge variant="outline">Cleared by this change</Badge>
								{:else if !row.required && row.check.status === 'fail'}
									<Badge variant="outline">Not required for this profile</Badge>
								{/if}
							</p>
							{#if row.check.status !== 'pass'}
								{#each row.check.evidence as line, lineIndex (lineIndex)}
									<p class="text-xs text-muted-foreground">{line}</p>
								{/each}
							{:else if row.check.evidence[0]}
								<p class="text-xs text-muted-foreground">{row.check.evidence[0]}</p>
							{/if}
							{#if row.check.fix}
								<div class="mt-1.5 text-xs">
									<span class="font-medium">{fixKindLabel[row.check.fix.kind]}:</span>
									{#if row.check.fix.kind === 'command' || row.check.fix.kind === 'env'}
										<code
											class="mt-1 block rounded bg-muted px-2 py-1 font-mono break-all select-all"
											>{row.check.fix.value}</code
										>
									{:else}
										<span>{row.check.fix.value}</span>
									{/if}
								</div>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>
