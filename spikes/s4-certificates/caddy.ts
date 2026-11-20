/**
 * Caddy JSON for the S4 ingresses. Shared by the runner (design A and B bootstrap) and the design-B
 * agent (agent.ts), which renders the full config with the delivered certificate files.
 */
import { IN, LAB } from './lab.ts';

/** The agent's loopback endpoint for delivery: 'manager' (Caddy's http manager cannot send headers). */
export const AGENT_PORT = 2020;
export const AGENT_TOKEN = 's4-local-token';

export type Storage = 's3-lock' | 's3-nolock' | 'local';

export interface IngressConfig {
	node: string;
	host: string;
	design: 'A' | 'B';
	/** Design A: where certmagic keeps certificates, keys, locks and HTTP-01 tokens. */
	storage?: Storage;
	/** Design B: the files the agent wrote (0640 root:caddy), or none before the first delivery. */
	certFiles?: { certificate: string; key: string } | null;
	/**
	 * Design B delivery: `load` = load_files + POST /load (the plan's §7.3; reloads the whole config);
	 * `manager` = Caddy asks the local agent for the pair on each new handshake (tls.get_certificate
	 * http), so a new pair needs no config reload.
	 */
	delivery?: 'load' | 'manager';
	/** Design B: forward /.well-known/acme-challenge/* to the ACME holder (H20 relay). */
	relay?: string | null;
	renewInterval?: string;
}

const siteRoute = (node: string, host: string) => ({
	match: [{ host: [host] }],
	handle: [
		{ handler: 'headers', response: { set: { 'X-Node': [node] } } },
		{ handler: 'static_response', status_code: 200, body: `${node}\n` },
	],
});

function storage(kind: Storage) {
	const m = LAB.minio;
	if (kind === 's3-lock')
		// github.com/techknowlogick/certmagic-s3 v1.5.0
		return {
			module: 's3',
			endpoint: `http://${m.alias}:9000`,
			bucket: m.bucket,
			region: 'us-east-1',
			access_key: m.user,
			secret_key: m.pass,
			prefix: 'caddy',
			use_path_style: true,
		};
	if (kind === 's3-nolock')
		// github.com/ss098/certmagic-s3 @8af482af (Lock/Unlock return nil)
		return { module: 's3', host: `${m.alias}:9000`, bucket: m.bucket, access_id: m.user, secret_key: m.pass, prefix: 'caddy', insecure: true };
	return undefined; // Caddy's default file_system storage, private to the ingress
}

export function caddyConfig(o: IngressConfig): Record<string, unknown> {
	const base = {
		admin: { listen: 'localhost:2019' },
		logging: { logs: { default: { level: 'INFO', encoder: { format: 'json' } } } },
	};
	if (o.design === 'A') {
		const st = storage(o.storage ?? 's3-lock');
		return {
			...base,
			...(st ? { storage: st } : {}),
			apps: {
				http: { servers: { web: { listen: [':443'], routes: [siteRoute(o.node, o.host)] } } },
				tls: {
					automation: {
						policies: [
							{
								subjects: [o.host],
								issuers: [
									{
										module: 'acme',
										ca: LAB.acme,
										trusted_roots_pem_files: [`${IN.shared}/pebble-ca.pem`],
										email: 's4@s4.test',
										// HTTP-01 only, so every validation goes through HAProxy :80.
										challenges: { 'tls-alpn': { disabled: true } },
									},
								],
							},
						],
						renew_interval: o.renewInterval ?? '5s',
					},
				},
			},
		};
	}
	const relayRoute = o.relay
		? [
				{
					match: [{ path: ['/.well-known/acme-challenge/*'] }],
					handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: o.relay }] }],
					terminal: true,
				},
			]
		: [];
	return {
		...base,
		apps: {
			http: {
				servers: {
					web: {
						listen: [':443'],
						routes: [siteRoute(o.node, o.host)],
						tls_connection_policies: [{}],
						automatic_https: { disable: true },
					},
					plain: {
						listen: [':80'],
						routes: [
							...relayRoute,
							{
								handle: [
									{
										handler: 'static_response',
										status_code: 308,
										headers: { Location: ['https://{http.request.host}{http.request.uri}'] },
									},
								],
							},
						],
						automatic_https: { disable: true },
						logs: {},
					},
				},
			},
			...(o.delivery === 'manager'
				? {
						tls: {
							automation: {
								policies: [
									{
										// No `subjects`: listing them makes Caddy manage (issue) the names. With no
										// issuer Caddy falls back to the public Let's Encrypt and ZeroSSL CAs, which
										// an earlier run of this rig reached. The issuer below is a dead end on
										// purpose, and the lab network has no egress.
										get_certificate: [{ via: 'http', url: `http://127.0.0.1:${AGENT_PORT}/pair?token=${AGENT_TOKEN}` }],
										issuers: [{ module: 'acme', ca: 'https://127.0.0.1:9/no-issuance-here' }],
									},
								],
							},
						},
					}
				: o.certFiles
					? { tls: { certificates: { load_files: [{ ...o.certFiles, tags: ['s4'] }] } } }
					: {}),
		},
	};
}
