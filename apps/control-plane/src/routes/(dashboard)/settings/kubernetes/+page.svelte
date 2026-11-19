<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import type { KubernetesComponentView } from '@yoal/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatRelative } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const errors = $derived(
		(form as { fieldErrors?: Record<string, string> } | null)?.fieldErrors ?? {}
	);

	// Installs take minutes: refresh while any node has a request in flight.
	const pending = $derived(data.components.some((item) => item.pending !== null));
	$effect(() => {
		if (!pending) return;
		const timer = setInterval(() => void invalidateAll(), 5_000);
		return () => clearInterval(timer);
	});

	let removeOpen = $state(false);
	let removing = $state<KubernetesComponentView | null>(null);
	let grantOpen = $state(false);

	function install(item: KubernetesComponentView) {
		askConfirm({
			title: `Install Kubernetes on ${item.nodeName}?`,
			description:
				'The node downloads the pinned k3s images for every supported version and probes which isolation tiers work. It takes a few minutes and does not restart anything running there.',
			confirmLabel: 'Install',
			action: '?/install',
			fields: { nodeId: item.nodeId }
		});
	}

	function openRemove(item: KubernetesComponentView) {
		removing = item;
		removeOpen = true;
	}

	function revoke(orgId: string) {
		askConfirm({
			title: `Revoke the trusted tier for ${orgId}?`,
			description:
				'The org can no longer create trusted-tier clusters. Refused while it still has any; delete those first.',
			confirmLabel: 'Revoke',
			tone: 'danger',
			action: '?/revoke',
			fields: { orgId }
		});
	}
</script>

<svelte:head>
	<title>Kubernetes · Settings · Yoal</title>
</svelte:head>

<SettingsHeader id="kubernetes" />

<div class="mt-5 space-y-5">
	{#if !data.enabled}
		<Notice tone="warning" title="Kubernetes is switched off">
			Set <code class="font-mono">YOAL_FEATURE_KUBERNETES=1</code> to let orgs create clusters. You can
			still install the component on nodes ahead of time.
		</Notice>
	{/if}

	<Panel
		title="Node component"
		icon={ServerIcon}
		description="Clusters are placed only on nodes with the component. Nodes that never install it download nothing."
	>
		{#snippet actions()}
			{#if pending}
				<span class="flex items-center gap-1.5 text-xs text-muted-foreground"
					><Spinner />Waiting for nodes…</span
				>
			{/if}
		{/snippet}
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Node</Table.Head>
					<Table.Head>Component</Table.Head>
					<Table.Head class="hidden md:table-cell">Versions · tiers</Table.Head>
					<Table.Head class="hidden lg:table-cell">Last change</Table.Head>
					<Table.Head class="text-right"><span class="sr-only">Actions</span></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.components as item (item.nodeId)}
					<Table.Row>
						<Table.Cell>
							<div class="font-mono text-sm">{item.nodeName}</div>
							<div class="text-xs text-muted-foreground">
								{item.machines}
								{item.machines === 1 ? 'machine' : 'machines'}{#if item.dedicatedTo}
									· dedicated to <span class="font-mono">{item.dedicatedTo}</span>{/if}
							</div>
						</Table.Cell>
						<Table.Cell>
							{#if item.pending}
								<Badge variant="info"
									><Spinner />{item.pending.action === 'install' ? 'Installing' : 'Removing'}</Badge
								>
								<div class="mt-1 text-xs text-muted-foreground">
									requested {formatRelative(item.pending.requestedAt)}
								</div>
							{:else if item.error}
								<Badge variant="danger">Error</Badge>
							{:else if item.installed}
								<Badge variant="success">Installed</Badge>
							{:else}
								<Badge variant="neutral">Not installed</Badge>
							{/if}
							{#if item.error}
								<p class="mt-1 max-w-xs text-xs text-destructive">{item.error}</p>
							{/if}
						</Table.Cell>
						<Table.Cell class="hidden md:table-cell">
							{#if item.minors.length > 0}
								<div class="font-mono text-xs">{item.minors.join(', ')}</div>
								<div class="mt-1 flex flex-wrap gap-1">
									{#each item.tiers as tier (tier)}
										<Badge variant={tier === 'trusted' ? 'warning' : 'outline'}>{tier}</Badge>
									{:else}
										<span class="text-xs text-muted-foreground">no working tier</span>
									{/each}
								</div>
							{:else}
								<span class="text-xs text-muted-foreground">—</span>
							{/if}
						</Table.Cell>
						<Table.Cell class="hidden text-xs lg:table-cell">
							{#if item.lastResult}
								<span class={item.lastResult.ok ? 'text-muted-foreground' : 'text-destructive'}>
									{item.lastResult.action}
									{item.lastResult.ok ? 'succeeded' : 'failed'}
									{formatRelative(item.lastResult.at)}
								</span>
								{#if item.lastResult.message}
									<p class="max-w-xs text-muted-foreground">{item.lastResult.message}</p>
								{/if}
							{:else}
								<span class="text-muted-foreground">—</span>
							{/if}
						</Table.Cell>
						<Table.Cell class="text-right">
							{#if !item.pending}
								{#if item.installed || item.error}
									<Button variant="outline" size="sm" onclick={() => openRemove(item)}>
										<Trash2Icon />Remove
									</Button>
								{/if}
								{#if !item.installed}
									<Button variant="outline" size="sm" onclick={() => install(item)}>
										<DownloadIcon />{item.error ? 'Reinstall' : 'Install'}
									</Button>
								{/if}
							{/if}
						</Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row>
						<Table.Cell colspan={5} class="text-sm text-muted-foreground">No nodes yet.</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
		<p class="mt-3 text-xs text-muted-foreground">
			The <span class="font-mono">trusted</span> tier only appears on nodes labelled
			<span class="font-mono">kubernetes=dedicated:&lt;org&gt;</span>. Removing the component is
			refused while cluster machines run on the node.
		</p>
	</Panel>

	<Panel
		title="Trusted tier"
		icon={ShieldAlertIcon}
		description="Orgs allowed to create trusted-tier clusters: privileged k3s without a user namespace. Cluster admins can become root on the node, so the node must be dedicated to that org."
	>
		{#snippet actions()}
			<Button variant="outline" size="sm" onclick={() => (grantOpen = true)}
				><PlusIcon />Grant</Button
			>
		{/snippet}
		{#if data.trustedOrgs.length === 0}
			<p class="text-sm text-muted-foreground">
				No org holds the trusted tier. Everyone uses userns.
			</p>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Org</Table.Head>
						<Table.Head>Granted</Table.Head>
						<Table.Head class="text-right"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.trustedOrgs as grant (grant.orgId)}
						<Table.Row>
							<Table.Cell class="font-mono text-sm">{grant.orgId}</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground">
								{formatRelative(grant.grantedAt)} by
								<span class="font-mono">{grant.grantedBy}</span>
							</Table.Cell>
							<Table.Cell class="text-right">
								<Button variant="ghost" size="sm" onclick={() => revoke(grant.orgId)}>Revoke</Button
								>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>
</div>

<FormDialog
	bind:open={removeOpen}
	icon={Trash2Icon}
	title="Remove Kubernetes from {removing?.nodeName ?? 'node'}?"
	description="The node stops offering the kubernetes capability. Refused while cluster machines still run there; delete those clusters first."
	action="?/remove"
	submitLabel="Remove component"
	submitVariant="destructive"
>
	<input type="hidden" name="nodeId" value={removing?.nodeId ?? ''} />
	<Field.Field orientation="horizontal">
		<Checkbox id="component-purge" name="purge" value="on" />
		<Field.Label for="component-purge">Also delete the cached k3s images and data</Field.Label>
	</Field.Field>
</FormDialog>

<FormDialog
	bind:open={grantOpen}
	icon={ShieldAlertIcon}
	title="Grant the trusted tier"
	description="Cluster admins in this org can become root on the node their trusted cluster runs on. Only grant it to orgs you trust with that node."
	action="?/grant"
	submitLabel="Grant"
>
	<Field.Field data-invalid={errors.orgId ? true : undefined}>
		<Field.Label for="grant-org">Org id</Field.Label>
		<Input
			id="grant-org"
			name="orgId"
			required
			maxlength={100}
			spellcheck="false"
			class="font-mono text-sm"
		/>
		{#if errors.orgId}<Field.Error>{errors.orgId}</Field.Error>{/if}
	</Field.Field>
</FormDialog>
