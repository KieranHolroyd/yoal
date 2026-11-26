<script lang="ts">
	import LogExplorer from '#lib/logs/LogExplorer.svelte';
	import BrokerHeader from '../../_lib/BrokerHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Logs · {data.broker.name} · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<BrokerHeader broker={data.broker} can={data.brokerCan} />

	<LogExplorer
		scopes={[{ kind: 'broker', id: data.broker.id }]}
		locked
		lockedLabel={data.broker.name}
		urlPrefix=""
		order="oldest-first"
		defaultLive
		defaultTime={{ kind: 'relative', value: '7d' }}
		facets={false}
		defaultColumns={['time', 'level']}
		filename="{data.broker.name}-{data.broker.engine}"
		canRead={data.canRead}
		emptyHint="The broker writes to the unit journal and the agent drains it every couple of seconds. A fresh broker may take a moment."
	/>
</div>
