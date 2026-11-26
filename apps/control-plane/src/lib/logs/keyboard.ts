/**
 * The Explorer's keyboard map (docs/LOGS.md §7.3). Vim-adjacent on purpose, like the HyperDX
 * TUI. The help sheet renders `LOG_SHORTCUTS`; `logShortcutFor` maps a key event to an action.
 */

export type LogShortcutAction =
	| 'focusQuery'
	| 'run'
	| 'next'
	| 'previous'
	| 'expand'
	| 'context'
	| 'filter'
	| 'exclude'
	| 'toggleLive'
	| 'time'
	| 'shiftBack'
	| 'shiftForward'
	| 'palette'
	| 'help'
	| 'close';

export const LOG_SHORTCUTS: ReadonlyArray<{
	keys: string[];
	action: LogShortcutAction;
	label: string;
}> = [
	{ keys: ['/'], action: 'focusQuery', label: 'Focus the query' },
	{ keys: ['⌘', '↵'], action: 'run', label: 'Run the query' },
	{ keys: ['j'], action: 'next', label: 'Next line' },
	{ keys: ['k'], action: 'previous', label: 'Previous line' },
	{ keys: ['o'], action: 'expand', label: 'Open the line (also ↵)' },
	{ keys: ['c'], action: 'context', label: 'Lines around it (context)' },
	{ keys: ['f'], action: 'filter', label: 'Filter to the focused value' },
	{ keys: ['x'], action: 'exclude', label: 'Exclude the focused value' },
	{ keys: ['space'], action: 'toggleLive', label: 'Pause or resume the live tail' },
	{ keys: ['t'], action: 'time', label: 'Time picker' },
	{ keys: ['['], action: 'shiftBack', label: 'Previous time window' },
	{ keys: [']'], action: 'shiftForward', label: 'Next time window' },
	{ keys: ['⌘', 'K'], action: 'palette', label: 'Saved queries and scopes' },
	{ keys: ['?'], action: 'help', label: 'This help' },
	{ keys: ['esc'], action: 'close', label: 'Close the line or dialog' }
];

export interface KeyLike {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

/**
 * The action for a key press, or null. `typing` is true when focus is in a text field: only
 * ⌘↵, ⌘K and Escape act there, so the shortcuts never eat characters.
 */
export function logShortcutFor(event: KeyLike, typing: boolean): LogShortcutAction | null {
	const mod = event.metaKey || event.ctrlKey;
	if (mod && event.key === 'Enter') return 'run';
	if (mod && (event.key === 'k' || event.key === 'K')) return 'palette';
	if (event.key === 'Escape') return 'close';
	if (typing || mod || event.altKey) return null;
	switch (event.key) {
		case '/':
			return 'focusQuery';
		case 'j':
			return 'next';
		case 'k':
			return 'previous';
		case 'o':
		case 'Enter':
			return 'expand';
		case 'c':
			return 'context';
		case 'f':
			return 'filter';
		case 'x':
			return 'exclude';
		case ' ':
			return 'toggleLive';
		case 't':
			return 'time';
		case '[':
			return 'shiftBack';
		case ']':
			return 'shiftForward';
		case '?':
			return 'help';
	}
	return null;
}

/** True when the event target is somewhere the reader types. */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!target || typeof (target as HTMLElement).closest !== 'function') return false;
	const element = target as HTMLElement;
	if (element.isContentEditable) return true;
	return (
		element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null
	);
}
