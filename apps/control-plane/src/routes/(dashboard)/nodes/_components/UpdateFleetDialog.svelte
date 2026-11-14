<script lang="ts">
	import { untrack } from 'svelte';
	import { browser } from '$app/env';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '$app/forms';
	import { resolve } from '$app/paths';
	import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
	import {
		nodeRolloutLimits,
		nodeRolloutStrategies,
		type ClusterConfig,
		type NodeRolloutPlanView,
		type NodeRolloutStrategy
	} from '@yoal/contracts';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import ShieldOffIcon from '@lucide/svelte/icons/shield-off';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { notify } from '#lib/actions.js';
	import { errorText, fetchJson } from '#lib/query.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { rolloutParams, strategyCopy, type RolloutChoice } from './rollout.js';

	/**
	 * Start a fleet node update (CLUSTERING §3.11): pick a strategy and options, see the waves the
	 * planner would run right now, then start. The preview reloads as the options change.
	 */
	let {
		open = $bindable(false),
		defaults,
		targetVersion
	}: {
		open?: boolean;
		defaults: ClusterConfig['updates'];
		targetVersion: string | null;
	} = $props();

	let strategy = $state<NodeRolloutStrategy>('availability');
	let batchSize = $state<number | null>(1);
	let drain = $state(false);
	/** `null` follows the strategy's default (on, except for parallel). */
	let canaryChoice = $state<boolean | null>(null);
	let soakSeconds = $state<number | null>(60);
	let maxFailures = $state<number | null>(0);
	let pending = $state(false);
	let error = $state('');

	// Each opening starts from Settings → Clustering → Node updates.
	$effect(() => {
		if (!open) return;
		untrack(() => {
			strategy = defaults.strategy;
			batchSize = defaults.batchSize;
			drain = defaults.drain;
			canaryChoice = defaults.canary ?? null;
			soakSeconds = defaults.soakSeconds;
			maxFailures = defaults.maxFailures;
			error = '';
		});
	});

	const canary = $derived(canaryChoice ?? strategy !== 'parallel');

	const invalid = $derived.by(() => {
		const whole = (value: number | null, min: number, max: number) =>
			value !== null && Number.isInteger(value) && value >= min && value <= max;
		if (strategy === 'rolling' && !whole(batchSize, 1, nodeRolloutLimits.maxBatchSize))
			return `Batch size is a whole number from 1 to ${nodeRolloutLimits.maxBatchSize}.`;
		if (!whole(soakSeconds, 0, nodeRolloutLimits.maxSoakSeconds))
			return `Soak is a whole number of seconds from 0 to ${nodeRolloutLimits.maxSoakSeconds}.`;
		if (!whole(maxFailures, 0, nodeRolloutLimits.maxFailures))
			return `Failures allowed is a whole number from 0 to ${nodeRolloutLimits.maxFailures}.`;
		return '';
	});

	const choice = $derived<RolloutChoice>({
		strategy,
		batchSize: batchSize ?? 1,
		drain,
		canary,
		soakSeconds: soakSeconds ?? 0,
		maxFailures: maxFailures ?? 0
	});

	// Typing a number should not fire a plan per keystroke.
	let planned = $state<RolloutChoice | null>(null);
	$effect(() => {
		const next = choice;
		if (!open || invalid) return;
		const timer = setTimeout(() => (planned = next), 250);
		return () => clearTimeout(timer);
	});

	const planUrl = `${resolve('/(dashboard)/nodes')}/rollout-plan`;
	const plan = createQuery(() => ({
		queryKey: ['node-rollout-plan', planned] as const,
		queryFn: ({ signal }) =>
			fetchJson<NodeRolloutPlanView>(`${planUrl}?${rolloutParams(planned!)}`, {
				signal,
				cache: 'no-store',
				fallback: 'Could not plan the rollout'
			}),
		enabled: browser && open && planned !== null && !invalid,
		placeholderData: keepPreviousData,
		staleTime: 0,
		retry: false
	}));

	const view = $derived(plan.data ?? null);
	const nodeCount = $derived(
		view ? view.waves.reduce((sum, wave) => sum + wave.nodes.length, 0) : 0
	);
	/** The preview shows exactly what the form would start. */
	const upToDate = $derived(
		planned !== null && rolloutParams(planned).toString() === rolloutParams(choice).toString()
	);
	const canStart = $derived(
		!invalid && !pending && upToDate && !plan.isFetching && !plan.isError && nodeCount > 0
	);

	const submit: SubmitFunction = () => {
		pending = true;
		error = '';
		return async ({ result, update }) => {
			await update({ reset: false });
			pending = false;
			if (result.type === 'success' || result.type === 'redirect') {
				notify(result);
				open = false;
			} else if (result.type === 'failure') {
				const message = (result.data as { message?: unknown } | undefined)?.message;
				error = typeof message === 'string' ? message : 'Check the options and try again.';
			} else {
				error = 'Something went wrong. Please try again.';
			}
		};
	};
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-4xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<CircleArrowUpIcon class="size-4 text-muted-foreground" />
				Update fleet{targetVersion ? ` to ${targetVersion}` : ''}
			</Dialog.Title>
			<Dialog.Description>
				Every node behind the control plane installs its signed release, in waves. Each wave must
				stay healthy on the new version before the next starts. Workloads keep running; an agent
				restart briefly cuts cross-node endpoints, replication links, mail and running builds.
			</Dialog.Description>
		</Dialog.Header>

		<form method="POST" action="?/startRollout" use:enhance={submit} class="grid gap-5">
			{#if error}
				<Alert.Root variant="destructive">
					<CircleAlertIcon />
					<Alert.Description>{error}</Alert.Description>
				</Alert.Root>
			{/if}
			<input type="hidden" name="strategy" value={strategy} />
			<input type="hidden" name="drain" value={String(drain)} />
			<input type="hidden" name="canary" value={String(canary)} />

			<div class="grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
				<Field.Group>
					<Field.Set>
						<Field.Legend variant="label">Strategy</Field.Legend>
						<div class="grid gap-2">
							{#each nodeRolloutStrategies as option (option)}
								<label
									class="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors has-[:checked]:border-brand has-[:checked]:bg-brand/5"
								>
									<input
										type="radio"
										value={option}
										bind:group={strategy}
										class="mt-1 size-4 accent-brand"
									/>
									<span class="min-w-0 space-y-0.5">
										<span class="flex items-center gap-2 font-medium">
											{strategyCopy[option].label}
											{#if option === 'availability'}<Badge variant="brand">Recommended</Badge>{/if}
										</span>
										<span class="block text-xs text-muted-foreground"
											>{strategyCopy[option].summary}</span
										>
									</span>
								</label>
							{/each}
						</div>
					</Field.Set>

					{#if strategy === 'rolling'}
						<Field.Field>
							<Field.Label for="rollout-batch">Nodes per wave</Field.Label>
							<Input
								id="rollout-batch"
								name="batchSize"
								type="number"
								min="1"
								max={nodeRolloutLimits.maxBatchSize}
								bind:value={batchSize}
							/>
						</Field.Field>
					{/if}

					<Field.Field orientation="horizontal" class="gap-2">
						<Switch
							id="rollout-canary"
							bind:checked={() => canary, (value) => (canaryChoice = value)}
						/>
						<Field.Content>
							<Field.Label for="rollout-canary" class="font-normal">Canary first</Field.Label>
							<Field.Description>
								Update the node whose trouble costs least on its own before the rest.
							</Field.Description>
						</Field.Content>
					</Field.Field>
					<Field.Field orientation="horizontal" class="gap-2">
						<Switch id="rollout-drain" bind:checked={drain} />
						<Field.Content>
							<Field.Label for="rollout-drain" class="font-normal"
								>Drain each wave first</Field.Label
							>
							<Field.Description>
								Cordon the wave and let the scheduler move what can move, then lift the cordon. Use
								it when single-copy apps depend on cross-node attachments or builds must not be cut.
							</Field.Description>
						</Field.Content>
					</Field.Field>

					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field>
							<Field.Label for="rollout-soak">Soak (seconds)</Field.Label>
							<Input
								id="rollout-soak"
								name="soakSeconds"
								type="number"
								min="0"
								max={nodeRolloutLimits.maxSoakSeconds}
								bind:value={soakSeconds}
							/>
							<Field.Description
								>How long a wave must stay healthy before the next.</Field.Description
							>
						</Field.Field>
						<Field.Field>
							<Field.Label for="rollout-failures">Failures allowed</Field.Label>
							<Input
								id="rollout-failures"
								name="maxFailures"
								type="number"
								min="0"
								max={nodeRolloutLimits.maxFailures}
								bind:value={maxFailures}
							/>
							<Field.Description>0 pauses the rollout on the first failed node.</Field.Description>
						</Field.Field>
					</div>
				</Field.Group>

				<section class="min-w-0 space-y-3" aria-live="polite" aria-busy={plan.isFetching}>
					<div class="flex items-center justify-between gap-2">
						<h3 class="text-sm font-medium">Plan</h3>
						{#if plan.isFetching}<Spinner class="size-3.5 text-muted-foreground" />{/if}
					</div>
					{#if invalid}
						<p class="text-sm text-destructive">{invalid}</p>
					{:else if plan.isError && !view}
						<p class="text-sm text-destructive">
							{errorText(plan.error, 'Could not plan the rollout.')}
						</p>
					{:else if !view}
						<p class="text-sm text-muted-foreground">Working out the waves…</p>
					{:else}
						<p class="text-sm text-muted-foreground">
							{#if nodeCount === 0}
								Nothing to update to <span class="font-mono text-foreground"
									>{view.targetVersion}</span
								>.
							{:else}
								<span class="font-mono text-foreground">{nodeCount}</span>
								node{nodeCount === 1 ? '' : 's'} in
								<span class="font-mono text-foreground">{view.waves.length}</span>
								wave{view.waves.length === 1 ? '' : 's'} to
								<span class="font-mono text-foreground">{view.targetVersion}</span>.
							{/if}
							{#if view.current > 0}{view.current} already on it.{/if}
						</p>
						{#if plan.isError}
							<p class="text-xs text-destructive">{errorText(plan.error)}</p>
						{/if}

						{#if view.warnings.length > 0}
							<Alert.Root>
								<TriangleAlertIcon class="text-warning" />
								<Alert.Description>
									<ul class="list-disc space-y-1 pl-4">
										{#each view.warnings as warning, i (i)}<li>{warning}</li>{/each}
									</ul>
								</Alert.Description>
							</Alert.Root>
						{/if}

						<ol class="max-h-80 space-y-2 overflow-y-auto pr-1">
							{#each view.waves as wave (wave.index)}
								<li class="rounded-md border px-3 py-2">
									<div class="mb-1.5 flex items-center gap-2 text-xs">
										<span class="font-medium">Wave {wave.index + 1}</span>
										<Badge variant="outline">{wave.reason}</Badge>
									</div>
									<ul class="space-y-1.5">
										{#each wave.nodes as node (node.id)}
											<li class="flex flex-wrap items-center gap-1.5 text-xs">
												<span class="font-medium">{node.name}</span>
												{#if node.zone}<Badge variant="outline" class="font-mono text-[10px]"
														>{node.zone}</Badge
													>{/if}
												{#each node.roles as role (role)}
													<Badge variant="neutral" class="text-[10px]">{role}</Badge>
												{/each}
												{#each node.groups as group (group)}
													<Badge variant="info" class="text-[10px]">{group}</Badge>
												{/each}
												<span class="font-mono text-[11px] text-muted-foreground">
													{node.agentVersion ?? 'unknown'}
												</span>
												{#if !node.guarded}
													<span
														class="inline-flex items-center gap-1 text-warning"
														title="This agent predates node-update-guard: if the new release never reports in, the node does not roll itself back."
													>
														<ShieldOffIcon class="size-3" />no rollback guard
													</span>
												{/if}
												{#if node.singleCopies > 0}
													<span class="text-muted-foreground">
														· {node.singleCopies} single-copy workload{node.singleCopies === 1
															? ''
															: 's'}
													</span>
												{/if}
											</li>
										{/each}
									</ul>
								</li>
							{/each}
						</ol>

						{#if view.skipped.length > 0}
							<div class="space-y-1">
								<h4 class="text-xs font-medium">Not updated</h4>
								<ul class="space-y-0.5 text-xs text-muted-foreground">
									{#each view.skipped as skipped (skipped.nodeId)}
										<li>
											<span class="font-medium text-foreground">{skipped.name}</span>: {skipped.reason}
										</li>
									{/each}
								</ul>
							</div>
						{/if}
					{/if}
				</section>
			</div>

			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props} disabled={pending}>Cancel</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={!canStart}>
					{#if pending}<Spinner />{/if}
					{nodeCount > 0
						? `Update ${nodeCount} node${nodeCount === 1 ? '' : 's'}`
						: 'Start rollout'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
