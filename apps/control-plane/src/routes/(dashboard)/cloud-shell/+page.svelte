<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import type { CloudShellState, CloudShellView } from '@yoal/contracts';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlayIcon from '@lucide/svelte/icons/play';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ServerIcon from '@lucide/svelte/icons/server';
	import SquareIcon from '@lucide/svelte/icons/square';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TimerIcon from '@lucide/svelte/icons/timer';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText, fetchJson } from '#lib/query.js';
	import ConfirmDialog, { confirmAction } from '../dashboards/_lib/ConfirmDialog.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { formatRelative } from '../_lib/format.js';
	import ContainerShell from '../projects/[slug]/_components/ContainerShell.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The server's first answer, then whatever the API says after each action and poll.
	let latest = $state<CloudShellState | null>(null);
	let busy = $state<'start' | 'stop' | null>(null);
	let failure = $state<string | null>(null);
	/** Remounts the terminal after a stop/start, so it opens a new shell in the new container. */
	let terminalKey = $state(0);

	const current = $derived(latest ?? data.state);
	const shell = $derived<CloudShellView | null>(current?.shell ?? null);
	const running = $derived(shell?.status === 'running');
	const starting = $derived(shell?.status === 'starting' || busy === 'start');

	async function refresh(): Promise<void> {
		try {
			latest = await fetchJson<CloudShellState>('/api/v1/cloud-shell');
		} catch (error) {
			failure = errorText(error);
		}
	}

	async function post(action: 'start' | 'stop' | 'reset'): Promise<void> {
		await fetchJson(`/api/v1/cloud-shell/${action}`, {
			method: 'POST',
			fallback: `Could not ${action} the cloud shell.`
		});
	}

	async function start(): Promise<void> {
		busy = 'start';
		failure = null;
		try {
			await post('start');
			await refresh();
			terminalKey += 1;
		} catch (error) {
			failure = errorText(error);
		} finally {
			busy = null;
		}
	}

	async function stop(): Promise<void> {
		busy = 'stop';
		failure = null;
		try {
			await post('stop');
			await refresh();
			toast.success('Cloud shell stopped. Your files stay on its disk.');
		} catch (error) {
			failure = errorText(error);
		} finally {
			busy = null;
		}
	}

	function reset(): void {
		confirmAction({
			title: 'Reset your cloud shell?',
			description: `This stops the shell and deletes its ${diskLabel} home disk with everything in it. The next start makes a new, empty one, possibly on another node.`,
			confirmLabel: 'Delete disk and reset',
			tone: 'danger',
			run: async () => {
				await post('reset');
				await refresh();
				toast.success('Cloud shell reset. Its disk is being deleted.');
			}
		});
	}

	const diskLabel = $derived(
		(shell?.diskMb ?? current?.limits.diskMb ?? 1024) >= 1024
			? `${Math.round((shell?.diskMb ?? current?.limits.diskMb ?? 1024) / 1024)} GiB`
			: `${shell?.diskMb ?? current?.limits.diskMb} MiB`
	);

	// Opening the page is the intent: start a stopped shell straight away, as a terminal app would.
	onMount(() => {
		if (current?.enabled && (!shell || shell.status === 'stopped')) void start();
	});

	// While the node is still pulling the image and starting the container, poll until it runs.
	$effect(() => {
		if (shell?.status !== 'starting') return;
		const timer = setInterval(() => void refresh(), 2_000);
		return () => clearInterval(timer);
	});

	// The idle timer can stop the shell while the page is open; notice within a minute.
	$effect(() => {
		if (!running) return;
		const timer = setInterval(() => void refresh(), 60_000);
		return () => clearInterval(timer);
	});

	const statusBadge = $derived.by((): { label: string; variant: 'success' | 'warning' | 'neutral' | 'danger' } => {
		if (!shell) return { label: 'Not created', variant: 'neutral' };
		if (shell.status === 'running') return { label: 'Running', variant: 'success' };
		if (shell.status === 'starting') return { label: 'Starting', variant: 'warning' };
		if (shell.status === 'deleting') return { label: 'Deleting', variant: 'danger' };
		return { label: 'Stopped', variant: 'neutral' };
	});
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
		{#if shell && (running || shell.status === 'starting')}
			<Button variant="outline" size="sm" disabled={busy !== null} onclick={stop}>
				{#if busy === 'stop'}<Spinner />{:else}<SquareIcon />{/if}
				Stop
			</Button>
		{:else}
			<Button size="sm" disabled={busy !== null || shell?.status === 'deleting'} onclick={start}>
				{#if busy === 'start'}<Spinner />{:else}<PlayIcon />{/if}
				Start
			</Button>
		{/if}
		{#if shell && shell.status !== 'deleting'}
			<Button variant="ghost" size="sm" disabled={busy !== null} onclick={reset}>
				<RotateCcwIcon />
				Reset disk
			</Button>
		{/if}
	{/if}
</PageHeader>

{#if !current}
	<EmptyState icon={TerminalIcon} title="Cloud shell unavailable" description={data.refusal ?? 'The cloud shell is unavailable.'} />
{:else if !current.enabled}
	<EmptyState
		icon={TerminalIcon}
		title="The cloud shell is turned off"
		description="An operator turned it off on this install (YOAL_FEATURE_CLOUD_SHELL=0). Your disk, if you had one, is kept."
	/>
{:else}
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
						{#if shell?.node && !shell.node.online}<span class="text-destructive">· offline</span>{/if}
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
						{diskLabel} at <span class="font-mono text-xs">{shell?.home ?? '/home/yoal'}</span>
					</p>
				</div>
			</Card.Content>
		</Card.Root>
		<Card.Root class="gap-1 py-4">
			<Card.Content class="flex items-center gap-3 px-4">
				{#if running || shell?.status === 'starting'}
					<KeyRoundIcon class="size-4 shrink-0 text-muted-foreground" />
					<div class="min-w-0">
						<p class="text-xs text-muted-foreground">yoal CLI</p>
						<p class="truncate text-sm font-medium">
							{shell?.cliSignedIn ? 'Signed in as you' : 'Not signed in (run yoal login)'}
						</p>
					</div>
				{:else}
					<TimerIcon class="size-4 shrink-0 text-muted-foreground" />
					<div class="min-w-0">
						<p class="text-xs text-muted-foreground">Idle stop</p>
						<p class="truncate text-sm font-medium">After {current.limits.idleMinutes} minutes</p>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	{#if failure}
		<p class="text-sm text-destructive">{failure}</p>
	{/if}

	{#if running}
		{#key terminalKey}
			<ContainerShell
				slug="~cloud-shell"
				base="/cloud-shell/console"
				simple
				label="Cloud shell"
				note={`Runs as you in a small sandboxed container on ${shell?.node?.name ?? 'a node'}: ${current.limits.memoryMb} MiB of memory, no added capabilities, a read-only system and a ${diskLabel} home disk that survives stops. It stops after ${current.limits.idleMinutes} minutes without typing${shell?.stopsAt ? ` (next: ${formatRelative(shell.stopsAt)})` : ''}. Opening a shell is audited; what you type is not.`}
			/>
		{/key}
	{:else if starting}
		<div class="flex h-[min(70vh,640px)] items-center justify-center rounded-xl border bg-[#0b0d10] text-sm text-[#e4e7eb]">
			<span class="flex items-center gap-2">
				<Spinner class="size-4" />
				Starting your cloud shell{shell?.node ? ` on ${shell.node.name}` : ''}… The first start pulls the image and can take a minute.
			</span>
		</div>
	{:else}
		<EmptyState
			icon={TerminalIcon}
			title={shell?.status === 'deleting' ? 'Your old disk is being deleted' : 'Your cloud shell is stopped'}
			description={shell?.status === 'deleting'
				? 'Once its node has deleted the disk you can start a new shell.'
				: `Start it to get a terminal with the yoal CLI. Files in your home directory are kept on its ${diskLabel} disk.`}
		/>
	{/if}
{/if}

<ConfirmDialog />
