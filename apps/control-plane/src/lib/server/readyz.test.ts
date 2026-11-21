import { describe, expect, test } from 'bun:test';
import { readyzResponse } from './readyz.js';

/** `/readyz` (HA Wave 5): the running flags go to the local agent only, never through the proxy. */
const report = { ok: true, version: '0.16.11', schema: { current: 134 }, dataDirs: [] };
const ha = { status: 200 as const, body: { role: 'standby', epoch: 3, canPromote: true } };
const flags = () => ({ STEERING: true, REGIONS: false });
const direct = new Request('http://localhost/readyz');
const proxied = (header: string) => new Request('http://localhost/readyz', { headers: { [header]: '203.0.113.9' } });

describe('/readyz flag reporting', () => {
	test('a direct request with CONTROL_STANDBY on carries the running flags', async () => {
		const body = await readyzResponse(report, ha, flags, direct).json();
		expect(body).toMatchObject({ role: 'standby', featureFlags: { STEERING: true, REGIONS: false }, ok: true });
	});

	test('a request through a proxy never does', async () => {
		for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip']) {
			const body = (await readyzResponse(report, ha, flags, proxied(header)).json()) as Record<string, unknown>;
			expect({ header, flags: 'featureFlags' in body }).toEqual({ header, flags: false });
			expect(body.role).toBe('standby');
		}
	});

	test('with CONTROL_STANDBY off the response is byte-identical to the plain report, even direct', async () => {
		const response = readyzResponse(report, null, flags, direct);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(JSON.stringify(report));
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(readyzResponse({ ...report, ok: false }, null, flags, direct).status).toBe(503);
	});

	test('a 503 control state wins over a healthy report, and ok follows the status line', async () => {
		const response = readyzResponse(report, { status: 503, body: { role: 'fenced', epoch: 3, canPromote: false } }, flags, direct);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ ok: false, role: 'fenced' });
	});
});
