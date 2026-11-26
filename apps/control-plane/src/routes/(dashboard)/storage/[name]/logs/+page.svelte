<script lang="ts">
	import LogExplorer from '#lib/logs/LogExplorer.svelte';
	import StorageHeader from '../../_lib/StorageHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Logs · {data.storage.name} · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<StorageHeader st={data.storage} can={data.storageCan} />

	<LogExplorer
		scopes={[{ kind: 'storage', id: data.storage.id }]}
		locked
		lockedLabel={data.storage.name}
		urlPrefix=""
		order="oldest-first"
		defaultLive
		defaultTime={{ kind: 'relative', value: '7d' }}
		facets={false}
		defaultColumns={['time', 'level']}
		filename="{data.storage.name}-rustfs"
		canRead={data.canRead}
		emptyHint="RustFS writes to the unit journal and the agent drains it every couple of seconds. A fresh instance may take a moment."
	/>
</div>
