<script lang="ts">
	/**
	 * One log body: ANSI colours rendered (docs/LOGS.md §7.2), search terms highlighted, and either
	 * wrapped in full or cut to its first line with a "+N lines" hint. The palette is CSS variables
	 * on the element itself, so it themes correctly inside portals (the flyout) and in dark mode.
	 */
	import { ansiStyleCss, hasAnsi, parseAnsi } from './ansi.js';
	import { highlightMatches } from './query-text.js';

	let {
		body,
		ansi = false,
		terms = [],
		wrap = true,
		class: className = ''
	}: {
		body: string;
		/** The record says escapes were kept; bodies with stray escapes render too. */
		ansi?: boolean;
		terms?: readonly string[];
		wrap?: boolean;
		class?: string;
	} = $props();

	const shown = $derived.by(() => {
		if (wrap) return { text: body, more: 0 };
		const newline = body.indexOf('\n');
		if (newline < 0) return { text: body, more: 0 };
		return { text: body.slice(0, newline), more: body.split('\n').length - 1 };
	});

	const segments = $derived(
		(ansi || hasAnsi(shown.text) ? parseAnsi(shown.text) : [{ text: shown.text, style: null }]).map(
			(segment) => ({
				css: ansiStyleCss(segment.style),
				parts: highlightMatches(segment.text, terms)
			})
		)
	);
</script>

<span
	class="ansi min-w-0 {wrap
		? 'break-words whitespace-pre-wrap'
		: 'truncate whitespace-pre'} {className}"
	>{#each segments as segment, s (s)}<span style={segment.css || undefined}
			>{#each segment.parts as part, p (p)}{#if part.match}<mark
						class="rounded-[2px] bg-warning/25 text-inherit">{part.text}</mark
					>{:else}{part.text}{/if}{/each}</span
		>{/each}{#if shown.more > 0}<span class="ml-2 text-muted-foreground select-none"
			>(+{shown.more} {shown.more === 1 ? 'line' : 'lines'})</span
		>{/if}</span
>

<style>
	.ansi {
		--ansi-black: #3f3f46;
		--ansi-red: #dc2626;
		--ansi-green: #16a34a;
		--ansi-yellow: #ca8a04;
		--ansi-blue: #2563eb;
		--ansi-magenta: #c026d3;
		--ansi-cyan: #0891b2;
		--ansi-white: #a1a1aa;
		--ansi-bright-black: #71717a;
		--ansi-bright-red: #ef4444;
		--ansi-bright-green: #22c55e;
		--ansi-bright-yellow: #eab308;
		--ansi-bright-blue: #3b82f6;
		--ansi-bright-magenta: #d946ef;
		--ansi-bright-cyan: #06b6d4;
		--ansi-bright-white: #52525b;
	}
	:global(.dark) .ansi {
		--ansi-black: #71717a;
		--ansi-red: #f87171;
		--ansi-green: #4ade80;
		--ansi-yellow: #facc15;
		--ansi-blue: #60a5fa;
		--ansi-magenta: #e879f9;
		--ansi-cyan: #22d3ee;
		--ansi-white: #d4d4d8;
		--ansi-bright-black: #a1a1aa;
		--ansi-bright-red: #fca5a5;
		--ansi-bright-green: #86efac;
		--ansi-bright-yellow: #fde047;
		--ansi-bright-blue: #93c5fd;
		--ansi-bright-magenta: #f0abfc;
		--ansi-bright-cyan: #67e8f9;
		--ansi-bright-white: #fafafa;
	}
</style>
