<script lang="ts">
	/**
	 * The query half of a log alert (docs/LOGS.md §9.1): the log filter (with the Explorer's editor,
	 * highlighting and parse errors), the scopes it reads, and, for counts, the measure and group-by;
	 * for new patterns, the deploy window and lookback. Reports a new `logs` builder spec up.
	 */
	import {
		builderLogsOf,
		logAlertScopeKinds,
		logExplorerHref,
		parseLogQuery,
		type AlertRuleKind,
		type BuilderSpec,
		type LogPatternAlertOptions,
		type LogScopeRef
	} from '@yoal/contracts';
	import { createQuery } from '@tanstack/svelte-query';
	import { browser } from '$app/env';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { getCapabilities, logKeys } from '#lib/logs/api.js';
	import QueryEditor from '#lib/logs/QueryEditor.svelte';
	import ScopeBar from '#lib/logs/ScopeBar.svelte';

	let {
		kind,
		builder,
		pattern,
		windowSeconds,
		error,
		onchange,
		onpattern
	}: {
		kind: Exclude<AlertRuleKind, 'metric'>;
		builder: BuilderSpec;
		pattern: LogPatternAlertOptions | undefined;
		windowSeconds: number;
		error?: string;
		onchange: (builder: BuilderSpec) => void;
		onpattern: (pattern: LogPatternAlertOptions) => void;
	} = $props();

	const capabilities = createQuery(() => ({
		queryKey: logKeys.capabilities,
		queryFn: ({ signal }) => getCapabilities(signal),
		enabled: browser,
		staleTime: 60_000,
		retry: false
	}));
	/** Platform and edge scopes are for admins reading, never for org alert rules. */
	const available = $derived(
		(capabilities.data?.scopes ?? []).filter((scope) => logAlertScopeKinds.includes(scope.kind))
	);
	const lite = $derived(capabilities.data?.engine === 'sqlite');

	const logs = $derived(builderLogsOf(builder));
	const parsed = $derived(parseLogQuery(logs.q));
	const pipes = $derived(parsed.ok && parsed.ast.pipes.length > 0);
	const metric = $derived(builder.metrics[0] ?? { field: 'count', agg: 'count' as const });
	const options = $derived(pattern ?? { afterDeployMinutes: null, lookbackDays: 7 });

	function setLogs(patch: Partial<{ q: string; scopes: LogScopeRef[] }>) {
		onchange({ ...builder, logs: { ...logs, ...patch } });
	}

	function setGroups(text: string) {
		const groupBy = text
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean)
			.slice(0, 4);
		onchange({ ...builder, groupBy });
	}

	const explorer = $derived(
		logExplorerHref({
			q: logs.q,
			scopes: logs.scopes,
			range:
				windowSeconds % 3600 === 0
					? `${windowSeconds / 3600}h`
					: `${Math.round(windowSeconds / 60)}m`
		})
	);
</script>

<div class="grid gap-4">
	<div class="space-y-1.5">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<span class="text-sm font-medium">Log query</span>
			<!-- eslint-disable svelte/no-navigation-without-resolve -- /logs plus its query string -->
			<a
				href={explorer}
				target="_blank"
				rel="noopener"
				class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
				><ScrollTextIcon class="size-3.5" />Open in the Explorer</a
			>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</div>
		<QueryEditor
			id="rule-log-query"
			label="Log query"
			placeholder="level:error service:api -@path:/health"
			bind:value={() => logs.q, (next) => setLogs({ q: next })}
			error={parsed.ok ? null : parsed.error}
			onrun={() => {}}
		/>
		{#if pipes}
			<p class="text-xs text-destructive">
				A log alert takes a filter only: remove the <code class="font-mono">| …</code> stages.
			</p>
		{:else if error}
			<p class="text-xs text-destructive">{error}</p>
		{:else}
			<p class="text-xs text-muted-foreground">
				Empty matches every line. The same syntax as the Logs Explorer: <code class="font-mono"
					>level:error</code
				>, <code class="font-mono">@http.status:>=500</code>,
				<code class="font-mono">"timeout"</code>.
			</p>
		{/if}
	</div>

	<div class="space-y-1.5">
		<span class="block text-sm font-medium">Scopes</span>
		<div class="flex flex-wrap items-center gap-2">
			<ScopeBar scopes={logs.scopes} {available} onchange={(scopes) => setLogs({ scopes })} />
			<span class="text-xs text-muted-foreground">
				{logs.scopes.length === 0
					? 'Every project and service in the organisation.'
					: 'Only these. You must be able to read their logs.'}
			</span>
		</div>
	</div>

	{#if kind === 'log_count'}
		<div class="flex flex-wrap items-end gap-3">
			<label class="space-y-1">
				<span class="block text-xs font-medium text-muted-foreground">Measure</span>
				<NativeSelect.Root
					value={metric.field}
					aria-label="Measure"
					onchange={(event) => {
						const field = event.currentTarget.value;
						onchange({
							...builder,
							metrics: [
								field === 'count_distinct'
									? { field, agg: 'count', of: metric.of ?? '@user.id' }
									: { field: 'count', agg: 'count' }
							]
						});
					}}
				>
					<NativeSelect.Option value="count">Line count</NativeSelect.Option>
					<NativeSelect.Option value="count_distinct" disabled={lite}
						>Distinct values of a field{lite ? ' (ClickHouse)' : ''}</NativeSelect.Option
					>
				</NativeSelect.Root>
			</label>
			{#if metric.field === 'count_distinct'}
				<label class="space-y-1">
					<span class="block text-xs font-medium text-muted-foreground">Field</span>
					<Input
						class="h-8 w-44 font-mono text-xs"
						value={metric.of ?? ''}
						placeholder="@user.id"
						aria-label="Field to count distinct values of"
						onchange={(event) =>
							onchange({
								...builder,
								metrics: [{ ...metric, of: event.currentTarget.value.trim() || undefined }]
							})}
					/>
				</label>
			{/if}
			<label class="min-w-56 flex-1 space-y-1">
				<span class="block text-xs font-medium text-muted-foreground"
					>Group by <span class="font-normal">(optional, one series each)</span></span
				>
				<Input
					class="h-8 font-mono text-xs"
					value={builder.groupBy.join(', ')}
					placeholder="service, @http.route"
					aria-label="Group by"
					onchange={(event) => setGroups(event.currentTarget.value)}
				/>
			</label>
		</div>
		{#if lite && builder.groupBy.some((field) => field.startsWith('@') || field.startsWith('resource.'))}
			<p class="text-xs text-warning">
				Grouping by an attribute needs ClickHouse; without it the rule reports an error.
			</p>
		{/if}
	{:else}
		<div class="grid gap-3 rounded-lg border p-3">
			<label class="flex items-center gap-2 text-sm">
				<Switch
					checked={options.afterDeployMinutes !== null}
					onCheckedChange={(on) =>
						onpattern({
							...options,
							afterDeployMinutes: on ? (options.afterDeployMinutes ?? 30) : null
						})}
					aria-label="Only after a deploy"
				/>
				Only after a deploy
			</label>
			{#if options.afterDeployMinutes !== null}
				<label class="flex flex-wrap items-center gap-2 text-sm">
					Look for patterns new since a deploy, for
					<Input
						type="number"
						min="1"
						max="1440"
						class="h-8 w-20 tabular-nums"
						value={options.afterDeployMinutes}
						aria-label="Minutes after a deploy"
						onchange={(event) => {
							const minutes = Math.round(Number(event.currentTarget.value));
							if (Number.isFinite(minutes) && minutes >= 1)
								onpattern({ ...options, afterDeployMinutes: Math.min(1_440, minutes) });
						}}
					/>
					minutes after it goes live.
				</label>
			{/if}
			<label class="flex flex-wrap items-center gap-2 text-sm">
				“Never seen before” looks back
				<Input
					type="number"
					min="1"
					max="30"
					class="h-8 w-16 tabular-nums"
					value={options.lookbackDays}
					aria-label="Lookback in days"
					onchange={(event) => {
						const days = Math.round(Number(event.currentTarget.value));
						if (Number.isFinite(days) && days >= 1)
							onpattern({ ...options, lookbackDays: Math.min(30, days) });
					}}
				/>
				days.
			</label>
			{#if lite}
				<p class="text-xs text-warning">
					New-pattern alerts need ClickHouse (Settings → Telemetry). Until it is installed the rule
					reports an error and never fires.
				</p>
			{/if}
		</div>
	{/if}
</div>
