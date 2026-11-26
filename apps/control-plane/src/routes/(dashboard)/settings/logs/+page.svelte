<script lang="ts">
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import FilterIcon from '@lucide/svelte/icons/filter';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ServerIcon from '@lucide/svelte/icons/server';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '$app/forms';
	import type { LogRuleKind, LogRulePreviewResult, LogRuleView } from '@yoal/contracts';
	import { notify, runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import SettingsFields from './SettingsFields.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const KINDS: Array<{ id: LogRuleKind; label: string; help: string }> = [
		{ id: 'exclude', label: 'Exclude', help: 'Drop matching lines at ingest. Drains never see them.' },
		{ id: 'sample', label: 'Sample', help: 'Keep a share of matching lines at ingest; the rest are dropped and counted.' },
		{ id: 'index_only', label: 'Hot tail only', help: 'Keep matching lines for live tail and drains, but out of the search index.' },
		{ id: 'redact', label: 'Redact', help: 'Mask a regular expression in every line before it is stored. (?i) at the start ignores case.' }
	];
	const kindLabel = (kind: LogRuleKind) => KINDS.find((entry) => entry.id === kind)?.label ?? kind;

	let saving = $state<string | null>(null);
	let ruleOpen = $state(false);
	let ruleKind = $state<LogRuleKind>('exclude');
	let ruleQuery = $state('');
	let rulePattern = $state('');
	let ruleSample = $state('10');
	let ruleProject = $state('');
	let preview = $state<LogRulePreviewResult | null>(null);
	let previewing = $state(false);
	let previewError = $state('');
	let projectOpen = $state(false);
	let projectSlug = $state('');

	const editing = $derived(data.overrides.find((entry) => entry.slug === projectSlug) ?? null);

	const save =
		(key: string): SubmitFunction =>
		() => {
			saving = key;
			return async ({ result, update }) => {
				await update({ reset: false });
				saving = null;
				notify(result);
			};
		};

	function openRule() {
		ruleKind = 'exclude';
		ruleQuery = '';
		rulePattern = '';
		ruleSample = '10';
		ruleProject = '';
		preview = null;
		previewError = '';
		ruleOpen = true;
	}

	async function runPreview() {
		previewing = true;
		previewError = '';
		const result = await runAction(
			'?/previewRule',
			{ kind: ruleKind, query: ruleQuery, pattern: rulePattern, samplePercent: ruleKind === 'sample' ? ruleSample : '', project: ruleProject },
			{ apply: false, toast: false }
		);
		previewing = false;
		if (result.type === 'success') preview = (result.data as { preview: LogRulePreviewResult }).preview;
		else if (result.type === 'failure') previewError = String((result.data as { message?: unknown })?.message ?? 'Preview failed');
	}

	function toggle(rule: LogRuleView) {
		void runAction('?/toggleRule', { id: rule.id, enabled: String(!rule.enabled) });
	}

	function remove(rule: LogRuleView) {
		askConfirm({
			title: `Delete ${rule.name}?`,
			description: 'Lines logged from now on are no longer affected. Lines already dropped or masked stay that way.',
			confirmLabel: 'Delete rule',
			action: '?/deleteRule',
			fields: { id: rule.id }
		});
	}

	function gb(bytes: number): string {
		if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
		if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
		if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
		return `${bytes} B`;
	}
</script>

<svelte:head><title>Logs · Settings · Yoal</title></svelte:head>

<SettingsHeader id="logs" />

<div class="space-y-6">
	<form method="POST" action="?/saveSettings" use:enhance={save('org')}>
		<input type="hidden" name="level" value="org" />
		<Panel
			title="Retention, archive and quotas"
			description="For this organisation. A blank field inherits the platform value shown in it."
			icon={ArchiveIcon}
		>
			<SettingsFields level="org" prefix="org" row={data.org.org ?? {}} inherited={data.orgInherited} disabled={!data.canConfigure} />
			{#snippet footer()}
				{#if data.canConfigure}
					<div class="flex justify-end p-4">
						<Button type="submit" disabled={saving === 'org'}>{saving === 'org' ? 'Saving…' : 'Save'}</Button>
					</div>
				{/if}
			{/snippet}
		</Panel>
	</form>

	<Panel
		title="Per project"
		description="Projects that keep fewer search days, a lower ingest limit, or ship every edge request."
		icon={FolderIcon}
		count={data.overrides.length}
		flush
	>
		{#snippet actions()}
			{#if data.canConfigure && data.projects.length > 0}
				<Button size="sm" variant="outline" onclick={() => ((projectSlug = data.overrides[0]?.slug ?? data.projects[0]!.slug), (projectOpen = true))}>
					<PlusIcon class="size-4" /> Project settings
				</Button>
			{/if}
		{/snippet}
		{#if data.overrides.length === 0}
			<EmptyState title="Every project inherits" description="Set a project’s own search window, quotas or edge sampling here." />
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Project</Table.Head>
						<Table.Head>Search</Table.Head>
						<Table.Head>Lines/s · burst</Table.Head>
						<Table.Head>MB/day</Table.Head>
						<Table.Head>Edge 2xx</Table.Head>
						<Table.Head></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.overrides as entry (entry.slug)}
						<Table.Row>
							<Table.Cell class="font-medium">{entry.name}</Table.Cell>
							<Table.Cell class="tabular-nums">{entry.effective.searchDays} d</Table.Cell>
							<Table.Cell class="tabular-nums">{entry.effective.ingestLinesPerSecond} · {entry.effective.ingestBurst}</Table.Cell>
							<Table.Cell class="tabular-nums">{entry.effective.ingestMbPerDay}</Table.Cell>
							<Table.Cell class="tabular-nums">{Math.round(entry.effective.edgeSampleRate * 1000) / 10}%</Table.Cell>
							<Table.Cell class="text-right">
								{#if data.canConfigure}
									<Button size="sm" variant="ghost" onclick={() => ((projectSlug = entry.slug), (projectOpen = true))}>Edit</Button>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>

	<Panel
		title="Rules"
		description="Drop, sample, keep out of the index, or mask lines. Preview a rule against the last 15 minutes before saving."
		icon={FilterIcon}
		count={data.rules.length}
		flush
	>
		{#snippet actions()}
			{#if data.canConfigure}
				<Button size="sm" variant="outline" onclick={openRule}><PlusIcon class="size-4" /> Add rule</Button>
			{/if}
		{/snippet}
		{#if data.rules.length === 0}
			<EmptyState title="No rules" description="Every line is kept, and only built-in redaction and known secrets are masked." />
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Name</Table.Head>
						<Table.Head>Action</Table.Head>
						<Table.Head>Matches</Table.Head>
						<Table.Head>Scope</Table.Head>
						<Table.Head>On</Table.Head>
						<Table.Head></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.rules as rule (rule.id)}
						<Table.Row>
							<Table.Cell class="font-medium">{rule.name}</Table.Cell>
							<Table.Cell>
								<Badge variant="secondary">{kindLabel(rule.kind)}</Badge>
								{#if rule.kind === 'sample' && rule.sampleRate !== null}
									<span class="ml-1 text-xs text-muted-foreground">keep {Math.round(rule.sampleRate * 1000) / 10}%</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="max-w-xs truncate font-mono text-xs">{rule.kind === 'redact' ? rule.pattern : rule.query}</Table.Cell>
							<Table.Cell>{rule.projectSlug ?? 'Whole organisation'}</Table.Cell>
							<Table.Cell>
								<Switch checked={rule.enabled} disabled={!data.canConfigure} onCheckedChange={() => toggle(rule)} aria-label="Rule on" />
							</Table.Cell>
							<Table.Cell class="text-right">
								{#if data.canConfigure}
									<Button size="icon" variant="ghost" onclick={() => remove(rule)} aria-label="Delete rule"><TrashIcon class="size-4" /></Button>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>

	<Panel
		title="Log volume, last 7 days"
		description="Lines and bytes kept in the hot tail per project, service or cluster, and lines dropped by quotas and rules."
		icon={ChartColumnIcon}
		flush
	>
		{#if !data.usage || data.usage.rows.length === 0}
			<EmptyState title="No log volume yet" description="Counts start with lines logged after this version." />
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Scope</Table.Head>
						<Table.Head class="text-right">Per day</Table.Head>
						<Table.Head class="text-right">Total</Table.Head>
						<Table.Head class="text-right">Lines</Table.Head>
						<Table.Head class="text-right">Dropped</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.usage.rows as row (`${row.scope.kind}:${row.scope.id}`)}
						<Table.Row>
							<Table.Cell>
								<span class="font-medium">{row.name ?? row.scope.id}</span>
								<span class="ml-1 text-xs text-muted-foreground">{row.scope.kind}</span>
							</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{gb(row.bytesPerDay)}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{gb(row.bytes)}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{row.lines.toLocaleString()}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{row.droppedLines.toLocaleString()}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>

	{#if data.platform}
		<form method="POST" action="?/saveSettings" use:enhance={save('platform')}>
			<input type="hidden" name="level" value="platform" />
			<Panel
				title="Platform defaults"
				description="Every organisation inherits these, and the ingest limits are the ceiling they can lower. Platform logs follow them too."
				icon={ServerIcon}
			>
				<SettingsFields level="platform" prefix="platform" row={data.platform.platform} inherited={data.platformDefaults} disabled={!data.platform.canEdit} />
				{#snippet footer()}
					{#if data.platform?.canEdit}
						<div class="flex justify-end p-4">
							<Button type="submit" disabled={saving === 'platform'}>{saving === 'platform' ? 'Saving…' : 'Save platform defaults'}</Button>
						</div>
					{/if}
				{/snippet}
			</Panel>
		</form>
	{/if}
</div>

<FormDialog bind:open={projectOpen} title="Project log settings" action="?/saveSettings" size="lg" description="A blank field inherits the organisation’s value.">
	<input type="hidden" name="level" value="project" />
	<Field.Field>
		<Field.Label for="project-pick">Project</Field.Label>
		<NativeSelect.Root id="project-pick" name="project" bind:value={projectSlug} class="w-full">
			{#each data.projects as project (project.slug)}
				<NativeSelect.Option value={project.slug}>{project.name}</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
	</Field.Field>
	{#key projectSlug}
		<SettingsFields level="project" prefix="project" row={editing?.row ?? {}} inherited={data.org.effective} />
	{/key}
</FormDialog>

<FormDialog bind:open={ruleOpen} title="Add a log rule" action="?/createRule" submitLabel="Add rule" size="lg">
	<Field.Group>
		<div class="grid gap-4 sm:grid-cols-2">
			<Field.Field>
				<Field.Label for="rule-name">Name</Field.Label>
				<Input id="rule-name" name="name" required maxlength={80} placeholder="Health checks" />
			</Field.Field>
			<Field.Field>
				<Field.Label for="rule-kind">Action</Field.Label>
				<NativeSelect.Root id="rule-kind" name="kind" bind:value={ruleKind} class="w-full">
					{#each KINDS as kind (kind.id)}
						<NativeSelect.Option value={kind.id}>{kind.label}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</Field.Field>
		</div>
		<Field.Description>{KINDS.find((kind) => kind.id === ruleKind)?.help}</Field.Description>
		{#if ruleKind === 'redact'}
			<Field.Field>
				<Field.Label for="rule-pattern">Regular expression</Field.Label>
				<Input id="rule-pattern" name="pattern" bind:value={rulePattern} required class="font-mono text-sm" placeholder={'(?i)cus_[a-z0-9]{14}'} />
			</Field.Field>
		{:else}
			<Field.Field>
				<Field.Label for="rule-query">Log query</Field.Label>
				<Input id="rule-query" name="query" bind:value={ruleQuery} class="font-mono text-sm" placeholder={'"GET /health" @http.status:200'} />
			</Field.Field>
		{/if}
		<div class="grid gap-4 sm:grid-cols-2">
			{#if ruleKind === 'sample'}
				<Field.Field>
					<Field.Label for="rule-sample">Keep (%)</Field.Label>
					<Input id="rule-sample" name="samplePercent" type="number" min={0} max={100} step="0.1" bind:value={ruleSample} required />
				</Field.Field>
			{/if}
			<Field.Field>
				<Field.Label for="rule-project">Applies to</Field.Label>
				<NativeSelect.Root id="rule-project" name="project" bind:value={ruleProject} class="w-full">
					<NativeSelect.Option value="">Whole organisation</NativeSelect.Option>
					{#each data.projects as project (project.slug)}
						<NativeSelect.Option value={project.slug}>{project.name}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</Field.Field>
		</div>
		<div class="rounded-md border p-3 text-sm">
			<div class="flex items-center justify-between gap-2">
				<span class="text-muted-foreground">Try it against the last 15 minutes of logs.</span>
				<Button type="button" size="sm" variant="outline" onclick={runPreview} disabled={previewing}>{previewing ? 'Previewing…' : 'Preview'}</Button>
			</div>
			{#if previewError}
				<p class="mt-2 text-destructive">{previewError}</p>
			{:else if preview}
				<p class="mt-2">
					Matches {preview.matched.toLocaleString()} of {preview.scanned.toLocaleString()} lines{preview.capped ? ' (newest only)' : ''}.
					{#if ruleKind === 'exclude' || ruleKind === 'sample'}Would drop {preview.droppedPercent}% of lines.{/if}
					{#if ruleKind === 'index_only'}Would keep {preview.indexSkippedPercent}% out of the search index.{/if}
				</p>
				{#if preview.topPatterns.length > 0}
					<ul class="mt-2 space-y-1">
						{#each preview.topPatterns as pattern, index (index)}
							<li class="flex gap-2 font-mono text-xs"><span class="tabular-nums text-muted-foreground">{pattern.count}×</span><span class="truncate">{pattern.template}</span></li>
						{/each}
					</ul>
				{/if}
				{#if preview.examples.length > 0}
					<ul class="mt-2 space-y-1">
						{#each preview.examples as example, index (index)}
							<li class="truncate font-mono text-xs">{example}</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</div>
	</Field.Group>
</FormDialog>
