<script lang="ts">
	import { cloudShellPresets, type CloudShellSettings } from '@yoal/contracts';
	import { toast } from 'svelte-sonner';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { cloudShell, diskLabel } from '#lib/cloud-shell/cloud-shell.svelte.js';
	import { errorText } from '#lib/query.js';

	/**
	 * The person's cloud shell settings (D236): node, disk, memory, CPUs and idle stop. Shared by
	 * the drawer's ⋯ menu and the details page. Says before saving what each change takes: the next
	 * start, a restart, or a reset (a smaller disk or another node: the files are on that disk).
	 */
	let { open = $bindable(false) }: { open?: boolean } = $props();

	let node = $state('');
	let disk = $state('1024');
	let memory = $state('512');
	let cpus = $state('1');
	let idle = $state('20');
	let saving = $state<'save' | 'restart' | null>(null);
	let failure = $state<string | null>(null);

	// Load the saved settings each time the dialog opens.
	$effect(() => {
		if (!open) return;
		const saved = cloudShell.state?.settings;
		if (!saved) return;
		node = saved.nodeId ?? '';
		disk = String(saved.diskMb);
		memory = String(saved.memoryMb);
		cpus = String(saved.cpus);
		idle = String(saved.idleMinutes);
		failure = null;
	});

	const shell = $derived(cloudShell.shell);
	const nodes = $derived(cloudShell.state?.nodes ?? []);
	const active = $derived(shell?.status === 'running' || shell?.status === 'starting');
	/** The node the disk is on now, when there is a disk. */
	const diskNode = $derived(shell && shell.status !== 'deleting' ? shell.node : null);
	const diskNodeOption = $derived(nodes.find((item) => item.id === diskNode?.id));

	const next = $derived<CloudShellSettings>({
		nodeId: node || null,
		diskMb: Number(disk),
		memoryMb: Number(memory),
		cpus: Number(cpus),
		idleMinutes: Number(idle)
	});

	const withCurrent = (presets: readonly number[], current: number | undefined) =>
		[...new Set([...presets, ...(current ? [current] : [])])].sort((a, b) => a - b);
	const diskChoices = $derived(
		withCurrent(cloudShellPresets.diskMb, cloudShell.state?.settings.diskMb)
	);
	const memoryChoices = $derived(
		withCurrent(cloudShellPresets.memoryMb, cloudShell.state?.settings.memoryMb)
	);
	const cpuChoices = $derived(withCurrent(cloudShellPresets.cpus, cloudShell.state?.settings.cpus));
	const idleChoices = $derived(
		withCurrent(cloudShellPresets.idleMinutes, cloudShell.state?.settings.idleMinutes)
	);

	/** What saving would take, worded for the person, with the action that applies it. */
	const effects = $derived.by(() => {
		const out: Array<{ text: string; needs: 'reset' | 'restart' | 'start' | 'node-update' }> = [];
		if (!shell || shell.status === 'deleting') return out;
		if (next.nodeId && diskNode && next.nodeId !== diskNode.id) {
			const target = nodes.find((item) => item.id === next.nodeId)?.name ?? 'that node';
			out.push({
				text: `Your disk is on ${diskNode.name}. Moving to ${target} needs a reset, which deletes the files on it.`,
				needs: 'reset'
			});
		}
		if (next.diskMb < shell.diskMb)
			out.push({
				text: `Your disk is ${diskLabel(shell.diskMb)}. A disk can grow but not shrink, so ${diskLabel(next.diskMb)} needs a reset.`,
				needs: 'reset'
			});
		else if (next.diskMb > shell.diskMb)
			out.push(
				diskNodeOption && !diskNodeOption.canGrowDisk
					? {
							text: `${diskNodeOption.name} runs an agent that cannot grow disks yet; the disk grows once it is updated.`,
							needs: 'node-update'
						}
					: {
							text: `Your disk grows to ${diskLabel(next.diskMb)} ${active ? 'when the shell restarts' : 'at the next start'}. Your files stay.`,
							needs: active ? 'restart' : 'start'
						}
			);
		if (
			active &&
			(next.memoryMb !== shell.memoryMb ||
				next.cpus !== shell.cpus ||
				next.idleMinutes !== shell.idleMinutes)
		)
			out.push({
				text: 'Memory, CPU and idle-stop changes apply when the shell restarts.',
				needs: 'restart'
			});
		return out;
	});
	const needsRestart = $derived(effects.some((effect) => effect.needs === 'restart'));

	/** Memory or disk the chosen node does not have free right now. */
	const roomWarning = $derived.by(() => {
		const target = nodes.find((item) => item.id === (next.nodeId ?? diskNode?.id));
		if (!target) return null;
		const shellMemory = shell && active && target.id === diskNode?.id ? shell.memoryMb : 0;
		if (next.memoryMb > target.memoryFreeMb + shellMemory)
			return `${target.name} has ${Math.max(0, target.memoryFreeMb + shellMemory)} MiB of workload memory free; the shell will not start with ${next.memoryMb} MiB.`;
		const growth = target.id === diskNode?.id && shell ? next.diskMb - shell.diskMb : next.diskMb;
		if (growth > 0 && target.diskFreeMb !== null && target.diskFreeMb - 1024 < growth)
			return `${target.name} has ${diskLabel(target.diskFreeMb)} of disk free, not enough for this disk and 1 GiB to spare.`;
		return null;
	});

	function nodeLabel(option: (typeof nodes)[number]): string {
		const facts = [`${option.shells} ${option.shells === 1 ? 'shell' : 'shells'}`];
		if (option.diskFreeMb !== null) facts.push(`${diskLabel(option.diskFreeMb)} disk free`);
		facts.push(`${option.memoryFreeMb} MiB memory free`);
		return `${option.name} · ${option.unavailable ?? facts.join(', ')}`;
	}

	async function save(andRestart: boolean) {
		saving = andRestart ? 'restart' : 'save';
		failure = null;
		try {
			await cloudShell.saveSettings(next);
			if (andRestart) {
				if (!(await cloudShell.restart()))
					throw new Error(cloudShell.failure ?? 'Could not restart the cloud shell.');
				toast.success('Settings saved. Your cloud shell is restarting with them.');
			} else toast.success('Cloud shell settings saved.');
			open = false;
		} catch (error) {
			failure = errorText(error);
		} finally {
			saving = null;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Cloud shell settings</Dialog.Title>
			<Dialog.Description>
				Where your shell runs and what it gets. Changes apply the next time it starts.
			</Dialog.Description>
		</Dialog.Header>

		<Field.Group class="gap-4">
			<Field.Field>
				<Field.Label for="cloud-shell-node">Node</Field.Label>
				<NativeSelect.Root id="cloud-shell-node" bind:value={node} class="w-full">
					<NativeSelect.Option value=""
						>Automatic (the node with the fewest shells)</NativeSelect.Option
					>
					{#each nodes as option (option.id)}
						<NativeSelect.Option
							value={option.id}
							disabled={option.unavailable !== null && option.id !== node}
						>
							{nodeLabel(option)}
						</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				<Field.Description>
					{#if diskNode}
						Your disk is on {diskNode.name}. The node only changes with a new disk.
					{:else}
						Your home disk is made on this node and stays there.
					{/if}
				</Field.Description>
			</Field.Field>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="cloud-shell-disk">Home disk</Field.Label>
					<NativeSelect.Root id="cloud-shell-disk" bind:value={disk} class="w-full">
						{#each diskChoices as mb (mb)}
							<NativeSelect.Option value={String(mb)}>
								{diskLabel(mb)}{shell && shell.status !== 'deleting' && mb < shell.diskMb
									? ' (needs a reset)'
									: ''}
							</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="cloud-shell-memory">Memory</Field.Label>
					<NativeSelect.Root id="cloud-shell-memory" bind:value={memory} class="w-full">
						{#each memoryChoices as mb (mb)}
							<NativeSelect.Option value={String(mb)}>{diskLabel(mb)}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="cloud-shell-cpus">CPUs</Field.Label>
					<NativeSelect.Root id="cloud-shell-cpus" bind:value={cpus} class="w-full">
						{#each cpuChoices as count (count)}
							<NativeSelect.Option value={String(count)}
								>{count} {count === 1 ? 'CPU' : 'CPUs'}</NativeSelect.Option
							>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="cloud-shell-idle">Idle stop</Field.Label>
					<NativeSelect.Root id="cloud-shell-idle" bind:value={idle} class="w-full">
						{#each idleChoices as minutes (minutes)}
							<NativeSelect.Option value={String(minutes)}>
								After {minutes >= 60
									? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`
									: `${minutes} minutes`}
							</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
			</div>
		</Field.Group>

		{#if effects.length > 0 || roomWarning}
			<ul class="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-sm">
				{#if roomWarning}
					<li class="flex gap-2 text-destructive">
						<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />{roomWarning}
					</li>
				{/if}
				{#each effects as effect (effect.text)}
					<li
						class="flex gap-2 {effect.needs === 'reset'
							? 'text-foreground'
							: 'text-muted-foreground'}"
					>
						{#if effect.needs === 'reset'}
							<TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-warning" />
						{:else}
							<InfoIcon class="mt-0.5 size-4 shrink-0" />
						{/if}
						{effect.text}
					</li>
				{/each}
			</ul>
		{/if}

		{#if failure}
			<p class="text-sm text-destructive">{failure}</p>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" disabled={saving !== null} onclick={() => (open = false)}
				>Cancel</Button
			>
			{#if needsRestart}
				<Button variant="outline" disabled={saving !== null} onclick={() => save(false)}>
					{#if saving === 'save'}<Spinner />{/if}
					Save
				</Button>
				<Button disabled={saving !== null} onclick={() => save(true)}>
					{#if saving === 'restart'}<Spinner />{/if}
					Save and restart
				</Button>
			{:else}
				<Button disabled={saving !== null} onclick={() => save(false)}>
					{#if saving === 'save'}<Spinner />{/if}
					Save
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
