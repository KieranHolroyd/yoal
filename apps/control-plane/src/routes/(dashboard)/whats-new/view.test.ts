import { describe, expect, test } from 'bun:test';
import type { WhatsNewItemView } from '@yoal/contracts';
import {
	destinationLabel,
	endpointHost,
	groupByRelease,
	itemState,
	paragraphs,
	releaseAnchor,
	richText
} from './view.ts';

function item(overrides: Partial<WhatsNewItemView>): WhatsNewItemView {
	return {
		id: 'x',
		since: '0.1.0',
		title: 'X',
		summary: '',
		attention: 'info',
		decision: null,
		decidedAt: null,
		consentState: null,
		...overrides
	};
}

describe('itemState', () => {
	test('an undecided consent item needs a decision; an undecided info item is new', () => {
		expect(itemState(item({ attention: 'consent' }))).toBe('consent');
		expect(itemState(item({}))).toBe('new');
	});

	test('a decision wins over the kind of item', () => {
		expect(itemState(item({ attention: 'consent', decision: 'enabled' }))).toBe('enabled');
		expect(itemState(item({ attention: 'consent', decision: 'declined' }))).toBe('declined');
		expect(itemState(item({ decision: 'acknowledged' }))).toBe('read');
	});
});

describe('groupByRelease', () => {
	test('keeps the incoming order of releases and of items within one', () => {
		const groups = groupByRelease([
			{ id: 'a', since: '0.2.0' },
			{ id: 'b', since: '0.1.0' },
			{ id: 'c', since: '0.2.0' }
		]);
		expect(groups.map((group) => [group.version, group.items.map((entry) => entry.id)])).toEqual([
			['0.2.0', ['a', 'c']],
			['0.1.0', ['b']]
		]);
	});
});

describe('releaseAnchor', () => {
	test('is a selector-safe id', () => {
		expect(releaseAnchor('0.16.18')).toBe('release-0-16-18');
		expect(releaseAnchor('1.0.0-rc.1')).toBe('release-1-0-0-rc-1');
	});
});

describe('destinationLabel', () => {
	test('names the page an item links to', () => {
		expect(destinationLabel('/settings/usage-analytics')).toBe('Open settings');
		expect(destinationLabel('/cloud-shell')).toBe('Open cloud shell');
		expect(destinationLabel('/databases?tab=public')).toBe('Open databases');
	});
});

describe('endpointHost', () => {
	test('shows the host of a URL and passes anything else through', () => {
		expect(endpointHost('https://collector.example/api/v1/ping')).toBe('collector.example');
		expect(endpointHost('not a url')).toBe('not a url');
	});
});

describe('richText', () => {
	const code = (text: string) =>
		richText(text)
			.filter((segment) => segment.kind === 'code')
			.map((segment) => segment.value);

	test('marks feature flags, permissions and templated hosts as code', () => {
		expect(code('Turn it off with YOAL_FEATURE_CLOUD_SHELL=0.')).toEqual([
			'YOAL_FEATURE_CLOUD_SHELL=0'
		]);
		expect(code('Deployers and up can use it (cloudShell:use); the CLI')).toEqual([
			'cloudShell:use'
		]);
		expect(code('reached at <name>-<org>.db.<your domain>:<port>, through a proxy')).toEqual([
			'<name>-<org>.db.<your domain>:<port>'
		]);
		expect(code('add a DNS-only *.db.<content domain> record')).toEqual(['*.db.<content domain>']);
		expect(code('gets a <node>.yoal.internal name.')).toEqual(['<node>.yoal.internal']);
	});

	test('leaves prose alone and round-trips the text', () => {
		const text =
			'Settings → Clustering can now connect every pair of nodes, as Tailscale does. Off by default.';
		expect(richText(text)).toEqual([{ kind: 'text', value: text }]);
		const mixed = 'Needs YOAL_FEATURE_DB_PUBLIC_ANYWHERE. Then <a>.b works';
		expect(
			richText(mixed)
				.map((segment) => segment.value)
				.join('')
		).toBe(mixed);
	});
});

describe('paragraphs', () => {
	test('splits on blank lines and drops empties', () => {
		expect(paragraphs('One.\n\nTwo.\n  \nThree.')).toEqual(['One.', 'Two.', 'Three.']);
		expect(paragraphs(undefined)).toEqual([]);
	});
});
