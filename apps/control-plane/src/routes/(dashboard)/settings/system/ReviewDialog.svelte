<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import FileCogIcon from '@lucide/svelte/icons/file-cog';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { runAction } from '#lib/actions.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { changeFields, envDiff, type ToggleChange } from './_lib/changes.js';

	/**
	 * Review before saving: each change, the exact yoal.env lines the helper will write, and an
	 * explicit acknowledgement when a change weakens sign-in or data safety.
	 */
	let {
		open = $bindable(false),
		changes,
		local = false,
		onsaved
	}: {
		open?: boolean;
		changes: ToggleChange[];
		/** Dev server: saved to .data/platform-settings.json, applied on the next restart. */
		local?: boolean;
		onsaved: () => void;
	} = $props();

	const risky = $derived(changes.filter((change) => change.risky));
	const diff = $derived(envDiff(changes));
	let acknowledged = $state(false);
	let saving = $state(false);

	$effect(() => {
		if (!open) acknowledged = false;
	});

	async function save() {
		saving = true;
		const result = await runAction('?/save', changeFields(changes));
		saving = false;
		if (result.type === 'success') {
			open = false;
			onsaved();
		}
	}
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content class="sm:max-w-xl">
		<AlertDialog.Header>
			<AlertDialog.Media
				class={risky.length ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}
			>
				{#if risky.length}<ShieldAlertIcon />{:else}<FileCogIcon />{/if}
			</AlertDialog.Media>
			<AlertDialog.Title>
				Save {changes.length}
				{changes.length === 1 ? 'change' : 'changes'}{local ? '' : ' and restart'}?
			</AlertDialog.Title>
			<AlertDialog.Description>
				{local
					? 'Saved to .data/platform-settings.json. Restart the dev server to use them.'
					: 'The control plane restarts with the new settings, which takes a few seconds. If it does not come back, the previous file is put back automatically.'}
			</AlertDialog.Description>
		</AlertDialog.Header>

		<div class="max-h-[55vh] space-y-4 overflow-y-auto">
			<ul class="divide-y rounded-lg border">
				{#each changes as change (change.toggle.key)}
					<li class="flex items-center gap-3 px-3 py-2.5 text-sm">
						{#if change.risky}
							<ShieldAlertIcon class="size-4 shrink-0 text-destructive" aria-label="Less safe" />
						{:else}
							<span class="size-4 shrink-0" aria-hidden="true"></span>
						{/if}
						<span class="min-w-0 flex-1 truncate font-medium">{change.toggle.label}</span>
						<span class="flex shrink-0 items-center gap-1.5 text-xs">
							<span class="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
								{change.from ? 'On' : 'Off'}
							</span>
							<ArrowRightIcon class="size-3 text-muted-foreground" />
							<span
								class="rounded px-1.5 py-0.5 font-medium {change.risky
									? 'bg-destructive/10 text-destructive'
									: change.to
										? 'bg-success/10 text-success'
										: 'bg-foreground/10'}"
							>
								{change.to ? 'On' : 'Off'}
							</span>
						</span>
					</li>
				{/each}
			</ul>

			<div class="overflow-hidden rounded-md border bg-muted/40">
				<div class="flex items-center justify-between border-b bg-muted px-3 py-1.5">
					<span class="font-mono text-xs text-muted-foreground"
						>{local ? '.data/platform-settings.json' : '/etc/yoal/yoal.env'}</span
					>
					<span class="text-[11px] text-muted-foreground">
						{diff.filter((line) => line.sign === '+').length} added ·
						{diff.filter((line) => line.sign === '-').length} removed
					</span>
				</div>
				<pre class="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{#each diff as line, index (index)}<span
							class="block {line.sign === '+'
								? 'bg-success/10 text-success'
								: 'bg-destructive/10 text-destructive'}"><span class="select-none opacity-60"
								>{line.sign}
							</span>{line.text}</span
						>{:else}<span class="text-muted-foreground"># no lines change</span>{/each}</pre>
				<p class="border-t px-3 py-2 text-[11px] text-muted-foreground">
					A setting moved back to its default is removed rather than pinned, so a later release can
					change the default.
				</p>
			</div>

			{#if risky.length}
				<Alert.Root variant="destructive">
					<ShieldAlertIcon />
					<Alert.Title>
						{risky.length === 1 ? 'This change makes' : 'These changes make'} the install less safe
					</Alert.Title>
					<Alert.Description>
						<ul class="mt-1 list-disc space-y-0.5 pl-4">
							{#each risky as change (change.toggle.key)}
								<li>
									<span class="font-medium">{change.toggle.label}</span>
									{change.to ? 'on' : 'off'}: {change.toggle.description}
								</li>
							{/each}
						</ul>
					</Alert.Description>
				</Alert.Root>
				<Field.Field orientation="horizontal">
					<Checkbox id="system-acknowledge" bind:checked={acknowledged} />
					<Field.Content>
						<Field.Label for="system-acknowledge">I understand and want this anyway</Field.Label>
						<Field.Description>The audit log records who saved it and which keys changed.</Field.Description>
					</Field.Content>
				</Field.Field>
			{/if}
		</div>

		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={saving}>Keep editing</AlertDialog.Cancel>
			<Button
				variant={risky.length ? 'destructive' : 'default'}
				disabled={saving || (risky.length > 0 && !acknowledged)}
				onclick={save}
			>
				{#if saving}
					<LoaderCircleIcon class="animate-spin" aria-hidden="true" />
				{:else if !local}
					<RotateCwIcon />
				{/if}
				{local ? 'Save' : 'Save and restart'}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
