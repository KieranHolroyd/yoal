/** The shape the System page's load function sends for each toggle. */
export interface ToggleView {
	key: string;
	label: string;
	area: string;
	description: string;
	default: boolean;
	optIn: boolean;
	risky: 'on' | 'off' | null;
	/** What the running control plane uses. */
	value: boolean;
	/** What yoal.env holds, or null when unset. */
	raw: string | null;
}

export interface ToggleChange {
	toggle: ToggleView;
	from: boolean;
	to: boolean;
	/** The new position weakens sign-in or data safety. */
	risky: boolean;
	/** `KEY=0|1`, or null when the key is removed because the new value is the default. */
	line: string | null;
}

/** True when a toggle sits in its risky position. */
export function isRisky(toggle: Pick<ToggleView, 'risky'>, value: boolean): boolean {
	return (toggle.risky === 'on' && value) || (toggle.risky === 'off' && !value);
}

/**
 * The pending changes, in page order. Mirrors `systemToggleChanges` in @yoal/contracts, which the
 * server runs again: a move back to the default removes the key instead of pinning it.
 */
export function pendingChanges(
	toggles: readonly ToggleView[],
	draft: Readonly<Record<string, boolean>>
): ToggleChange[] {
	const changes: ToggleChange[] = [];
	for (const toggle of toggles) {
		const to = draft[toggle.key];
		if (to === undefined || to === toggle.value) continue;
		changes.push({
			toggle,
			from: toggle.value,
			to,
			risky: isRisky(toggle, to),
			line: to === toggle.default ? null : `${toggle.key}=${to ? '1' : '0'}`
		});
	}
	return changes;
}

/** A unified-diff-style preview of what the helper will write to yoal.env. */
export function envDiff(changes: readonly ToggleChange[]): { sign: '+' | '-'; text: string }[] {
	const lines: { sign: '+' | '-'; text: string }[] = [];
	for (const change of changes) {
		const { raw, key } = change.toggle;
		if (raw !== null) lines.push({ sign: '-', text: `${key}=${raw}` });
		if (change.line) lines.push({ sign: '+', text: change.line });
	}
	return lines;
}

/** Form fields for the `save` action: only the keys that change. */
export function changeFields(changes: readonly ToggleChange[]): Record<string, string> {
	return Object.fromEntries(changes.map((change) => [change.toggle.key, change.to ? '1' : '0']));
}

/** Split `text` around case-insensitive matches of `needle`, for highlighting. */
export function highlight(text: string, needle: string): { text: string; match: boolean }[] {
	const query = needle.trim().toLowerCase();
	if (!query) return [{ text, match: false }];
	const parts: { text: string; match: boolean }[] = [];
	const lower = text.toLowerCase();
	let index = 0;
	while (index < text.length) {
		const found = lower.indexOf(query, index);
		if (found === -1) {
			parts.push({ text: text.slice(index), match: false });
			break;
		}
		if (found > index) parts.push({ text: text.slice(index, found), match: false });
		parts.push({ text: text.slice(found, found + query.length), match: true });
		index = found + query.length;
	}
	return parts;
}
