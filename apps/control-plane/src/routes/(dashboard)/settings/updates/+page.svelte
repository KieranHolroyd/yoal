<script lang="ts">
	import { browser } from '$app/env';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import CodeIcon from '@lucide/svelte/icons/code';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
	import type { SelfUpdateLog, SelfUpdateStatus } from '@yoal/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import FormFeedback from '#lib/components/yoal/FormFeedback.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import type { Tone } from '#lib/status.js';
	import { fetchJson } from '#lib/query.js';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import ChannelSwitch from './ChannelSwitch.svelte';
	import FleetSection from './FleetSection.svelte';
	import LastUpdate from './LastUpdate.svelte';
	import LogView from './LogView.svelte';
	import MigrationApproval from './MigrationApproval.svelte';
	import UpdateDialog from './UpdateDialog.svelte';
	import UpdateSteps from './UpdateSteps.svelte';
	import type { FleetView } from './fleet-ui.js';
	import { checkLabel, formatElapsed, methodOption, toneTile, updateSteps } from './update-ui.js';
	import type { PageProps } from './$types';

	type StatusView = SelfUpdateStatus & { stale: boolean };
	interface Live {
		version: string;
		status: StatusView | null;
		pending: boolean;
		inFlight: boolean;
		log: SelfUpdateLog;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as { success?: string; message?: string } | null);

	const queryClient = useQueryClient();
	/**
	 * True from the moment an update is requested until its finished state has been loaded. It
	 * cannot rely on `data.inFlight` alone: systemd consumes the request file before the updater
	 * writes its status, so for a moment nothing on disk says a run is under way.
	 */
	let following = $state(false);
	/** The status `updatedAt` from before the request; a later one proves this run has started. */
	let baseline = $state<string | null>(null);
	/** The updater never picked the request up; stop waiting and point at the server. */
	let startTimedOut = $state(false);
	let checking = $state(false);
	let confirmOpen = $state(false);

	// Node versions and the running rollout, re-read on their own: quickly while nodes are
	// updating, slowly otherwise. The page data wins again whenever it is newer (after an action).
	const fleetBusy = (view: FleetView) => view.active !== null || view.counts.updating > 0;
	const fleetPoll = createQuery(() => ({
		queryKey: ['fleet-update-status'] as const,
		queryFn: ({ signal }) =>
			fetchJson<FleetView>('/settings/updates/fleet', { signal, cache: 'no-store' }),
		enabled: browser && data.fleet.readable,
		refetchInterval: (query) => (fleetBusy(query.state.data ?? data.fleet) ? 3_000 : 15_000),
		staleTime: 0,
		retry: false
	}));
	const fleet = $derived(
		fleetPoll.data && fleetPoll.data.at > data.fleet.at ? fleetPoll.data : data.fleet
	);

	function beginFollowing(previousUpdatedAt: string | null) {
		baseline = previousUpdatedAt;
		startTimedOut = false;
		following = true;
	}

	function stopFollowing() {
		following = false;
		queryClient.removeQueries({ queryKey: ['self-update-status'] });
	}

	// The page was opened (or reloaded) while a run was already queued or running.
	$effect(() => {
		if (following || !data.inFlight) return;
		beginFollowing(data.status?.updatedAt ?? null);
	});

	// The control plane restarts near the end, so failed polls are expected for a few seconds:
	// no retries, keep the interval going, and say we are reconnecting.
	const poll = createQuery(() => ({
		queryKey: ['self-update-status'] as const,
		queryFn: ({ signal }) =>
			fetchJson<Live>('/settings/updates/status', { signal, cache: 'no-store' }),
		enabled: browser && following,
		refetchInterval: 1_000,
		staleTime: 0,
		retry: false
	}));

	/** Fresh state from the status endpoint while an update runs; null = use the page data. */
	const live = $derived(following ? (poll.data ?? null) : null);
	const reconnecting = $derived(following && poll.isError);

	const view = $derived<Live>(
		live ?? {
			version: data.comparison.current,
			status: data.status,
			pending: data.pending,
			inFlight: data.inFlight,
			log: data.log
		}
	);
	/** The updater has written progress for this run, not just the previous run's last status. */
	const runObserved = $derived(
		Boolean(view.status && (view.status.running || view.status.updatedAt !== baseline))
	);
	const ready = $derived(data.availability === 'ready');
	/** Following but not observed yet means "queued": the trigger has fired, status is next. */
	const running = $derived(view.inFlight || (following && !runObserved));
	const lastRun = $derived(view.status && !view.status.running && !running ? view.status : null);
	/** Until the updater truncates and rewrites the file, a queued run has no log of its own. */
	const currentLog = $derived(
		(following && !runObserved) || (view.pending && !view.status?.running)
			? { lines: [], exists: false, truncated: false, updatedAt: null }
			: view.log
	);

	$effect(() => {
		const next = poll.data;
		if (!following || !next) return;
		const status = next.status;
		const observed = Boolean(status && (status.running || status.updatedAt !== baseline));
		// Keep following through the gap between the request being consumed and status being
		// written; the previous run's finished status does not mean this run is over.
		if (!observed && !next.inFlight) return;
		if (next.inFlight && next.version === data.comparison.current) return;
		void invalidateAll().then(stopFollowing);
	});

	// If nothing starts at all (for example the path unit was removed), do not sit on "Queued"
	// forever: reload once after a minute and tell the reader where to look.
	$effect(() => {
		if (!following || runObserved || view.inFlight) return;
		const timer = setTimeout(() => {
			startTimedOut = true;
			void invalidateAll().then(stopFollowing);
		}, 60_000);
		return () => clearTimeout(timer);
	});

	/** The run being shown, once the updater has reported on it. */
	const activeRun = $derived(view.status?.running && !view.status.stale ? view.status : null);
	const steps = $derived(updateSteps(activeRun?.method ?? data.defaultMethod));
	const currentPhase = $derived(activeRun?.phase ?? 'queued');
	const rollingBack = $derived(currentPhase === 'rolling-back');
	const currentStep = $derived(
		rollingBack
			? steps.length - 1
			: Math.max(
					0,
					steps.findIndex((step) => step.phase === currentPhase)
				)
	);

	// A ticking clock for the elapsed time; only runs while an update does.
	let now = $state(Date.now());
	$effect(() => {
		if (!running) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 1_000);
		return () => clearInterval(timer);
	});
	const elapsed = $derived(activeRun ? formatElapsed(now - Date.parse(activeRun.startedAt)) : null);

	const target = $derived(data.comparison.available ? data.comparison.latest : null);
	/** Previewing the other channel: requesting an update also moves the host onto it. */
	const switching = $derived(data.channel !== data.hostChannel);
	const canInstall = $derived(
		ready &&
			!running &&
			(data.comparison.available || switching || (!data.latest.ok && data.channel === 'canary'))
	);

	const lastRunFailed = $derived(
		lastRun?.outcome === 'build-failed' ||
			lastRun?.outcome === 'canary-failed' ||
			lastRun?.outcome === 'error' ||
			lastRun?.outcome === 'rolled-back'
	);
	/** The last run was refused until destructive migrations are approved (see MigrationApproval). */
	const approval = $derived(lastRun?.approval ?? null);
	/** It is for the version on offer, so approving replaces the plain install. */
	const needsApproval = $derived(Boolean(approval && (!target || approval.version === target)));
	/** The last run tried this same version and failed: lead with that, not the offer. */
	const retrying = $derived(lastRunFailed && Boolean(target) && lastRun?.toVersion === target);

	/** Pre-update checks that are not passing; passed checks only show as a count. */
	const problems = $derived(
		[...data.preflight.checks]
			.filter((check) => check.status !== 'ok')
			.sort((a, b) => (a.status === 'error' ? 0 : 1) - (b.status === 'error' ? 0 : 1))
	);
	const passed = $derived(data.preflight.checks.filter((check) => check.status === 'ok'));

	/** The one state this host is in, picked in priority order. */
	const hero = $derived.by(
		(): {
			tone: Tone;
			icon: typeof CircleCheckIcon;
			spin?: boolean;
			title: string;
			description: string;
		} => {
			if (running && rollingBack && activeRun)
				return {
					tone: 'warning',
					icon: RotateCcwIcon,
					title: activeRun.fromVersion
						? `Rolling back to v${activeRun.fromVersion}`
						: 'Rolling back',
					description: `${activeRun.toVersion ? `v${activeRun.toVersion}` : 'The new version'} failed its health checks after switching over. The previous version is being restored.`
				};
			if (running) {
				const to = activeRun?.toVersion ?? target;
				return {
					tone: 'info',
					icon: LoaderCircleIcon,
					spin: true,
					title: to ? `Updating to v${to}` : 'Installing the newest version',
					description: activeRun
						? `Started ${formatRelative(activeRun.startedAt)} via ${methodOption(activeRun.method).short}. You can leave this page; the update carries on.`
						: 'Queued. systemd starts the updater in a moment.'
				};
			}
			if (data.availability === 'unmanaged')
				return {
					tone: 'neutral',
					icon: CodeIcon,
					title: "This host can't update itself",
					description:
						"It isn't running from an installed release (for example a development server). Hosts installed with install.sh update from here."
				};
			if (!data.latest.ok)
				return {
					tone: 'warning',
					icon: TriangleAlertIcon,
					title: "Couldn't check for updates",
					description: ready
						? `${data.latest.error} The updater can still check with its own GitHub credentials.`
						: data.latest.error
				};
			if (approval && needsApproval)
				return {
					tone: 'warning',
					icon: ShieldAlertIcon,
					title: `v${approval.version} needs your approval`,
					description: `It changes or removes existing data in the control database, so the updater stopped before installing it. Review the SQL below.`
				};
			if (data.comparison.available && retrying && lastRun)
				return {
					tone: 'warning',
					icon: TriangleAlertIcon,
					title: `v${target} didn't install`,
					description: `${lastRun.message} You're still on v${view.version}.`
				};
			if (data.comparison.available)
				return {
					tone: 'info',
					icon: CircleArrowUpIcon,
					title: `v${target} is available`,
					description: `${data.comparison.bump ? `A ${data.comparison.bump} update` : 'An update'} on ${data.channel}. Test-booted against a copy of your data first, and rolled back on its own if anything fails.`
				};
			if (switching)
				return {
					tone: 'info',
					icon: ShieldCheckIcon,
					title: `This host is ahead of ${data.channel}`,
					description: `The newest ${data.channel} release is v${data.comparison.latest}. Switching keeps v${view.version} (Yoal never downgrades) and installs the next ${data.channel} release once it is newer.`
				};
			return {
				tone: 'success',
				icon: CircleCheckIcon,
				title: "You're up to date",
				description: `v${view.version} is the newest ${data.channel} release.`
			};
		}
	);

	const action = $derived(
		target ? `Update to v${target}` : switching ? `Switch to ${data.channel}` : 'Check and install'
	);
</script>

<svelte:head><title>Updates · Settings · Yoal</title></svelte:head>

<SettingsHeader id="updates">
	{#snippet actions()}
		<form
			method="POST"
			action="?/check"
			use:enhance={() => {
				checking = true;
				return async ({ update }) => {
					await update();
					checking = false;
				};
			}}
		>
			<input type="hidden" name="channel" value={data.channel} />
			<Button type="submit" variant="outline" size="sm" disabled={checking || running}>
				<RefreshCwIcon class={checking ? 'animate-spin' : ''} aria-hidden="true" />
				{checking ? 'Checking…' : 'Check for updates'}
			</Button>
		</form>
	{/snippet}
</SettingsHeader>

<div class="space-y-6">
	<FormFeedback {result} />

	{#if data.availability === 'not-enabled'}
		<Notice tone="warning" title="Dashboard updates aren't enabled on this host">
			Run <code>sudo yoal-update-self check</code> on the server once. It installs the systemd trigger
			this page uses to start an update.
		</Notice>
	{/if}

	{#if startTimedOut && !running && !data.inFlight}
		<Notice tone="warning" title="The updater hasn't started">
			The request is queued, but nothing has reported progress. Check
			<code>systemctl status yoal-update-self.path</code> and
			<code>journalctl -u yoal-update-self</code>.
		</Notice>
	{/if}

	{#if !running && view.status?.stale}
		<Notice tone="warning" title="The last update stopped reporting">
			It last said “{view.status.message}” at {formatDateTime(view.status.updatedAt)} and probably crashed.
			Check <code>journalctl -u yoal-update-self</code>. You can start a new update.
		</Notice>
	{/if}

	<!-- The control plane: one card that is the state, the action and, while running, the progress. -->
	<section
		class="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs"
		aria-labelledby="update-title"
	>
		<div class="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:gap-5 sm:p-6">
			<span
				class="flex size-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset {toneTile[
					hero.tone
				]}"
				aria-hidden="true"
			>
				<hero.icon class="size-5 {hero.spin ? 'animate-spin' : ''}" />
			</span>
			<div class="min-w-0 flex-1 space-y-1">
				<h3 id="update-title" class="text-lg leading-tight font-semibold tracking-tight">
					{hero.title}
				</h3>
				<p class="max-w-prose text-sm text-pretty text-muted-foreground" aria-live="polite">
					{hero.description}
				</p>
			</div>
			{#if canInstall && !needsApproval}
				<Button class="shrink-0 self-start sm:self-center" onclick={() => (confirmOpen = true)}>
					<CircleArrowUpIcon aria-hidden="true" />
					{action}
				</Button>
			{:else if running && elapsed}
				<span
					class="shrink-0 self-start font-mono text-sm text-muted-foreground tabular-nums sm:self-center"
					title="Time since the updater started">{elapsed}</span
				>
			{/if}
		</div>

		{#if running}
			<div class="space-y-4 border-t p-5 sm:p-6">
				<UpdateSteps {steps} current={currentStep} {rollingBack} />
				<p
					class="flex items-start gap-2.5 text-sm text-pretty {rollingBack ? 'text-warning' : ''}"
					aria-live="polite"
				>
					<span class="relative mt-1.5 flex size-2 shrink-0" aria-hidden="true">
						<span
							class="absolute size-full animate-ping rounded-full opacity-60 {rollingBack
								? 'bg-warning'
								: 'bg-info'}"
						></span>
						<span class="relative size-2 rounded-full {rollingBack ? 'bg-warning' : 'bg-info'}"
						></span>
					</span>
					{activeRun ? activeRun.message : 'Waiting for systemd to start the updater…'}
				</p>
				{#if reconnecting}
					<p class="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
						<WifiOffIcon class="size-3.5" aria-hidden="true" />
						The control plane is restarting; reconnecting…
					</p>
				{/if}
				<LogView log={currentLog} running />
			</div>
		{:else if problems.length > 0 && data.availability !== 'unmanaged'}
			<ul class="divide-y border-t px-5 sm:px-6" aria-label="Pre-update checks needing attention">
				{#each problems as check (check.id + check.message)}
					<li class="flex items-start gap-3 py-3 text-sm">
						{#if check.status === 'error'}
							<CircleXIcon
								class="mt-0.5 size-4 shrink-0 text-destructive"
								aria-label="Blocks the update"
							/>
						{:else}
							<TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />
						{/if}
						<p class="min-w-0 text-pretty break-words">
							<span class="font-medium">{checkLabel(check.id)}</span>
							<span class="text-muted-foreground">— {check.message}</span>
						</p>
					</li>
				{/each}
			</ul>
		{/if}

		<div
			class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/30 px-5 py-2.5 text-xs text-muted-foreground sm:px-6"
		>
			<span>Running <span class="font-mono font-medium text-foreground">v{view.version}</span></span
			>
			{#if data.availability !== 'unmanaged' && !running}
				<ChannelSwitch
					selected={data.channel}
					hostChannel={data.hostChannel}
					latest={data.channels}
				/>
				{#if passed.length > 0}
					<span
						class="inline-flex items-center gap-1"
						title={passed.map((check) => checkLabel(check.id)).join(', ')}
					>
						<ShieldCheckIcon
							class="size-3.5 {problems.length ? '' : 'text-success'}"
							aria-hidden="true"
						/>
						{passed.length}/{data.preflight.checks.length} checks pass
					</span>
				{/if}
			{/if}
			<a
				href="https://github.com/{data.source.repo}/tree/{data.source.ref}"
				target="_blank"
				rel="external noreferrer"
				class="inline-flex min-w-0 items-center gap-1 font-mono hover:text-foreground sm:ml-auto"
				title={data.latest.checkedAt
					? `Checked ${formatDateTime(data.latest.checkedAt)}`
					: undefined}
			>
				<GitBranchIcon class="size-3 shrink-0" aria-hidden="true" />
				<span class="truncate">{data.source.repo}@{data.source.ref}</span>
			</a>
		</div>
	</section>

	{#if approval && needsApproval && ready && !running}
		<MigrationApproval
			{approval}
			currentVersion={view.version}
			method={data.defaultMethod}
			channel={data.channel}
			previousUpdatedAt={data.status?.updatedAt ?? null}
			onrequested={beginFollowing}
		/>
	{/if}

	<FleetSection {fleet} controlTarget={target} controlRunning={running} />

	{#if !running && (lastRun?.outcome || data.snapshots.length > 0 || currentLog.exists)}
		<LastUpdate {lastRun} log={currentLog} snapshots={data.snapshots} failed={lastRunFailed} />
	{/if}
</div>

{#if canInstall && !needsApproval}
	<UpdateDialog
		bind:open={confirmOpen}
		current={view.version}
		{target}
		channel={data.channel}
		{switching}
		defaultMethod={data.defaultMethod}
		preflightOk={data.preflight.ok}
		previousUpdatedAt={data.status?.updatedAt ?? null}
		onrequested={beginFollowing}
	/>
{/if}
