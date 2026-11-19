<script lang="ts">
	import { resolve } from '$app/paths';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FileCodeIcon from '@lucide/svelte/icons/file-code';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import MessageCircleQuestionIcon from '@lucide/svelte/icons/message-circle-question';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import type {
		KubernetesApplyResult,
		KubernetesClusterView,
		KubernetesGenerateResult,
		KubernetesManifestFinding
	} from '@yoal/contracts';
	import { toast } from 'svelte-sonner';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import {
		groupFindings,
		objectLabel,
		objectsInYaml,
		postApply,
		progressLabel,
		streamGenerate,
		type GenerateProgress
	} from './write-config.js';

	/**
	 * Write a Kubernetes config in plain language (docs/KUBERNETES.md §18). Yoal's model writes it
	 * with the cluster's real facts, lints and repairs it; the person edits, dry-runs and applies
	 * the YAML as themselves. Nothing reaches the cluster without a click.
	 */
	let {
		cluster,
		enabled,
		canConfigure,
		canApply,
		live
	}: {
		cluster: KubernetesClusterView;
		/** A model provider is configured (Settings → Assistant). */
		enabled: boolean;
		/** The viewer may configure the assistant. */
		canConfigure: boolean;
		/** The viewer holds `kubernetes:edit`. */
		canApply: boolean;
		live: boolean;
	} = $props();

	const NAMESPACE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
	const reachable = $derived(
		live &&
			cluster.apiUrl !== null &&
			!cluster.restoring &&
			(cluster.status === 'running' || cluster.status === 'degraded')
	);
	const routeLabel = $derived(cluster.routes[0]?.host.split('.')[0] ?? 'shop');
	const examples = $derived([
		`nginx serving a static site on ${routeLabel}, 2 replicas`,
		'a worker that reads jobs from the attached broker',
		'Postgres-backed web app using the attached database',
		'a CronJob that cleans up old uploads every night at 02:00'
	]);

	let prompt = $state('');
	let namespace = $state('default');
	let dryRun = $state(true);
	let refinePrompt = $state('');

	let busy = $state(false);
	let progress = $state<GenerateProgress | null>(null);
	let failure = $state<string | null>(null);
	let controller: AbortController | null = null;

	let result = $state<KubernetesGenerateResult | null>(null);
	let yaml = $state('');
	/** The latest dry run or apply, and the YAML it was run on. */
	let check = $state<{ result: KubernetesApplyResult; yaml: string } | null>(null);
	let checking = $state<'dry-run' | 'apply' | null>(null);
	let confirmOpen = $state(false);

	const namespaceError = $derived(
		NAMESPACE.test(namespace) && namespace.length <= 63
			? null
			: 'Use a Kubernetes namespace name: lowercase letters, digits and dashes.'
	);
	const edited = $derived(result !== null && yaml !== result.yaml);
	const groups = $derived(groupFindings(result?.findings ?? []));
	const confirmObjects = $derived(objectsInYaml(yaml));
	const checkStale = $derived(check !== null && check.yaml !== yaml);

	$effect(() => () => controller?.abort());

	async function generate(input: { prompt: string; yaml?: string }) {
		if (busy || namespaceError) return;
		controller?.abort();
		controller = new AbortController();
		busy = true;
		progress = null;
		failure = null;
		try {
			const next = await streamGenerate(
				`/api/v1/kubernetes/${encodeURIComponent(cluster.name)}/generate`,
				{
					prompt: input.prompt,
					namespace,
					...(input.yaml ? { yaml: input.yaml } : {}),
					dryRun: dryRun && reachable
				},
				{ signal: controller.signal, onProgress: (event) => (progress = event) }
			);
			result = next;
			yaml = next.yaml;
			check = next.dryRun ? { result: next.dryRun, yaml: next.yaml } : null;
			if (input.yaml) refinePrompt = '';
		} catch (caught) {
			if (controller?.signal.aborted) failure = null;
			else failure = caught instanceof Error ? caught.message : 'Could not write the config.';
		} finally {
			busy = false;
			progress = null;
			controller = null;
		}
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (prompt.trim().length < 3) {
			failure = 'Describe what to run in a few words.';
			return;
		}
		void generate({ prompt: prompt.trim() });
	}

	function refine(event: SubmitEvent) {
		event.preventDefault();
		if (refinePrompt.trim().length < 3 || !yaml.trim()) return;
		void generate({ prompt: refinePrompt.trim(), yaml });
	}

	function cancel() {
		controller?.abort();
	}

	async function runCheck(mode: 'dry-run' | 'apply') {
		if (checking || !yaml.trim()) return;
		checking = mode;
		try {
			const outcome = await postApply(
				`/api/v1/kubernetes/${encodeURIComponent(cluster.name)}/apply`,
				{ yaml, dryRun: mode === 'dry-run', namespace }
			);
			check = { result: outcome, yaml };
			const count = outcome.outcomes.length;
			const objects = `${count} ${count === 1 ? 'object' : 'objects'}`;
			if (mode === 'apply') {
				confirmOpen = false;
				if (outcome.ok) toast.success(`Applied ${objects} to ${cluster.name}.`);
				else toast.error('Some objects were not applied. See the outcomes below.');
			} else if (outcome.ok) toast.success(`Dry run passed: the cluster accepted ${objects}.`);
			else toast.error('The dry run found problems. See the outcomes below.');
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : 'The request failed.';
			if (mode === 'apply') confirmOpen = false;
			toast.error(message);
		} finally {
			checking = null;
		}
	}

	function download() {
		const blob = new Blob([yaml.endsWith('\n') ? yaml : `${yaml}\n`], { type: 'application/yaml' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `${cluster.name}-${namespace}.yaml`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1_000);
	}

	const severityLabel: Record<KubernetesManifestFinding['severity'], string> = {
		error: 'Errors',
		warning: 'Warnings',
		info: 'Notes'
	};
	const severityTone = {
		error: 'danger',
		warning: 'warning',
		info: 'info'
	} as const;
</script>

{#if !enabled}
	<EmptyState
		icon={SparklesIcon}
		title="Writing configs needs a model provider"
		description={canConfigure
			? 'Describe what to run and Yoal writes the Kubernetes YAML for this cluster. It uses the dashboard assistant’s model provider; set one up first.'
			: 'Describe what to run and Yoal writes the Kubernetes YAML for this cluster. It uses the dashboard assistant’s model provider, which an owner sets up in Settings → Assistant.'}
	>
		{#if canConfigure}
			<Button size="sm" href={resolve('/(dashboard)/settings/assistant')}
				><SparklesIcon />Set up Settings → Assistant</Button
			>
		{/if}
	</EmptyState>
{:else}
	<Panel
		title="Describe what to run"
		icon={SparklesIcon}
		description="Yoal writes Kubernetes YAML for {cluster.name} from its real routes, attachments and limits, checks it and fixes what it can. Nothing is applied until you click Apply."
	>
		<form class="space-y-4" onsubmit={submit}>
			<Field.Field>
				<Field.Label for="write-prompt">What should run on {cluster.name}?</Field.Label>
				<Textarea
					id="write-prompt"
					bind:value={prompt}
					rows={3}
					maxlength={4000}
					placeholder="A Next.js app on {routeLabel} backed by the attached database, 2 replicas"
					disabled={busy}
				/>
			</Field.Field>
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-xs text-muted-foreground">Try:</span>
				{#each examples as example (example)}
					<Button
						type="button"
						variant="outline"
						size="sm"
						class="h-7 rounded-full text-xs font-normal"
						disabled={busy}
						onclick={() => (prompt = example)}>{example}</Button
					>
				{/each}
			</div>
			<div class="grid gap-4 sm:grid-cols-[16rem_1fr] sm:items-end">
				<Field.Field data-invalid={namespaceError ? true : undefined}>
					<Field.Label for="write-namespace">Namespace</Field.Label>
					<Input
						id="write-namespace"
						bind:value={namespace}
						maxlength={63}
						spellcheck="false"
						class="font-mono text-sm"
						disabled={busy}
					/>
					{#if namespaceError}<Field.Error>{namespaceError}</Field.Error>{/if}
				</Field.Field>
				<Field.Field orientation="horizontal">
					<Checkbox id="write-dry-run" bind:checked={dryRun} disabled={busy || !reachable} />
					<Field.Label for="write-dry-run">Validate on cluster (dry run)</Field.Label>
				</Field.Field>
			</div>
			{#if !reachable && live}
				<p class="text-xs text-muted-foreground">
					Dry runs and Apply need {cluster.name} running with a public API; you can still write and download
					configs.
				</p>
			{/if}
			<div class="flex flex-wrap items-center gap-3">
				<Button type="submit" disabled={busy || !!namespaceError || prompt.trim().length < 3}>
					{#if busy}<Spinner />{:else}<WandSparklesIcon />{/if}
					{result ? 'Generate again' : 'Generate'}
				</Button>
				{#if busy}
					<span class="text-sm text-muted-foreground" aria-live="polite"
						>{progressLabel(progress)}</span
					>
					<Button type="button" variant="ghost" size="sm" onclick={cancel}>Cancel</Button>
				{/if}
			</div>
		</form>
		{#if failure}
			<Notice tone="danger" title="Could not write the config" class="mt-4">{failure}</Notice>
		{/if}
	</Panel>

	{#if result}
		<Panel title="Config" icon={FileCodeIcon} description={result.summary || undefined}>
			{#snippet actions()}
				<div class="flex flex-wrap items-center gap-2">
					{#if result?.ok}
						<Badge variant="success">no errors</Badge>
					{:else}
						<Badge variant="danger"
							>{groups.error.length} {groups.error.length === 1 ? 'error' : 'errors'}</Badge
						>
					{/if}
					{#if edited}<Badge variant="info">edited</Badge>{/if}
					{#if yaml.trim()}
						<CopyButton value={yaml} label="Copy" />
						<Button variant="outline" size="sm" onclick={download}
							><DownloadIcon />Download YAML</Button
						>
					{/if}
				</div>
			{/snippet}
			{#if !result.yaml && !yaml}
				<Notice tone="warning" title="No objects">
					The model did not return any Kubernetes objects. Answer its questions below or describe
					the workload differently.
				</Notice>
			{:else}
				<Field.Field>
					<Field.Label for="write-yaml" class="sr-only">YAML</Field.Label>
					<Textarea
						id="write-yaml"
						bind:value={yaml}
						rows={Math.min(28, Math.max(10, yaml.split('\n').length + 1))}
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						class="font-mono text-xs leading-relaxed"
						disabled={busy}
					/>
					<Field.Description>
						{result.objects.length}
						{result.objects.length === 1 ? 'object' : 'objects'} · {result.model} · {result.rounds}
						{result.rounds === 1 ? 'round' : 'rounds'}. Edit freely; Dry run and Apply use the YAML
						as it is here.
					</Field.Description>
				</Field.Field>
				<div class="mt-4 flex flex-wrap items-center gap-2">
					{#if reachable}
						<Button
							variant="outline"
							size="sm"
							disabled={busy || checking !== null || !yaml.trim()}
							onclick={() => void runCheck('dry-run')}
						>
							{#if checking === 'dry-run'}<Spinner />{:else}<ShieldCheckIcon />{/if}Dry run
						</Button>
						{#if canApply}
							<Button
								size="sm"
								disabled={busy || checking !== null || !yaml.trim()}
								onclick={() => (confirmOpen = true)}
							>
								<RocketIcon />Apply
							</Button>
						{/if}
					{/if}
				</div>
			{/if}
			<form class="mt-5 flex flex-col gap-2 border-t pt-4 sm:flex-row" onsubmit={refine}>
				<Field.Label for="write-refine" class="sr-only">Refine</Field.Label>
				<Input
					id="write-refine"
					bind:value={refinePrompt}
					maxlength={4000}
					placeholder="Refine it: “make it 3 replicas”, “add a readiness probe on /healthz”"
					disabled={busy}
				/>
				<Button
					type="submit"
					variant="outline"
					disabled={busy || refinePrompt.trim().length < 3 || !yaml.trim() || !!namespaceError}
				>
					{#if busy}<Spinner />{:else}<WandSparklesIcon />{/if}Refine
				</Button>
			</form>
		</Panel>

		{#if result.findings.length > 0}
			<Panel title="Findings" icon={ListChecksIcon} count={result.findings.length}>
				<div class="space-y-4">
					{#each ['error', 'warning', 'info'] as const as severity (severity)}
						{#if groups[severity].length > 0}
							<section>
								<h3 class="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
									{severityLabel[severity]}
								</h3>
								<ul class="space-y-1.5">
									{#each groups[severity] as finding, index (index)}
										<li class="flex flex-wrap items-baseline gap-2 text-sm">
											<Badge variant={severityTone[severity]}>{severity}</Badge>
											{#if finding.object}<span class="font-mono text-xs">{finding.object}</span
												>{/if}
											{#if finding.path}<span class="font-mono text-xs text-muted-foreground"
													>{finding.path}</span
												>{/if}
											<span>{finding.message}</span>
											{#if finding.fixed}
												<Badge variant="success"><CircleCheckIcon />fixed automatically</Badge>
											{/if}
										</li>
									{/each}
								</ul>
							</section>
						{/if}
					{/each}
				</div>
			</Panel>
		{/if}

		{#if result.assumptions.length > 0 || result.questions.length > 0}
			<div class="grid items-start gap-5 lg:grid-cols-2">
				{#if result.assumptions.length > 0}
					<Panel title="Assumptions" icon={ListChecksIcon} count={result.assumptions.length}>
						<ul class="list-disc space-y-1 pl-5 text-sm">
							{#each result.assumptions as item, index (index)}<li>{item}</li>{/each}
						</ul>
					</Panel>
				{/if}
				{#if result.questions.length > 0}
					<Panel
						title="Questions"
						icon={MessageCircleQuestionIcon}
						count={result.questions.length}
						description="Answer them with Refine for a better config."
					>
						<ul class="list-disc space-y-1 pl-5 text-sm">
							{#each result.questions as item, index (index)}<li>{item}</li>{/each}
						</ul>
					</Panel>
				{/if}
			</div>
		{/if}

		{#if check}
			<Panel
				title={check.result.dryRun ? 'Dry run on the cluster' : 'Applied'}
				icon={check.result.dryRun ? ShieldCheckIcon : RocketIcon}
				count={check.result.outcomes.length}
				description={checkStale
					? 'The YAML changed since this ran; run it again to check the current version.'
					: check.result.dryRun
						? 'The API server validated each object as you. Nothing was changed.'
						: 'Server-side apply as you; the cluster’s RBAC decided each object.'}
				flush
			>
				{#if check.result.outcomes.length === 0}
					<div class="space-y-2 p-4 text-sm">
						<p>Nothing was sent to the cluster.</p>
						{#each check.result.findings.filter((finding) => finding.severity === 'error') as finding, index (index)}
							<p class="text-destructive">
								{#if finding.object}<span class="font-mono text-xs">{finding.object}</span>
								{/if}{finding.message}
							</p>
						{/each}
					</div>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head class="pl-4">Object</Table.Head>
								<Table.Head class="hidden sm:table-cell">Namespace</Table.Head>
								<Table.Head>Result</Table.Head>
								<Table.Head class="pr-4">Message</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each check.result.outcomes as outcome, index (index)}
								<Table.Row>
									<Table.Cell class="pl-4 font-mono text-xs">{objectLabel(outcome)}</Table.Cell>
									<Table.Cell class="hidden font-mono text-xs sm:table-cell"
										>{outcome.namespace ?? '—'}</Table.Cell
									>
									<Table.Cell>
										<Badge variant={outcome.ok ? 'success' : 'danger'}>{outcome.result}</Badge>
									</Table.Cell>
									<Table.Cell class="max-w-md pr-4 text-xs whitespace-normal text-muted-foreground"
										>{outcome.message ?? ''}</Table.Cell
									>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</Panel>
		{/if}
	{/if}
{/if}

<AlertDialog.Root bind:open={confirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Apply to {cluster.name}?</AlertDialog.Title>
			<AlertDialog.Description>
				Server-side apply as you: existing objects with these names are updated, and the cluster’s
				RBAC decides each one. Objects without a namespace go to <span class="font-mono"
					>{namespace}</span
				>.
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if confirmObjects.length > 0}
			<ul class="max-h-56 space-y-1 overflow-y-auto rounded-md border p-3 font-mono text-xs">
				{#each confirmObjects as object, index (index)}
					<li>
						{objectLabel(object)}
						<span class="text-muted-foreground">({object.namespace ?? namespace})</span>
					</li>
				{/each}
			</ul>
		{/if}
		{#if checkStale || !check?.result.dryRun || !check.result.ok}
			<p class="text-xs text-muted-foreground">
				Tip: a passing dry run of this exact YAML catches most problems before they reach the
				cluster.
			</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={checking === 'apply'}>Cancel</AlertDialog.Cancel>
			<Button disabled={checking === 'apply'} onclick={() => void runCheck('apply')}>
				{#if checking === 'apply'}<Spinner />{:else}<RocketIcon />{/if}Apply
				{confirmObjects.length || ''}
				{confirmObjects.length === 1 ? 'object' : confirmObjects.length > 1 ? 'objects' : ''}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
