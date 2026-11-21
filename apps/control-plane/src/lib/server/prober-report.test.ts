import { describe, expect, test } from 'bun:test';
import { isAuthenticatedApi } from './api-auth.ts';
import { checkCsrf } from './csrf.ts';
import { handleProberReport, PROBER_REPORT_MAX_BYTES, type ProberReportSink } from './prober-report.ts';

/**
 * The HTTP edge of W15's prober sink, without booting SvelteKit: the same Request goes through the
 * CSRF allowlist, the `isAuthenticatedApi` exception and the token-first handler. The regression
 * this pins is a prober POST with only its Bearer token and no Origin/session.
 */
const ORIGIN = 'https://control.test';
const REPORT = {
	proberId: 'prb_1',
	sequence: 1,
	sentAt: '2026-11-21T10:00:00.000Z',
	installId: null,
	targets: [{ target: 'https://app.test/healthz', kind: 'https', status: 'up', checkedAt: '2026-11-21T10:00:00.000Z' }]
};

function sink(enabled = true) {
	const calls = { authenticate: 0, report: 0 };
	const value: ProberReportSink = {
		enabled: () => enabled,
		authenticate: (token) => {
			calls.authenticate += 1;
			if (token !== 'yoalp_good') {
				const error = new Error(token ? 'Unknown or revoked prober token.' : 'Send the prober token as a Bearer credential.');
				Object.assign(error, { status: 401, code: 'unauthorized' });
				throw error;
			}
		},
		report: async (token, report) => {
			calls.report += 1;
			expect(token).toBe('yoalp_good');
			return { proberId: report.proberId, sequence: report.sequence, receivedAt: REPORT.sentAt, accepted: report.targets.length };
		}
	};
	return { value, calls };
}

function request(body: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
	return new Request(`${ORIGIN}/api/v1/ha/prober/report`, {
		method: 'POST',
		body,
		...init
	});
}

describe('external prober report HTTP edge', () => {
	test('the exact path is CSRF cookieless and exempt from the session gate', () => {
		const request = new Request(`${ORIGIN}/api/v1/ha/prober/report`, { method: 'POST' });
		expect(checkCsrf(request, new URL(request.url), ORIGIN).ok).toBe(true);
		expect(checkCsrf(new Request(`${ORIGIN}/api/v1/ha/prober/reports`, { method: 'POST' }), new URL(`${ORIGIN}/api/v1/ha/prober/reports`), ORIGIN).ok).toBe(false);
		expect(isAuthenticatedApi('/api/v1/ha/prober/report')).toBe(false);
		expect(isAuthenticatedApi('/api/v1/ha/probers')).toBe(true);
	});

	test('a token-only POST with no Origin or session is accepted', async () => {
		const { value, calls } = sink();
		const response = await handleProberReport(request(JSON.stringify(REPORT), { headers: { authorization: 'Bearer yoalp_good' } }), value);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ proberId: 'prb_1', sequence: 1, accepted: 1 });
		expect(calls).toEqual({ authenticate: 1, report: 1 });
	});

	test('the endpoint is 404 while EXTERNAL_PROBER is off', async () => {
		const { value, calls } = sink(false);
		const response = await handleProberReport(request(JSON.stringify(REPORT), { headers: { authorization: 'Bearer yoalp_good' } }), value);
		expect(response.status).toBe(404);
		expect(calls).toEqual({ authenticate: 0, report: 0 });
	});

	test('a bad or absent token is 401 before the body is parsed', async () => {
		const { value, calls } = sink();
		for (const headers of [{}, { authorization: 'Bearer wrong' }] as Array<Record<string, string>>) {
			const response = await handleProberReport(request('{not json', { headers }), value);
			expect(response.status).toBe(401);
		}
		expect(calls).toEqual({ authenticate: 2, report: 0 });
	});

	test('an oversized declared body is 413 before it is read', async () => {
		const { value, calls } = sink();
		const response = await handleProberReport(
			request('{}', { headers: { authorization: 'Bearer yoalp_good', 'content-length': String(PROBER_REPORT_MAX_BYTES + 1) } }),
			value,
		);
		expect(response.status).toBe(413);
		expect(calls).toEqual({ authenticate: 1, report: 0 });
	});
});
