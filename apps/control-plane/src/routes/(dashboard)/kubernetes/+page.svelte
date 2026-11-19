<script lang="ts">
	import StorageSelect from '#lib/components/yoal/StorageSelect.svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShipWheelIcon from '@lucide/svelte/icons/ship-wheel';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import DataTable, { type DataColumn } from '#lib/components/yoal/DataTable.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatDate } from '../_lib/format.js';
	import { purgeCountdown } from '../_lib/operations/copy.js';
	import type { PageProps } from './$types';

	interface CreateFormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
		values?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as CreateFormResult | null);
	const errors = $derived(result?.fieldErrors ?? {});

	let createOpen = $state(page.url.searchParams.get('new') === '1');
	let query = $state('');
	let placement = $state('auto');
	let tier = $state('');
	let apiAccess = $state<'public' | 'private'>('public');
	let purpose = $state<'lab' | 'production'>('lab');
	let servers = $state('1');
	let spread = $state(false);
	let spreadNodes = $state<string[]>([]);

	function toggleNode(id: string, on: boolean) {
		spreadNodes = on
			? [...new Set([...spreadNodes, id])]
			: spreadNodes.filter((item) => item !== id);
	}

	const trashView = $derived(data.view === 'trash');
	const rows = $derived(trashView ? data.trash : data.clusters);
	let matched = $state(0);

	/** Tiers the chosen node offers; `auto` lets the server pick (userns unless only trusted works). */
	const tierChoices = $derived.by(() => {
		if (placement === 'auto') return [...new Set(data.nodes.flatMap((node) => node.tiers))];
		return data.nodes.find((node) => node.id === placement)?.tiers ?? [];
	});

	type Row = PageProps['data']['clusters'][number];
	const nodeOf = (row: Row) => row.nodeName ?? row.nodeId;
	const nameColumn: DataColumn<Row> = {
		id: 'name',
		header: 'Cluster',
		value: (row) => row.name,
		cell: nameCell,
		class: 'pl-4'
	};
	const actionsColumn: DataColumn<Row> = {
		id: 'actions',
		header: '',
		srHeader: 'Actions',
		cell: actionsCell,
		class: 'w-0 pr-4'
	};
	const activeColumns: DataColumn<Row>[] = [
		nameColumn,
		{ id: 'status', header: 'Status', value: (row) => row.status, cell: statusCell },
		{
			id: 'node',
			header: 'Node',
			value: nodeOf,
			cell: nodeCell,
			class: 'hidden font-mono text-xs md:table-cell'
		},
		{
			id: 'machines',
			header: 'Machines',
			value: (row) => row.agents,
			searchable: false,
			descFirst: true,
			cell: machinesCell,
			class: 'hidden font-mono text-xs tabular-nums lg:table-cell'
		},
		{
			id: 'api',
			header: 'API',
			value: (row) => row.apiUrl ?? 'private',
			sortable: false,
			cell: apiCell,
			class: 'hidden font-mono text-xs xl:table-cell'
		},
		actionsColumn
	];
	const trashColumns: DataColumn<Row>[] = [
		nameColumn,
		{
			id: 'node',
			header: 'Node',
			value: nodeOf,
			cell: nodeCell,
			class: 'hidden font-mono text-xs text-muted-foreground sm:table-cell'
		},
		{
			id: 'deleted',
			header: 'Deleted',
			value: (row) => row.deletedAt,
			searchable: false,
			descFirst: true,
			cell: deletedCell,
			class: 'hidden font-mono text-xs text-muted-foreground sm:table-cell'
		},
		{
			id: 'purge',
			header: 'Purge',
			value: (row) => row.purgeAt,
			searchable: false,
			cell: purgeCell,
			class: 'text-xs text-muted-foreground'
		},
		actionsColumn
	];

	function setView(value: string) {
		const href = resolve('/(dashboard)/kubernetes');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route, only `?view` changes
		void goto(value === 'trash' ? `${href}?view=trash` : href);
	}

	function restartOne(name: string) {
		askConfirm({
			title: `Restart ${name}?`,
			description:
				'Every machine stops and starts again. Running pods restart with their nodes; cluster state and volumes are kept.',
			confirmLabel: 'Restart',
			tone: 'danger',
			action: '?/restart',
			fields: { name }
		});
	}

	function purge(name: string) {
		askConfirm({
			title: `Delete ${name} permanently?`,
			description:
				'Its node deletes every machine’s data directory: cluster state, local volumes and images. This cannot be undone.',
			confirmLabel: 'Delete permanently',
			tone: 'danger',
			typeToConfirm: name,
			action: '?/purge',
			fields: { name }
		});
	}
</script>

<svelte:head>
	<title>{trashView ? 'Kubernetes trash' : 'Kubernetes'} · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.kubernetes"
		eyebrow="Workloads"
		title="Kubernetes"
		description="Managed k3s clusters. Yoal runs, patches and routes them; you use kubectl, Helm or Argo CD with access that follows your Yoal role."
	>
		{#if data.kubernetesCan.create && data.enabled}
			<Button onclick={() => (createOpen = true)}>
				<PlusIcon />
				New cluster
			</Button>
		{/if}
	</PageHeader>

	{#if !data.enabled}
		<Notice tone="warning" title="Kubernetes is switched off">
			Set <code class="font-mono">YOAL_FEATURE_KUBERNETES=1</code> to create new clusters. Existing ones
			keep running.
		</Notice>
	{:else if data.nodes.length === 0}
		<Notice tone="info" title="No node runs Kubernetes yet">
			A platform admin installs the optional component from Settings → Kubernetes. Clusters are only
			placed on nodes that have it.
		</Notice>
	{/if}

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Clusters are not visible"
			description="This account does not have the kubernetes:read permission."
		/>
	{:else}
		<Tabs.Root value={data.view} onValueChange={setView}>
			<Tabs.List variant="line" class="w-full justify-start border-b" aria-label="Cluster lists">
				<Tabs.Trigger value="live" class="flex-none">
					<ShipWheelIcon />
					Clusters
					<span class="font-mono text-xs text-muted-foreground">{data.clusters.length}</span>
				</Tabs.Trigger>
				<Tabs.Trigger value="trash" class="flex-none">
					<Trash2Icon />
					Trash
					<span class="font-mono text-xs text-muted-foreground">{data.trash.length}</span>
				</Tabs.Trigger>
			</Tabs.List>
		</Tabs.Root>

		{#if rows.length === 0}
			{#if trashView}
				<EmptyState
					icon={Trash2Icon}
					title="The trash is empty"
					description={`Deleted clusters stay here for ${data.policies.trashDays} days with their data intact, then they are permanently deleted.`}
				/>
			{:else}
				<EmptyState
					icon={ShipWheelIcon}
					title="No clusters yet"
					description="Create a k3s cluster on a node with the Kubernetes component, then download a kubeconfig with yoal k8s kubeconfig."
				>
					{#if data.kubernetesCan.create && data.enabled && data.nodes.length > 0}
						<Button onclick={() => (createOpen = true)}><PlusIcon />Create cluster</Button>
					{/if}
				</EmptyState>
			{/if}
		{:else}
			<div class="flex flex-wrap items-center justify-between gap-3">
				<InputGroup.Root class="max-w-xs bg-card">
					<InputGroup.Input
						placeholder={trashView ? 'Search the trash' : 'Search clusters'}
						bind:value={query}
						aria-label={trashView ? 'Search the trash' : 'Search clusters'}
					/>
					<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
					{#if query}
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">{matched}</InputGroup.Text>
						</InputGroup.Addon>
					{/if}
				</InputGroup.Root>
				<p class="text-sm text-muted-foreground">
					{#if trashView}
						{rows.length} in the trash · purged after {data.policies.trashDays} days
					{:else}
						{rows.length}
						{rows.length === 1 ? 'cluster' : 'clusters'}
					{/if}
				</p>
			</div>

			<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
				<DataTable
					label={trashView ? 'Deleted clusters' : 'Kubernetes clusters'}
					{rows}
					columns={trashView ? trashColumns : activeColumns}
					rowId={(row) => row.id}
					search={query.trim()}
					sort={trashView ? { id: 'deleted', desc: true } : { id: 'name', desc: false }}
					onmatch={(count) => (matched = count)}
				/>
			</div>
		{/if}
	{/if}
</div>

{#if data.kubernetesCan.create && data.enabled}
	<FormDialog
		bind:open={createOpen}
		icon={ShipWheelIcon}
		title="New Kubernetes cluster"
		description="A k3s server, plus optional agent machines, on one node. Placement is decided once and never moves."
		action="?/create"
		submitLabel="Create cluster"
		size="lg"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.name ? true : undefined}>
				<Field.Label for="k8s-name">Name</Field.Label>
				<Input
					id="k8s-name"
					name="name"
					placeholder="lab"
					minlength={3}
					maxlength={40}
					required
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
					aria-invalid={errors.name ? 'true' : undefined}
				/>
				<Field.Description>3–40 lowercase letters, digits and single hyphens.</Field.Description>
				{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
			</Field.Field>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.version ? true : undefined}>
					<Field.Label for="k8s-version">Version</Field.Label>
					<NativeSelect.Root
						id="k8s-version"
						name="version"
						value={data.defaults.minor}
						class="w-full"
					>
						{#each data.versions as version (version.minor)}
							<NativeSelect.Option value={version.minor}
								>{version.minor} ({version.release.replace(/^v/, '').replace(/\+k3s\d+$/, '')},
								until {version.endOfSupport})</NativeSelect.Option
							>
						{/each}
					</NativeSelect.Root>
					{#if errors.version}<Field.Error>{errors.version}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.placement ? true : undefined}>
					<Field.Label for="k8s-placement">Node</Field.Label>
					<NativeSelect.Root
						id="k8s-placement"
						name="placement"
						bind:value={placement}
						class="w-full"
						disabled={spread}
					>
						<NativeSelect.Option value="auto">Auto — most free memory</NativeSelect.Option>
						{#each data.nodes as node (node.id)}
							<NativeSelect.Option value={node.id}
								>{node.name} ({node.tiers.join(', ') || 'no tier'}{node.dedicatedTo
									? ', dedicated'
									: ''})</NativeSelect.Option
							>
						{/each}
					</NativeSelect.Root>
					{#if errors.placement}<Field.Error>{errors.placement}</Field.Error>{/if}
				</Field.Field>
			</div>

			<div class="grid gap-4 sm:grid-cols-3">
				<Field.Field data-invalid={errors.memoryMb ? true : undefined}>
					<Field.Label for="k8s-memory">Memory per machine</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="k8s-memory"
							name="memoryMb"
							type="number"
							min={data.defaults.minMemoryMb}
							max={data.defaults.maxMemoryMb}
							step={256}
							value={String(data.defaults.memoryMb)}
							class="font-mono text-sm"
							aria-invalid={errors.memoryMb ? 'true' : undefined}
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>
					{#if errors.memoryMb}<Field.Error>{errors.memoryMb}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.cpus ? true : undefined}>
					<Field.Label for="k8s-cpus">CPUs per machine</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="k8s-cpus"
							name="cpus"
							type="number"
							min={0.5}
							max={32}
							step={0.5}
							value={String(data.defaults.cpus)}
							class="font-mono text-sm"
							aria-invalid={errors.cpus ? 'true' : undefined}
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">vCPU</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>
					{#if errors.cpus}<Field.Error>{errors.cpus}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.agents ? true : undefined}>
					<Field.Label for="k8s-agents">Agent machines</Field.Label>
					<Input
						id="k8s-agents"
						name="agents"
						type="number"
						min={0}
						max={data.defaults.maxAgents}
						step={1}
						value="0"
						class="font-mono text-sm"
						aria-invalid={errors.agents ? 'true' : undefined}
					/>
					<Field.Description>0 runs pods on the server.</Field.Description>
					{#if errors.agents}<Field.Error>{errors.agents}</Field.Error>{/if}
				</Field.Field>
			</div>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.tier ? true : undefined}>
					<Field.Label for="k8s-tier">Isolation tier</Field.Label>
					<NativeSelect.Root id="k8s-tier" name="tier" bind:value={tier} class="w-full">
						<NativeSelect.Option value="">Default (userns)</NativeSelect.Option>
						{#each tierChoices as choice (choice)}
							<NativeSelect.Option value={choice}>{choice}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					{#if errors.tier}<Field.Error>{errors.tier}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.apiAccess ? true : undefined}>
					<Field.Label for="k8s-api">API access</Field.Label>
					<NativeSelect.Root id="k8s-api" name="apiAccess" bind:value={apiAccess} class="w-full">
						<NativeSelect.Option value="public">Public HTTPS endpoint</NativeSelect.Option>
						<NativeSelect.Option value="private">Private (overlay only)</NativeSelect.Option>
					</NativeSelect.Root>
					{#if errors.apiAccess}<Field.Error>{errors.apiAccess}</Field.Error>{/if}
				</Field.Field>
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.purpose ? true : undefined}>
					<Field.Label for="k8s-purpose">Purpose</Field.Label>
					<NativeSelect.Root id="k8s-purpose" name="purpose" bind:value={purpose} class="w-full">
						<NativeSelect.Option value="lab">Lab</NativeSelect.Option>
						<NativeSelect.Option value="production">Production</NativeSelect.Option>
					</NativeSelect.Root>
					<Field.Description>
						{purpose === 'production'
							? 'Hourly snapshots and the pod-log shipper by default; can run three servers.'
							: 'Daily snapshots, no log shipper; one server on SQLite.'}
					</Field.Description>
					{#if errors.purpose}<Field.Error>{errors.purpose}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.servers ? true : undefined}>
					<Field.Label for="k8s-servers">Control plane</Field.Label>
					<NativeSelect.Root id="k8s-servers" name="servers" bind:value={servers} class="w-full">
						<NativeSelect.Option value="1">1 server (SQLite)</NativeSelect.Option>
						<NativeSelect.Option value="3">3 servers (etcd, highly available)</NativeSelect.Option>
					</NativeSelect.Root>
					{#if servers === '3'}
						<Field.Description>Needs three nodes with the Kubernetes component.</Field.Description>
					{/if}
					{#if errors.servers}<Field.Error>{errors.servers}</Field.Error>{/if}
				</Field.Field>
			</div>

			{#if data.nodes.length > 1}
				<Field.Field orientation="horizontal">
					<Checkbox
						id="k8s-spread"
						checked={spread}
						onCheckedChange={(value) => (spread = value === true)}
					/>
					<Field.Label for="k8s-spread">Spread machines across several nodes</Field.Label>
				</Field.Field>
				{#if spread}
					<Field.Field data-invalid={errors.nodes ? true : undefined}>
						<div class="flex flex-wrap gap-x-4 gap-y-2">
							{#each data.nodes as node (node.id)}
								<label class="flex items-center gap-2 text-sm">
									<Checkbox
										name="nodes"
										value={node.id}
										checked={spreadNodes.includes(node.id)}
										onCheckedChange={(value) => toggleNode(node.id, value === true)}
									/>
									<span class="font-mono">{node.name}</span>
								</label>
							{/each}
						</div>
						<Field.Description
							>Machines are placed across these nodes over the overlay network.</Field.Description
						>
						{#if errors.nodes}<Field.Error>{errors.nodes}</Field.Error>{/if}
					</Field.Field>
				{/if}
			{/if}

			{#if tier === 'trusted'}
				<Notice tone="warning" title="Trusted tier">
					Machines run privileged without a user namespace: cluster admins can become root on this
					node. Only nodes dedicated to your org offer it.
				</Notice>
			{/if}

			{#if apiAccess === 'public'}
				<Field.Field data-invalid={errors.allowCidrs ? true : undefined}>
					<Field.Label for="k8s-allow">
						API allowlist <span class="font-normal text-muted-foreground">optional</span>
					</Field.Label>
					<Textarea
						id="k8s-allow"
						name="allowCidrs"
						rows={2}
						placeholder="203.0.113.0/24, 198.51.100.7/32"
						spellcheck="false"
						class="font-mono text-xs"
					/>
					<Field.Description
						>CIDRs, comma or newline separated. Empty lets any address reach the endpoint; every
						request still needs a token.</Field.Description
					>
					{#if errors.allowCidrs}<Field.Error>{errors.allowCidrs}</Field.Error>{/if}
				</Field.Field>
			{/if}

			<StorageSelect
				choices={data.storageChoices}
				id="k8s-storage"
				value={result?.values?.storage ?? ''}
			/>
			<p class="text-xs text-muted-foreground">
				Each machine reserves its memory from the node's workload slice. Persistent volumes are
				node-local (<span class="font-mono">local-path</span>): keep data that matters in an
				attached database or bucket.
			</p>
		</Field.Group>
	</FormDialog>
{/if}

{#snippet nameCell(item: Row)}
	<div class="flex items-center gap-3">
		<span
			class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
		>
			<ShipWheelIcon class="size-4" />
		</span>
		<div class="min-w-0">
			<a
				href={resolve('/(dashboard)/kubernetes/[name]', { name: item.name })}
				class="font-mono text-sm font-medium underline-offset-4 group-hover:underline"
				>{item.name}</a
			>
			<p class="text-xs text-muted-foreground">
				Kubernetes {item.displayVersion}{#if item.upgradeTo}<span>
						· {item.upgradeTo} available</span
					>{/if}
			</p>
		</div>
	</div>
{/snippet}

{#snippet statusCell(item: Row)}
	<div class="flex items-center gap-1.5">
		<StatusBadge status={item.status} />
		{#if item.tier === 'trusted'}<Badge variant="warning">trusted</Badge>{/if}
	</div>
{/snippet}

{#snippet nodeCell(item: Row)}
	{nodeOf(item)}
{/snippet}

{#snippet machinesCell(item: Row)}
	{1 + item.agents} × {item.memoryMb} MB{#if item.nodesReady !== null}<span
			class="text-muted-foreground"
		>
			· {item.nodesReady}/{item.nodesTotal} ready</span
		>{/if}
{/snippet}

{#snippet apiCell(item: Row)}
	{#if item.apiUrl}{item.apiUrl.replace(/^https:\/\//, '')}{:else}<span
			class="text-muted-foreground">private</span
		>{/if}
{/snippet}

{#snippet deletedCell(item: Row)}
	<time datetime={item.deletedAt}>{formatDate(item.deletedAt)}</time>
{/snippet}

{#snippet purgeCell(item: Row)}
	<time datetime={item.purgeAt}>{purgeCountdown(item.purgeAt)}</time>
{/snippet}

{#snippet actionsCell(item: Row)}
	{@const href = resolve('/(dashboard)/kubernetes/[name]', { name: item.name })}
	{#if trashView}
		{#if data.kubernetesCan.delete}
			<RowMenu label="Actions for {item.name}">
				<DropdownMenu.Item onSelect={() => void runAction('?/restore', { name: item.name })}>
					<RotateCcwIcon />Restore
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" onSelect={() => purge(item.name)}>
					<TrashIcon />Delete permanently
				</DropdownMenu.Item>
			</RowMenu>
		{/if}
	{:else}
		<RowMenu label="Actions for {item.name}">
			{#if data.kubernetesCan.update}
				<DropdownMenu.Item onSelect={() => restartOne(item.name)}>
					<RotateCcwIcon />Restart
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
			{/if}
			<DropdownMenu.Item onSelect={() => goto(href)}>
				<ArrowRightIcon />Open cluster
			</DropdownMenu.Item>
			<DropdownMenu.Item
				onSelect={() => goto(resolve('/(dashboard)/kubernetes/[name]/logs', { name: item.name }))}
			>
				<ScrollTextIcon />Logs
			</DropdownMenu.Item>
		</RowMenu>
	{/if}
{/snippet}
