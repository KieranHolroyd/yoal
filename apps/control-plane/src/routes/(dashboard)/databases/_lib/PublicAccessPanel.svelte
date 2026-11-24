<script lang="ts">
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type {
		DatabaseCredentialView,
		DatabasePublicAccessView,
		DatabaseView
	} from '@yoal/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DetailList from '#lib/components/yoal/DetailList.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import CopyValue from '../../_lib/service/CopyValue.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';

	/**
	 * Public access from outside Yoal (docs/DATABASES.md §19, D241): a TLS proxy on the ingress
	 * nodes, only from the listed CIDRs and, for Postgres, only for the chosen roles. Every rule is
	 * checked on the server; this form only collects the configuration. Saving needs
	 * `database:expose` (step-up through `runAction`); turning it off needs `database:update`.
	 */
	let {
		db,
		access,
		credentials,
		canExpose,
		canUpdate
	}: {
		db: DatabaseView;
		access: DatabasePublicAccessView | null;
		/** Named credentials (Postgres): the role picker. */
		credentials: DatabaseCredentialView[];
		canExpose: boolean;
		canUpdate: boolean;
	} = $props();

	type Rule = { cidr: string; label: string };
	const EXPIRY_PRESETS = [
		{ key: 'never', label: 'Never', ms: null },
		{ key: '1d', label: '1 day', ms: 86_400_000 },
		{ key: '7d', label: '7 days', ms: 7 * 86_400_000 },
		{ key: '30d', label: '30 days', ms: 30 * 86_400_000 },
		{ key: '90d', label: '90 days', ms: 90 * 86_400_000 }
	] as const;

	const deleted = $derived(db.deletedAt !== null);
	const postgres = $derived(access?.protocol === 'postgres');
	const roleChoices = $derived(
		credentials.filter((item) => item.role !== 'monitor' && item.status === 'ready')
	);

	let editing = $state(false);
	let saving = $state(false);
	let rules = $state<Rule[]>([]);
	let anywhere = $state(false);
	let chosen = $state<string[]>([]);
	let expiry = $state<string>('never');
	let maxConnections = $state(20);

	function startEdit() {
		rules =
			access && access.rules.length > 0
				? access.rules.map((rule) => ({ ...rule }))
				: [{ cidr: '', label: '' }];
		anywhere = access?.allowAnywhere ?? false;
		chosen = access?.credentials.filter((item) => item.usable).map((item) => item.id) ?? [];
		expiry = access?.enabled && access.expiresAt ? 'keep' : 'never';
		maxConnections = access?.maxConnections ?? 20;
		editing = true;
	}

	/** Light client-side shape check; the server refuses private ranges, host bits and broad prefixes. */
	function cidrHint(value: string): string | null {
		const trimmed = value.trim();
		if (!trimmed) return null;
		if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(trimmed))
			return 'Use an address or CIDR, e.g. 203.0.113.0/24';
		if (
			/^(10\.|127\.|192\.168\.|169\.254\.)/.test(trimmed) ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(trimmed)
		)
			return 'Private ranges are never reachable from the internet';
		return null;
	}

	function expiresAt(): string | null {
		if (expiry === 'keep') return access?.expiresAt ?? null;
		const preset = EXPIRY_PRESETS.find((item) => item.key === expiry);
		return preset?.ms ? new Date(Date.now() + preset.ms).toISOString() : null;
	}

	async function save() {
		saving = true;
		const config = {
			// Everyone replaces the list, so leftover rows can't block the save.
			rules: anywhere
				? []
				: rules
						.filter((rule) => rule.cidr.trim())
						.map((rule) => ({ cidr: rule.cidr.trim(), label: rule.label.trim() })),
			allowAnywhere: anywhere,
			credentials: postgres ? chosen : [],
			expiresAt: expiresAt(),
			maxConnections
		};
		const outcome = await runAction('?/public-access', { config: JSON.stringify(config) });
		saving = false;
		if (outcome.type === 'success') editing = false;
	}

	function turnOff() {
		askConfirm({
			title: `Turn off public access to ${db.name}?`,
			description:
				'Every ingress closes the listener on its next pull and open connections from outside are cut. ' +
				'Apps on Yoal are unaffected. The address is kept, so turning it back on gives the same URL.',
			confirmLabel: 'Turn off',
			tone: 'danger',
			action: '?/public-access-disable'
		});
	}
</script>

<Panel
	title="Public access"
	icon={GlobeIcon}
	description="Reach this database from outside Yoal over TLS, only from the addresses you list."
>
	{#snippet actions()}
		{#if access && access.status !== 'unsupported' && !deleted && !editing}
			{#if canExpose}
				<Button variant="outline" size="sm" onclick={startEdit}>
					{access.enabled ? 'Edit' : 'Turn on…'}
				</Button>
			{/if}
			{#if access.enabled && canUpdate}
				<Button variant="ghost" size="sm" onclick={turnOff}>Turn off</Button>
			{/if}
		{/if}
	{/snippet}

	{#if !access}
		<p class="text-sm text-muted-foreground">Public access status is unavailable.</p>
	{:else if access.status === 'unsupported'}
		<p class="text-sm text-muted-foreground">{access.statusDetail}</p>
	{:else}
		<div class="space-y-4">
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<StatusBadge status={access.status} />
				{#if access.statusDetail}<span class="text-xs text-muted-foreground"
						>{access.statusDetail}</span
					>{/if}
			</div>

			{#if access.enabled || access.rules.length > 0}
				<DetailList>
					{#if access.host && access.port !== null}
						<dt>Address</dt>
						<dd><CopyValue value={`${access.host}:${access.port}`} label="address" /></dd>
					{/if}
					{#if access.connectionTemplate}
						<dt>URL</dt>
						<dd><CopyValue value={access.connectionTemplate} label="URL template" /></dd>
					{/if}
					<dt>Sources</dt>
					<dd class="text-xs">
						{#if access.allowAnywhere}
							<span class="text-warning">Everyone (any address)</span>
						{:else}
							{#each access.rules as rule (rule.cidr)}
								<div>
									<span class="font-mono">{rule.cidr}</span>{#if rule.label}<span
											class="text-muted-foreground"
										>
											· {rule.label}</span
										>{/if}
								</div>
							{/each}
						{/if}
					</dd>
					{#if postgres}
						<dt>Roles</dt>
						<dd class="text-xs">
							{#each access.credentials as item (item.id)}
								<div>
									<span class="font-mono">{item.username}</span>
									<span class="text-muted-foreground"
										>· {item.role}{item.usable ? '' : ' · not usable'}</span
									>
								</div>
							{:else}
								<span class="text-muted-foreground">None</span>
							{/each}
						</dd>
					{/if}
					<dt>Limits</dt>
					<dd class="text-xs">
						{access.maxConnections} connections per ingress ·
						{access.expiresAt ? `expires ${formatDateTime(access.expiresAt)}` : 'no expiry'}
					</dd>
				</DetailList>
				{#if postgres && access.enabled}
					<p class="text-xs text-muted-foreground">
						Use <span class="font-mono">sslmode=require</span> (or
						<span class="font-mono">verify-full</span> with the system roots). Reveal a credential below
						to copy its ready-made public URL.
					</p>
				{/if}
			{:else if !editing}
				<p class="text-sm text-muted-foreground">
					Off. Apps on Yoal connect through their attachment; turn this on only for clients that run
					elsewhere.
				</p>
			{/if}

			{#if editing}
				<div class="space-y-3 rounded-lg border bg-muted/30 p-3">
					<div class="space-y-2">
						<p class="text-sm font-medium">Allowed sources</p>
						<ToggleGroup.Root
							type="single"
							variant="outline"
							size="sm"
							value={anywhere ? 'everyone' : 'listed'}
							onValueChange={(value) => value && (anywhere = value === 'everyone')}
							aria-label="Allowed sources"
						>
							<ToggleGroup.Item value="listed">Specific addresses</ToggleGroup.Item>
							<ToggleGroup.Item value="everyone" disabled={!access.anywhereAvailable && !anywhere}
								>Everyone</ToggleGroup.Item
							>
						</ToggleGroup.Root>
						{#if anywhere}
							<Notice tone="warning">
								No address check: any IPv4 or IPv6 address can reach the login prompt. TLS, the role
								list and the failed-login ban still apply, but a leaked password is then enough to get
								in.
							</Notice>
						{:else}
							{#if !access.anywhereAvailable}
								<p class="text-[11px] text-muted-foreground">
									Everyone is off on this install. An operator turns it on with
									<span class="font-mono">YOAL_FEATURE_DB_PUBLIC_ANYWHERE=1</span>.
								</p>
							{/if}
							{#each rules as rule, index (index)}
								{@const hint = cidrHint(rule.cidr)}
								<div class="flex flex-wrap items-start gap-2">
									<div class="min-w-0 flex-1 space-y-1">
										<Input
											bind:value={rule.cidr}
											placeholder="203.0.113.0/24"
											aria-label="CIDR"
											class="h-8 font-mono"
										/>
										{#if hint}<p class="text-[11px] text-destructive">{hint}</p>{/if}
									</div>
									<Input
										bind:value={rule.label}
										placeholder="Label (office, CI…)"
										aria-label="Label"
										class="h-8 w-44"
										maxlength={80}
									/>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="Remove source"
										onclick={() => (rules = rules.filter((_, at) => at !== index))}
									>
										<TrashIcon />
									</Button>
								</div>
							{/each}
							<Button
								variant="outline"
								size="xs"
								onclick={() => (rules = [...rules, { cidr: '', label: '' }])}
								disabled={rules.length >= 50}
							>
								<PlusIcon class="size-3.5" />Add source
							</Button>
						{/if}
					</div>

					{#if postgres}
						<div class="space-y-1">
							<p class="text-sm font-medium">Roles that may log in</p>
							{#each roleChoices as item (item.id)}
								<label class="flex items-center gap-2 text-sm">
									<Checkbox
										checked={chosen.includes(item.id)}
										onCheckedChange={(on) =>
											(chosen = on ? [...chosen, item.id] : chosen.filter((id) => id !== item.id))}
									/>
									<span class="font-mono">{item.username}</span>
									<span class="text-xs text-muted-foreground">{item.role}</span>
								</label>
							{:else}
								<p class="text-xs text-muted-foreground">No ready credentials yet.</p>
							{/each}
							<p class="text-[11px] text-muted-foreground">
								Prefer a dedicated app or readonly credential over the owner. Any other role is
								refused at the proxy.
							</p>
						</div>
					{/if}

					<div class="flex flex-wrap items-end gap-3">
						<label class="space-y-1 text-sm">
							<span class="block text-xs text-muted-foreground">Turns off after</span>
							<NativeSelect.Root bind:value={expiry} class="h-8 w-40">
								{#if access.enabled && access.expiresAt}
									<NativeSelect.Option value="keep"
										>Keep ({formatDateTime(access.expiresAt)})</NativeSelect.Option
									>
								{/if}
								{#each EXPIRY_PRESETS as preset (preset.key)}
									<NativeSelect.Option value={preset.key}>{preset.label}</NativeSelect.Option>
								{/each}
							</NativeSelect.Root>
						</label>
						<label class="space-y-1 text-sm">
							<span class="block text-xs text-muted-foreground">Max connections per ingress</span>
							<Input type="number" min={1} max={500} bind:value={maxConnections} class="h-8 w-28" />
						</label>
					</div>

					<div class="flex justify-end gap-2">
						<Button variant="ghost" size="sm" onclick={() => (editing = false)} disabled={saving}
							>Cancel</Button
						>
						<Button size="sm" onclick={save} disabled={saving}>
							{#if saving}<Spinner />{/if}{access.enabled ? 'Save' : 'Turn on'}
						</Button>
					</div>
				</div>
			{/if}

			{#if access.enabled && access.nodes.length > 0}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Ingress</Table.Head>
							<Table.Head>State</Table.Head>
							<Table.Head class="text-right">Open</Table.Head>
							<Table.Head class="text-right">Accepted</Table.Head>
							<Table.Head class="text-right">Refused</Table.Head>
							<Table.Head class="hidden text-right md:table-cell">Failed logins</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each access.nodes as node (node.nodeId)}
							<Table.Row>
								<Table.Cell>{node.nodeName}</Table.Cell>
								<Table.Cell>
									<StatusBadge status={node.state} />
									{#if node.error}<p class="text-[11px] text-muted-foreground">{node.error}</p>{/if}
								</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{node.open}</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{node.accepted}</Table.Cell>
								<Table.Cell class="text-right tabular-nums">{node.refused}</Table.Cell>
								<Table.Cell class="hidden text-right tabular-nums md:table-cell">
									{node.authFailures}{node.banned ? ` · ${node.banned} banned` : ''}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}

			{#if access.events.length > 0}
				<div class="space-y-1 border-t pt-3">
					<p class="text-xs font-medium text-muted-foreground">Recent refusals</p>
					{#each access.events.slice(0, 8) as event, index (index)}
						<p class="text-xs">
							<span class="text-muted-foreground">{formatRelative(event.at)}</span>
							<span class="font-mono">{event.source}</span>
							· {event.reason}{#if event.detail}<span class="text-muted-foreground">
									· {event.detail}</span
								>{/if}
						</p>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</Panel>
