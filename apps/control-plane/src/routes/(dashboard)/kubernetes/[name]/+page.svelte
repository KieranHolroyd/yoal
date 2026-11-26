<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import LogsIcon from '@lucide/svelte/icons/logs';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import { notify, runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DetailList from '#lib/components/yoal/DetailList.svelte';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import CopyValue from '../../_lib/service/CopyValue.svelte';
	import DangerZone from '../../_lib/service/DangerZone.svelte';
	import { readTab, tabHref } from '../../_lib/service/sections.js';
	import { formatBytes, formatDate, formatDateTime, formatRelative } from '../../_lib/format.js';
	import { purgeCountdown } from '../../_lib/operations/copy.js';
	import ClusterHeader from '../_lib/ClusterHeader.svelte';
	import LogExplorer from '#lib/logs/LogExplorer.svelte';
	import WriteConfig from '../_lib/WriteConfig.svelte';
	import { clusterSubnavKey } from '../_lib/subnav.js';
	import { useSubnavLocal } from '#lib/nav/subnav-local.svelte.js';
	import {
		KUBERNETES_DEFAULT_TAB,
		KUBERNETES_TABS,
		type KubernetesTab
	} from '../_lib/kubernetes-tabs.js';
	import type { PageProps } from './$types';

	interface ClusterFormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
		section?: string;
		createdKey?: { name: string; role: string; kubeconfig: string };
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as ClusterFormResult | null);
	const errors = $derived(result?.fieldErrors ?? {});

	const cluster = $derived(data.cluster);
	const can = $derived(data.kubernetesCan);
	const deleted = $derived(cluster.deletedAt !== null);
	const nodeLabel = $derived(cluster.nodeName ?? cluster.nodeId);
	const live = $derived(!deleted);

	let tab = $state<KubernetesTab>(
		readTab(page.url.searchParams.get('tab'), KUBERNETES_TABS, KUBERNETES_DEFAULT_TAB)
	);

	/** Switch sections in place (no reload), keeping `?tab=` deep-linkable. */
	function setTab(next: KubernetesTab) {
		tab = next;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only `?tab` changes
		replaceState(tabHref(page.url.pathname + page.url.search, next, KUBERNETES_DEFAULT_TAB), {});
	}

	/** The sidebar lists the sections; in-place ones switch here without a page load. */
	useSubnavLocal(() => ({
		key: clusterSubnavKey(cluster.name),
		active: tab,
		select: (id) => {
			if (!KUBERNETES_TABS.includes(id as KubernetesTab)) return false;
			setTab(id as KubernetesTab);
			return true;
		}
	}));

	const kubeconfigSnippet = $derived(
		[
			`yoal k8s kubeconfig ${cluster.name} --write`,
			`export KUBECONFIG=~/.kube/yoal-${cluster.name}.yaml`,
			'kubectl get nodes'
		].join('\n')
	);

	const machineLabel = (machine: { role: string; ordinal: number }) =>
		machine.role === 'server' ? `server-${machine.ordinal}` : `agent-${machine.ordinal}`;

	// --- backups (K14) and HA (K17) --------------------------------------------------------------

	let restoreOpen = $state(false);
	let restoreFrom = $state<{ id: string; createdAt: string } | null>(null);

	function openRestore(backup: { id: string; createdAt: string }) {
		restoreFrom = backup;
		restoreOpen = true;
	}

	function makeHa() {
		askConfirm({
			title: `Make ${cluster.name} highly available?`,
			description:
				'Yoal snapshots the cluster, converts its SQLite datastore to embedded etcd in place, then adds two servers on other capable nodes. The API stays up except for a short restart of the first server. Servers never go back down to one.',
			confirmLabel: 'Make highly available',
			action: '?/makeHa'
		});
	}

	function makeProduction() {
		askConfirm({
			title: `Make ${cluster.name} a production cluster?`,
			description:
				'Production clusters snapshot hourly and ship pod logs by default, and can be made highly available.',
			confirmLabel: 'Switch to production',
			action: '?/makeProduction'
		});
	}

	const backupTone = (status: string) =>
		status === 'ok' ? 'success' : status === 'failed' ? 'danger' : 'info';

	// --- access keys (K19): the kubeconfig comes back in the action result once, never page data ---

	let keyOpen = $state(false);

	function revokeKey(name: string) {
		askConfirm({
			title: `Revoke ${name}?`,
			description:
				'Its ServiceAccount and binding leave the cluster on the next reconcile, which ends its access at once. Tools using it stop working.',
			confirmLabel: 'Revoke',
			tone: 'danger',
			action: '?/revokeKey',
			fields: { key: name }
		});
	}

	const activeKeys = $derived(data.accessKeys.filter((key) => !key.revokedAt));

	// --- routes and attachments --------------------------------------------------------------------

	let routeOpen = $state(false);
	let attachOpen = $state(false);
	let attachTarget = $state('');
	const attachName = $derived(attachTarget.split(':').slice(1).join(':'));

	function removeRoute(host: string) {
		askConfirm({
			title: `Remove ${host}?`,
			description: 'The hostname stops reaching the cluster’s ingress and is free to claim again.',
			confirmLabel: 'Remove route',
			tone: 'danger',
			action: '?/removeRoute',
			fields: { host }
		});
	}

	function detach(attachment: { id: string; name: string; namespace: string; secret: string }) {
		askConfirm({
			title: `Detach ${attachment.name}?`,
			description: `Secret ${attachment.namespace}/${attachment.secret} is removed from the cluster. Pods that read it keep their current values until they restart.`,
			confirmLabel: 'Detach',
			tone: 'danger',
			action: '?/detach',
			fields: { id: attachment.id }
		});
	}

	function moveToTrash() {
		askConfirm({
			title: `Delete ${cluster.name}?`,
			description:
				'Its machines stop and the cluster moves to the trash. Its data stays on the node.',
			confirmLabel: 'Move to trash',
			tone: 'danger',
			typeToConfirm: cluster.name,
			action: '?/delete'
		});
	}

	function upgrade(version: string) {
		askConfirm({
			title: `Upgrade ${cluster.name} to ${version}?`,
			description:
				'Servers upgrade first, then agents, one at a time; each is drained and rolled back if its API does not come ready. A new minor can remove deprecated APIs: check your manifests first. Downgrades are refused.',
			confirmLabel: `Upgrade to ${version}`,
			action: '?/upgrade',
			fields: { version }
		});
	}

	/** Re-run page data after an inline settings form and toast the outcome. */
	const submitInline: SubmitFunction = () => {
		return async ({ result: outcome, update }) => {
			await update({ reset: false });
			notify(outcome);
		};
	};

	const hours = Array.from({ length: 24 }, (_, hour) => hour);
</script>

<svelte:head>
	<title>{cluster.name} · Kubernetes · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<ClusterHeader {cluster} {can} />

	{#if page.url.searchParams.get('created') === '1' && cluster.status === 'pending'}
		<Notice tone="info" title="Starting on {nodeLabel}">
			The node starts the k3s machines on its next reconcile. This page shows <em>running</em> once the
			API answers and every node is Ready.
		</Notice>
	{/if}
	{#if cluster.message && !deleted}
		<Notice tone="warning" title="Cluster message">{cluster.message}</Notice>
	{/if}
	{#if cluster.restoring}
		<Notice tone="info" title="Restoring from a backup">
			The node is putting the snapshot's datastore in place. The machines start once it is done;
			until then the API does not answer.
		</Notice>
	{/if}
	{#if cluster.upgrade}
		<Notice tone="info" title="Rollout in progress: {cluster.upgrade.from} → {cluster.upgrade.to}">
			Started {formatRelative(cluster.upgrade.startedAt)}. Servers go first, then agents, one
			machine at a time; each is drained and rolled back if its API does not come ready.{#if cluster.upgrade.message}
				<span class="font-mono text-xs"> {cluster.upgrade.message}</span>{/if}
		</Notice>
	{/if}
	{#if cluster.deprecatedApis.length > 0 && !deleted}
		<Notice tone="warning" title="Deprecated APIs in use">
			Clients still call APIs that a later minor removes: <span class="font-mono text-xs"
				>{cluster.deprecatedApis.join(', ')}</span
			>. Move those manifests to the current API versions before upgrading.
		</Notice>
	{/if}
	{#if deleted}
		<Notice tone="warning" title="In the trash">
			The machines are stopped; their data stays on {nodeLabel} until
			<time datetime={cluster.purgeAt}>{purgeCountdown(cluster.purgeAt)}</time>. Restore it from the
			header.
		</Notice>
	{/if}

	{#if tab === 'overview'}
		<div class="grid items-start gap-5 xl:grid-cols-5">
			<Panel title="Cluster" icon={LayoutDashboardIcon} class="xl:col-span-3">
				<DetailList>
					<dt>Status</dt>
					<dd><StatusBadge status={deleted ? 'deleted' : cluster.status} /></dd>
					<dt>Version</dt>
					<dd class="font-mono text-xs">
						{cluster.displayVersion}
						<span class="text-muted-foreground">({cluster.release})</span>
					</dd>
					<dt>Upgrade</dt>
					<dd class="text-xs">
						{#if cluster.upgradeTo}
							<Badge variant="info">{cluster.upgradeTo} available</Badge>
						{:else}
							<span class="text-muted-foreground">Newest minor; patches apply in the window</span>
						{/if}
					</dd>
					<dt>End of support</dt>
					<dd class="font-mono text-xs">{cluster.endOfSupport ?? '—'}</dd>
					<dt>API</dt>
					<dd>
						{#if cluster.apiUrl}
							<CopyValue value={cluster.apiUrl} label="API URL" />
						{:else}
							<span class="text-xs text-muted-foreground">Private (no public endpoint)</span>
						{/if}
					</dd>
					<dt>Node</dt>
					<dd class="font-mono text-xs">{nodeLabel}</dd>
					<dt>Tier</dt>
					<dd>
						<Badge variant={cluster.tier === 'trusted' ? 'warning' : 'outline'}
							>{cluster.tier}</Badge
						>
					</dd>
					<dt>Nodes ready</dt>
					<dd class="font-mono text-xs tabular-nums">
						{#if cluster.nodesReady === null}
							<span class="text-muted-foreground">—</span>
						{:else}
							{cluster.nodesReady}/{cluster.nodesTotal}
							{#if cluster.statsAt}<span class="text-muted-foreground">
									· {formatRelative(cluster.statsAt)}</span
								>{/if}
						{/if}
					</dd>
					<dt>Purpose</dt>
					<dd class="text-xs">{cluster.purpose}</dd>
					<dt>Control plane</dt>
					<dd class="text-xs">
						{cluster.servers}
						{cluster.servers === 1 ? 'server' : 'servers'} ·
						<span class="font-mono">{cluster.datastore}</span>{#if cluster.servers >= 3}
							<Badge variant="success" class="ml-1">HA</Badge>{/if}{#if cluster.multiNode}
							<span class="text-muted-foreground"> · multi-node</span>{/if}
					</dd>
					<dt>Backups</dt>
					<dd class="text-xs">
						every {cluster.backup.hours} h ·
						{#if cluster.backup.lastAt}
							last {formatRelative(cluster.backup.lastAt)} ({cluster.backup.lastStatus ?? '—'})
						{:else}
							none yet
						{/if}
					</dd>
				</DetailList>
				{#if cluster.tier === 'trusted'}
					<Notice tone="warning" title="Trusted tier" class="mt-4">
						Machines run privileged without a user namespace: cluster admins can become root on this
						node.
					</Notice>
				{/if}
			</Panel>

			<Panel title="Connect" icon={TerminalIcon} class="xl:col-span-2">
				{#if cluster.apiUrl}
					<CodeBlock code={kubeconfigSnippet} label="shell" />
					<p class="mt-3 text-xs text-muted-foreground">
						The kubeconfig holds no secret: kubectl runs <code class="font-mono"
							>yoal k8s token {cluster.name}</code
						> for a 15-minute token. Your access follows your Yoal role.
					</p>
				{:else}
					<p class="text-sm text-muted-foreground">
						The API is private. Switch API access to public in Settings to reach it with kubectl
						from here.
					</p>
				{/if}
			</Panel>
		</div>

		<Panel
			title="Machines"
			icon={ServerIcon}
			count={cluster.machines.length}
			description="Each k3s server or agent is a container on {nodeLabel} with its own memory and CPU limit."
			flush
		>
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">Machine</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="hidden sm:table-cell">Node</Table.Head>
						<Table.Head class="hidden lg:table-cell">Overlay IP</Table.Head>
						<Table.Head class="hidden lg:table-cell">Release</Table.Head>
						<Table.Head class="hidden md:table-cell">Size</Table.Head>
						<Table.Head class="pr-4 text-right">Restarts</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each cluster.machines as machine (machine.id)}
						<Table.Row>
							<Table.Cell class="pl-4 font-mono text-sm">{machineLabel(machine)}</Table.Cell>
							<Table.Cell><StatusBadge status={machine.status} /></Table.Cell>
							<Table.Cell class="hidden font-mono text-xs sm:table-cell"
								>{machine.nodeName ?? machine.nodeId}</Table.Cell
							>
							<Table.Cell class="hidden font-mono text-xs lg:table-cell"
								>{machine.overlayIp ?? '—'}</Table.Cell
							>
							<Table.Cell class="hidden font-mono text-xs lg:table-cell"
								>{machine.release.replace(/^v/, '')}{#if machine.release !== cluster.release}
									<Badge variant="info" class="ml-1">rolling</Badge>{/if}</Table.Cell
							>
							<Table.Cell class="hidden font-mono text-xs tabular-nums md:table-cell"
								>{machine.memoryMb} MB · {machine.cpus} vCPU</Table.Cell
							>
							<Table.Cell class="pr-4 text-right font-mono text-xs tabular-nums"
								>{machine.restarts}</Table.Cell
							>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Panel>
	{:else if tab === 'access'}
		<Panel
			title="kubectl"
			icon={TerminalIcon}
			description="Download a kubeconfig that runs the Yoal CLI for each token."
		>
			{#if cluster.apiUrl}
				<CodeBlock code={kubeconfigSnippet} label="shell" />
			{:else}
				<p class="text-sm text-muted-foreground">
					The API is private, so there is no public endpoint for a kubeconfig. Switch API access to
					public in Settings.
				</p>
			{/if}
			<div class="mt-4 text-xs text-muted-foreground">
				In-cluster access follows your Yoal role: <code class="font-mono">kubernetes:view</code> →
				<code class="font-mono">view</code>,
				<code class="font-mono">kubernetes:edit</code> → <code class="font-mono">edit</code>,
				<code class="font-mono">kubernetes:admin</code> →
				<code class="font-mono">cluster-admin</code>. Removing someone from the org ends their
				access within 15 minutes.
			</div>
		</Panel>

		{#if result?.createdKey}
			<Notice tone="success" title="Access key {result.createdKey.name} ({result.createdKey.role})">
				Copy this kubeconfig now. It carries the key's token and is not shown again.
			</Notice>
			<CodeBlock
				code={result.createdKey.kubeconfig}
				label="yoal-{cluster.name}-{result.createdKey.name}.yaml"
				lang="yaml"
			/>
		{/if}

		<Panel
			title="Access keys"
			icon={KeyRoundIcon}
			count={activeKeys.length}
			description="Static kubeconfigs for tools that cannot run the exec plugin: Argo CD, Lens, dashboards. Revoking one ends its access at once."
			flush
		>
			{#snippet actions()}
				{#if live && can.keyRoles.length > 0 && cluster.apiUrl}
					<Button variant="outline" size="sm" onclick={() => (keyOpen = true)}
						><PlusIcon />Create key</Button
					>
				{/if}
			{/snippet}
			{#if data.accessKeys.length === 0}
				<EmptyState
					icon={KeyRoundIcon}
					title="No access keys"
					description="People use yoal k8s kubeconfig. Create a key only for a tool that needs a static kubeconfig."
				/>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Key</Table.Head>
							<Table.Head>Role</Table.Head>
							<Table.Head class="hidden md:table-cell">Created</Table.Head>
							<Table.Head class="hidden md:table-cell">Expires</Table.Head>
							<Table.Head class="pr-4 text-right"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.accessKeys as key (key.id)}
							<Table.Row>
								<Table.Cell class="pl-4 font-mono text-sm">{key.name}</Table.Cell>
								<Table.Cell
									><Badge variant={key.role === 'admin' ? 'warning' : 'outline'}>{key.role}</Badge
									></Table.Cell
								>
								<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
									{formatDate(key.createdAt)} by <span class="font-mono">{key.createdBy}</span>
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
									{key.expiresAt ? formatDate(key.expiresAt) : 'never'}
								</Table.Cell>
								<Table.Cell class="pr-4 text-right">
									{#if key.revokedAt}
										<span class="text-xs text-muted-foreground"
											>revoked {formatRelative(key.revokedAt)}</span
										>
									{:else if can.update && live}
										<Button variant="ghost" size="sm" onclick={() => revokeKey(key.name)}
											>Revoke</Button
										>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Panel>
	{:else if tab === 'routes'}
		<Panel
			title="Routes"
			icon={GlobeIcon}
			count={cluster.routes.length}
			description="Public HTTPS hostnames routed to the cluster's bundled Traefik ingress. Yoal terminates TLS; create an Ingress for the host on the web entrypoint."
			flush
		>
			{#snippet actions()}
				{#if live && can.update && cluster.traefik}
					<Button variant="outline" size="sm" onclick={() => (routeOpen = true)}
						><PlusIcon />Add route</Button
					>
				{/if}
			{/snippet}
			{#if !cluster.traefik}
				<EmptyState
					icon={GlobeIcon}
					title="Ingress is off"
					description="This cluster runs without the bundled Traefik, so Yoal routes cannot reach it."
				/>
			{:else if cluster.routes.length === 0}
				<EmptyState
					icon={GlobeIcon}
					title="No routes"
					description="Claim a name under {data.contentDomain} and point an Ingress at it."
				/>
			{:else}
				<ul class="divide-y">
					{#each cluster.routes as route (route.id)}
						<li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
							<a
								href="https://{route.host}"
								target="_blank"
								rel="noreferrer"
								class="font-mono text-sm underline-offset-4 hover:underline">{route.host}</a
							>
							<div class="flex items-center gap-2">
								<span class="text-xs text-muted-foreground"
									>since {formatDate(route.createdAt)}</span
								>
								{#if can.update && live}
									<Button variant="ghost" size="sm" onclick={() => removeRoute(route.host)}>
										<TrashIcon />Remove
									</Button>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	{:else if tab === 'attachments'}
		<Panel
			title="Attachments"
			icon={PlugIcon}
			count={cluster.attachments.length}
			description="Databases and brokers whose connection values Yoal writes into the cluster as a Secret. They must run on {nodeLabel} for now."
			flush
		>
			{#snippet actions()}
				{#if live && can.attach && data.databases.length + data.brokers.length > 0}
					<Button variant="outline" size="sm" onclick={() => (attachOpen = true)}
						><PlugIcon />Attach</Button
					>
				{/if}
			{/snippet}
			{#if cluster.attachments.length === 0}
				<EmptyState
					icon={PlugIcon}
					title="Nothing attached"
					description="Attach a database or broker on {nodeLabel}; pods read it with envFrom.secretRef."
				/>
			{:else}
				<ul class="divide-y">
					{#each cluster.attachments as attachment (attachment.id)}
						<li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
							<div class="flex min-w-0 items-center gap-3">
								<Badge variant="outline">{attachment.kind}</Badge>
								<span class="font-mono text-sm font-medium">{attachment.name}</span>
								<span class="font-mono text-xs text-muted-foreground"
									>→ {attachment.namespace}/{attachment.secret}</span
								>
							</div>
							<div class="flex items-center gap-2">
								<span class="text-xs text-muted-foreground"
									>since {formatDate(attachment.createdAt)}</span
								>
								{#if can.attach && live}
									<Button variant="ghost" size="sm" onclick={() => detach(attachment)}>
										<UnplugIcon />Detach
									</Button>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	{:else if tab === 'backups'}
		<Panel
			title="Backups"
			icon={ArchiveIcon}
			count={data.backups.length}
			description="Datastore snapshots ({cluster.datastore}) in Yoal object storage: every {cluster
				.backup.hours} h, kept {cluster.backup
				.retentionDays} days, plus one before every upgrade. Persistent volume data is not included."
			flush
		>
			{#snippet actions()}
				{#if live && can.update}
					<Button variant="outline" size="sm" onclick={() => void runAction('?/backupNow')}
						><ArchiveIcon />Snapshot now</Button
					>
				{/if}
			{/snippet}
			{#if data.backups.length === 0}
				<EmptyState
					icon={ArchiveIcon}
					title="No snapshots yet"
					description={cluster.backup.nextAt
						? `The first scheduled one runs ${formatRelative(cluster.backup.nextAt)}.`
						: 'Take one now, or wait for the schedule.'}
				/>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Taken</Table.Head>
							<Table.Head>Status</Table.Head>
							<Table.Head class="hidden md:table-cell">Kind</Table.Head>
							<Table.Head class="hidden md:table-cell">Version</Table.Head>
							<Table.Head class="hidden lg:table-cell">Size</Table.Head>
							<Table.Head class="hidden lg:table-cell">Expires</Table.Head>
							<Table.Head class="pr-4 text-right"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.backups as backup (backup.id)}
							<Table.Row>
								<Table.Cell class="pl-4">
									<div class="text-sm">{formatDateTime(backup.createdAt)}</div>
									<div class="font-mono text-xs text-muted-foreground">{backup.id}</div>
								</Table.Cell>
								<Table.Cell>
									<Badge variant={backupTone(backup.status)}>{backup.status}</Badge>
									{#if backup.error}<p class="mt-1 max-w-xs text-xs text-destructive">
											{backup.error}
										</p>{/if}
								</Table.Cell>
								<Table.Cell class="hidden text-xs md:table-cell">{backup.kind}</Table.Cell>
								<Table.Cell class="hidden font-mono text-xs md:table-cell"
									>{backup.minor} · {backup.datastore}</Table.Cell
								>
								<Table.Cell class="hidden font-mono text-xs lg:table-cell"
									>{backup.sizeBytes === null ? '—' : formatBytes(backup.sizeBytes)}</Table.Cell
								>
								<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell"
									>{formatDate(backup.expiresAt)}</Table.Cell
								>
								<Table.Cell class="pr-4 text-right">
									{#if backup.status === 'ok' && can.create}
										<Button variant="ghost" size="sm" onclick={() => openRestore(backup)}
											><RotateCcwIcon />Restore into new cluster</Button
										>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Panel>
	{:else if tab === 'pod-logs'}
		{#if cluster.shipper}
			<Panel
				title="Pod logs"
				icon={LogsIcon}
				description="Container output the cluster's log shipper sends to Yoal, kept {cluster.logRetentionDays} days."
			>
				<!-- The Logs Explorer locked to this cluster's pod streams (docs/LOGS.md §7). -->
				<LogExplorer
					scopes={[{ kind: 'k8s', id: cluster.id }]}
					locked
					lockedLabel={cluster.name}
					baseQuery="stream:pod:*"
					baseLabel="Pod output"
					urlPrefix="podlog_"
					order="oldest-first"
					defaultLive
					defaultTime={{ kind: 'relative', value: '24h' }}
					facets={false}
					defaultColumns={['time', 'level', 'stream']}
					filename="{cluster.name}-pods"
					canRead={data.permissions.includes('logs:read')}
					emptyHint="The shipper sends each pod's stdout and stderr about once a minute. Narrow to one pod with stream:pod:<namespace>/<pod>/*."
				/>
			</Panel>
		{:else}
			<EmptyState
				icon={LogsIcon}
				title="The log shipper is off"
				description="Turn it on to collect every pod's stdout and stderr in Yoal, searchable here without running Loki or Elasticsearch in the cluster."
			>
				{#if can.update && live}
					<Button onclick={() => void runAction('?/enableShipper')}
						><LogsIcon />Enable log shipper</Button
					>
				{/if}
			</EmptyState>
		{/if}
	{:else if tab === 'write'}
		<WriteConfig
			{cluster}
			{live}
			enabled={data.assistant.enabled}
			canConfigure={data.can.configurePlatform}
			canApply={data.canApplyConfig}
		/>
	{:else if tab === 'settings'}
		<Panel title="Version" icon={CircleArrowUpIcon}>
			<p class="text-sm text-muted-foreground">
				Kubernetes {cluster.displayVersion}{cluster.endOfSupport
					? `, supported upstream until ${cluster.endOfSupport}`
					: ''}.
				{#if cluster.upgradeTo}
					{cluster.upgradeTo} is available. Minors move one at a time and are never automatic until the
					current one leaves support.
				{:else}
					This is the newest minor Yoal ships. Patch releases apply in the maintenance window.
				{/if}
			</p>
			{#if can.update && live && cluster.upgradeTo}
				<Button
					class="mt-3"
					size="sm"
					variant="outline"
					onclick={() => upgrade(cluster.upgradeTo!)}
				>
					<CircleArrowUpIcon />Upgrade to {cluster.upgradeTo}
				</Button>
			{/if}
		</Panel>

		{#if can.update && live}
			<Panel
				title="Size"
				icon={SlidersHorizontalIcon}
				description="Agents and per-machine limits. More memory is admitted against {nodeLabel}'s workload slice."
			>
				<form
					method="POST"
					action="?/update"
					use:enhance={submitInline}
					class="grid gap-4 sm:grid-cols-4 sm:items-end"
				>
					<input type="hidden" name="section" value="size" />
					<Field.Field data-invalid={errors.agents ? true : undefined}>
						<Field.Label for="set-agents">Agent machines</Field.Label>
						<Input
							id="set-agents"
							name="agents"
							type="number"
							min={0}
							max={data.limits.maxAgents}
							value={String(cluster.agents)}
							class="font-mono text-sm"
						/>
						{#if errors.agents}<Field.Error>{errors.agents}</Field.Error>{/if}
					</Field.Field>
					<Field.Field data-invalid={errors.memoryMb ? true : undefined}>
						<Field.Label for="set-memory">Memory per machine</Field.Label>
						<InputGroup.Root>
							<InputGroup.Input
								id="set-memory"
								name="memoryMb"
								type="number"
								min={data.limits.minMemoryMb}
								max={data.limits.maxMemoryMb}
								step={256}
								value={String(cluster.memoryMb)}
								class="font-mono text-sm"
							/>
							<InputGroup.Addon align="inline-end"
								><InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text></InputGroup.Addon
							>
						</InputGroup.Root>
						{#if errors.memoryMb}<Field.Error>{errors.memoryMb}</Field.Error>{/if}
					</Field.Field>
					<Field.Field data-invalid={errors.cpus ? true : undefined}>
						<Field.Label for="set-cpus">CPUs per machine</Field.Label>
						<InputGroup.Root>
							<InputGroup.Input
								id="set-cpus"
								name="cpus"
								type="number"
								min={0.5}
								max={32}
								step={0.5}
								value={String(cluster.cpus)}
								class="font-mono text-sm"
							/>
							<InputGroup.Addon align="inline-end"
								><InputGroup.Text class="font-mono text-xs">vCPU</InputGroup.Text></InputGroup.Addon
							>
						</InputGroup.Root>
						{#if errors.cpus}<Field.Error>{errors.cpus}</Field.Error>{/if}
					</Field.Field>
					<Button type="submit" size="sm" variant="outline">Save size</Button>
				</form>
			</Panel>

			<Panel
				title="API access"
				icon={ShieldIcon}
				description="Public serves the API at its own HTTPS hostname; Yoal refuses requests without a bearer token before they reach it."
			>
				<form method="POST" action="?/update" use:enhance={submitInline} class="space-y-4">
					<input type="hidden" name="section" value="access" />
					<Field.Field data-invalid={errors.apiAccess ? true : undefined}>
						<Field.Label for="set-api">API access</Field.Label>
						<NativeSelect.Root
							id="set-api"
							name="apiAccess"
							value={cluster.apiAccess}
							class="w-full sm:w-72"
						>
							<NativeSelect.Option value="public">Public HTTPS endpoint</NativeSelect.Option>
							<NativeSelect.Option value="private">Private (overlay only)</NativeSelect.Option>
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field data-invalid={errors.allowCidrs ? true : undefined}>
						<Field.Label for="set-allow">Allowlist</Field.Label>
						<Textarea
							id="set-allow"
							name="allowCidrs"
							rows={3}
							value={cluster.allowCidrs.join('\n')}
							placeholder="203.0.113.0/24"
							spellcheck="false"
							class="font-mono text-xs"
						/>
						<Field.Description
							>CIDRs, one per line. Empty allows any address (a token is still required).</Field.Description
						>
						{#if errors.allowCidrs}<Field.Error>{errors.allowCidrs}</Field.Error>{/if}
					</Field.Field>
					<Button type="submit" size="sm" variant="outline">Save access</Button>
				</form>
			</Panel>

			<Panel
				title="Maintenance"
				icon={ClockIcon}
				description="Pinned patch releases apply in this daily window (platform time zone)."
			>
				<form
					method="POST"
					action="?/update"
					use:enhance={submitInline}
					class="grid gap-4 sm:grid-cols-3 sm:items-end"
				>
					<input type="hidden" name="section" value="maintenance" />
					<Field.Field>
						<Field.Label for="set-hour">Starts at</Field.Label>
						<NativeSelect.Root
							id="set-hour"
							name="windowHour"
							value={String(cluster.window.hour)}
							class="w-full"
						>
							{#each hours as hour (hour)}
								<NativeSelect.Option value={String(hour)}
									>{String(hour).padStart(2, '0')}:00</NativeSelect.Option
								>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="set-hours">Length</Field.Label>
						<InputGroup.Root>
							<InputGroup.Input
								id="set-hours"
								name="windowHours"
								type="number"
								min={1}
								max={8}
								value={String(cluster.window.hours)}
								class="font-mono text-sm"
							/>
							<InputGroup.Addon align="inline-end"
								><InputGroup.Text class="font-mono text-xs">h</InputGroup.Text></InputGroup.Addon
							>
						</InputGroup.Root>
					</Field.Field>
					<Field.Field orientation="horizontal">
						<Checkbox id="set-autopatch" name="autoPatch" value="on" checked={cluster.autoPatch} />
						<Field.Label for="set-autopatch">Apply patches automatically</Field.Label>
					</Field.Field>
					<Button type="submit" size="sm" variant="outline" class="sm:col-start-3"
						>Save maintenance</Button
					>
				</form>
			</Panel>
		{/if}

		{#if can.update && live}
			<Panel
				title="High availability"
				icon={ServerIcon}
				description="Three servers on embedded etcd survive the loss of one node. Lab clusters run one server on SQLite."
			>
				<p class="text-sm text-muted-foreground">
					{cluster.servers}
					{cluster.servers === 1 ? 'server' : 'servers'} on
					<span class="font-mono">{cluster.datastore}</span>
					· purpose <span class="font-mono">{cluster.purpose}</span>.
					{#if cluster.servers >= 3}This cluster is highly available.{/if}
				</p>
				{#if cluster.servers < 3}
					<div class="mt-3 flex flex-wrap gap-2">
						{#if cluster.purpose === 'production'}
							<Button
								size="sm"
								variant="outline"
								disabled={cluster.upgrade !== null}
								onclick={makeHa}><ServerIcon />Make highly available</Button
							>
						{:else}
							<Button size="sm" variant="outline" onclick={makeProduction}
								>Switch to production</Button
							>
							<span class="self-center text-xs text-muted-foreground"
								>Only production clusters can be made highly available.</span
							>
						{/if}
					</div>
				{/if}
			</Panel>

			<Panel
				title="Backups"
				icon={ArchiveIcon}
				description="How often Yoal snapshots the datastore and how long it keeps them."
			>
				<form
					method="POST"
					action="?/update"
					use:enhance={submitInline}
					class="grid gap-4 sm:grid-cols-3 sm:items-end"
				>
					<input type="hidden" name="section" value="backups" />
					<Field.Field data-invalid={errors.backupHours ? true : undefined}>
						<Field.Label for="set-backup-hours">Every</Field.Label>
						<InputGroup.Root>
							<InputGroup.Input
								id="set-backup-hours"
								name="backupHours"
								type="number"
								min={1}
								max={168}
								value={String(cluster.backup.hours)}
								class="font-mono text-sm"
							/>
							<InputGroup.Addon align="inline-end"
								><InputGroup.Text class="font-mono text-xs">h</InputGroup.Text></InputGroup.Addon
							>
						</InputGroup.Root>
						{#if errors.backupHours}<Field.Error>{errors.backupHours}</Field.Error>{/if}
					</Field.Field>
					<Field.Field data-invalid={errors.backupRetentionDays ? true : undefined}>
						<Field.Label for="set-backup-retention">Keep for</Field.Label>
						<InputGroup.Root>
							<InputGroup.Input
								id="set-backup-retention"
								name="backupRetentionDays"
								type="number"
								min={1}
								max={90}
								value={String(cluster.backup.retentionDays)}
								class="font-mono text-sm"
							/>
							<InputGroup.Addon align="inline-end"
								><InputGroup.Text class="font-mono text-xs">days</InputGroup.Text></InputGroup.Addon
							>
						</InputGroup.Root>
						{#if errors.backupRetentionDays}<Field.Error>{errors.backupRetentionDays}</Field.Error
							>{/if}
					</Field.Field>
					<Button type="submit" size="sm" variant="outline">Save backups</Button>
				</form>
			</Panel>

			<Panel
				title="Pod logs"
				icon={LogsIcon}
				description="The log shipper sends every pod's output to Yoal, searchable under Pod logs."
			>
				<form
					method="POST"
					action="?/update"
					use:enhance={submitInline}
					class="grid gap-4 sm:grid-cols-3 sm:items-end"
				>
					<input type="hidden" name="section" value="logs" />
					<Field.Field orientation="horizontal">
						<Checkbox id="set-shipper" name="shipper" value="on" checked={cluster.shipper} />
						<Field.Label for="set-shipper">Ship pod logs</Field.Label>
					</Field.Field>
					<Field.Field data-invalid={errors.logRetentionDays ? true : undefined}>
						<Field.Label for="set-log-retention">Keep for</Field.Label>
						<InputGroup.Root>
							<InputGroup.Input
								id="set-log-retention"
								name="logRetentionDays"
								type="number"
								min={1}
								max={90}
								value={String(cluster.logRetentionDays)}
								class="font-mono text-sm"
							/>
							<InputGroup.Addon align="inline-end"
								><InputGroup.Text class="font-mono text-xs">days</InputGroup.Text></InputGroup.Addon
							>
						</InputGroup.Root>
						{#if errors.logRetentionDays}<Field.Error>{errors.logRetentionDays}</Field.Error>{/if}
					</Field.Field>
					<Button type="submit" size="sm" variant="outline">Save pod logs</Button>
				</form>
			</Panel>
		{/if}

		{#if can.delete && live}
			<DangerZone>
				{#snippet description()}
					Delete moves the cluster to the trash for {page.data.policies?.trashDays ?? 7} days; its data
					stays on
					{nodeLabel} so a restore is lossless. Purge it from the trash to delete it for good.
				{/snippet}
				<Button variant="destructive" size="sm" onclick={moveToTrash}
					><TrashIcon />Delete cluster</Button
				>
			</DangerZone>
		{/if}
	{/if}
</div>

{#if live && can.keyRoles.length > 0}
	<FormDialog
		bind:open={keyOpen}
		icon={KeyRoundIcon}
		title="New access key for {cluster.name}"
		description="A ServiceAccount bound to the role you pick, delivered as a kubeconfig shown once. Use it for tools that cannot run the Yoal CLI."
		action="?/createKey"
		submitLabel="Create key"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.name ? true : undefined}>
				<Field.Label for="key-name">Name</Field.Label>
				<Input
					id="key-name"
					name="name"
					required
					maxlength={64}
					pattern="[a-z0-9][a-z0-9-]*"
					placeholder="argocd"
					spellcheck="false"
					class="font-mono text-sm"
				/>
				{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.role ? true : undefined}>
				<Field.Label for="key-role">Role</Field.Label>
				<NativeSelect.Root id="key-role" name="role" value={can.keyRoles[0]} class="w-full">
					{#each can.keyRoles as role (role)}
						<NativeSelect.Option value={role}
							>{role === 'admin' ? 'admin (cluster-admin)' : role}</NativeSelect.Option
						>
					{/each}
				</NativeSelect.Root>
				{#if errors.role}<Field.Error>{errors.role}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.expiresAt ? true : undefined}>
				<Field.Label for="key-expires"
					>Expires <span class="font-normal text-muted-foreground">optional</span></Field.Label
				>
				<Input id="key-expires" name="expiresAt" type="datetime-local" class="font-mono text-sm" />
				{#if errors.expiresAt}<Field.Error>{errors.expiresAt}</Field.Error>{/if}
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#if live && can.update}
	<FormDialog
		bind:open={routeOpen}
		icon={GlobeIcon}
		title="Add a route"
		description="Claims the name across the platform, like a project slug, and routes it to this cluster's ingress."
		action="?/addRoute"
		submitLabel="Add route"
	>
		<Field.Field data-invalid={errors.name ? true : undefined}>
			<Field.Label for="route-name">Hostname</Field.Label>
			<InputGroup.Root>
				<InputGroup.Input
					id="route-name"
					name="name"
					required
					minlength={3}
					maxlength={40}
					placeholder="shop"
					spellcheck="false"
					class="font-mono text-sm"
				/>
				<InputGroup.Addon align="inline-end"
					><InputGroup.Text class="font-mono text-xs">.{data.contentDomain}</InputGroup.Text
					></InputGroup.Addon
				>
			</InputGroup.Root>
			{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
		</Field.Field>
	</FormDialog>
{/if}

{#if can.create && restoreFrom}
	<FormDialog
		bind:open={restoreOpen}
		icon={RotateCcwIcon}
		title="Restore into a new cluster"
		description="Creates a new cluster from the snapshot taken {formatDateTime(
			restoreFrom.createdAt
		)}. {cluster.name} itself is not touched."
		action="?/restoreBackup"
		submitLabel="Restore"
	>
		<input type="hidden" name="backup" value={restoreFrom.id} />
		<Field.Group>
			<Field.Field data-invalid={errors.name ? true : undefined}>
				<Field.Label for="restore-name">New cluster name</Field.Label>
				<Input
					id="restore-name"
					name="name"
					required
					minlength={3}
					maxlength={40}
					placeholder="{cluster.name}-restored"
					spellcheck="false"
					class="font-mono text-sm"
				/>
				{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
			</Field.Field>
			<Field.Field>
				<Field.Label for="restore-node">Node</Field.Label>
				<NativeSelect.Root id="restore-node" name="placement" value="auto" class="w-full">
					<NativeSelect.Option value="auto">Auto</NativeSelect.Option>
					{#each data.nodes as node (node.id)}
						<NativeSelect.Option value={node.id}>{node.name}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#if live && can.attach}
	<FormDialog
		bind:open={attachOpen}
		icon={PlugIcon}
		title="Attach to {cluster.name}"
		description="Yoal writes the connection values as a Secret in the namespace you pick, and keeps it up to date."
		action="?/attach"
		submitLabel="Attach"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.name ? true : undefined}>
				<Field.Label for="attach-target">Database or broker</Field.Label>
				<NativeSelect.Root
					id="attach-target"
					name="target"
					bind:value={attachTarget}
					class="w-full"
					required
				>
					<NativeSelect.Option value="" disabled>Pick one on {nodeLabel}</NativeSelect.Option>
					{#each data.databases as item (item.name)}
						<NativeSelect.Option value="database:{item.name}"
							>Database · {item.label}</NativeSelect.Option
						>
					{/each}
					{#each data.brokers as item (item.name)}
						<NativeSelect.Option value="broker:{item.name}"
							>Broker · {item.label}</NativeSelect.Option
						>
					{/each}
				</NativeSelect.Root>
				{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.namespace ? true : undefined}>
					<Field.Label for="attach-namespace">Namespace</Field.Label>
					<Input
						id="attach-namespace"
						name="namespace"
						value="default"
						maxlength={63}
						spellcheck="false"
						class="font-mono text-sm"
					/>
					{#if errors.namespace}<Field.Error>{errors.namespace}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.secret ? true : undefined}>
					<Field.Label for="attach-secret">Secret</Field.Label>
					<Input
						id="attach-secret"
						name="secret"
						placeholder={attachName ? `yoal-${attachName}` : 'yoal-<name>'}
						maxlength={253}
						spellcheck="false"
						class="font-mono text-sm"
					/>
					{#if errors.secret}<Field.Error>{errors.secret}</Field.Error>{/if}
				</Field.Field>
			</div>
		</Field.Group>
	</FormDialog>
{/if}
