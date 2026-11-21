/**
 * The `/readyz` document (docs/OPS.md §4.2.3), kept free of the core so it is testable.
 *
 * Flag off (`ha` null): the upgrade report alone, byte-identical to before. With `CONTROL_STANDBY`
 * on, the HA fields are merged in and `ok` follows the status line. HA Wave 5: on a direct request
 * (the agent's unix socket or a loopback URL) the host's running feature flags are added for the
 * agent's control report, so `flags-consistent` can compare control-plane hosts. Through the
 * platform route the proxy always adds a forwarding header, and the public answer never carries
 * configuration.
 */
export interface ReadyzHa {
	status: 200 | 503;
	body: Record<string, unknown>;
}

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];

/** No proxy touched the request: Caddy always sets `X-Forwarded-For` on what it proxies. */
export function isDirectRequest(request: Request): boolean {
	return !FORWARDING_HEADERS.some((name) => request.headers.has(name));
}

export function readyzResponse<T extends { ok: boolean }>(
	report: T,
	ha: ReadyzHa | null,
	runningFlags: () => Record<string, boolean>,
	request: Request,
): Response {
	const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
	if (!ha) return new Response(JSON.stringify(report), { status: report.ok ? 200 : 503, headers });
	const status = report.ok && ha.status === 200 ? 200 : 503;
	const flags = isDirectRequest(request) ? { featureFlags: runningFlags() } : {};
	// `ok` must agree with the status line: a 503 body with ok:true would let a caller that reads
	// only the body treat a fenced/joining control plane as healthy.
	return new Response(JSON.stringify({ ...report, ...ha.body, ...flags, ok: status === 200 }), { status, headers });
}
