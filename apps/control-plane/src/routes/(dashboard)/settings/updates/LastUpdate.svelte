<script lang="ts">
	import { untrack } from 'svelte';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { SelfUpdateLog, SelfUpdateStatus } from '@yoal/contracts';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { formatDateTime, formatRelative, plural } from '../../_lib/format.js';
	import LogView from './LogView.svelte';
	import { formatElapsed, methodOption, outcomes } from './update-ui.js';

	interface Snapshot {
		dir: string;
		createdAt: string;
		pinned: boolean;
		/** The version the snapshot was taken for; null for a manual snapshot. */
		targetVersion: string | null;
		hasControlDb: boolean;
	}

	/** The last finished run, its log, and the rollback points the updater keeps on disk. */
	let {
		lastRun,
		log,
		snapshots,
		failed
	}: {
		lastRun: SelfUpdateStatus | null;
		log: SelfUpdateLog;
		snapshots: Snapshot[];
		/** Open the log straight away: it explains the failure. */
		failed: boolean;
	} = $props();

	const outcome = $derived(lastRun?.outcome ? outcomes[lastRun.outcome] : null);
	const finishedAt = $derived(lastRun ? (lastRun.finishedAt ?? lastRun.updatedAt) : null);
	const took = $derived(
		lastRun && finishedAt ? Date.parse(finishedAt) - Date.parse(lastRun.startedAt) : NaN
	);
	const moved = $derived(
		lastRun?.fromVersion && lastRun.toVersion && lastRun.fromVersion !== lastRun.toVersion
	);
	const newest = $derived(snapshots[0] ?? null);
	let logOpen = $state(untrack(() => failed));
	const rollbackCommand = 'sudo yoal-update-self rollback';
</script>

<section class="rounded-xl border bg-card text-sm shadow-xs" aria-labelledby="last-update-title">
	<div class="space-y-1.5 p-5 sm:px-6">
		<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
			<h3 id="last-update-title" class="font-medium">Last update</h3>
			{#if lastRun && outcome}
				<StatusBadge status={lastRun.outcome ?? 'done'} label={outcome.label} tone={outcome.tone} />
				{#if moved}
					<span
						class="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground tabular-nums"
					>
						v{lastRun.fromVersion}
						<ArrowRightIcon class="size-3" aria-label="to" />
						v{lastRun.toVersion}
					</span>
				{/if}
			{/if}
		</div>
		{#if lastRun && outcome}
			<p class="text-pretty">{lastRun.message}</p>
			<p class="text-xs text-muted-foreground">
				<span title={formatDateTime(finishedAt)}>{formatRelative(finishedAt)}</span>
				{#if Number.isFinite(took) && took > 0}· took {formatElapsed(took)}{/if}
				· {lastRun.trigger === 'dashboard' ? 'dashboard' : 'command line'}
				· {methodOption(lastRun.method).short}
			</p>
		{:else}
			<p class="text-muted-foreground">No update has finished on this host yet.</p>
		{/if}
	</div>

	{#if log.exists}
		<Collapsible.Root bind:open={logOpen} class="border-t">
			<Collapsible.Trigger
				class="group flex w-full items-center gap-2 px-5 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground sm:px-6"
			>
				<ChevronRightIcon class="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
				Log
				<span class="font-mono font-normal tabular-nums">{log.lines.length}</span>
			</Collapsible.Trigger>
			<Collapsible.Content class="px-5 pb-4 sm:px-6">
				<LogView {log} />
			</Collapsible.Content>
		</Collapsible.Root>
	{/if}

	<div
		class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-muted/30 px-5 py-3 text-xs text-muted-foreground sm:px-6"
	>
		<span class="text-pretty">
			{#if newest}
				{snapshots.length} rollback {plural(snapshots.length, 'point')}, newest
				<span title={formatDateTime(newest.createdAt)}>{formatRelative(newest.createdAt)}</span>
				{#if newest.targetVersion}(before <span class="font-mono">v{newest.targetVersion}</span
					>){/if}. To go back by hand:
			{:else}
				A rollback point is taken before every update. To go back by hand:
			{/if}
		</span>
		<span class="flex items-center gap-1">
			<code
				class="rounded-md border bg-background px-2 py-0.5 font-mono text-[0.7rem] text-foreground"
				>{rollbackCommand}</code
			>
			<CopyButton
				value={rollbackCommand}
				label="Copy command"
				iconOnly
				size="icon-xs"
				variant="ghost"
			/>
		</span>
	</div>
</section>
