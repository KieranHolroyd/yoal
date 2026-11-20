import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlEndpoints } from './control-endpoints.ts';

async function dir() {
	return mkdtemp(join(tmpdir(), 'yoal-agent-control-'));
}

describe('agent control address list and epoch fence (W9-SPEC §4.4)', () => {
	test('persists the highest epoch before applying a list and refuses a lower one', async () => {
		const dataDir = await dir();
		await writeFile(join(dataDir, 'epoch.json'), JSON.stringify({ epoch: 3 }));
		const control = new ControlEndpoints({ dataDir, initialUrl: 'https://a.example' });
		expect(await control.load()).toBe(3);
		const lower = await control.apply({ epoch: 2, nodes: [{ nodeId: 'a', url: 'https://a.example', zone: 'z' }] });
		expect(lower.ok).toBe(false);
		expect(control.baseUrl()).toBe('https://a.example');

		const higher = await control.apply({
			epoch: 4,
			nodes: [
				{ nodeId: 'b', url: 'https://b.example/', zone: 'b' },
				{ nodeId: 'c', url: 'https://c.example', zone: 'c' },
			],
		});
		expect(higher.ok).toBe(true);
		expect(control.epoch).toBe(4);
		expect(control.baseUrl()).toBe('https://b.example');
		expect(JSON.parse(await readFile(join(dataDir, 'epoch.json'), 'utf8'))).toMatchObject({ epoch: 4 });
	});

	test('moves to the next address when one is a non-primary or unreachable', async () => {
		const dataDir = await dir();
		const seen: string[] = [];
		const control = new ControlEndpoints({
			dataDir,
			initialUrl: 'https://a.example',
			fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
				const url = String(input);
				seen.push(url);
				if (url.startsWith('https://a.example'))
					return new Response('{}', {
						status: 503,
						headers: { 'x-yoal-role': 'standby', 'x-yoal-epoch': '5' },
					});
				return new Response('{"ok":true}', { status: 200 });
			}) as typeof fetch,
		});
		await control.apply({
			epoch: 5,
			nodes: [
				{ nodeId: 'a', url: 'https://a.example', zone: 'a' },
				{ nodeId: 'b', url: 'https://b.example', zone: 'b' },
			],
		});
		const response = await control.request('/api/agent/desired-state');
		expect(response.status).toBe(200);
		expect(seen).toEqual(['https://a.example/api/agent/desired-state', 'https://b.example/api/agent/desired-state']);
	});

	test('a response header cannot lower the persisted epoch and a higher one is persisted', async () => {
		const dataDir = await dir();
		const control = new ControlEndpoints({ dataDir, initialUrl: 'https://a.example' });
		await control.apply({ epoch: 5, nodes: [{ nodeId: 'a', url: 'https://a.example', zone: 'a' }] });
		expect(await control.observeEpoch(4)).toBe(false);
		expect(control.epoch).toBe(5);
		expect(await control.observeEpoch(6)).toBe(true);
		expect(control.epoch).toBe(6);
		expect(JSON.parse(await readFile(join(dataDir, 'epoch.json'), 'utf8'))).toMatchObject({ epoch: 6 });
	});

	test('when no address answers, the caller keeps its cached state (I11) and gets an error', async () => {
		const dataDir = await dir();
		const control = new ControlEndpoints({
			dataDir,
			initialUrl: 'https://a.example',
			fetchImpl: (async () => new Response('down', { status: 503 })) as unknown as typeof fetch,
		});
		await control.apply({ epoch: 1, nodes: [{ nodeId: 'a', url: 'https://a.example', zone: 'a' }] });
		await expect(control.request('/api/agent/heartbeat')).rejects.toThrow(/No control node answered/);
	});
});
