<script lang="ts">
	import type { LogRecord, PipelineJobView } from '@yoal/contracts';
	import LogExplorer from '#lib/logs/LogExplorer.svelte';
	import JobSteps from './JobSteps.svelte';

	/**
	 * A pipeline job's log: the Logs Explorer locked to the repository's `pipeline` scope and this
	 * job's stream (`stream:pipeline-job:<id>`, docs/LOGS.md §7). It reads the whole job from its
	 * start and tails until the job completes. "Steps" (the default) keeps the step-grouped view;
	 * "Lines" is the plain stream with search, context and the rest.
	 */
	let { repositoryId, repo, job }: { repositoryId: string; repo: string; job: PipelineJobView } =
		$props();

	// Primitive deriveds so a fresh `job` object from each poll does not remount the explorer.
	const jobId = $derived(job.id);
	const attempt = $derived(job.attempt);
	const start = $derived(Date.parse(job.startedAt ?? job.createdAt) - 60_000);
	const settled = $derived({
		done: job.status === 'completed',
		label: job.conclusion ? `Job ${job.conclusion.replace(/_/g, ' ')}` : 'Job complete'
	});
</script>

{#snippet steps({ records }: { records: LogRecord[]; live: boolean; done: boolean })}
	<JobSteps {job} {records} />
{/snippet}

{#key `${jobId}:${attempt}`}
	<LogExplorer
		scopes={[{ kind: 'pipeline', id: repositoryId }]}
		locked
		lockedLabel={repo}
		baseQuery="stream:pipeline-job:{jobId}"
		baseLabel="Job {job.name}"
		urlPrefix="joblog_"
		order="oldest-first"
		loadAll
		defaultLive
		defaultTime={{ kind: 'absolute', from: start, to: null }}
		{settled}
		facets={false}
		histogram={false}
		modes={false}
		defaultColumns={['time', 'level']}
		filename="{repo}-job-{job.name}"
		emptyHint={job.status === 'completed' ? 'No output.' : 'Waiting for output…'}
		streamView={steps}
		streamViewLabel="Steps"
	/>
{/key}
