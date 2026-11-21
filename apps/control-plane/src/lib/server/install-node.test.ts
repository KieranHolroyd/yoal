import { describe, expect, test } from 'bun:test';
import { renderNodeScript } from './install-node.js';

const source = { repo: 'KieranHolroyd/yoal', channel: 'canary' } as const;

describe('node installer script', () => {
	test('bakes the origin and keeps the token out of the script', () => {
		const script = renderNodeScript('https://control.example.com/', source);
		expect(script).toContain('ORIGIN=https://control.example.com');
		expect(script).toContain('--network-mode yoal');
		expect(script).toContain('join "$ORIGIN"');
		expect(script).not.toContain('skn1_');
	});

	test('quotes an origin that is not shell-safe', () => {
		const script = renderNodeScript("https://control.example.com/it's", source);
		expect(script).toContain("'https://control.example.com/it'\\''s'");
	});

	test('falls through to the worker install from the control plane repo and channel', () => {
		const script = renderNodeScript('https://control.example.com', { repo: 'acme/yoal', channel: 'stable' });
		expect(script).toContain('REPO=acme/yoal');
		expect(script).toContain('CHANNEL=stable');
		expect(script).toContain('https://raw.githubusercontent.com/$REPO/main/install.sh');
		expect(script).toContain('--yes --join "$ORIGIN" --name "$NAME"');
		expect(script).toContain('YOAL_JOIN_TOKEN=$TOKEN');
		expect(script).not.toContain('Install the signed Yoal release bundle first');
	});
});
