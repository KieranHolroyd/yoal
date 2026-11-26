<script lang="ts">
	import LogExplorer from '#lib/logs/LogExplorer.svelte';
	import ClusterHeader from '../../_lib/ClusterHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Logs · {data.cluster.name} · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<ClusterHeader cluster={data.cluster} can={data.kubernetesCan} />

	<!-- Machine and system lines only; pod output has its own tab on the cluster page. -->
	<LogExplorer
		scopes={[{ kind: 'k8s', id: data.cluster.id }]}
		locked
		lockedLabel={data.cluster.name}
		baseQuery="-stream:pod:*"
		baseLabel="Machine and system lines"
		urlPrefix=""
		order="oldest-first"
		defaultLive
		defaultTime={{ kind: 'relative', value: '7d' }}
		facets={false}
		defaultColumns={['time', 'level', 'stream']}
		filename="{data.cluster.name}-kubernetes"
		canRead={data.canRead}
		emptyHint="Machines write to their unit journals and the agent drains them every couple of seconds. A fresh cluster may take a moment."
	/>
</div>
