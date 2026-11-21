<script lang="ts">
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import {
		HA_DRILL_CATALOGUE,
		featureEnvKey,
		type FeatureName,
		type HaDrillRunStatus,
		type HaDrillRunView,
		type HaDrillScenario,
		type HaDrillScenarioId
	} from '@yoal/contracts';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { errorText } from '#lib/query.js';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import type { Tone } from '#lib/status.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatRelative } from '../../_lib/format.js';
	import { NotAvailableError, haKeys, listDrillRuns, runDrill } from './_lib/ha-api.js';
	import {
		drillConfirmValue,
		drillGate,
		formatMs,
		formatRpo,
		withoutPlanRefs
	} from './_lib/ha-setup.js';

	/**
	 * The drill catalogue (`yoal ha drill <scenario> <resource>`): every scenario, where it can run,
	 * and a form to run one on a named resource. A destructive scenario needs the resource's name
	 * typed back. Results show the measured RTO and RPO against the scenario's bound.
	 */
	let { flags, canRun }: { flags: Partial<Record<FeatureName, boolean>>; canRun: boolean } =
		$props();

	const queryClient = useQueryClient();
	const runs = createQuery(() => ({
		queryKey: haKeys.drillRuns,
		queryFn: ({ signal }) => listDrillRuns(signal),
		refetchInterval: (query) =>
			query.state.data?.some((run) => run.status === 'running') ? 3_000 : 30_000,
		retry: (count: number, error: Error) => !(error instanceof NotAvailableError) && count < 1
	}));

	let selected = $state<HaDrillScenarioId | null>(null);
	let resource = $state('');
	let typed = $state('');
	let confirmed = $state(false);
	let drillDatabase = $state('');
	let minutes = $state('5');
	let running = $state(false);
	let message = $state<{ tone: 'success' | 'error'; text: string } | null>(null);

	const scenario = $derived(HA_DRILL_CATALOGUE.find((entry) => entry.id === selected) ?? null);
	const gate = $derived(
		scenario
			? drillGate(scenario, { resource, typed, confirmed, flags, canRun, drillDatabase })
			: null
	);
	const bounded = $derived(selected === 'node-offline' || selected === 'ingress-offline');

	function pick(entry: HaDrillScenario) {
		selected = entry.id;
		resource = '';
		typed = '';
		confirmed = false;
		drillDatabase = '';
		message = null;
	}

	async function run() {
		if (!scenario || !gate?.enabled) return;
		running = true;
		message = null;
		try {
			const result = await runDrill({
				scenario: scenario.id,
				resource: resource.trim(),
				confirm: drillConfirmValue(scenario, typed, confirmed),
				...(bounded ? { durationSeconds: Number(minutes) * 60 } : {}),
				...(scenario.id === 'database-failover' ? { drillDatabase: drillDatabase.trim() } : {})
			});
			message = {
				tone: 'success',
				text: `The ${result.scenario} drill on ${result.resource.name} is ${result.status}. Its result appears below.`
			};
			typed = '';
			confirmed = false;
			await queryClient.invalidateQueries({ queryKey: haKeys.drillRuns });
		} catch (error) {
			message = {
				tone: 'error',
				text:
					error instanceof NotAvailableError
						? 'Running drills from here is not available on this control plane yet.'
						: errorText(error, 'Could not start the drill.')
			};
		} finally {
			running = false;
		}
	}

	const statusTone: Record<HaDrillRunStatus, Tone> = {
		running: 'warning',
		passed: 'success',
		failed: 'danger',
		cancelled: 'neutral',
		skipped: 'neutral'
	};
	const confirmationLabel = { none: 'No confirmation', confirm: 'Confirm', typed: 'Type the name' };

	function bound(run: Pick<HaDrillRunView, 'bound'>): string {
		const parts: string[] = [];
		if (run.bound.rtoSeconds !== null) parts.push(`RTO ≤ ${run.bound.rtoSeconds} s`);
		if (run.bound.rpo === 'zero') parts.push('RPO 0');
		if (run.bound.rpo === 'lag') parts.push('RPO = lag');
		return parts.join(', ') || '—';
	}
</script>

<Panel
	id="drills"
	title="Drills"
	icon={FlaskConicalIcon}
	description="Inject one fault on a named resource, measure how long recovery took and what was lost, and restore. Scenarios that need a fault a release build does not have run in the lab only."
>
	<div class="overflow-x-auto rounded-md border">
		<Table.Root>
			<Table.Header class="bg-muted/45">
				<Table.Row>
					<Table.Head class="pl-4">Scenario</Table.Head>
					<Table.Head>Runs on</Table.Head>
					<Table.Head>Measures</Table.Head>
					<Table.Head>Bound</Table.Head>
					<Table.Head class="pr-4 text-right">Where</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each HA_DRILL_CATALOGUE as entry (entry.id)}
					{@const missing = entry.flags.filter((name) => !flags[name])}
					<Table.Row class={selected === entry.id ? 'bg-primary/5' : ''}>
						<Table.Cell class="max-w-md pl-4 whitespace-normal">
							<p class="flex flex-wrap items-center gap-1.5 text-sm font-medium">
								<span class="font-mono text-xs">{entry.id}</span>
								{#if entry.destructive}<Badge variant="danger">destructive</Badge>{/if}
							</p>
							<p class="text-xs text-muted-foreground">{entry.title}</p>
							{#if entry.availability === 'fleet' && missing.length > 0}
								<p class="text-xs text-muted-foreground">
									Needs {missing.map((name) => featureEnvKey(name)).join(', ')}.
								</p>
							{/if}
						</Table.Cell>
						<Table.Cell class="text-xs">{entry.resourceKind}</Table.Cell>
						<Table.Cell class="text-xs">{entry.measures.join(', ')}</Table.Cell>
						<Table.Cell class="text-xs whitespace-nowrap">{bound(entry)}</Table.Cell>
						<Table.Cell class="pr-4 text-right">
							{#if entry.availability === 'lab'}
								<Badge
									variant="neutral"
									title={entry.fleetUnavailableReason
										? withoutPlanRefs(entry.fleetUnavailableReason)
										: undefined}>Lab only</Badge
								>
							{:else if canRun}
								<Button
									size="sm"
									variant={selected === entry.id ? 'default' : 'outline'}
									class="h-7"
									onclick={() => pick(entry)}>Run…</Button
								>
							{:else}
								<Badge variant="outline">Fleet</Badge>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>

	{#if !canRun}
		<p class="mt-3 text-xs text-muted-foreground">Running a drill needs a platform admin.</p>
	{/if}

	{#if scenario && canRun}
		<form
			class="mt-4 space-y-3 rounded-md border p-3"
			class:border-destructive={scenario.destructive}
			onsubmit={(event) => {
				event.preventDefault();
				void run();
			}}
			data-testid="drill-form"
		>
			<div>
				<p class="text-sm font-medium">Run <span class="font-mono">{scenario.id}</span></p>
				<p class="text-xs text-muted-foreground">
					{scenario.title}. {confirmationLabel[scenario.confirmation]}.
				</p>
			</div>
			<div class="flex flex-wrap items-end gap-3">
				<label class="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
					The {scenario.resourceKind} to drill (name or id)
					<input
						bind:value={resource}
						required
						maxlength="128"
						class="h-9 rounded-md border bg-background px-2 font-mono text-sm text-foreground"
						autocomplete="off"
					/>
				</label>
				{#if bounded}
					<label class="flex w-32 flex-col gap-1 text-xs text-muted-foreground">
						Offline for
						<select
							bind:value={minutes}
							class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
						>
							{#each [1, 2, 5, 10, 15, 30] as value (value)}<option value={String(value)}
									>{value} min</option
								>{/each}
						</select>
					</label>
				{/if}
				{#if scenario.id === 'database-failover'}
					<label class="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
						Disposable copy to promote
						<input
							bind:value={drillDatabase}
							maxlength="128"
							class="h-9 rounded-md border bg-background px-2 font-mono text-sm text-foreground"
							autocomplete="off"
						/>
					</label>
				{/if}
			</div>
			{#if scenario.confirmation === 'typed'}
				<label class="flex flex-col gap-1 text-xs">
					<span>
						{#if scenario.destructive}This takes <span class="font-mono"
								>{resource || `the ${scenario.resourceKind}`}</span
							> down for real.{/if}
						Type
						<span class="font-mono font-medium"
							>{resource || `the ${scenario.resourceKind}’s name`}</span
						> to confirm.
					</span>
					<input
						bind:value={typed}
						class="h-9 max-w-sm rounded-md border bg-background px-2 font-mono text-sm"
						autocomplete="off"
						data-testid="drill-confirm"
					/>
				</label>
			{:else if scenario.confirmation === 'confirm'}
				<label class="flex items-center gap-2 text-xs">
					<input type="checkbox" bind:checked={confirmed} class="size-4" />
					I understand this promotes the disposable copy for real.
				</label>
			{/if}
			<div class="flex flex-wrap items-center gap-3">
				<Button
					type="submit"
					variant={scenario.destructive ? 'destructive' : 'default'}
					disabled={!gate?.enabled || running}
				>
					{running ? 'Starting…' : 'Run drill'}
				</Button>
				<Button type="button" variant="ghost" onclick={() => (selected = null)}>Cancel</Button>
				{#if gate?.reason}<span class="text-xs text-muted-foreground">{gate.reason}</span>{/if}
			</div>
		</form>
	{/if}

	{#if message}
		<p
			class="mt-3 rounded-md border px-3 py-2 text-sm {message.tone === 'error'
				? 'border-destructive/40 bg-destructive/10'
				: 'border-success/40 bg-success/10'}"
			role="status"
		>
			{message.text}
		</p>
	{/if}

	<h4 class="mt-5 mb-2 text-sm font-semibold">Results</h4>
	{#if runs.isError}
		<p class="text-sm text-muted-foreground">
			{runs.error instanceof NotAvailableError
				? 'Drill results are not available on this control plane yet. Node offline drills are listed under Disaster drill.'
				: errorText(runs.error)}
		</p>
	{:else if !runs.data}
		<p class="text-sm text-muted-foreground">Loading…</p>
	{:else if runs.data.length === 0}
		<EmptyState
			icon={FlaskConicalIcon}
			compact
			title="No drills yet"
			description="Each run records its measured RTO and RPO here."
		/>
	{:else}
		<div class="overflow-x-auto rounded-md border">
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">When</Table.Head>
						<Table.Head>Scenario</Table.Head>
						<Table.Head>Result</Table.Head>
						<Table.Head class="text-right">RTO</Table.Head>
						<Table.Head class="text-right">RPO</Table.Head>
						<Table.Head class="text-right">Failed requests</Table.Head>
						<Table.Head class="pr-4">Bound</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each runs.data as item (item.id)}
						<Table.Row>
							<Table.Cell class="pl-4 text-sm whitespace-nowrap"
								>{item.startedAt ? formatRelative(item.startedAt) : '—'}</Table.Cell
							>
							<Table.Cell>
								<p class="font-mono text-xs">{item.scenario}</p>
								<p class="text-xs text-muted-foreground">
									{item.resource.kind} <span class="font-mono">{item.resource.name}</span>
								</p>
							</Table.Cell>
							<Table.Cell class="max-w-64 whitespace-normal">
								<StatusBadge status={item.status} tone={statusTone[item.status]} />
								{#if item.measured.refused !== null}<p class="mt-0.5 text-xs text-muted-foreground">
										{item.measured.refused ? 'Refused, as it must be' : 'Not refused'}
									</p>{/if}
								{#if item.message}<p class="mt-0.5 text-xs text-muted-foreground">
										{item.message}
									</p>{/if}
							</Table.Cell>
							<Table.Cell class="text-right font-mono text-xs"
								>{formatMs(item.measured.rtoMs)}</Table.Cell
							>
							<Table.Cell class="text-right font-mono text-xs"
								>{formatRpo(item.measured)}</Table.Cell
							>
							<Table.Cell class="text-right font-mono text-xs"
								>{item.measured.failedRequests ?? '—'}</Table.Cell
							>
							<Table.Cell class="pr-4 text-xs whitespace-nowrap">{bound(item)}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</Panel>
