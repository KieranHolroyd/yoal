import { json } from '#lib/server/api.js';
import { core } from '#lib/server/core.js';
import type { RequestHandler } from './$types';

/**
 * Public readiness (docs/OPS.md §4.2.3). Reports the app/schema/agent versions, data directories,
 * disk headroom and backup target reachability. Never includes secrets or environment values.
 *
 * 200 = serving; 503 = the control plane or schema is not usable, which is what the self-updater
 * uses to decide whether a just-switched release should be rolled back.
 *
 * With `CONTROL_STANDBY` on, the same document carries the HA fields (role, epoch, lease,
 * replication, `canPromote`, CLUSTERING §6.1) and is 503 while `joining`, `fenced` or
 * `unavailable`. A standby answering 200 with `canPromote: false` is honest; the platform route's
 * `/readyz` health check uses exactly that distinction. Flag off: byte-identical report.
 */
export const GET: RequestHandler = async ({ request }) => {
	const report = await core.upgrades.readyz();
	const ha = core.controlPlane.readyz();
	if (!ha) return json(report, report.ok ? 200 : 503, { 'cache-control': 'no-store' });
	const status = report.ok && ha.status === 200 ? 200 : 503;
	// `ok` must agree with the status line: a 503 body with ok:true would let a caller that reads
	// only the body treat a fenced/joining control plane as healthy.
	// HA Wave 5: this host's running flags, for the agent's control report (`flags-consistent`).
	// Only on a direct request (the agent's unix socket or loopback URL): through the platform route
	// the proxy adds a forwarding header, and the public answer never carries configuration.
	const flags = isDirect(request) ? { featureFlags: core.haDoctor.runningFlags() } : {};
	const body = { ...report, ...ha.body, ...flags, ok: status === 200 };
	return json(body, status, { 'cache-control': 'no-store' });
};

/** No proxy touched the request: Caddy always sets `X-Forwarded-For` on what it proxies. */
function isDirect(request: Request): boolean {
	return !['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip'].some((name) =>
		request.headers.has(name),
	);
}
