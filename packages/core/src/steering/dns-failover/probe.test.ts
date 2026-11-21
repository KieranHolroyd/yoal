import { describe, expect, test } from 'bun:test';
import { ingressHealthWords } from '@yoal/contracts';
import { httpIngressProber } from './probe.ts';

/** What the ingress health route answers (packages/site-config compile.ts): one word, 16 bytes. */
const word = (value: string) => `${value.padEnd(15, ' ')}\n`;

function proberAnswering(status: number, body: string) {
	return httpIngressProber({
		observerId: 'cp',
		observerZone: 'control',
		host: 'control.example.org',
		scheme: 'http',
		fetchImpl: async () => new Response(body, { status, headers: { 'content-type': 'text/plain' } }),
	});
}

const node = { id: 'nod_a', name: 'a', zone: 'z1', address: '192.0.2.10' } as never;

describe('httpIngressProber reads the real health answer', () => {
	test('200 with the padded word "ok" is a healthy probe', async () => {
		const [observation] = await proberAnswering(200, word(ingressHealthWords.ok)).probe([node], 1);
		expect(observation!.ok).toBe(true);
		expect(observation!.reason).toBe('ok');
	});

	test('a draining ingress (503 "draining") fails the probe', async () => {
		const [observation] = await proberAnswering(503, word(ingressHealthWords.draining)).probe([node], 1);
		expect(observation!.ok).toBe(false);
	});

	test('200 with any other word fails the probe', async () => {
		const [observation] = await proberAnswering(200, word(ingressHealthWords.caddy)).probe([node], 1);
		expect(observation!.ok).toBe(false);
	});
});
