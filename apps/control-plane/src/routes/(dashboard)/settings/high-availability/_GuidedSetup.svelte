<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CompassIcon from '@lucide/svelte/icons/compass';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import type { HaInitAnswers, HaInitApplyView, HaProfile } from '@yoal/contracts';
	import { createQuery, keepPreviousData, useQueryClient } from '@tanstack/svelte-query';
	import { invalidateAll } from '$app/navigation';
	import { errorText } from '#lib/query.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import CheckList from './_CheckList.svelte';
	import { NotAvailableError, applyInit, haKeys, planInit } from './_lib/ha-api.js';
	import {
		applyGate,
		changedAnswers,
		optionLabel,
		planIsNoop,
		profileChoices,
		setupSteps,
		stepLabel
	} from './_lib/ha-setup.js';

	/**
	 * The guided setup (the dashboard's `yoal ha init`): choose a profile, see what it changes,
	 * answer at most three questions, see every preflight check with its fix, then apply. Apply
	 * stays off while a required check fails. Returning to `single` is the way back.
	 */
	let { currentProfile, canApply }: { currentProfile: HaProfile; canApply: boolean } = $props();

	const queryClient = useQueryClient();
	let chosen = $state<HaProfile | null>(null);
	let answers = $state<HaInitAnswers>({});
	let applying = $state(false);
	let applied = $state<HaInitApplyView | null>(null);
	let applyError = $state<string | null>(null);

	const plan = createQuery(() => ({
		queryKey: haKeys.plan(chosen ?? 'single', answers),
		queryFn: ({ signal }) => planInit(chosen!, answers, signal),
		enabled: chosen !== null,
		placeholderData: keepPreviousData,
		staleTime: 0,
		retry: (count: number, error: Error) => !(error instanceof NotAvailableError) && count < 1
	}));
	const view = $derived(
		chosen !== null && plan.data?.plan.profile === chosen ? plan.data : undefined
	);
	const stale = $derived(plan.isPlaceholderData || plan.isFetching);
	const gate = $derived(applyGate(view, { canApply, stale, applying }));
	const steps = $derived(setupSteps({ chosen, view, gate }));

	function choose(profile: HaProfile) {
		if (chosen === profile) return;
		chosen = profile;
		answers = {};
		applied = null;
		applyError = null;
	}

	function answer(id: string, value: string) {
		answers = changedAnswers(view, { ...answers, [id]: value } as HaInitAnswers);
	}

	async function apply() {
		if (!chosen || !gate.enabled) return;
		applying = true;
		applyError = null;
		try {
			applied = await applyInit(chosen, answers);
			await invalidateAll();
			await queryClient.invalidateQueries({ queryKey: ['ha-setup'] });
		} catch (error) {
			applyError = errorText(error, 'Could not apply the profile.');
		} finally {
			applying = false;
		}
	}

	const stepTone = {
		done: 'bg-success text-success-foreground',
		current: 'bg-primary text-primary-foreground',
		blocked: 'bg-destructive text-white',
		todo: 'bg-muted text-muted-foreground'
	};
</script>

<Panel
	id="guided-setup"
	title="Set up high availability"
	icon={CompassIcon}
	description="Choose a profile, review what it changes, answer its questions and pass its checks. Apply is the same as yoal ha init; the checks are the same as yoal ha preflight."
>
	{#snippet actions()}
		<Badge variant={currentProfile === 'single' ? 'neutral' : 'success'}
			>Current profile: {currentProfile}</Badge
		>
	{/snippet}

	<ol class="mb-5 flex flex-wrap gap-x-4 gap-y-2 text-xs" aria-label="Setup steps">
		{#each steps as step, index (step.id)}
			<li class="flex items-center gap-1.5" data-step={step.id} data-state={step.state}>
				<span
					class="flex size-5 items-center justify-center rounded-full text-[11px] font-medium {stepTone[
						step.state
					]}"
				>
					{#if step.state === 'done'}<CheckIcon class="size-3" />{:else}{index + 1}{/if}
				</span>
				<span class={step.state === 'todo' ? 'text-muted-foreground' : 'font-medium'}
					>{stepLabel[step.id]}</span
				>
			</li>
		{/each}
	</ol>

	<!-- 1. Profile -->
	<fieldset class="grid gap-3 sm:grid-cols-3">
		<legend class="sr-only">Profile</legend>
		{#each profileChoices as choice (choice.id)}
			<label
				class="flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/40 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
			>
				<span class="flex items-center gap-2 font-medium">
					<input
						type="radio"
						name="ha-profile"
						value={choice.id}
						checked={chosen === choice.id}
						onchange={() => choose(choice.id)}
						class="size-4"
					/>
					{choice.label}
					{#if choice.id === currentProfile}<Badge variant="outline" class="ml-auto">current</Badge
						>{/if}
				</span>
				<span class="text-xs text-muted-foreground">{choice.summary}</span>
			</label>
		{/each}
	</fieldset>
	{#if currentProfile !== 'single' && chosen !== 'single'}
		<p class="mt-3 text-xs text-muted-foreground">
			To undo, choose <span class="font-medium">Single</span>: it turns off the flags and puts back
			the settings the profile changed.
			<Button variant="link" size="sm" class="h-auto p-0 text-xs" onclick={() => choose('single')}>
				<RotateCcwIcon class="size-3" /> Return to single
			</Button>
		</p>
	{/if}

	{#if chosen !== null}
		{#if plan.isError && !view}
			{#if plan.error instanceof NotAvailableError}
				<p
					class="mt-5 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
					role="status"
				>
					The setup plan is not available on this control plane yet. Use <code class="font-mono"
						>yoal ha init --profile {chosen}</code
					> once it is.
				</p>
			{:else}
				<p
					class="mt-5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
					role="alert"
				>
					{errorText(plan.error, 'Could not plan the profile.')}
				</p>
			{/if}
		{:else if !view}
			<p class="mt-5 text-sm text-muted-foreground">Planning the {chosen} profile…</p>
		{:else}
			<div class="mt-6 space-y-6" class:opacity-70={stale}>
				<!-- 2. Plan -->
				<section>
					<h3 class="text-sm font-semibold">What the {view.plan.profile} profile changes</h3>
					{#if planIsNoop(view, currentProfile)}
						<p class="mt-1 text-sm text-muted-foreground">
							Nothing: this install already runs this profile with these settings.
						</p>
					{/if}
					<div class="mt-2 grid gap-4 lg:grid-cols-2">
						<div class="rounded-md border p-3">
							<p class="text-xs font-medium">Feature flags</p>
							{#if view.plan.flags.length === 0}
								<p class="mt-1 text-xs text-muted-foreground">None.</p>
							{:else}
								<ul class="mt-1 flex flex-wrap gap-1">
									{#each view.plan.flags as flag (flag.name)}
										{@const pending = view.flagsToChange.some(
											(change) => change.name === flag.name
										)}
										<li>
											<Badge variant={pending ? 'warning' : 'outline'} class="font-mono text-[11px]"
												>{flag.env}</Badge
											>
										</li>
									{/each}
								</ul>
							{/if}
							{#if view.flagsToChange.length > 0}
								<p class="mt-3 text-xs">
									Flags are read from <code class="font-mono">yoal.env</code> when the control plane starts.
									Add these lines on every control-plane host, then restart it. Apply stays off until
									every host runs them.
								</p>
								<pre
									class="mt-1.5 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs select-all">{view.plan.envLines.join(
										'\n'
									)}</pre>
							{:else if view.plan.flags.length > 0}
								<p class="mt-2 text-xs text-muted-foreground">
									The running control plane already has these flags.
								</p>
							{/if}
						</div>
						<div class="rounded-md border p-3">
							<p class="text-xs font-medium">Cluster settings</p>
							<ul class="mt-1 space-y-0.5 text-xs">
								{#each view.plan.settings as setting (setting.path)}
									{@const changes = view.settingsToChange.some(
										(change) => change.path === setting.path
									)}
									<li class="flex flex-wrap gap-1">
										<span class="font-mono">{setting.path}</span> →
										<span class="font-mono"
											>{Array.isArray(setting.value)
												? `[${setting.value.join(', ')}]`
												: String(setting.value)}</span
										>
										{#if !changes}<span class="text-muted-foreground">(already set)</span>{/if}
									</li>
								{/each}
							</ul>
						</div>
					</div>
					{#each view.plan.notes as note (note)}
						<p class="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
							{note}
						</p>
					{/each}
				</section>

				<!-- 3. Questions -->
				{#if view.plan.questions.length > 0}
					<section>
						<h3 class="text-sm font-semibold">Questions</h3>
						<p class="text-xs text-muted-foreground">
							Each has a default the checks below already use. Change one and the plan and checks
							run again.
						</p>
						<div class="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
							{#each view.plan.questions as question (question.id)}
								<label class="flex flex-col gap-1 text-xs">
									<span class="font-medium">{question.prompt}</span>
									<select
										class="h-9 w-full rounded-md border bg-background px-2 text-sm"
										value={question.value ?? ''}
										onchange={(event) => answer(question.id, event.currentTarget.value)}
										disabled={stale}
									>
										{#if question.value === null}<option value="" disabled>Choose one</option>{/if}
										{#each question.options as option (option)}
											<option value={option}
												>{optionLabel(option)}{option === question.default
													? ' (default)'
													: ''}</option
											>
										{/each}
									</select>
									{#if question.options.length === 0}
										<span class="text-destructive"
											>No other region has an online data node yet.</span
										>
									{/if}
								</label>
							{/each}
						</div>
					</section>
				{/if}

				<!-- 4. Checks -->
				<section>
					<h3 class="flex flex-wrap items-center gap-2 text-sm font-semibold">
						Checks
						<span class="text-xs font-normal text-muted-foreground">
							{view.preflight.counts.pass} pass · {view.preflight.counts.warn} warn · {view
								.preflight.counts.fail} fail · {view.preflight.counts.skip} not checked
						</span>
					</h3>
					<p class="mb-2 text-xs text-muted-foreground">
						A check marked “Blocks apply” must pass first. Warnings never block. Run the same list
						with <code class="font-mono">yoal ha preflight --profile {view.plan.profile}</code>.
					</p>
					<CheckList profile={view.plan.profile} checks={view.preflight.checks} />
				</section>

				<!-- 5. Apply -->
				<section class="rounded-md border p-3" aria-live="polite">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div>
							<h3 class="text-sm font-semibold">Apply the {view.plan.profile} profile</h3>
							<p class="text-xs text-muted-foreground">
								{view.plan.profile === 'single'
									? 'Puts back the cluster settings the HA profile changed, in one step.'
									: 'Changes the cluster settings above in one step. You can return to single at any time.'}
							</p>
						</div>
						<Button disabled={!gate.enabled} onclick={apply} data-testid="ha-apply">
							{applying
								? 'Applying…'
								: view.plan.profile === 'single'
									? 'Return to single'
									: `Apply ${view.plan.profile}`}
						</Button>
					</div>
					{#if !gate.enabled && gate.reasons.length > 0 && !applying}
						<ul class="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
							{#each gate.reasons as reason (reason)}<li>{reason}</li>{/each}
						</ul>
					{/if}
					{#if applyError}
						<p class="mt-2 text-sm text-destructive" role="alert">{applyError}</p>
					{/if}
					{#if applied}
						<p class="mt-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm">
							The {applied.profile} profile is applied{applied.applied.length
								? `: ${applied.applied.map((change) => change.path).join(', ')} changed`
								: ''}.
						</p>
					{/if}
				</section>
			</div>
		{/if}
	{/if}
</Panel>
