<script lang="ts">
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import TargetIcon from '@lucide/svelte/icons/target';
	import type { SloOverviewItem } from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	function percent(value: number): string {
		return `${(value * 100).toFixed(value >= 0.999 ? 3 : 2)}%`;
	}
	function budgetTone(slo: SloOverviewItem): 'success' | 'warning' | 'danger' | 'neutral' {
		if (!slo.errorBudget) return 'neutral';
		if (slo.errorBudget.consumed >= 1) return 'danger';
		if (slo.errorBudget.consumed >= 0.75) return 'warning';
		return 'success';
	}
	function firing(slo: SloOverviewItem): number {
		return slo.evaluation?.burnAlerts.filter((alert) => alert.firing).length ?? 0;
	}
	function duration(seconds: number): string {
		if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
		if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
		return `${Math.round(seconds / 60)}m`;
	}
</script>

<svelte:head><title>SLOs · Settings · Yoal</title></svelte:head>

<SettingsHeader id="slo" />

<div class="space-y-6">
	{#if form?.success}
		<div class="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm">{form.success}</div>
	{/if}
	{#if form?.message}
		<div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{form.message}</div>
	{/if}

	{#if !data.overview.enabled}
		<Panel title="SLO objects are off" icon={TargetIcon} description="Enable the opt-in flag to create service-level objectives.">
			<p class="text-sm text-muted-foreground">
				Set <code class="font-mono">YOAL_FEATURE_SLO_OBJECTS=true</code> (or turn it on in Settings → Feature
				flags), then reload. With it off no SLO object exists and no evaluation runs.
			</p>
		</Panel>
	{:else}
		<Panel
			title="Service-level objectives"
			icon={TargetIcon}
			description="A success target over a rolling window, the error budget it implies, and multi-window burn alerts evaluated from telemetry."
			count={data.overview.objects.length}
			flush
		>
			{#if data.overview.objects.length === 0}
				<div class="p-4">
					<EmptyState icon={TargetIcon} compact title="No SLOs" description="Create one below; evaluation reads the same traffic and database telemetry as the dashboard." />
				</div>
			{:else}
				<Table.Root>
					<Table.Header class="bg-muted/45">
						<Table.Row>
							<Table.Head class="pl-4">Objective</Table.Head>
							<Table.Head>Target</Table.Head>
							<Table.Head>Error budget</Table.Head>
							<Table.Head>Burn</Table.Head>
							<Table.Head class="pr-4 text-right">Actions</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.overview.objects as slo (slo.id)}
							<Table.Row>
								<Table.Cell class="pl-4">
									<p class="text-sm font-medium">{slo.name}</p>
									<p class="text-xs text-muted-foreground">
										{slo.projectName} · <code class="font-mono">{slo.indicator}</code> · {duration(slo.windowSeconds)}
									</p>
									{#if slo.evaluation?.note}<p class="mt-0.5 text-xs text-warning">{slo.evaluation.note}</p>{/if}
								</Table.Cell>
								<Table.Cell class="font-mono text-xs">{percent(slo.target)}</Table.Cell>
								<Table.Cell>
									{#if slo.errorBudget}
										<p class="flex items-center gap-2 text-sm">
											<Badge variant={budgetTone(slo)}>{Math.round(slo.errorBudget.consumed * 100)}% used</Badge>
											<span class="text-xs text-muted-foreground">{Math.round(slo.errorBudget.remaining * 100)}% left</span>
										</p>
										<p class="mt-0.5 text-xs text-muted-foreground">
											Burn {slo.errorBudget.burnRate.toFixed(2)}× · budget {percent(slo.errorBudget.total)}
										</p>
									{:else}
										<span class="text-xs text-muted-foreground">No window</span>
									{/if}
								</Table.Cell>
								<Table.Cell>
									{#if firing(slo) > 0}
										{#each slo.evaluation?.burnAlerts.filter((alert) => alert.firing) ?? [] as alert (alert.severity + alert.burnRate)}
											<Badge variant={alert.severity === 'critical' ? 'danger' : 'warning'}>
												{alert.severity} {alert.observedBurnRate.toFixed(1)}× / {alert.burnRate}×
											</Badge>
										{/each}
									{:else}
										<span class="text-xs text-muted-foreground">No burn alert</span>
									{/if}
								</Table.Cell>
								<Table.Cell class="pr-4 text-right">
									{#if data.canEdit}
										<form method="POST" action="?/remove">
											<input type="hidden" name="project" value={slo.projectSlug} />
											<input type="hidden" name="id" value={slo.id} />
											<Button type="submit" size="sm" variant="ghost">Remove</Button>
										</form>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Panel>

		{#if data.canEdit}
			<Panel title="New objective" icon={GaugeIcon} description="One success-ratio target per project and name; saving the same name updates it in place.">
				<form method="POST" action="?/create" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					<label class="text-xs">
						<span class="mb-1 block text-muted-foreground">Project</span>
						<select name="project" required class="h-9 w-full rounded-md border bg-background px-2 text-sm">
							{#each data.projects as project (project.slug)}
								<option value={project.slug}>{project.name}</option>
							{/each}
						</select>
					</label>
					<label class="text-xs">
						<span class="mb-1 block text-muted-foreground">Name</span>
						<input name="name" required maxlength="100" placeholder="availability" class="h-9 w-full rounded-md border bg-background px-2 text-sm" />
					</label>
					<label class="text-xs">
						<span class="mb-1 block text-muted-foreground">Indicator</span>
						<select name="indicator" class="h-9 w-full rounded-md border bg-background px-2 text-sm">
							<option value="http_availability">HTTP availability (non-5xx)</option>
							<option value="database_writable">Database writable (samples up)</option>
						</select>
					</label>
					<label class="text-xs">
						<span class="mb-1 block text-muted-foreground">Target (%)</span>
						<input name="target" type="number" min="0.001" max="99.999" step="0.001" value="99.9" required class="h-9 w-full rounded-md border bg-background px-2 text-sm" />
					</label>
					<label class="text-xs">
						<span class="mb-1 block text-muted-foreground">Window (hours)</span>
						<input name="windowHours" type="number" min="1" max="2160" value="24" required class="h-9 w-full rounded-md border bg-background px-2 text-sm" />
					</label>
					<label class="text-xs">
						<span class="mb-1 block text-muted-foreground">Description (optional)</span>
						<input name="description" maxlength="2000" class="h-9 w-full rounded-md border bg-background px-2 text-sm" />
					</label>
					<label class="text-xs">
						<span class="mb-1 block text-muted-foreground">Burn alert</span>
						<select name="burnSeverity" class="h-9 w-full rounded-md border bg-background px-2 text-sm">
							<option value="none">None</option>
							<option value="warning">Warning</option>
							<option value="critical">Critical</option>
						</select>
					</label>
					<label class="text-xs">
						<span class="mb-1 block text-muted-foreground">Burn rate (× allowed)</span>
						<input name="burnRate" type="number" min="1" max="1000" step="0.1" value="14.4" class="h-9 w-full rounded-md border bg-background px-2 text-sm" />
					</label>
					<label class="text-xs">
						<span class="mb-1 block text-muted-foreground">Long window (minutes)</span>
						<input name="burnWindowMinutes" type="number" min="1" max="129600" value="60" class="h-9 w-full rounded-md border bg-background px-2 text-sm" />
					</label>
					<label class="text-xs">
						<span class="mb-1 block text-muted-foreground">Short window (minutes, optional)</span>
						<input name="burnShortMinutes" type="number" min="1" max="129600" value="5" class="h-9 w-full rounded-md border bg-background px-2 text-sm" />
					</label>
					<div class="flex items-end">
						<Button type="submit" size="sm">Create objective</Button>
					</div>
				</form>
			</Panel>
		{/if}
	{/if}
</div>
