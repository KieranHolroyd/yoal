<script lang="ts">
	import ServiceLogs from '../../../_lib/service/ServiceLogs.svelte';
	import ClusterHeader from '../../_lib/ClusterHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Logs · {data.cluster.name} · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<ClusterHeader cluster={data.cluster} can={data.kubernetesCan} />

	<ServiceLogs
		endpoint="/api/v1/kubernetes/{encodeURIComponent(data.cluster.name)}/logs"
		filename="{data.cluster.name}-kubernetes.log"
		canRead={data.canRead}
		initial={data.initial}
		loadError={data.logsError}
		emptyHint="Machines write to their unit journals and the agent drains them every couple of seconds. A fresh cluster may take a moment."
	/>
</div>
