<script lang="ts">
	/**
	 * A project's (or function's) Logs tab: the Logs Explorer locked to `project:<id>`
	 * (docs/LOGS.md §7, LP11), with the Runtime / Build switch the tab always had.
	 *
	 * - Runtime: runtime and system lines (no job or build output), optionally one deployment.
	 *   Newest at the bottom, tailing live.
	 * - Build: `source:build build:<id>`, read from the build's start, tailing until the build
	 *   settles (polled), then one last read and "Finished", as the old build stream did.
	 */
	import { browser } from '$app/env';
	import { createQuery } from '@tanstack/svelte-query';
	import HammerIcon from '@lucide/svelte/icons/hammer';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import type { DeploymentView, ProjectView } from '@yoal/core';
	import type { BuildView } from '@yoal/contracts';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import LogExplorer from '#lib/logs/LogExplorer.svelte';
	import { fetchJson } from '#lib/query.js';
	import { shortId } from '../../../_lib/format.js';

	type Source = 'runtime' | 'build';

	let {
		project,
		deployments,
		builds,
		workloadStatus = null,
		workloadDeploymentId = '',
		canRead,
		source = $bindable<Source>('runtime'),
		buildId = $bindable(''),
		deploymentId = $bindable(''),
		single = false
	}: {
		project: ProjectView;
		deployments: DeploymentView[];
		builds: BuildView[];
		workloadStatus?: string | null;
		/** The deployment the workload is actually running; it may differ from production. */
		workloadDeploymentId?: string;
		canRead: boolean;
		source?: Source;
		buildId?: string;
		/** `''` = every deployment of the project. */
		deploymentId?: string;
		/** Scoped to one deployment and its build (the deployment page): no pickers. */
		single?: boolean;
	} = $props();

	const RUNTIME = 'source:runtime OR source:system';
	const SETTLED = new Set(['succeeded', 'failed', 'cancelled']);

	const activeBuild = $derived(builds.find((build) => build.id === buildId) ?? builds[0] ?? null);
	const activeDeployment = $derived(
		single
			? (deployments[0] ?? null)
			: deploymentId
				? (deployments.find((deployment) => deployment.id === deploymentId) ?? null)
				: null
	);

	// A deployment chosen elsewhere (Deployments → "Logs") that is not in the list falls back to all.
	$effect(() => {
		if (
			!single &&
			deploymentId &&
			!deployments.some((deployment) => deployment.id === deploymentId)
		)
			deploymentId = '';
	});
	$effect(() => {
		if (activeBuild && buildId !== activeBuild.id) buildId = activeBuild.id;
	});

	// The build's own status, polled while it runs (the list endpoint, without the 2 MB log copy).
	const buildStatus = createQuery(() => ({
		queryKey: ['project-build-status', project.slug, activeBuild?.id ?? ''] as const,
		queryFn: async ({ signal }) => {
			const body = await fetchJson<{ builds: BuildView[] }>(
				`/api/v1/projects/${encodeURIComponent(project.slug)}/builds?limit=20`,
				{ signal, fallback: 'Could not read the build' }
			);
			return body.builds.find((build) => build.id === activeBuild?.id)?.status ?? null;
		},
		enabled:
			browser &&
			canRead &&
			source === 'build' &&
			activeBuild !== null &&
			!SETTLED.has(activeBuild.status),
		refetchInterval: (query) => (query.state.data && SETTLED.has(query.state.data) ? false : 2_000),
		staleTime: 0,
		retry: 2
	}));
	const status = $derived(buildStatus.data ?? activeBuild?.status ?? null);
	const settled = $derived(
		source === 'build' && status ? { done: SETTLED.has(status), label: `Build ${status}` } : null
	);

	const targetStatus = $derived(
		source === 'build'
			? status
			: activeDeployment && activeDeployment.id === workloadDeploymentId
				? (workloadStatus ?? activeDeployment.status)
				: (activeDeployment?.status ?? null)
	);

	const baseQuery = $derived(
		source === 'build'
			? activeBuild
				? `source:build build:${activeBuild.id}`
				: 'source:build'
			: activeDeployment
				? `(${RUNTIME}) deployment:${activeDeployment.id}`
				: RUNTIME
	);
	const baseLabel = $derived(
		source === 'build'
			? activeBuild
				? `Build ${shortId(activeBuild.id)} · ${activeBuild.ref}`
				: 'Builds'
			: activeDeployment
				? `Runtime · ${activeDeployment.shortId}`
				: 'Runtime and system lines'
	);
	/** Builds are read whole from their start; the runtime view opens on the last 7 days. */
	const buildStart = $derived(activeBuild ? Date.parse(activeBuild.createdAt) - 60_000 : null);
	const viewKey = $derived(
		`${source}:${source === 'build' ? (activeBuild?.id ?? '') : (activeDeployment?.id ?? 'all')}`
	);
	const emptyHint = $derived(
		source === 'build'
			? activeBuild?.status === 'queued'
				? 'Queued. Build output appears when a Builder claims the job.'
				: 'This build has no output yet.'
			: project.runtime === 'static'
				? 'Static deployments do not run a process, so there is no runtime output. Switch to Build for the build log.'
				: deployments.length === 0
					? 'Deploy once and runtime output will appear here.'
					: "Waiting for output. The app's stdout and stderr are drained here."
	);
</script>

{#snippet toolbar()}
	<ToggleGroup.Root
		type="single"
		variant="outline"
		size="sm"
		value={source}
		onValueChange={(value) => value && (source = value as Source)}
		aria-label="Log source"
	>
		<ToggleGroup.Item value="runtime"><RocketIcon />Runtime</ToggleGroup.Item>
		<ToggleGroup.Item
			value="build"
			disabled={builds.length === 0}
			title={builds.length === 0 ? 'No git builds (uploaded, not built from git).' : undefined}
			><HammerIcon />Build</ToggleGroup.Item
		>
	</ToggleGroup.Root>
	{#if source === 'runtime' && !single && deployments.length > 0}
		<label class="sr-only" for="log-deployment">Deployment</label>
		<NativeSelect.Root
			id="log-deployment"
			size="sm"
			class="w-auto font-mono text-xs"
			bind:value={deploymentId}
		>
			<NativeSelect.Option value="">All deployments</NativeSelect.Option>
			{#each deployments as deployment (deployment.id)}
				<NativeSelect.Option value={deployment.id}>
					{deployment.shortId}{deployment.isProduction
						? ' · production'
						: ` · ${deployment.environmentSlug}`}{deployment.id === workloadDeploymentId
						? ' · running'
						: ''}
				</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
	{:else if source === 'build' && !single && builds.length > 1}
		<label class="sr-only" for="log-build">Build</label>
		<NativeSelect.Root
			id="log-build"
			size="sm"
			class="w-auto font-mono text-xs"
			bind:value={buildId}
		>
			{#each builds as build (build.id)}
				<NativeSelect.Option value={build.id}>
					{shortId(build.id)} · {build.ref}{build.status === 'building' ? ' · building' : ''}
				</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
	{/if}
	{#if targetStatus}<StatusBadge status={targetStatus} />{/if}
{/snippet}

{#key viewKey}
	<LogExplorer
		scopes={[{ kind: 'project', id: project.id }]}
		locked
		lockedLabel={project.slug}
		{baseQuery}
		{baseLabel}
		urlPrefix={source === 'build' ? 'buildlog_' : 'log_'}
		order="oldest-first"
		defaultLive
		defaultTime={source === 'build' && buildStart !== null
			? { kind: 'absolute', from: buildStart, to: null }
			: { kind: 'relative', value: '7d' }}
		loadAll={source === 'build'}
		{settled}
		facets={false}
		defaultColumns={source === 'build' ? ['time', 'level'] : ['time', 'level', 'replica']}
		filename={source === 'build' && activeBuild
			? `${project.slug}-build-${shortId(activeBuild.id)}`
			: `${project.slug}-${activeDeployment ? `deployment-${shortId(activeDeployment.id)}` : 'runtime'}`}
		{emptyHint}
		{canRead}
		{toolbar}
	/>
{/key}
