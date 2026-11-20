import type { DnsFailoverNode, ProbeObservation } from './health.ts';

/**
 * Ingress probing for `dns-failover` (CLUSTERING §7.2 step 1).
 *
 * `GET https://<address>/.well-known/yoal/health` with the probed node's SNI and `Host`, 3 s
 * timeout, `200` and `status: "ok"` is success. The request goes to the origin address, not
 * through Cloudflare, so the probe tests the node that would answer after a DNS change. A
 * draining node answers 503, which is a failed probe here: that is how lame duck leaves rotation.
 */

export interface IngressProber {
	probe(nodes: readonly DnsFailoverNode[], at: number): Promise<ProbeObservation[]>;
}

export interface HttpIngressProberOptions {
	observerId: string;
	observerZone: string;
	/** Host header and SNI: the platform host the records resolve. */
	host: string;
	path?: string;
	timeoutMs?: number;
	/** Plain HTTP is allowed for a test listener; production uses 443 with TLS. */
	scheme?: 'https' | 'http';
	fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export function httpIngressProber(options: HttpIngressProberOptions): IngressProber {
	const fetchImpl = options.fetchImpl ?? fetch;
	const path = options.path ?? '/.well-known/yoal/health';
	const timeoutMs = options.timeoutMs ?? 3_000;
	const scheme = options.scheme ?? 'https';
	return {
		async probe(nodes, at) {
			return Promise.all(
				nodes.map(async (node): Promise<ProbeObservation> => {
					const url = `${scheme}://${addressForUrl(node.address)}${path}`;
					try {
						const init: RequestInit = {
							method: 'GET',
							headers: { host: options.host },
							redirect: 'manual',
							signal: AbortSignal.timeout(timeoutMs),
							// Bun's fetch connects to the address but validates the certificate for the
							// host we actually serve; Node ignores this and falls back to the URL host.
							...(scheme === 'https' ? { tls: { serverName: options.host } } : {}),
						};
						const response = await fetchImpl(url, init);
						const body = (await response.json().catch(() => null)) as { status?: string } | null;
						const ok = response.status === 200 && body?.status === 'ok';
						return {
							nodeId: node.id,
							observerId: options.observerId,
							observerZone: options.observerZone,
							ok,
							at,
							reason: ok ? 'ok' : 'http-status',
						};
					} catch (error) {
						const name = error instanceof Error ? error.name : '';
						return {
							nodeId: node.id,
							observerId: options.observerId,
							observerZone: options.observerZone,
							ok: false,
							at,
							reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error',
						};
					}
				}),
			);
		},
	};
}

function addressForUrl(address: string): string {
	const value = address.trim().replace(/^\[|\]$/g, '');
	return value.includes(':') ? `[${value}]` : value;
}
