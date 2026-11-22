import { describe, expect, mock, test } from 'bun:test';
import { roles, type Principal } from '@yoal/contracts';

/**
 * `/api/v1/assistant/confirm` (docs/ASSISTANT.md, D237): a quick action keeps its plain JSON
 * answer; a slow one (a cloud shell command) is kept alive with whitespace, which JSON ignores,
 * because Bun drops a request that stays silent for 10 s.
 */

let delayMs = 0;
let fail: string | null = null;

mock.module('#lib/server/assistant/orchestrator.js', () => ({
	runConfirmed: async () => {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		if (fail) throw new Error(fail);
		return { ok: true, tool: 'run_in_cloud_shell', title: 'Run a command', text: 'Exit code 0' };
	}
}));

const route = await import('../../routes/api/v1/assistant/confirm/+server');

const principal = {
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	credential: 'session',
	permissions: new Set(roles.owner)
} as unknown as Principal;

function confirm(): Promise<Response> {
	return route.POST({
		locals: { principal },
		request: new Request('http://control.test/api/v1/assistant/confirm', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: 'signed' })
		})
	} as never) as Promise<Response>;
}

describe('assistant confirm route', () => {
	test('a quick action answers plain JSON, and a refusal keeps its 400', async () => {
		delayMs = 0;
		fail = null;
		const ok = await confirm();
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ ok: true, tool: 'run_in_cloud_shell', title: 'Run a command', text: 'Exit code 0' });
		fail = 'Cannot confirm: this confirmation has expired; ask again.';
		const refused = await confirm();
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({ error: 'confirmation_failed', message: expect.stringMatching(/expired/) });
	});

	test('a slow action streams keepalive spaces and then the same JSON', async () => {
		delayMs = 9_500;
		fail = null;
		const response = await confirm();
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toMatch(/^ +\{/);
		expect(JSON.parse(text)).toMatchObject({ ok: true, text: 'Exit code 0' });
	}, 15_000);

	test('a slow failure still reaches the client as an error body', async () => {
		delayMs = 4_500;
		fail = 'The cloud shell answered 502.';
		const body = JSON.parse(await (await confirm()).text()) as { ok?: boolean; message?: string };
		expect(body.ok).toBeUndefined();
		expect(body.message).toBe('The cloud shell answered 502.');
	}, 10_000);
});
