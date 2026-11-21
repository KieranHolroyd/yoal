<script lang="ts">
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import WaypointsIcon from '@lucide/svelte/icons/waypoints';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { errorText } from '#lib/query.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime } from '../../_lib/format.js';
	import { applyMigration, haKeys, loadCa, loadMigrationPlan, rotateCa } from './_lib/ha-api.js';
	import {
		CA_ROTATE_CONFIRM,
		MIGRATE_CONFIRM,
		caRotateGate,
		migrationApplyProjects,
		migrationGate
	} from './_lib/ha-setup.js';
	import type { AttachmentMigrationResponse } from './_lib/ha-types.js';

	/**
	 * The two platform-admin HA actions an API key cannot take under the default bindings: rotating
	 * the install CA and moving apps to their attachment endpoints. Anyone with HA access sees the
	 * status and the dry run; only a platform admin sees the controls, each behind a typed word.
	 */
	let { isAdmin }: { isAdmin: boolean } = $props();

	const queryClient = useQueryClient();
	const ca = createQuery(() => ({
		queryKey: haKeys.ca,
		queryFn: ({ signal }) => loadCa(signal),
		staleTime: 30_000
	}));
	// The dry run the admin reads is the one apply sends: it never refreshes on its own, so the
	// list cannot change between reading it and typing the word. "Run the dry run again" refreshes.
	const migration = createQuery(() => ({
		queryKey: haKeys.migration,
		queryFn: ({ signal }) => loadMigrationPlan(signal),
		staleTime: Infinity,
		refetchOnWindowFocus: false
	}));

	let caTyped = $state('');
	let migrateTyped = $state('');
	let busy = $state<'ca' | 'migrate' | null>(null);
	let caMessage = $state<{ tone: 'success' | 'error'; text: string } | null>(null);
	let migrateMessage = $state<{ tone: 'success' | 'error'; text: string } | null>(null);
	let moved = $state<AttachmentMigrationResponse | null>(null);

	const caFacts = $derived(
		ca.data
			? {
					inUse: ca.data.inUse,
					authorities: ca.data.authorities.length,
					onPreviousCa: ca.data.leaves.onPreviousCa
				}
			: undefined
	);
	const rotateGate = $derived(caRotateGate(caFacts, { isAdmin, typed: caTyped }));
	const migrateGate = $derived(migrationGate(migration.data, { isAdmin, typed: migrateTyped }));
	const plan = $derived(moved ?? migration.data);

	async function rotate() {
		if (!rotateGate.enabled) return;
		busy = 'ca';
		caMessage = null;
		try {
			const status = await rotateCa();
			queryClient.setQueryData(haKeys.ca, status);
			caTyped = '';
			caMessage = {
				tone: 'success',
				text: 'The CA is rotated. Each node moves to the new CA when it next renews its certificate, within 60 days; the old CA stays trusted until then.'
			};
		} catch (error) {
			caMessage = { tone: 'error', text: errorText(error, 'Could not rotate the CA.') };
		} finally {
			busy = null;
		}
	}

	async function migrate() {
		if (!migrateGate.enabled) return;
		busy = 'migrate';
		migrateMessage = null;
		try {
			moved = await applyMigration(migrationApplyProjects(migration.data));
			const count = moved.projects.filter((item) => item.status === 'moved').length;
			migrateTyped = '';
			migrateMessage = {
				tone: 'success',
				text: `${count} app${count === 1 ? '' : 's'} moved to ${count === 1 ? 'its' : 'their'} stable endpoint. Each restarts once on its next heartbeat.`
			};
			// Read the dry run again; the result above stays until the next one.
			await queryClient.invalidateQueries({ queryKey: haKeys.migration });
		} catch (error) {
			migrateMessage = { tone: 'error', text: errorText(error, 'Could not move the apps.') };
		} finally {
			busy = null;
		}
	}

	const short = (fingerprint: string) => `${fingerprint.slice(0, 16)}…`;
	const statusVariant = { 'will-move': 'info', moved: 'success', blocked: 'warning' } as const;
</script>

<div class="grid gap-6 xl:grid-cols-2">
	<Panel
		id="install-ca"
		title="Install CA"
		icon={KeyRoundIcon}
		description="Nodes authenticate each other's endpoint traffic with certificates this CA signs. Rotate it if its key may be exposed, or before it expires."
	>
		{#if ca.isError}
			<p class="text-sm text-destructive">{errorText(ca.error, 'Could not load the CA.')}</p>
		{:else if !ca.data}
			<p class="text-sm text-muted-foreground">Loading…</p>
		{:else}
			{#if !ca.data.inUse}
				<p class="mb-3 text-sm text-muted-foreground">
					Not in use: nodes use the CA only while the endpoints gateway is on.
				</p>
			{/if}
			{#if ca.data.authorities.length > 0}
				<ul class="space-y-1.5 text-xs">
					{#each ca.data.authorities as authority (authority.fingerprint)}
						<li class="flex flex-wrap items-center gap-2">
							<Badge variant={authority.state === 'active' ? 'success' : 'neutral'}
								>{authority.state}</Badge
							>
							<code class="font-mono" title={authority.fingerprint}
								>{short(authority.fingerprint)}</code
							>
							<span class="text-muted-foreground"
								>valid until {formatDateTime(authority.notAfter)}</span
							>
						</li>
					{/each}
				</ul>
			{/if}
			<dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
				<div>
					<dt class="text-muted-foreground">Nodes with a certificate</dt>
					<dd class="font-medium tabular-nums">{ca.data.leaves.nodes}</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Renewing soon</dt>
					<dd class="font-medium tabular-nums">{ca.data.leaves.renewDue}</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">On the previous CA</dt>
					<dd
						class="font-medium tabular-nums"
						class:text-warning={ca.data.leaves.onPreviousCa > 0}
						data-testid="ca-previous"
					>
						{ca.data.leaves.onPreviousCa}
					</dd>
				</div>
			</dl>
		{/if}

		{#if rotateGate.visible}
			<div class="mt-4 space-y-2 rounded-md border p-3" data-testid="ca-rotate">
				<p class="text-sm font-medium">Rotate the CA</p>
				<p class="text-xs text-muted-foreground">
					A new CA signs from now. The old one stays trusted while each node renews, so no endpoint
					loses its connection. A second rotation is refused while any node is still on the previous
					CA.
				</p>
				<div class="flex flex-wrap items-center gap-2">
					<input
						bind:value={caTyped}
						placeholder="Type {CA_ROTATE_CONFIRM}"
						aria-label="Type {CA_ROTATE_CONFIRM} to confirm"
						class="h-9 w-40 rounded-md border bg-background px-2 font-mono text-sm"
						autocomplete="off"
						disabled={!!caFacts && caFacts.onPreviousCa > 0}
					/>
					<Button
						variant="destructive"
						size="sm"
						disabled={!rotateGate.enabled || busy !== null}
						onclick={rotate}
					>
						{busy === 'ca' ? 'Rotating…' : 'Rotate the CA'}
					</Button>
				</div>
				{#if rotateGate.reason}<p class="text-xs text-muted-foreground">{rotateGate.reason}</p>{/if}
			</div>
		{/if}
		{#if caMessage}
			<p
				class="mt-3 rounded-md border px-3 py-2 text-sm {caMessage.tone === 'error'
					? 'border-destructive/40 bg-destructive/10'
					: 'border-success/40 bg-success/10'}"
				role="status"
			>
				{caMessage.text}
			</p>
		{/if}
	</Panel>

	<Panel
		id="attachment-migration"
		title="Move apps to their endpoints"
		icon={WaypointsIcon}
		description="Apps reach their databases through a stable endpoint once the endpoints gateway is on. Each app moves on its own next deploy; this moves the rest now, restarting each once."
	>
		{#if migration.isError}
			<p class="text-sm text-destructive">
				{errorText(migration.error, 'Could not load the dry run.')}
			</p>
		{:else if !plan}
			<p class="text-sm text-muted-foreground">Loading…</p>
		{:else}
			<p class="text-xs text-muted-foreground">
				{plan.apply ? 'Result' : 'Dry run'}: {plan.projects.filter(
					(item) => item.status === 'will-move'
				).length} to move,
				{plan.projects.filter((item) => item.status === 'blocked').length} blocked, {plan.alreadyMoved}
				already on their endpoints.
				{#if !plan.gateway}The gateway is off, so nothing can move.{/if}
				<Button
					variant="link"
					size="sm"
					class="h-auto p-0 text-xs"
					disabled={migration.isFetching || busy !== null}
					onclick={() => {
						moved = null;
						migrateTyped = '';
						void migration.refetch();
					}}>Run the dry run again</Button
				>
			</p>
			{#if plan.projects.length > 0}
				<div class="mt-2 overflow-x-auto rounded-md border">
					<Table.Root>
						<Table.Header class="bg-muted/45">
							<Table.Row>
								<Table.Head class="pl-4">App</Table.Head>
								<Table.Head>Databases</Table.Head>
								<Table.Head class="pr-4">Status</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each plan.projects as item (item.projectId)}
								<Table.Row>
									<Table.Cell class="pl-4">
										<p class="font-mono text-sm">{item.slug}</p>
										<p class="text-xs text-muted-foreground">
											{item.runtime} on {item.nodes.join(', ') || 'no node'}
										</p>
									</Table.Cell>
									<Table.Cell class="font-mono text-xs">{item.databases.join(', ')}</Table.Cell>
									<Table.Cell class="max-w-64 pr-4 whitespace-normal">
										<Badge variant={statusVariant[item.status]}>{item.status}</Badge>
										<p class="mt-0.5 text-xs text-muted-foreground">{item.reason}</p>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		{/if}

		{#if migrateGate.visible}
			<div class="mt-4 space-y-2 rounded-md border p-3" data-testid="migrate-apply">
				<p class="text-sm font-medium">Move them now</p>
				<p class="text-xs text-muted-foreground">
					Moves exactly the apps this dry run lists as will-move{#if migrationApplyProjects(migration.data).length}: <span
							class="font-mono">{migrationApplyProjects(migration.data).join(', ')}</span
						>{/if}. Each restarts once.
				</p>
				<div class="flex flex-wrap items-center gap-2">
					<input
						bind:value={migrateTyped}
						placeholder="Type {MIGRATE_CONFIRM}"
						aria-label="Type {MIGRATE_CONFIRM} to confirm"
						class="h-9 w-40 rounded-md border bg-background px-2 font-mono text-sm"
						autocomplete="off"
					/>
					<Button
						variant="destructive"
						size="sm"
						disabled={!migrateGate.enabled || busy !== null}
						onclick={migrate}
					>
						{busy === 'migrate' ? 'Moving…' : 'Move and restart'}
					</Button>
				</div>
				{#if migrateGate.reason}<p class="text-xs text-muted-foreground">
						{migrateGate.reason}
					</p>{/if}
			</div>
		{:else if !isAdmin}
			<p class="mt-3 text-xs text-muted-foreground">
				Moving apps and rotating the CA need a platform admin signed in to the dashboard.
			</p>
		{/if}
		{#if migrateMessage}
			<p
				class="mt-3 rounded-md border px-3 py-2 text-sm {migrateMessage.tone === 'error'
					? 'border-destructive/40 bg-destructive/10'
					: 'border-success/40 bg-success/10'}"
				role="status"
			>
				{migrateMessage.text}
			</p>
		{/if}
	</Panel>
</div>
