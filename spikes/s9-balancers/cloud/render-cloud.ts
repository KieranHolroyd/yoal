/**
 * Caddy configs for the cloud ingress nodes: the same real compiler and the same S9 prototype
 * (`applyIngressPrototype`) as the local half, with cloud addresses. Lab-only additions: the
 * whoami/allowlist routes, the app on the node's own loopback, and `lab_l7`, a plain-HTTP copy of
 * the content server for Hetzner's `http` (L7) service, which speaks plain HTTP to its targets.
 */
import { compileCaddyConfig } from '../../../packages/site-config/src/index.ts';
import { compileKubernetesRoute } from '../../../apps/agent/src/caddy-config.ts';
import { applyIngressPrototype, clientIpAllowRoute, site, whoamiRoute, type IngressOptions } from '../render.ts';

export const DOMAIN = 's9.test';
export const HEALTH_PORT = 8099;
export const L7_PORT = 8081;

export interface CloudEnv {
	/** Addresses that send PROXY headers or X-Forwarded-For: the LB's private address. */
	trustedProxies: string[];
	/** Who the allowlist routes admit: this Mac's public address. */
	allow: string[];
}

/** Deep copy with every `@id` suffixed, since ids must be unique across the whole config. */
function reId<T>(value: T, suffix: string): T {
	return JSON.parse(JSON.stringify(value), (key, v) => (key === '@id' ? `${v}${suffix}` : v));
}

export function renderCloudCaddy(node: string, generation: number, env: CloudEnv, drainClose = true): Record<string, any> {
	const d = DOMAIN;
	const sites = [site(`app.${d}`, { upstreams: ['http://127.0.0.1:3000'], healthPath: '/healthz' }), site(`static.${d}`, {})];
	for (let i = 0; i < generation; i++) sites.push(site(`gen${i}.${d}`, {}));
	const config = compileCaddyConfig({
		listen: [':443'],
		sites,
		catchAllStatus: 404,
		contentDomain: d,
		tls: { email: 'lab@example.invalid', subjects: [`*.${d}`, d] },
	}) as Record<string, any>;
	const content = config.apps.http.servers.content;
	const k8s = compileKubernetesRoute({
		kind: 'ingress',
		host: `allow.${d}`,
		upstream: '127.0.0.1:3000',
		upstreams: [],
		allowCidrs: env.allow,
		bearerOnly: false,
	} as Parameters<typeof compileKubernetesRoute>[0]);
	content.routes = [
		{ handle: [{ handler: 'headers', response: { set: { 'X-S9-Node': [node] } } }] },
		whoamiRoute(node),
		k8s,
		clientIpAllowRoute(env.allow),
		...content.routes,
	];
	config.apps.tls = { automation: { policies: [{ subjects: [`*.${d}`, d], issuers: [{ module: 'internal' }] }] } };
	config.apps.pki = { certificate_authorities: { local: { install_trust: false } } };
	content.logs = { default_logger_name: 'yoal_access' };
	config.logging = {
		logs: {
			default: { exclude: ['http.log.access.yoal_access'] },
			yoal_access: {
				writer: { output: 'file', filename: '/var/log/caddy/access.log' },
				encoder: { format: 'json' },
				include: ['http.log.access.yoal_access'],
			},
		},
	};
	config.admin = { listen: 'unix//run/caddy/admin.sock|0660' };
	const options: IngressOptions = {
		proxyProtocol: 'v2',
		trustedProxies: env.trustedProxies,
		healthPort: HEALTH_PORT,
		drainClose,
		gracePeriod: '10s',
	};
	applyIngressPrototype(config, options);
	const servers = config.apps.http.servers;
	servers.lab_l7 = {
		listen: [`:${L7_PORT}`],
		automatic_https: { disable: true },
		listener_wrappers: servers.yoal_health.listener_wrappers,
		trusted_proxies: servers.content.trusted_proxies,
		client_ip_headers: servers.content.client_ip_headers,
		trusted_proxies_strict: servers.content.trusted_proxies_strict,
		routes: reId(servers.content.routes, ':l7'),
		...(servers.content.errors ? { errors: reId(servers.content.errors, ':l7') } : {}),
		logs: { default_logger_name: 'yoal_access' },
	};
	return config;
}

if (import.meta.main) {
	const c = renderCloudCaddy('ing-a', 1, { trustedProxies: ['10.209.1.5/32'], allow: ['198.51.100.1/32'] });
	console.log(Object.keys(c.apps.http.servers), Object.keys(c.apps.http.servers.content));
}
