/**
 * Renders the lab's Caddy, HAProxy and keepalived configs into `tmp/conf/`.
 *
 * The Caddy config starts from the real compiler (`compileCaddyConfig`, `compileKubernetesRoute`)
 * and then applies the S9 prototype (`applyIngressPrototype`): the health endpoint, lame-duck
 * draining, the PROXY protocol listener wrapper and `trusted_proxies`. That function is the "exact
 * Caddy JSON" W8 would render; nothing in production code changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileCaddyConfig, type CaddyRoute, type SiteCompileInput } from '../../packages/site-config/src/index.ts';
import { platformPortOwner } from '../../packages/contracts/src/host-ports.ts';
import { compileKubernetesRoute } from '../../apps/agent/src/caddy-config.ts';
import { LAB } from './lab.ts';

const OUT = join(import.meta.dir, 'tmp', 'conf');

export const HEALTH_PATH = '/.well-known/yoal/health';
/** Agent-owned state files the health routes stat on every probe; no reload to flip them. */
export const HEALTH_DIR = '/run/yoal/health';
const READY_FILE = `${HEALTH_DIR}/ready`;
const DRAIN_FILE = `${HEALTH_DIR}/drain`;

/** Every answer is 16 bytes: one word, space-padded, newline. Same size in every state (§10). */
function healthBody(word: string): string {
	return `${word.padEnd(15, ' ')}\n`;
}

function fileExists(path: string): Record<string, unknown> {
	return { file: { root: '/', try_files: [path] } };
}

function healthAnswer(status: number, word: string): Record<string, unknown> {
	return {
		handler: 'static_response',
		status_code: status,
		headers: { 'Content-Type': ['text/plain'], 'Cache-Control': ['no-store'] },
		body: healthBody(word),
	};
}

/**
 * `GET /.well-known/yoal/health`: 503 `draining` while the drain file exists, 503 `notready` until
 * the agent has written the ready file, otherwise 200 `ok`. Terminal, ahead of every host route,
 * so it answers for any Host (a balancer probe sends the node address or nothing).
 */
export function healthRoute(server: string): CaddyRoute {
	return {
		// `@id` must be unique across the whole config, so one per server.
		'@id': `yoal-health:${server}`,
		match: [{ path: [HEALTH_PATH] }],
		terminal: true,
		handle: [
			{
				handler: 'subroute',
				routes: [
					// Drop `Server: Caddy` so the answer names no software (§10).
					{ handle: [{ handler: 'headers', response: { delete: ['Server'] } }] },
					{ match: [fileExists(DRAIN_FILE)], handle: [healthAnswer(503, 'draining')], terminal: true },
					{ match: [{ not: [fileExists(READY_FILE)] }], handle: [healthAnswer(503, 'notready')], terminal: true },
					{ handle: [healthAnswer(200, 'ok')] },
				],
			},
		],
	};
}

/**
 * While draining, every response closes its connection (`Connection: close`; Go's HTTP/2 server
 * turns it into GOAWAY), so keep-alive clients move to another ingress before Caddy stops instead
 * of racing the final close. Non-terminal; it only adds a header.
 */
export function drainCloseRoute(server: string): CaddyRoute {
	return {
		'@id': `yoal-drain-close:${server}`,
		match: [fileExists(DRAIN_FILE)],
		handle: [{ handler: 'headers', response: { set: { Connection: ['close'] } } }],
	};
}

export interface IngressOptions {
	/** `ingress.proxyProtocol` */
	proxyProtocol: 'off' | 'v1' | 'v2';
	/** `ingress.trustedProxies` */
	trustedProxies: string[];
	/** Dedicated plain-HTTP health listener for L4 balancers. */
	healthPort: number;
	/** Close keep-alive connections while draining (variant under test). */
	drainClose: boolean;
	/** Bound on in-flight requests at stop. */
	gracePeriod: string;
}

/** The PROXY protocol wrapper: header used only from `trustedProxies`, read and ignored from anyone else. */
function proxyWrapper(options: IngressOptions): Record<string, unknown>[] {
	if (options.proxyProtocol === 'off' || options.trustedProxies.length === 0) return [];
	return [{ wrapper: 'proxy_protocol', timeout: '5s', allow: options.trustedProxies, fallback_policy: 'ignore' }];
}

function trusted(options: IngressOptions): Record<string, unknown> {
	if (options.trustedProxies.length === 0) return {};
	return {
		trusted_proxies: { source: 'static', ranges: options.trustedProxies },
		client_ip_headers: ['X-Forwarded-For'],
		trusted_proxies_strict: 1,
	};
}

/** Applies the S9 prototype to a config from `compileCaddyConfig` (TLS on: `content` + `http_redirect`). */
export function applyIngressPrototype(config: Record<string, any>, options: IngressOptions): Record<string, any> {
	const servers = config.apps.http.servers as Record<string, any>;
	const wrappers = proxyWrapper(options);
	for (const name of ['content', 'http_redirect']) {
		const server = servers[name];
		server.routes = [healthRoute(name), ...(options.drainClose ? [drainCloseRoute(name)] : []), ...server.routes];
		Object.assign(server, trusted(options));
		if (wrappers.length > 0)
			server.listener_wrappers = name === 'content' ? [...wrappers, { wrapper: 'tls' }] : wrappers;
	}
	// grace_period is app-wide: in-flight requests get this long when a server stops or is replaced.
	config.apps.http.grace_period = options.gracePeriod;
	servers.yoal_health = {
		listen: [`:${options.healthPort}`],
		automatic_https: { disable: true },
		...(wrappers.length > 0 ? { listener_wrappers: wrappers } : {}),
		...trusted(options),
		routes: [healthRoute('yoal_health')],
	};
	return config;
}

// ---- lab-only pieces below: sites, instrumentation, TLS without ACME ---------------------------

export function site(host: string, extra: Partial<SiteCompileInput>): SiteCompileInput {
	return {
		host,
		projectId: host.split('.')[0]!,
		releasePath: '/srv/site',
		accessMode: 'public',
		site: { cleanUrls: false, trailingSlash: 'ignore', spa: false, notFound: null } as SiteCompileInput['site'],
		redirects: [],
		headers: [],
		loginUrl: `https://control.${LAB.domain}/login`,
		...extra,
	};
}

/** Echoes what each matcher family would read; a lab route, not part of the prototype. */
export function whoamiRoute(node: string): CaddyRoute {
	return {
		'@id': 'lab-whoami',
		match: [{ host: [`whoami.${LAB.domain}`] }],
		terminal: true,
		handle: [
			{
				handler: 'static_response',
				status_code: 200,
				headers: { 'Content-Type': ['application/json'] },
				body: `{"node":"${node}","remote":"{http.request.remote.host}","client":"{http.vars.client_ip}","xff":"{http.request.header.X-Forwarded-For}","host":"{http.request.host}","proto":"{http.request.proto}"}`,
			},
		],
	};
}

/** The same allowlist as today's Kubernetes route, but matching the resolved client address. */
export function clientIpAllowRoute(allow: string[]): CaddyRoute {
	return {
		'@id': 'lab-allow-client-ip',
		match: [{ host: [`allowci.${LAB.domain}`] }],
		terminal: true,
		handle: [
			{
				handler: 'subroute',
				routes: [
					{ match: [{ not: [{ client_ip: { ranges: allow } }] }], handle: [{ handler: 'static_response', status_code: 403, body: 'denied' }], terminal: true },
					{ handle: [{ handler: 'static_response', status_code: 200, body: 'allowed' }] },
				],
			},
		],
	};
}

export function renderCaddy(node: string, generation: number, options: IngressOptions): Record<string, any> {
	const d = LAB.domain;
	const sites = [
		// A workload with two copies and a health path: least_conn, active checks (compile.ts:255).
		site(`app.${d}`, { upstreams: LAB.apps.map((a) => `http://${a.ip}:3000`), healthPath: '/healthz' }),
		site(`static.${d}`, {}),
	];
	// A reconcile that adds a site per generation, so every POST /load is a real change.
	for (let i = 0; i < generation; i++) sites.push(site(`gen${i}.${d}`, {}));
	const config = compileCaddyConfig({
		listen: [':443'],
		sites,
		catchAllStatus: 404,
		contentDomain: d,
		tls: { email: 'lab@example.invalid', subjects: [`*.${d}`, d] },
	}) as Record<string, any>;
	const content = config.apps.http.servers.content;
	// Today's allowlist matcher (`remote_ip`, caddy-config.ts:230) on allow.<d>, the client_ip one on allowci.<d>.
	const allow = [`${LAB.client.ip}/32`];
	const k8s = compileKubernetesRoute({
		kind: 'ingress',
		host: `allow.${d}`,
		upstream: `${LAB.apps[0]!.ip}:3000`,
		upstreams: [],
		allowCidrs: allow,
		bearerOnly: false,
	} as Parameters<typeof compileKubernetesRoute>[0]);
	content.routes = [
		// Lab instrumentation: which ingress answered.
		{ handle: [{ handler: 'headers', response: { set: { 'X-S9-Node': [node] } } }] },
		whoamiRoute(node),
		k8s,
		clientIpAllowRoute(allow),
		...content.routes,
	];
	// Lab TLS: Caddy's internal CA instead of ACME (no DNS, no money). H20 owns real certificates.
	config.apps.tls = {
		automation: { policies: [{ subjects: [`*.${d}`, d], issuers: [{ module: 'internal' }] }] },
	};
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
	return applyIngressPrototype(config, options);
}

export function renderHaproxy(): string {
	const servers = LAB.ingress;
	const check = `check port ${LAB.healthPort} inter 5s fall 2 rise 2`;
	return `# HAProxy recipe sketch for a Yoal ingress set (S9). See README.md.
global
  log stdout format raw local0 info
  maxconn 20000
  stats socket /tmp/haproxy.sock mode 600 level admin

defaults
  log global
  option log-health-checks
  timeout connect 2s
  timeout client 10m
  timeout server 10m
  timeout check 2s
  retries 3
  option redispatch

# L4 (the NLB / Azure LB / Hetzner LB shape): TLS passes through, the client address rides PROXY v2.
frontend fe_tls
  mode tcp
  bind :443
  option tcplog
  default_backend be_tls

backend be_tls
  mode tcp
  balance leastconn
  option httpchk
  http-check send meth GET uri ${HEALTH_PATH}
  http-check expect status 200
  # No "on-marked-down shutdown-sessions": it resets requests still being served by a draining node.
  default-server send-proxy-v2
${servers.map((s) => `  server ${s.name} ${s.ip}:443 ${check}`).join('\n')}

# L7 (HAProxy terminates the client side; re-encrypts to Caddy with SNI from Host).
frontend fe_http
  mode http
  bind :8080
  option httplog
  option http-keep-alive
  timeout http-keep-alive 10m
  default_backend be_http

backend be_http
  mode http
  balance leastconn
  http-reuse safe
  retry-on conn-failure empty-response response-timeout
  option httpchk
  http-check send meth GET uri ${HEALTH_PATH}
  http-check expect status 200
  default-server send-proxy-v2 ssl verify none sni req.hdr(host)
${servers.map((s) => `  server ${s.name} ${s.ip}:443 ${check}`).join('\n')}
`;
}

/** keepalived for the first two ingress nodes: VRRP auth on, no script of any kind. */
export function renderKeepalived(name: string, priority: number, state: 'MASTER' | 'BACKUP'): string {
	return `# keepalived recipe sketch for the vip driver (S9). Rendered from fields; no scripts (§10).
global_defs {
  router_id ${name}
  enable_script_security
  script_user nobody
  vrrp_garp_master_delay 1
  vrrp_garp_master_repeat 3
}

# Debian 13's keepalived is built without track_process, so the only script-free signal is a
# file the agent (through a fixed helper verb) writes: 0 = serve, non-zero = FAULT (gives up the VIP).
track_file yoal_ingress {
  file ${HEALTH_DIR}/vrrp
  weight 0
  init_file 0 overwrite
}

vrrp_instance yoal_ingress {
  state ${state}
  interface eth0
  virtual_router_id 59
  priority ${priority}
  advert_int 1
  authentication {
    auth_type PASS
    auth_pass ${LAB.vrrpPass}
  }
  virtual_ipaddress {
    ${LAB.vip}/24 dev eth0
  }
  track_file {
    yoal_ingress
  }
}
`;
}

if (import.meta.main) {
	mkdirSync(OUT, { recursive: true });
	const owner = platformPortOwner(LAB.healthPort);
	if (owner) throw new Error(`health port ${LAB.healthPort} collides with ${owner}`);
	const options: IngressOptions = {
		proxyProtocol: 'v2',
		trustedProxies: [`${LAB.haproxy.ip}/32`],
		healthPort: LAB.healthPort,
		drainClose: process.env.S9_DRAIN_CLOSE !== '0',
		gracePeriod: '10s',
	};
	for (const ingress of LAB.ingress) {
		for (const generation of [0, 1, 2, 3])
			writeFileSync(
				join(OUT, `caddy-${ingress.name}-g${generation}.json`),
				JSON.stringify(renderCaddy(ingress.name, generation, options), null, 2),
			);
		writeFileSync(
			join(OUT, `caddy-${ingress.name}-plain.json`),
			JSON.stringify(renderCaddy(ingress.name, 0, { ...options, drainClose: false }), null, 2),
		);
	}
	writeFileSync(join(OUT, 'haproxy.cfg'), renderHaproxy());
	writeFileSync(join(OUT, 'keepalived-a.conf'), renderKeepalived('ing-a', 150, 'MASTER'));
	writeFileSync(join(OUT, 'keepalived-b.conf'), renderKeepalived('ing-b', 100, 'BACKUP'));
	console.log(`rendered into ${OUT}`);
}
