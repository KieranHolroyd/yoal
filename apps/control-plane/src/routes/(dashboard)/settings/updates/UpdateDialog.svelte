<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import type { SelfUpdateChannel, SelfUpdateMethod } from '@yoal/contracts';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { methodOption, methods } from './update-ui.js';

	/** Confirm and request a control plane update; the install method is chosen here. */
	let {
		open = $bindable(false),
		current,
		target,
		channel,
		switching,
		defaultMethod,
		preflightOk,
		previousUpdatedAt,
		onrequested
	}: {
		open?: boolean;
		current: string;
		/** The version on offer; null installs whatever is newest (or only switches channel). */
		target: string | null;
		channel: SelfUpdateChannel;
		/** Requesting also moves the host onto `channel`. */
		switching: boolean;
		defaultMethod: SelfUpdateMethod;
		preflightOk: boolean;
		/** The status timestamp from before the request; a later one proves this run started. */
		previousUpdatedAt: string | null;
		onrequested: (previousUpdatedAt: string | null) => void;
	} = $props();

	let method = $state<SelfUpdateMethod>(untrack(() => defaultMethod));
	let requesting = $state(false);
	let form = $state<HTMLFormElement | null>(null);

	const title = $derived(
		target
			? `Update Yoal to v${target}?`
			: switching
				? `Switch this host to ${channel}?`
				: 'Install the newest version?'
	);
	const description = $derived(
		target
			? `It is test-booted against a copy of your data before anything switches over, and rolls back to v${current} on its own if a health check fails.${switching ? ` This host follows ${channel} from now on.` : ''}`
			: switching
				? `v${current} keeps running. The host records ${channel} and installs its next release once it is newer.`
				: 'The updater checks GitHub itself and installs the newest version, if there is one.'
	);
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Media class="bg-info/10 text-info">
				<CircleArrowUpIcon />
			</AlertDialog.Media>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			<AlertDialog.Description>{description}</AlertDialog.Description>
		</AlertDialog.Header>

		<form
			bind:this={form}
			method="POST"
			action="?/update"
			class="space-y-4 text-sm"
			use:enhance={() => {
				const previous = previousUpdatedAt;
				requesting = true;
				return async ({ result, update }) => {
					await update();
					requesting = false;
					open = false;
					if (result.type === 'success') onrequested(previous);
				};
			}}
		>
			<input type="hidden" name="channel" value={channel} />

			{#if target}
				<p class="flex items-center gap-3 font-mono tabular-nums">
					<span class="text-muted-foreground">v{current}</span>
					<ArrowRightIcon class="size-3.5 text-muted-foreground" aria-label="to" />
					<span class="font-semibold">v{target}</span>
				</p>
			{/if}

			<div class="space-y-1.5">
				<label for="update-method" class="text-xs font-medium text-muted-foreground"
					>Install method</label
				>
				<NativeSelect.Root id="update-method" name="method" bind:value={method} class="w-full">
					{#each methods as option (option.value)}
						<NativeSelect.Option value={option.value}>
							{option.label}{option.value === defaultMethod ? ' (default)' : ''}
						</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				<p class="text-xs text-pretty text-muted-foreground">{methodOption(method).description}</p>
			</div>

			<p class="text-xs text-pretty text-muted-foreground">
				The dashboard and API are down for a few seconds near the end; deployed sites keep serving.
			</p>

			{#if !preflightOk}
				<Notice tone="danger" title="A pre-update check is failing">
					The updater will most likely stop before changing anything.
				</Notice>
			{/if}
		</form>

		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={requesting}>Cancel</AlertDialog.Cancel>
			<Button disabled={requesting} onclick={() => form?.requestSubmit()}>
				{#if requesting}<LoaderCircleIcon class="animate-spin" aria-hidden="true" />{/if}
				{switching && !target ? 'Switch channel' : 'Start update'}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
