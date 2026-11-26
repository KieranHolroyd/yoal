import type { WhatsNewItemView } from '@yoal/contracts';

/**
 * Presentation helpers for the What’s new page (docs/WHATS-NEW.md). Pure, so the page stays
 * markup and the rules are testable without a DOM.
 */

/** Where an item stands for the person reading the page. */
export type ItemState = 'consent' | 'new' | 'enabled' | 'declined' | 'read';

export function itemState(item: WhatsNewItemView): ItemState {
	if (item.decision === 'enabled') return 'enabled';
	if (item.decision === 'declined') return 'declined';
	if (item.decision === 'acknowledged') return 'read';
	return item.attention === 'consent' ? 'consent' : 'new';
}

export const STATE_LABEL: Record<ItemState, string> = {
	consent: 'Needs a decision',
	new: 'New',
	enabled: 'Enabled',
	declined: 'Kept off',
	read: 'Read'
};

export interface ReleaseGroup<T> {
	version: string;
	items: T[];
}

/** Group items by release, keeping the order they arrive in (the service sends newest first). */
export function groupByRelease<T extends { since: string }>(
	items: readonly T[]
): ReleaseGroup<T>[] {
	const groups: ReleaseGroup<T>[] = [];
	for (const item of items) {
		const group = groups.find((entry) => entry.version === item.since);
		if (group) group.items.push(item);
		else groups.push({ version: item.since, items: [item] });
	}
	return groups;
}

/** A DOM id for a release heading; versions contain dots, which are awkward in selectors. */
export function releaseAnchor(version: string): string {
	return `release-${version.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

export function itemAnchor(id: string): string {
	return `change-${id}`;
}

/** Button copy for an item's dashboard link: “Open settings”, “Open cloud shell”, … */
export function destinationLabel(href: string): string {
	const path = href.split(/[?#]/, 1)[0] ?? '';
	const segments = path.split('/').filter(Boolean);
	if (segments[0] === 'settings' || segments.length === 0) return 'Open settings';
	return `Open ${segments[0]!.replace(/-/g, ' ')}`;
}

/** The host of a URL, for a compact label; the raw value when it does not parse. */
export function endpointHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

export type Segment = { kind: 'text' | 'code'; value: string };

/**
 * Catalog copy is plain text, but it is full of things an admin types or copies: environment
 * flags (`YOAL_FEATURE_X=0`), permissions (`database:expose`) and templated hostnames
 * (`<name>-<org>.db.<your domain>:<port>`). Mark those as code so they read as literals.
 */
const LITERAL =
	/[\w*.-]*(?:<[^<>\n]+>[\w*.:-]*)+|\bYOAL_[A-Z0-9_]+(?:=[\w.-]+)?|\b[a-z][a-zA-Z]*:[a-z][a-zA-Z]*\b/g;

export function richText(text: string): Segment[] {
	const segments: Segment[] = [];
	const push = (kind: Segment['kind'], value: string) => {
		if (!value) return;
		const last = segments.at(-1);
		if (last && last.kind === kind) last.value += value;
		else segments.push({ kind, value });
	};
	let cursor = 0;
	for (const match of text.matchAll(LITERAL)) {
		const start = match.index;
		// Sentence punctuation is not part of the literal.
		const literal = match[0].replace(/[.:]+$/, '');
		if (!literal) continue;
		push('text', text.slice(cursor, start));
		push('code', literal);
		cursor = start + literal.length;
	}
	push('text', text.slice(cursor));
	return segments;
}

/** Body copy may hold several paragraphs separated by a blank line. */
export function paragraphs(text: string | undefined): string[] {
	if (!text) return [];
	return text
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.filter(Boolean);
}
