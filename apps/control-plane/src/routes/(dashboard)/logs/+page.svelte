<script lang="ts">
	import LogExplorer from '#lib/logs/LogExplorer.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Logs · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		title="Logs"
		description="Every line from apps, builds, jobs, pipelines, databases, storage, queues and clusters you can read, in one place. Press ? for shortcuts."
		target="logs-header"
	/>

	<LogExplorer
		canRead={data.canRead}
		urlPrefix=""
		keyboard="global"
		defaultColumns={['time', 'level', 'service', 'replica']}
		heightClass="h-[max(24rem,calc(100dvh-30rem))]"
		filename="yoal-logs"
	/>
</div>
