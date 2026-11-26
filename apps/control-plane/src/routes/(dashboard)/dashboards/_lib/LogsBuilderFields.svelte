<script lang="ts">
	/**
	 * The `logs` dataset's own inputs in the query builder (docs/LOGS.md §9.2): the log filter (the
	 * Explorer's editor), the scopes it reads (always within the viewer's own log access), the field
	 * each `count_distinct` counts, and group-by on any `@attribute`. Measures, built-in group-by
	 * chips, time series, order and limit stay in the shared builder.
	 */
	import {
		builderLogsOf,
		logExplorerHref,
		parseLogFieldName,
		parseLogQuery,
		type BuilderSpec,
		type LogScopeRef
	} from '@yoal/contracts';
	import { createQuery } from '@tanstack/svelte-query';
	import { browser } from '$app/env';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import { Input } from '#lib/components/ui/input/index.js';
	import { getCapabilities, logKeys } from '#lib/logs/api.js';
	import QueryEditor from '#lib/logs/QueryEditor.svelte';
	import ScopeBar from '#lib/logs/ScopeBar.svelte';

	let {
		builder,
		dimensions,
		onchange
	}: {
		builder: BuilderSpec;
		/** Built-in group-by names the shared builder already offers as chips. */
		dimensions: string[];
		onchange: (builder: BuilderSpec) => void;
	} = $props();

	const capabilities = createQuery(() => ({
		queryKey: logKeys.capabilities,
		queryFn: ({ signal }) => getCapabilities(signal),
		enabled: browser,
		staleTime: 60_000,
		retry: false
	}));
	const lite = $derived(capabilities.data?.engine === 'sqlite');

	const logs = $derived(builderLogsOf(builder));
	const parsed = $derived(parseLogQuery(logs.q));
	const pipes = $derived(parsed.ok && parsed.ast.pipes.length > 0);
	const extraGroups = $derived(builder.groupBy.filter((name) => !dimensions.includes(name)));
	const builtIns = $derived(builder.groupBy.filter((name) => dimensions.includes(name)));

	function setLogs(patch: Partial<{ q: string; scopes: LogScopeRef[] }>) {
		onchange({ ...builder, logs: { ...logs, ...patch } });
	}

	let groupError = $state<string | null>(null);
	function setExtraGroups(text: string) {
		const names = text
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean);
		const bad = names.find((name) => !parseLogFieldName(name));
		groupError = bad ? `${bad} is not a log field (attributes start with @).` : null;
		if (bad) return;
		onchange({ ...builder, groupBy: [...builtIns, ...names].slice(0, 4) });
	}

	function setOf(index: number, of: string) {
		onchange({
			...builder,
			metrics: builder.metrics.map((metric, at) =>
				at === index ? { ...metric, of: of.trim() || undefined } : metric
			)
		});
	}

	const explorer = $derived(logExplorerHref({ q: logs.q, scopes: logs.scopes }));
</script>

<div class="grid gap-3 rounded-lg border bg-muted/20 p-3">
	<div class="space-y-1.5">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<span class="text-xs font-medium text-muted-foreground">Log query</span>
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
			id="builder-log-query"
			label="Log query"
			placeholder="level:error service:api (empty: every line)"
			bind:value={() => logs.q, (next) => setLogs({ q: next })}
			error={parsed.ok ? null : parsed.error}
			onrun={() => {}}
		/>
		{#if pipes}
			<p class="text-xs text-destructive">
				A filter only: the builder adds the <code class="font-mono">| stats</code> stage.
			</p>
		{/if}
	</div>
	<div class="flex flex-wrap items-center gap-2">
		<span class="text-xs font-medium text-muted-foreground">Scopes</span>
		<ScopeBar
			scopes={logs.scopes}
			available={capabilities.data?.scopes ?? []}
			onchange={(scopes) => setLogs({ scopes })}
		/>
		<span class="text-xs text-muted-foreground"
			>{logs.scopes.length === 0
				? 'Everything each viewer can read.'
				: 'Within what each viewer can read.'}</span
		>
	</div>
	{#each builder.metrics as metric, index (index)}
		{#if metric.field === 'count_distinct'}
			<label class="flex flex-wrap items-center gap-2 text-xs">
				<span class="font-medium text-muted-foreground">Distinct values of</span>
				<Input
					class="h-7 w-44 font-mono text-xs"
					value={metric.of ?? ''}
					placeholder="@user.id"
					aria-label="Field to count distinct values of"
					onchange={(event) => setOf(index, event.currentTarget.value)}
				/>
				{#if lite}<span class="text-warning">Needs ClickHouse.</span>{/if}
			</label>
		{/if}
	{/each}
	<label class="grid gap-1 text-xs">
		<span class="font-medium text-muted-foreground"
			>Group by attributes <span class="font-normal">(comma separated)</span></span
		>
		<Input
			class="h-7 font-mono text-xs"
			value={extraGroups.join(', ')}
			placeholder="@http.route, @http.status"
			aria-label="Group by attributes"
			onchange={(event) => setExtraGroups(event.currentTarget.value)}
		/>
		{#if groupError}<span class="text-destructive">{groupError}</span
			>{:else if lite && extraGroups.length > 0}<span class="text-warning"
				>Grouping by an attribute needs ClickHouse.</span
			>{/if}
	</label>
</div>
