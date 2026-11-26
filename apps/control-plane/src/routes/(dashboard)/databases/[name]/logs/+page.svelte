<script lang="ts">
	import LogExplorer from '#lib/logs/LogExplorer.svelte';
	import DatabaseHeader from '../../_lib/DatabaseHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Logs · {data.database.name} · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<DatabaseHeader db={data.database} can={data.dbCan} />

	<LogExplorer
		scopes={[{ kind: 'database', id: data.database.id }]}
		locked
		lockedLabel={data.database.name}
		urlPrefix=""
		order="oldest-first"
		defaultLive
		defaultTime={{ kind: 'relative', value: '7d' }}
		facets={false}
		defaultColumns={['time', 'level']}
		filename="{data.database.name}-postgres"
		canRead={data.canRead}
		emptyHint="Postgres writes to the unit journal and the agent drains it every couple of seconds. A fresh database may take a moment."
	/>
</div>
