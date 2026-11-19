<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { browser } from '$app/env';
	import { createQuery } from '@tanstack/svelte-query';
	import EraserIcon from '@lucide/svelte/icons/eraser';
	import LogsIcon from '@lucide/svelte/icons/logs';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import PlayIcon from '@lucide/svelte/icons/play';
	import SearchIcon from '@lucide/svelte/icons/search';
	import type { KubernetesPodLogLine } from '@yoal/contracts';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { errorText, fetchJson } from '#lib/query.js';
	import EmptyState from '../../_lib/EmptyState.svelte';

	/**
	 * Pod logs the cluster's shipper sent (docs/KUBERNETES.md K23). The first read returns the newest
	 * lines for the filters; following polls `after=<last seq>` every two seconds. Changing a filter
	 * starts over.
	 */
	let { endpoint }: { endpoint: string } = $props();

	const MAX_LINES = 2000;
	let namespace = $state('');
	let pod = $state('');
	let search = $state('');
	let filters = $state({ namespace: '', pod: '', q: '' });
	let follow = $state(true);
	let lines = $state<KubernetesPodLogLine[]>([]);
	let cursor = $state<number | null>(null);
	let viewport = $state<HTMLDivElement | null>(null);

	function apply(event: SubmitEvent) {
		event.preventDefault();
		filters = { namespace: namespace.trim(), pod: pod.trim(), q: search.trim() };
		lines = [];
		cursor = null;
	}

	const tail = createQuery(() => ({
		queryKey: ['k8s-pod-logs', endpoint, filters.namespace, filters.pod, filters.q] as const,
		queryFn: ({ signal }) => {
			const query: Record<string, string> = { limit: '300' };
			if (filters.namespace) query.namespace = filters.namespace;
			if (filters.pod) query.pod = filters.pod;
			if (filters.q) query.q = filters.q;
			// Read when it runs, so each poll asks only for lines after the last one seen.
			if (cursor !== null) query.after = String(cursor);
			return fetchJson<{ lines: KubernetesPodLogLine[] }>(
				`${endpoint}?${new URLSearchParams(query).toString()}`,
				{
					signal,
					fallback: 'Could not read pod logs'
				}
			);
		},
		enabled: browser,
		refetchInterval: follow ? 2_000 : false,
		refetchIntervalInBackground: false,
		staleTime: 0,
		gcTime: 0,
		retry: 3
	}));

	let applied = 0;
	$effect(() => {
		const page = tail.data;
		const at = tail.dataUpdatedAt;
		if (!page || at === applied) return;
		applied = at;
		untrack(() => {
			// The first page comes newest first; show oldest first either way.
			const fresh = [...page.lines].sort((a, b) => a.seq - b.seq);
			if (fresh.length > 0) {
				lines = [...lines, ...fresh].slice(-MAX_LINES);
				cursor = fresh.at(-1)!.seq;
				void tick().then(() => viewport?.scrollTo({ top: viewport.scrollHeight }));
			} else if (cursor === null) cursor = 0;
		});
	});

	const problem = $derived(tail.isError ? errorText(tail.error, 'Could not read pod logs.') : null);
	const time = (at: string) =>
		Number.isNaN(Date.parse(at)) ? at : new Date(at).toISOString().slice(11, 23);
</script>

<div class="space-y-3">
	<form class="flex flex-wrap items-center gap-2" onsubmit={apply}>
		<Input
			bind:value={namespace}
			placeholder="namespace"
			aria-label="Namespace"
			class="w-40 font-mono text-xs"
		/>
		<Input bind:value={pod} placeholder="pod" aria-label="Pod" class="w-48 font-mono text-xs" />
		<InputGroup.Root class="w-56">
			<InputGroup.Input
				bind:value={search}
				placeholder="Search messages"
				aria-label="Search messages"
			/>
			<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
		</InputGroup.Root>
		<Button type="submit" variant="outline" size="sm">Apply</Button>
		<div class="ml-auto flex items-center gap-2">
			<Button variant="outline" size="sm" onclick={() => (follow = !follow)}>
				{#if follow}<PauseIcon />Pause{:else}<PlayIcon />Follow{/if}
			</Button>
			<Button variant="ghost" size="sm" onclick={() => (lines = [])}><EraserIcon />Clear</Button>
		</div>
	</form>

	{#if problem}
		<Notice tone="warning" title="Pod logs">{problem}</Notice>
	{/if}

	{#if lines.length === 0}
		<EmptyState
			icon={LogsIcon}
			title="No pod logs yet"
			description="The shipper sends each pod's stdout and stderr about once a minute. Check the filters, or wait for the first batch."
		/>
	{:else}
		<div
			bind:this={viewport}
			class="max-h-[32rem] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed"
			role="log"
			aria-live="polite"
		>
			{#each lines as line (line.seq)}
				<div class="break-all whitespace-pre-wrap">
					<span class="text-muted-foreground">{time(line.at)}</span>
					<span class="text-info">{line.namespace}/{line.pod}</span>{#if line.container}<span
							class="text-muted-foreground">[{line.container}]</span
						>{/if}
					<span class={line.stream === 'stderr' ? 'text-destructive' : ''}>{line.message}</span>
				</div>
			{/each}
		</div>
		<p class="text-xs text-muted-foreground">
			{lines.length} lines{follow ? ' · following' : ' · paused'}
		</p>
	{/if}
</div>
