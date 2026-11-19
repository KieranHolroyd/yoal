<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ShipWheelIcon from '@lucide/svelte/icons/ship-wheel';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type { KubernetesClusterView } from '@yoal/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import ServiceHeader from '../../_lib/service/ServiceHeader.svelte';
	import { formatDate } from '../../_lib/format.js';

	type Can = { update: boolean; delete: boolean };

	/** Sections are in the sidebar (`./subnav.ts`); this is identity, facts and actions. */
	let { cluster, can }: { cluster: KubernetesClusterView; can: Can } = $props();

	/** Settings → Retention & defaults trash period; the layout loads it. */
	const trashDays = $derived<number>(page.data.policies?.trashDays ?? 7);

	const base = $derived(resolve('/(dashboard)/kubernetes/[name]', { name: cluster.name }));
	const deleted = $derived(cluster.deletedAt !== null);
	/** Actions live on the detail route, so the header works from every sub-route. */
	const act = (name: string) => `${base}?/${name}`;

	function restart() {
		askConfirm({
			title: `Restart ${cluster.name}?`,
			description:
				'Every machine stops and starts again. Running pods restart with their nodes; cluster state and volumes are kept.',
			confirmLabel: 'Restart',
			tone: 'danger',
			action: act('restart')
		});
	}

	function moveToTrash() {
		askConfirm({
			title: `Delete ${cluster.name}?`,
			description: `Its machines stop and the cluster moves to the trash for ${trashDays} days. Its data stays on the node, so a restore is lossless.`,
			confirmLabel: 'Move to trash',
			tone: 'danger',
			typeToConfirm: cluster.name,
			action: act('delete')
		});
	}

	function purge() {
		askConfirm({
			title: `Delete ${cluster.name} permanently?`,
			description:
				'Its node deletes every machine’s data directory: cluster state, local volumes and images. This cannot be undone.',
			confirmLabel: 'Delete permanently',
			tone: 'danger',
			typeToConfirm: cluster.name,
			action: act('purge')
		});
	}
</script>

<ServiceHeader icon={ShipWheelIcon} title={cluster.name} target="page.kubernetes">
	{#snippet meta()}
		<StatusBadge status={deleted ? 'deleted' : cluster.status} />
		<Badge variant="outline">Kubernetes {cluster.displayVersion}</Badge>
		{#if cluster.tier === 'trusted'}<Badge variant="warning">trusted</Badge>{/if}
		<span class="font-mono text-xs">on {cluster.nodeName ?? cluster.nodeId}</span>
		<span aria-hidden="true">·</span>
		<span class="font-mono text-xs tabular-nums"
			>{1 + cluster.agents} × {cluster.memoryMb} MB · {cluster.cpus} vCPU</span
		>
		<span aria-hidden="true">·</span>
		<span class="text-xs"
			>Created <time datetime={cluster.createdAt}>{formatDate(cluster.createdAt)}</time></span
		>
	{/snippet}

	{#if deleted}
		{#if can.delete}
			<Button variant="outline" onclick={() => void runAction(act('restore'))}
				><RotateCcwIcon />Restore</Button
			>
			<Button variant="destructive" onclick={purge}><TrashIcon />Delete permanently</Button>
		{/if}
	{:else}
		{#if can.update}
			<Button variant="outline" onclick={restart}><RotateCcwIcon />Restart</Button>
		{/if}
		{#if can.delete}
			<RowMenu label="More actions for {cluster.name}">
				<DropdownMenu.Item variant="destructive" onSelect={moveToTrash}>
					<TrashIcon />Delete cluster
				</DropdownMenu.Item>
			</RowMenu>
		{/if}
	{/if}
</ServiceHeader>
