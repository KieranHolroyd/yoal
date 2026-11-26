<script lang="ts">
	/**
	 * The log-query editor (docs/LOGS.md §6, §7.1): a transparent textarea over a highlighted
	 * mirror, so the caret and selection are native while fields, values, strings, regexes and
	 * pipe stages are coloured. Parse errors from `parseLogQuery` get a wavy underline at their
	 * offsets. Autocomplete comes from `suggestLogQuery` (see `./suggest.ts`) with values from
	 * `/fields`. Enter or ⌘↵ runs; Tab or Enter accepts a suggestion.
	 */
	import type { LogQueryError } from '@yoal/contracts';
	import { lexLogQuery, type QueryTokenKind } from './query-text.js';
	import { suggestLogQuery, type LogQueryCatalog, type LogQuerySuggestion } from './suggest.js';

	let {
		value = $bindable(''),
		error = null,
		catalog = {},
		placeholder = 'Search logs: level:error service:api -@path:/health "timeout"',
		onrun,
		id = 'log-query',
		label = 'Log query'
	}: {
		value?: string;
		error?: LogQueryError | null;
		catalog?: LogQueryCatalog;
		placeholder?: string;
		onrun: () => void;
		id?: string;
		label?: string;
	} = $props();

	let textarea = $state<HTMLTextAreaElement | null>(null);
	let mirror = $state<HTMLPreElement | null>(null);
	let focused = $state(false);
	let menuOpen = $state(false);
	let active = $state(0);
	let suggestion = $state<{ items: LogQuerySuggestion[]; from: number; to: number }>({
		items: [],
		from: 0,
		to: 0
	});

	export function focus(): void {
		textarea?.focus();
		const end = textarea?.value.length ?? 0;
		textarea?.setSelectionRange(end, end);
	}

	const TOKEN_CLASS: Record<QueryTokenKind, string> = {
		ws: '',
		text: 'text-foreground',
		string: 'text-success',
		field: 'text-info',
		attr: 'text-brand',
		op: 'text-warning',
		value: 'text-foreground',
		regex: 'text-warning',
		keyword: 'font-semibold text-primary',
		neg: 'font-semibold text-destructive',
		paren: 'text-muted-foreground',
		pipe: 'font-semibold text-muted-foreground',
		stage: 'font-semibold text-primary',
		fn: 'text-info',
		punct: 'text-muted-foreground',
		number: 'text-warning'
	};

	/** Tokens split at the error's bounds so the bad span can be underlined. */
	const pieces = $derived.by(() => {
		const out: Array<{ text: string; cls: string; bad: boolean }> = [];
		const start = error ? Math.max(0, error.start) : -1;
		const end = error ? Math.max(error.end, error.start + 1) : -1;
		for (const token of lexLogQuery(value)) {
			const cls = TOKEN_CLASS[token.kind];
			const tStart = token.start;
			const tEnd = token.start + token.text.length;
			if (!error || end <= tStart || start >= tEnd) {
				out.push({ text: token.text, cls, bad: false });
				continue;
			}
			const a = Math.max(start, tStart) - tStart;
			const b = Math.min(end, tEnd) - tStart;
			if (a > 0) out.push({ text: token.text.slice(0, a), cls, bad: false });
			out.push({ text: token.text.slice(a, b), cls, bad: true });
			if (b < token.text.length) out.push({ text: token.text.slice(b), cls, bad: false });
		}
		return out;
	});
	/** An error at (or past) the end of the text underlines a phantom space. */
	const errorAtEnd = $derived(error !== null && error.start >= value.length);

	function resize() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
	}

	$effect(() => {
		void value;
		resize();
	});

	function refreshSuggestions(open = true) {
		if (!textarea) return;
		const caret = textarea.selectionStart ?? value.length;
		suggestion = suggestLogQuery(value, caret, catalog);
		active = 0;
		menuOpen = open && focused && suggestion.items.length > 0;
	}

	function accept(item: LogQuerySuggestion) {
		const next = value.slice(0, suggestion.from) + item.insertText + value.slice(suggestion.to);
		const caret = suggestion.from + item.insertText.length;
		value = next;
		menuOpen = false;
		queueMicrotask(() => {
			textarea?.focus();
			textarea?.setSelectionRange(caret, caret);
			// A field name ending in `:` goes straight on to its values.
			if (item.insertText.endsWith(':')) refreshSuggestions();
		});
	}

	function onkeydown(event: KeyboardEvent) {
		if (menuOpen && suggestion.items.length > 0) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				active = (active + 1) % suggestion.items.length;
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				active = (active - 1 + suggestion.items.length) % suggestion.items.length;
				return;
			}
			if (event.key === 'Tab' || (event.key === 'Enter' && !event.metaKey && !event.ctrlKey)) {
				event.preventDefault();
				accept(suggestion.items[active]!);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				menuOpen = false;
				return;
			}
		}
		if (event.key === ' ' && event.ctrlKey) {
			event.preventDefault();
			refreshSuggestions();
			return;
		}
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			menuOpen = false;
			onrun();
		}
	}

	function syncScroll() {
		if (mirror && textarea) mirror.scrollTop = textarea.scrollTop;
	}
</script>

<div class="relative min-w-0 flex-1">
	<label for={id} class="sr-only">{label}</label>
	<div
		class="relative rounded-md border bg-background font-mono text-xs leading-5 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 {error
			? 'border-destructive/60'
			: ''}"
	>
		<pre
			bind:this={mirror}
			aria-hidden="true"
			class="pointer-events-none absolute inset-0 m-0 overflow-hidden px-2.5 py-1.5 font-mono text-xs leading-5 break-words whitespace-pre-wrap">{#each pieces as piece, index (index)}<span
					class="{piece.cls} {piece.bad
						? 'underline decoration-destructive decoration-wavy underline-offset-4'
						: ''}">{piece.text}</span
				>{/each}{#if errorAtEnd}<span
					class="underline decoration-destructive decoration-wavy underline-offset-4">&nbsp;</span
				>{/if}
</pre>
		<textarea
			bind:this={textarea}
			bind:value
			{id}
			rows="1"
			spellcheck="false"
			autocomplete="off"
			autocapitalize="off"
			{placeholder}
			aria-invalid={error ? 'true' : undefined}
			aria-autocomplete="list"
			aria-controls="{id}-suggestions"
			aria-expanded={menuOpen}
			role="combobox"
			class="relative block max-h-[120px] min-h-8 w-full resize-none overflow-y-auto bg-transparent px-2.5 py-1.5 font-mono text-xs leading-5 text-transparent caret-foreground outline-none selection:bg-primary/25 selection:text-transparent placeholder:text-muted-foreground"
			oninput={() => refreshSuggestions()}
			{onkeydown}
			onclick={() => refreshSuggestions(false)}
			onfocus={() => (focused = true)}
			onblur={() => {
				focused = false;
				// Let a click on a suggestion land first.
				setTimeout(() => (menuOpen = false), 120);
			}}
			onscroll={syncScroll}></textarea>
	</div>
	{#if error}
		<p class="mt-1 truncate text-xs text-destructive" role="alert">
			{error.message}{#if error.hint}<span class="text-muted-foreground"> · {error.hint}</span>{/if}
		</p>
	{/if}
	{#if menuOpen}
		<ul
			id="{id}-suggestions"
			role="listbox"
			class="absolute top-full left-0 z-50 mt-1 max-h-72 w-[min(30rem,100%)] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
		>
			{#each suggestion.items as item, index (item.kind + item.label + index)}
				<li role="option" aria-selected={index === active}>
					<button
						type="button"
						class="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs {index ===
						active
							? 'bg-muted'
							: 'hover:bg-muted/60'}"
						onmousedown={(event) => {
							event.preventDefault();
							accept(item);
						}}
						onmouseenter={() => (active = index)}
					>
						<span class="w-12 shrink-0 text-[10px] text-muted-foreground uppercase"
							>{item.kind}</span
						>
						<span class="shrink-0 font-mono">{item.label}</span>
						{#if item.detail}<span class="truncate text-muted-foreground">{item.detail}</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
