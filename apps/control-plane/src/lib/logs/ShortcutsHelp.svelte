<script lang="ts">
	/** The `?` help sheet: the keyboard map from docs/LOGS.md §7.3 and a query syntax crib. */
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { LOG_SHORTCUTS } from './keyboard.js';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const SYNTAX: Array<[string, string]> = [
		['timeout', 'body contains the word'],
		['"connection reset"', 'phrase'],
		['level:error', 'error or worse (level:=warn is exactly warn)'],
		['service:api deployment:dep_…', 'built-in fields'],
		['@http.status:>=500', 'attribute, numeric compare'],
		['@path:/api/*', 'wildcard'],
		['-@path:/health', 'exclude (also NOT)'],
		['a OR b, (a b) c', 'boolean logic, AND by default'],
		['| stats count() by bin(5m), level', 'aggregate (telemetry store)'],
		['| patterns', 'group lines by template']
	];
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Logs keyboard and syntax</Dialog.Title>
			<Dialog.Description
				>Shortcuts work while the explorer has focus and you are not typing.</Dialog.Description
			>
		</Dialog.Header>
		<div class="grid gap-6 sm:grid-cols-2">
			<ul class="space-y-1.5 text-sm">
				{#each LOG_SHORTCUTS as shortcut (shortcut.action)}
					<li class="flex items-center justify-between gap-3">
						<span class="text-muted-foreground">{shortcut.label}</span>
						<span class="flex shrink-0 gap-1">
							{#each shortcut.keys as key (key)}<Kbd>{key}</Kbd>{/each}
						</span>
					</li>
				{/each}
			</ul>
			<ul class="space-y-1.5 text-sm">
				{#each SYNTAX as [example, meaning] (example)}
					<li>
						<code class="font-mono text-xs">{example}</code>
						<p class="text-xs text-muted-foreground">{meaning}</p>
					</li>
				{/each}
			</ul>
		</div>
	</Dialog.Content>
</Dialog.Root>
