<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import InfoIcon from '@lucide/svelte/icons/info';
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import Minimize2Icon from '@lucide/svelte/icons/minimize-2';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SquareIcon from '@lucide/svelte/icons/square';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { cloudShell, diskLabel, DRAWER_MIN_HEIGHT } from '#lib/cloud-shell/cloud-shell.svelte.js';
	import ContainerShell from '../projects/[slug]/_components/ContainerShell.svelte';

	type Phase = 'loading' | 'idle' | 'opening' | 'live' | 'reconnecting' | 'ended' | 'error';

	/** Space kept above the drawer for the sticky page header (h-14) and the inset's margin. */
	const TOP_GAP = 72;

	let terminal = $state<ReturnType<typeof ContainerShell> | null>(null);
	let phase = $state<Phase>('loading');
	let section = $state<HTMLElement | null>(null);
	let drawerHeight = $state(0);
	let confirmReset = $state(false);
	let resetting = $state(false);
	let resetFailure = $state<string | null>(null);
	/**
	 * The terminal mounts the first time the drawer opens on a running shell and then stays
	 * mounted while the shell runs, so hiding the drawer or changing page keeps the session.
	 */
	let opened = $state(false);
	let now = $state(Date.now());

	const shell = $derived(cloudShell.shell);
	const showTerminal = $derived(opened && cloudShell.running);

	onMount(() => {
		cloudShell.init();
		const clock = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(clock);
	});

	$effect(() => {
		if (cloudShell.open) opened = true;
	});

	// The assistant's launcher floats bottom right; keep it above the drawer.
	$effect(() => {
		const root = document.documentElement;
		root.style.setProperty('--yoal-cloud-shell-height', `${cloudShell.open ? drawerHeight : 0}px`);
		return () => root.style.removeProperty('--yoal-cloud-shell-height');
	});

	function maxHeight(): number {
		return Math.max(DRAWER_MIN_HEIGHT, window.innerHeight - TOP_GAP);
	}

	const clamp = (value: number) => Math.min(maxHeight(), Math.max(DRAWER_MIN_HEIGHT, value));

	// --- resizing from the top edge ---------------------------------------------------------

	let drag: { startY: number; startHeight: number } | null = null;

	function resizeStart(event: PointerEvent) {
		if (event.button !== 0 || !section) return;
		event.preventDefault();
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		drag = { startY: event.clientY, startHeight: section.getBoundingClientRect().height };
	}

	function resizeMove(event: PointerEvent) {
		if (!drag) return;
		cloudShell.setHeight(clamp(drag.startHeight + drag.startY - event.clientY));
	}

	function resizeEnd(event: PointerEvent) {
		if (!drag) return;
		drag = null;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
	}

	function resizeKey(event: KeyboardEvent) {
		const step = event.shiftKey ? 96 : 24;
		if (event.key === 'ArrowUp') cloudShell.setHeight(clamp(cloudShell.height + step));
		else if (event.key === 'ArrowDown') cloudShell.setHeight(clamp(cloudShell.height - step));
		else return;
		event.preventDefault();
	}

	// --- keyboard: Ctrl+` toggles, as in most editors ---------------------------------------

	function keydown(event: KeyboardEvent) {
		if (
			event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			(event.key === '`' || event.code === 'Backquote')
		) {
			// Captured before the terminal sees it, so it never reaches the shell as a NUL byte.
			event.preventDefault();
			event.stopPropagation();
			cloudShell.toggle();
		}
	}

	// Focus the terminal when the drawer opens on a live session.
	$effect(() => {
		if (cloudShell.open && showTerminal)
			requestAnimationFrame(() =>
				section?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus()
			);
	});

	async function reset() {
		resetting = true;
		resetFailure = null;
		const ok = await cloudShell.reset();
		resetting = false;
		if (ok) confirmReset = false;
		else resetFailure = cloudShell.failure;
	}

	function minutesUntil(iso: string): string {
		const minutes = Math.round((new Date(iso).getTime() - now) / 60_000);
		if (minutes <= 1) return 'in a minute';
		if (minutes < 90) return `in ${minutes} min`;
		return `in ${Math.round(minutes / 60)} h`;
	}

	const pill = $derived.by((): { label: string; dot: string } => {
		if (!cloudShell.state) return { label: 'Loading', dot: 'bg-muted-foreground' };
		if (cloudShell.busy === 'stop') return { label: 'Stopping', dot: 'bg-warning animate-pulse' };
		if (cloudShell.starting) return { label: 'Starting', dot: 'bg-warning animate-pulse' };
		if (cloudShell.running) {
			if (!showTerminal || phase === 'live') return { label: 'Running', dot: 'bg-success' };
			if (phase === 'ended') return { label: 'Session ended', dot: 'bg-muted-foreground' };
			if (phase === 'error') return { label: 'Not connected', dot: 'bg-destructive' };
			return { label: 'Connecting', dot: 'bg-warning animate-pulse' };
		}
		if (cloudShell.failed) return { label: 'Failed to start', dot: 'bg-destructive' };
		if (cloudShell.status === 'deleting') return { label: 'Deleting disk', dot: 'bg-warning' };
		return { label: 'Stopped', dot: 'bg-muted-foreground' };
	});

	const meta = $derived.by(() => {
		if (!shell) return null;
		const parts: string[] = [];
		if (shell.node)
			parts.push(shell.node.online ? shell.node.name : `${shell.node.name} (offline)`);
		parts.push(`${diskLabel(shell.diskMb)} home`);
		if (cloudShell.running) {
			parts.push(shell.cliSignedIn ? 'CLI signed in' : 'CLI signed out');
			if (shell.stopsAt) parts.push(`idle stop ${minutesUntil(shell.stopsAt)}`);
		}
		return parts.join(' · ');
	});
</script>

<svelte:window onkeydowncapture={keydown} />

<section
	bind:this={section}
	bind:clientHeight={drawerHeight}
	class="sticky bottom-0 z-30 flex shrink-0 flex-col border-t bg-background shadow-[0_-12px_32px_-16px_rgb(0_0_0/0.35)] md:bottom-2 md:rounded-b-xl {cloudShell.open
		? ''
		: 'hidden'}"
	style:height={cloudShell.maximized
		? `calc(100svh - ${TOP_GAP}px)`
		: `min(${cloudShell.height}px, calc(100svh - ${TOP_GAP}px))`}
	aria-label="Cloud shell"
	data-yoal-target="cloud-shell.drawer"
>
	<!-- Drag the top edge to resize; arrow keys do the same. A focusable separator is the ARIA
	     window-splitter pattern, which the a11y lint does not count as interactive. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div
		class="group absolute inset-x-0 -top-1.5 z-10 flex h-3 cursor-row-resize touch-none justify-center outline-none"
		role="separator"
		aria-orientation="horizontal"
		aria-label="Resize the cloud shell"
		aria-valuemin={DRAWER_MIN_HEIGHT}
		aria-valuenow={Math.round(drawerHeight)}
		tabindex="0"
		onpointerdown={resizeStart}
		onpointermove={resizeMove}
		onpointerup={resizeEnd}
		onpointercancel={resizeEnd}
		onkeydown={resizeKey}
		ondblclick={() => (cloudShell.maximized = !cloudShell.maximized)}
	>
		<span
			class="mt-1 h-1 w-12 rounded-full bg-border opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
		></span>
	</div>

	<header class="flex h-11 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
		<SquareTerminalIcon class="size-4 shrink-0 text-muted-foreground" />
		<span class="text-sm font-medium">Cloud shell</span>
		<span
			class="flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
			aria-live="polite"
		>
			<span class="size-1.5 rounded-full {pill.dot}"></span>
			{pill.label}
		</span>
		{#if meta}
			<span class="hidden min-w-0 truncate text-xs text-muted-foreground md:inline">{meta}</span>
		{/if}

		<div class="ml-auto flex shrink-0 items-center gap-0.5">
			{#if cloudShell.running}
				{#if showTerminal}
					<Button
						variant="ghost"
						size="sm"
						onclick={() => terminal?.restart()}
						title="Close this session and open a new one"
					>
						<PlusIcon />
						<span class="hidden sm:inline">New session</span>
					</Button>
				{/if}
				<Button
					variant="ghost"
					size="sm"
					disabled={cloudShell.busy !== null}
					onclick={() => cloudShell.stop()}
					title="Stop the shell. Files in your home directory are kept."
				>
					{#if cloudShell.busy === 'stop'}<Spinner />{:else}<SquareIcon />{/if}
					<span class="hidden sm:inline">Stop</span>
				</Button>
			{:else if cloudShell.state?.enabled && !cloudShell.starting && cloudShell.status !== 'deleting'}
				<Button variant="ghost" size="sm" onclick={() => cloudShell.start()}>
					<PlayIcon />
					<span class="hidden sm:inline">{cloudShell.failed ? 'Try again' : 'Start'}</span>
				</Button>
			{/if}

			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button variant="ghost" size="icon-sm" aria-label="More cloud shell actions" {...props}>
							<EllipsisIcon />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-52">
					<DropdownMenu.Item onSelect={() => goto(resolve('/(dashboard)/cloud-shell'))}>
						<InfoIcon />
						Details and limits
					</DropdownMenu.Item>
					<DropdownMenu.Item
						onSelect={() =>
							goto(resolve('/(dashboard)/docs/[...slug]', { slug: 'clients/cloud-shell' }))}
					>
						<BookOpenIcon />
						Documentation
					</DropdownMenu.Item>
					{#if shell && cloudShell.status !== 'deleting'}
						<DropdownMenu.Separator />
						<DropdownMenu.Item variant="destructive" onSelect={() => (confirmReset = true)}>
							<RotateCcwIcon />
							Reset disk…
						</DropdownMenu.Item>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>

			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => (cloudShell.maximized = !cloudShell.maximized)}
				aria-label={cloudShell.maximized ? 'Restore size' : 'Maximise'}
				title={cloudShell.maximized ? 'Restore size' : 'Maximise'}
			>
				{#if cloudShell.maximized}<Minimize2Icon />{:else}<Maximize2Icon />{/if}
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => cloudShell.hide()}
				aria-label="Hide the cloud shell"
				title="Hide (Ctrl+`). The shell keeps running."
			>
				<ChevronDownIcon />
			</Button>
		</div>
	</header>

	<div class="relative min-h-0 flex-1 overflow-hidden bg-[#0b0d10] text-[#e4e7eb] md:rounded-b-xl">
		{#if showTerminal}
			{#key cloudShell.generation}
				<ContainerShell
					bind:this={terminal}
					bind:phase
					slug="~cloud-shell"
					base="/cloud-shell/console"
					simple
					panel
					label="Cloud shell terminal"
				/>
			{/key}
		{:else}
			<div class="flex size-full items-center justify-center p-6 text-center text-sm">
				{#if cloudShell.state && !cloudShell.state.enabled}
					<p class="text-[#9aa1ab]">The cloud shell is turned off on this install.</p>
				{:else if cloudShell.starting}
					<div class="flex flex-col items-center gap-3">
						<Spinner class="size-5" />
						<p>Starting your cloud shell{shell?.node ? ` on ${shell.node.name}` : ''}…</p>
						<p class="text-xs text-[#9aa1ab]">
							The first start downloads the shell's image and can take a minute.
						</p>
					</div>
				{:else if cloudShell.failed}
					<div class="flex max-w-xl flex-col items-center gap-3">
						<CircleAlertIcon class="size-5 text-[#f2777a]" />
						<p class="font-medium">Your cloud shell did not start</p>
						<p class="text-xs leading-relaxed text-[#9aa1ab]">{shell?.message}</p>
						<Button size="sm" variant="secondary" onclick={() => cloudShell.start()}>
							<PlayIcon />
							Try again
						</Button>
					</div>
				{:else if cloudShell.status === 'deleting'}
					<p class="text-[#9aa1ab]">
						Your old disk is being deleted. You can start a new shell once its node has finished.
					</p>
				{:else if cloudShell.state}
					<div class="flex flex-col items-center gap-3">
						<SquareTerminalIcon class="size-6 text-[#9aa1ab]" />
						<p>Your cloud shell is stopped.</p>
						<p class="text-xs text-[#9aa1ab]">
							A terminal with the yoal CLI signed in as you. Files in your {diskLabel(
								shell?.diskMb ?? cloudShell.state.limits.diskMb
							)} home directory are kept between sessions.
						</p>
						<Button size="sm" variant="secondary" onclick={() => cloudShell.start()}>
							<PlayIcon />
							Start
						</Button>
					</div>
				{:else if !cloudShell.failure}
					<Spinner class="size-5" />
				{/if}
				{#if cloudShell.failure}
					<p class="absolute inset-x-0 bottom-3 px-6 text-xs text-[#f2777a]">
						{cloudShell.failure}
					</p>
				{/if}
			</div>
		{/if}
	</div>
</section>

<AlertDialog.Root
	open={confirmReset}
	onOpenChange={(open) => {
		if (!open && !resetting) {
			confirmReset = false;
			resetFailure = null;
		}
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Reset your cloud shell?</AlertDialog.Title>
			<AlertDialog.Description>
				This stops the shell and deletes its {diskLabel(shell?.diskMb ?? 1024)} home disk with everything
				in it. The next start makes a new, empty one, possibly on another node.
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if resetFailure}
			<p class="text-sm text-destructive">{resetFailure}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={resetting}>Cancel</AlertDialog.Cancel>
			<Button variant="destructive" disabled={resetting} onclick={reset}>
				{#if resetting}<Spinner />{/if}
				Delete disk and reset
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
