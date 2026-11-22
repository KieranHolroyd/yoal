<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { cloudShellLimits } from '@yoal/contracts';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PanelBottomOpenIcon from '@lucide/svelte/icons/panel-bottom-open';
	import PlayIcon from '@lucide/svelte/icons/play';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ServerIcon from '@lucide/svelte/icons/server';
	import SquareIcon from '@lucide/svelte/icons/square';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { cloudShell, diskLabel } from '#lib/cloud-shell/cloud-shell.svelte.js';
	import ConfirmDialog, { confirmAction } from '../dashboards/_lib/ConfirmDialog.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Cloud shell details (D236). The terminal itself lives in the drawer at the bottom of every
	 * dashboard page; this page shows where the shell runs and its limits, and manages its disk.
	 */
	const current = $derived(cloudShell.state ?? data.state);
	const shell = $derived(current?.shell ?? null);
	const disk = $derived(diskLabel(shell?.diskMb ?? current?.limits.diskMb ?? 1024));

	// Opening this page is the intent, as it always was: open the drawer, which starts the shell.
	onMount(() => {
		if (!cloudShell.state && data.state) cloudShell.state = data.state;
		if (data.state?.enabled) void cloudShell.show();
	});

	function reset(): void {
		confirmAction({
			title: 'Reset your cloud shell?',
			description: `This stops the shell and deletes its ${disk} home disk with everything in it. The next start makes a new, empty one, possibly on another node.`,
			confirmLabel: 'Delete disk and reset',
			tone: 'danger',
			run: async () => {
				if (!(await cloudShell.reset()))
					throw new Error(cloudShell.failure ?? 'Could not reset the cloud shell.');
				toast.success('Cloud shell reset. Its disk is being deleted.');
			}
		});
	}

	async function stop(): Promise<void> {
		if (await cloudShell.stop()) toast.success('Cloud shell stopped. Your files stay on its disk.');
	}

	const statusBadge = $derived.by(
		(): { label: string; variant: 'success' | 'warning' | 'neutral' | 'danger' } => {
			if (!shell) return { label: 'Not created', variant: 'neutral' };
			if (shell.status === 'running') return { label: 'Running', variant: 'success' };
			if (shell.status === 'starting' || cloudShell.busy === 'start')
				return { label: 'Starting', variant: 'warning' };
			if (shell.status === 'deleting') return { label: 'Deleting', variant: 'danger' };
			if (shell.message) return { label: 'Failed to start', variant: 'danger' };
			return { label: 'Stopped', variant: 'neutral' };
		}
	);

	const limits = $derived(
		current
			? [
					{ label: 'Memory', value: `${current.limits.memoryMb} MiB, 1 CPU` },
					{ label: 'Home disk', value: `${disk} ext4, kept between sessions` },
					{
						label: 'Idle stop',
						value: `After ${current.limits.idleMinutes} minutes without typing`
					},
					{
						label: 'Session limit',
						value: `${cloudShellLimits.maxSessionMs / 3_600_000} hours, then it stops`
					},
					{ label: 'System', value: 'Read-only, reset on every start; /tmp is memory-backed' }
				]
			: []
	);
</script>

<svelte:head>
	<title>Cloud shell · Yoal</title>
</svelte:head>

<PageHeader
	title="Cloud shell"
	description="A terminal on one of your servers with the yoal CLI signed in as you, and a small home disk that keeps your files between sessions."
	target="cloud-shell.header"
>
	{#if current?.enabled}
		<Button size="sm" onclick={() => cloudShell.show()} disabled={shell?.status === 'deleting'}>
			<PanelBottomOpenIcon />
			Open terminal
		</Button>
		{#if cloudShell.running || cloudShell.status === 'starting'}
			<Button variant="outline" size="sm" disabled={cloudShell.busy !== null} onclick={stop}>
				{#if cloudShell.busy === 'stop'}<Spinner />{:else}<SquareIcon />{/if}
				Stop
			</Button>
		{/if}
		{#if shell && shell.status !== 'deleting'}
			<Button variant="ghost" size="sm" disabled={cloudShell.busy !== null} onclick={reset}>
				<RotateCcwIcon />
				Reset disk
			</Button>
		{/if}
	{/if}
</PageHeader>

{#if !current}
	<EmptyState
		icon={TerminalIcon}
		title="Cloud shell unavailable"
		description={data.refusal ?? 'The cloud shell is unavailable.'}
	/>
{:else if !current.enabled}
	<EmptyState
		icon={TerminalIcon}
		title="The cloud shell is turned off"
		description="An operator turned it off on this install (YOAL_FEATURE_CLOUD_SHELL=0). Your disk, if you had one, is kept."
	/>
{:else}
	<div class="flex flex-col gap-4">
		{#if shell?.status === 'stopped' && shell.message && cloudShell.busy !== 'start'}
			<Alert.Root variant="destructive">
				<CircleAlertIcon />
				<Alert.Title>Your cloud shell did not start</Alert.Title>
				<Alert.Description>
					<p>{shell.message}</p>
					<Button size="sm" variant="outline" class="mt-2" onclick={() => cloudShell.show()}>
						<PlayIcon />
						Try again
					</Button>
				</Alert.Description>
			</Alert.Root>
		{/if}
		{#if cloudShell.failure}
			<p class="text-sm text-destructive">{cloudShell.failure}</p>
		{/if}

		<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
			<Card.Root class="gap-1 py-4">
				<Card.Content class="flex items-center gap-3 px-4">
					<TerminalIcon class="size-4 shrink-0 text-muted-foreground" />
					<div class="min-w-0">
						<p class="text-xs text-muted-foreground">Status</p>
						<Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
					</div>
				</Card.Content>
			</Card.Root>
			<Card.Root class="gap-1 py-4">
				<Card.Content class="flex items-center gap-3 px-4">
					<ServerIcon class="size-4 shrink-0 text-muted-foreground" />
					<div class="min-w-0">
						<p class="text-xs text-muted-foreground">Node</p>
						<p class="truncate text-sm font-medium">
							{shell?.node?.name ?? 'Picked on first start'}
							{#if shell?.node && !shell.node.online}<span class="text-destructive">· offline</span
								>{/if}
						</p>
					</div>
				</Card.Content>
			</Card.Root>
			<Card.Root class="gap-1 py-4">
				<Card.Content class="flex items-center gap-3 px-4">
					<HardDriveIcon class="size-4 shrink-0 text-muted-foreground" />
					<div class="min-w-0">
						<p class="text-xs text-muted-foreground">Home disk</p>
						<p class="truncate text-sm font-medium">
							{disk} at <span class="font-mono text-xs">{shell?.home ?? '/home/yoal'}</span>
						</p>
					</div>
				</Card.Content>
			</Card.Root>
			<Card.Root class="gap-1 py-4">
				<Card.Content class="flex items-center gap-3 px-4">
					<KeyRoundIcon class="size-4 shrink-0 text-muted-foreground" />
					<div class="min-w-0">
						<p class="text-xs text-muted-foreground">yoal CLI</p>
						<p class="truncate text-sm font-medium">
							{#if cloudShell.running || cloudShell.status === 'starting'}
								{shell?.cliSignedIn ? 'Signed in as you' : 'Not signed in (run yoal login)'}
							{:else}
								Signed in when the shell starts
							{/if}
						</p>
					</div>
				</Card.Content>
			</Card.Root>
		</div>

		<div class="grid gap-3 lg:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>Open it from any page</Card.Title>
					<Card.Description>
						The terminal opens in a drawer at the bottom of the dashboard and stays connected while
						you move between pages.
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-2 text-sm text-muted-foreground">
					<p>
						Use the <span class="font-medium text-foreground">Cloud shell</span> button at the top
						right, or press <Kbd>Ctrl</Kbd>
						<Kbd>`</Kbd>. Drag the drawer's top edge to resize it; double-click the edge to
						maximise.
					</p>
					<p>
						Hiding the drawer keeps the shell running. It stops by itself after {current.limits
							.idleMinutes} minutes without typing, and your files stay on its disk for the next start.
					</p>
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header>
					<Card.Title>Limits</Card.Title>
					<Card.Description>
						A small sandboxed container: no added capabilities, no published ports. Opening a shell
						is audited; what you type is not.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
						{#each limits as row (row.label)}
							<dt class="text-muted-foreground">{row.label}</dt>
							<dd>{row.value}</dd>
						{/each}
					</dl>
				</Card.Content>
			</Card.Root>
		</div>
	</div>
{/if}

<ConfirmDialog />
