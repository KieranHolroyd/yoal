import { join } from 'node:path';
import type { DesiredState, IdentityDesired, IngressDesired, RouteSpec } from '@yoal/contracts';
import { INGRESS_HEALTH_PATH, INGRESS_HEALTH_PORT } from '@yoal/contracts';
import {
	compileAwaitingDeployRoute,
	compileCaddyConfig,
	compileIngressProtection,
	compileUnavailableRoute,
	type CaddyHandler,
	type CaddyRoute,
	type SiteCompileInput,
	type TlsOptions,
} from '@yoal/site-config';
import { compileFunctionRoute } from './function-routing.ts';
import { normalizeHost } from './verify.ts';

/**
 * Adapt the agent protocol's `RouteSpec` to the site-config compiler. Kept separate from `main.ts`
 * so it can be tested without a running agent or Caddy.
 */

export interface CompileAgentConfigOptions {
	state: DesiredState;
	listen: string[];
	/** Plain-HTTP listeners for the redirect server; defaults to `[':80']` while TLS is on. */
	httpListen?: string[];
	dataDir: string;
	agentSocket: string;
	caddyAdminSocket: string;
	/** When present, Caddy manages certs and serves :80 as a redirect. */
	tls?: TlsOptions;
	/** Platform route preserved across full-config reloads. */
	platform?: { host: string; upstream: string };
	/** Caddy JSON access log the agent tails for telemetry (DESIGN §8). */
	accessLog?: string | null;
	/** HA-PLAN H19: this node's ingress settings. Absent renders none of the edge additions. */
	ingress?: IngressDesired;
	/** Directory of state files the health routes stat (the agent writes them). */
	ingressHealthDir?: string;
}

const ACCESS_LOGGER = 'yoal_access';

type DesiredDomain = DesiredState['domains'][number];

interface HttpServerConfig {
	routes: CaddyRoute[];
	[key: string]: unknown;
}

/** A compiled site input paired with the desired route it came from (function routing needs both). */
interface SiteEntry {
	site: SiteCompileInput;
	route: RouteSpec;
}

function isSafeProjectId(projectId: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(projectId) && projectId !== '.' && projectId !== '..';
}

/**
 * The production route follows the project's production pointer; every other route is an
 * immutable preview. Older control planes do not send `production`, so fall back to the host.
 */
export function isProductionRoute(route: RouteSpec, contentDomain: string): boolean {
	if (route.production !== undefined) return route.production;
	return normalizeHost(route.host) === normalizeHost(`${route.slug}.${contentDomain}`);
}

/**
 * Where Caddy serves a route from. Production goes through `sites/<projectId>`, a symlink swapped
 * atomically on promote/rollback; previews are rooted at their own content-addressed release, so
 * each preview URL keeps serving exactly the deployment it names (D13).
 */
export function routeRoot(route: RouteSpec, dataDir: string, contentDomain: string): string {
	if (!isSafeProjectId(route.projectId))
		throw new Error(`Invalid project id in desired state: ${route.projectId}`);
	if (!/^[a-f0-9]{64}$/.test(route.release))
		throw new Error(`Invalid release hash in desired state: ${route.release}`);
	return isProductionRoute(route, contentDomain)
		? join(dataDir, 'sites', route.projectId)
		: join(dataDir, 'releases', route.release);
}

export function toSiteCompileInput(
	route: RouteSpec,
	options: Pick<CompileAgentConfigOptions, 'dataDir' | 'agentSocket'> & {
		contentDomain?: string;
		healthProbeCidr?: string | null;
		/** HA-PLAN H25: the app's drain window, so Caddy keeps in-flight requests on removal. */
		drainSeconds?: number;
	},
): SiteCompileInput {
	if (!isSafeProjectId(route.projectId))
		throw new Error(`Invalid project id in desired state: ${route.projectId}`);
	return {
		host: route.host,
		projectId: route.projectId,
		deploymentId: route.deploymentId,
		releasePath: routeRoot(route, options.dataDir, options.contentDomain ?? ''),
		agentSocket: route.accessMode === 'public' ? null : options.agentSocket,
		accessMode: route.accessMode,
		site: {
			spa: route.spa,
			cleanUrls: route.cleanUrls,
			trailingSlash: route.trailingSlash,
			notFound: route.notFound,
		},
		redirects: route.redirects,
		headers: route.headers,
		loginUrl: route.access.loginUrl,
		upstream: route.upstream,
		...(route.upstreams?.length ? { upstreams: route.upstreams } : {}),
		...(route.healthPath ? { healthPath: route.healthPath } : {}),
		...(route.healthPath && route.healthIntervalSeconds ? { healthIntervalSeconds: route.healthIntervalSeconds } : {}),
		// HA-PLAN H25: active checks use readiness when the control plane rendered one.
		...(route.readinessPath ? { readinessPath: route.readinessPath } : {}),
		...(options.drainSeconds !== undefined ? { drainSeconds: options.drainSeconds } : {}),
		// Ingresses probe a protected copy's health path over the overlay with no session (F7).
		...(options.healthProbeCidr && (route.healthPath || route.readinessPath) ? { healthProbeCidr: options.healthProbeCidr } : {}),
	};
}

/** Wildcard plus apex, the minimum a content domain needs for `<slug>.<domain>` sites. */
export function tlsSubjects(contentDomain: string, extraHosts: string[] = []): string[] {
	const domain = contentDomain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
	if (!domain || domain.includes('..') || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain))
		throw new Error(`Invalid content domain for TLS: ${contentDomain}`);
	return [...new Set([`*.${domain}`, domain, ...extraHosts.map((host) => host.trim().toLowerCase())])];
}

/** The route a custom domain clones: the project's `<slug>.<contentDomain>` production route. */
export function productionRouteFor(state: DesiredState, projectId: string): RouteSpec | null {
	return (
		state.routes.find(
			(route) => route.projectId === projectId && isProductionRoute(route, state.contentDomain),
		) ?? null
	);
}

/**
 * Issuers for verified custom domains, tried in order. DNS-01 through Cloudflare comes first: it is
 * the only challenge that works when the customer's record is behind the Cloudflare proxy, because
 * Cloudflare will not forward HTTP-01 or TLS-ALPN-01 to an origin that has no certificate yet. It
 * fails fast for a zone the token cannot edit, and Caddy falls through to HTTP-01/TLS-ALPN-01,
 * which work for grey-cloud and non-Cloudflare DNS.
 */
export function customDomainIssuers(tls: TlsOptions): Record<string, unknown>[] {
	const acme = { module: 'acme', email: tls.email, ...(tls.ca ? { ca: tls.ca } : {}) };
	if (!tls.cloudflareApiToken) return [acme];
	return [
		{ ...acme, challenges: { dns: { provider: { name: 'cloudflare', api_token: tls.cloudflareApiToken } } } },
		acme,
	];
}

function withScheme(target: string): string {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`;
}

/**
 * Old slugs 301 to the renamed project's host. `to` is an origin from the control plane, so the
 * original path and query are appended explicitly rather than relying on Caddy's defaults.
 */
function compileHostRedirect(host: string, to: string): CaddyRoute {
	let destination = to;
	try {
		const url = new URL(to);
		if (url.pathname === '/' && !url.search && !url.hash)
			destination = `${url.origin}{http.request.uri}`;
	} catch {
		// Leave an invalid target as-is; Caddy will report it when the config is loaded.
	}
	return {
		'@id': `redirect:${host}`,
		match: [{ host: [host] }],
		terminal: true,
		handle: [{ handler: 'static_response', headers: { Location: [destination] }, status_code: 301 }],
	};
}

/**
 * A public storage endpoint (S3). Not a site: there is no release, site config or forward_auth,
 * because S3 clients carry no cookies and the SigV4 signature is the access control. Caddy proxies
 * byte-for-byte, keeping `Host` on both hops (SigV4 signs it) and streaming bodies so multipart
 * uploads of many GB pass through without buffering or a size limit.
 */
function compileProxyRoute(id: string, host: string, upstream: string): CaddyRoute {
	return {
		'@id': id,
		match: [{ host: [normalizeHost(host)] }],
		handle: [
			{
				handler: 'reverse_proxy',
				upstreams: [{ dial: upstream.replace(/^https?:\/\//, '') }],
				headers: { request: { set: { Host: ['{http.request.host}'] } } },
				flush_interval: -1,
				transport: {
					protocol: 'http',
					dial_timeout: '30s',
					// Multipart uploads and large downloads must not hit an idle header timeout.
					response_header_timeout: '5m',
				},
				handle_response: [
					{
						match: { status_code: [502, 503, 504] },
						routes: [
							{
								handle: [
									{
										handler: 'static_response',
										status_code: 503,
										headers: { 'Retry-After': ['30'], 'Content-Type': ['text/plain; charset=utf-8'] },
										body: 'This storage endpoint is temporarily unavailable. Please try again shortly.',
									},
								],
							},
						],
					},
				],
			},
		],
	};
}

export function compileStorageRoute(route: DesiredState['storageRoutes'][number]): CaddyRoute {
	return compileProxyRoute(`storage:${route.storageId}`, route.host, route.upstream);
}

/** Paths the Kubernetes API answers without a token (liveness, readiness, version). */
const KUBERNETES_OPEN_PATHS = ['/livez', '/livez/*', '/readyz', '/readyz/*', '/healthz', '/version'];

/**
 * A Kubernetes API or cluster-ingress route (docs/KUBERNETES.md K7, K11).
 *
 * - The allowlist is checked where public traffic arrives (the control plane only sends it there).
 * - API routes refuse requests without `Authorization: Bearer` before they reach the API server, so
 *   unauthenticated traffic never touches it (G8). Health paths stay open.
 * - On the machine's own node the API upstream is HTTPS on loopback with the machine's own CA; it
 *   is a loopback hop to a listener Yoal started, so the certificate is not verified.
 * - Streams (`watch`, `logs -f`, `exec`, `port-forward`) pass through: no flush buffering, no
 *   response timeout.
 */
export function compileKubernetesRoute(route: DesiredState['kubernetesRoutes'][number]): CaddyRoute {
	const subroutes: CaddyRoute[] = [];
	if (route.allowCidrs.length > 0)
		subroutes.push({
			// `client_ip` is the resolved client address: the peer unless a configured trusted proxy
			// supplied it (H19). With no trusted proxies it equals `remote_ip`, today's behaviour.
			match: [{ not: [{ client_ip: { ranges: route.allowCidrs } }] }],
			handle: [
				{
					handler: 'static_response',
					status_code: 403,
					headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
					body: 'This address is not on the cluster\'s allowlist.',
				},
			],
			terminal: true,
		});
	if (route.bearerOnly)
		subroutes.push({
			match: [{ not: [{ header: { Authorization: ['Bearer *'] } }, { path: KUBERNETES_OPEN_PATHS }] }],
			handle: [
				{
					handler: 'static_response',
					status_code: 401,
					headers: { 'Content-Type': ['application/json'] },
					body: '{"kind":"Status","apiVersion":"v1","status":"Failure","message":"Unauthorized: use `yoal k8s kubeconfig`","reason":"Unauthorized","code":401}',
				},
			],
			terminal: true,
		});
	const remote = /^https?:\/\//.test(route.upstream);
	// An HA API has one upstream per server node (K17): Caddy uses the first healthy one, retries the
	// next for a few seconds, and sets a failed node aside for half a minute.
	const targets = (route.upstreams ?? []).length > 0 ? route.upstreams : [route.upstream];
	subroutes.push({
		handle: [
			{
				handler: 'reverse_proxy',
				upstreams: targets.map((target) => ({ dial: target.replace(/^https?:\/\//, '') })),
				...(targets.length > 1
					? {
							load_balancing: { selection_policy: { policy: 'first' }, try_duration: '5s' },
							health_checks: { passive: { fail_duration: '30s', max_fails: 1 } },
						}
					: {}),
				// The next hop (another node's Caddy) matches on the original host.
				...(remote ? { headers: { request: { set: { Host: ['{http.request.host}'] } } } } : {}),
				flush_interval: -1,
				transport: {
					protocol: 'http',
					dial_timeout: '30s',
					...(route.upstreamTls ? { tls: { insecure_skip_verify: true } } : {}),
				},
				handle_response: [
					{
						match: { status_code: [502, 503, 504] },
						routes: [
							{
								handle: [
									{
										handler: 'static_response',
										status_code: 503,
										headers: { 'Retry-After': ['15'], 'Content-Type': ['text/plain; charset=utf-8'] },
										body:
											route.kind === 'api'
												? 'The cluster API is not reachable right now. It may still be starting.'
												: 'This cluster route is not reachable right now.',
									},
								],
							},
						],
					},
				],
			},
		],
	});
	return {
		'@id': `k8s:${route.kind}:${route.clusterId}:${normalizeHost(route.host)}`,
		match: [{ host: [normalizeHost(route.host)] }],
		handle: [{ handler: 'subroute', routes: subroutes }],
		terminal: true,
	};
}

/**
 * User-pool issuer routes (IAM.md I26–I28, §11.2).
 *
 * A pool's public issuer is `https://auth.<contentDomain>/<poolId>`, but discovery, JWKS and the
 * OIDC code flow live on the control plane under `/api/v1/user-pools/<poolId>/…`; the hosted
 * pages live under `/pool/<poolId>/…`. These routes rewrite the issuer-shaped path and proxy to
 * the platform upstream. `auth.<contentDomain>` is reserved in `RESERVED_SLUGS`, so a project can
 * never claim it.
 *
 * Requirements outside this file: the content domain's wildcard (`*.example.com`) already covers
 * `auth`, so DNS must resolve it like any project host, and Caddy must be able to issue its
 * certificate. The agent only adds these routes when `YOAL_PLATFORM_HOST` and
 * `YOAL_PLATFORM_UPSTREAM` are configured, i.e. on the node that serves the platform.
 */
const USER_POOL_ISSUER_ROUTES: ReadonlyArray<{ id: string; name: string; pattern: string; uri: string }> = [
	{
		id: 'discovery',
		name: 'yoal_pool_discovery',
		pattern: '^/(?P<pool>[A-Za-z0-9_-]+)/[.]well-known/(?P<doc>openid-configuration|jwks[.]json)$',
		uri: '/api/v1/user-pools/{http.regexp.yoal_pool_discovery.pool}/.well-known/{http.regexp.yoal_pool_discovery.doc}'
	},
	{
		id: 'oauth',
		name: 'yoal_pool_oauth',
		pattern: '^/(?P<pool>[A-Za-z0-9_-]+)/oauth2/(?P<action>authorize|token|userinfo|logout)/?$',
		uri: '/api/v1/user-pools/{http.regexp.yoal_pool_oauth.pool}/oauth/{http.regexp.yoal_pool_oauth.action}'
	},
	{
		id: 'hosted-root',
		name: 'yoal_pool_root',
		pattern: '^/(?P<pool>[A-Za-z0-9_-]+)/?$',
		uri: '/pool/{http.regexp.yoal_pool_root.pool}'
	},
	{
		id: 'hosted',
		name: 'yoal_pool_hosted',
		pattern: '^/(?P<pool>[A-Za-z0-9_-]+)/(?P<page>login|signup|logout|verify)$',
		uri: '/pool/{http.regexp.yoal_pool_hosted.pool}/{http.regexp.yoal_pool_hosted.page}'
	},
	{
		id: 'hosted-nested',
		name: 'yoal_pool_hosted_nested',
		pattern: '^/(?P<pool>[A-Za-z0-9_-]+)/(?P<page>login|signup|logout|verify)(?P<rest>/.*)$',
		uri: '/pool/{http.regexp.yoal_pool_hosted_nested.pool}/{http.regexp.yoal_pool_hosted_nested.page}{http.regexp.yoal_pool_hosted_nested.rest}'
	}
];

/** The issuer host for a content domain, or null when the domain is empty. */
export function userPoolIssuerHost(contentDomain: string): string | null {
	const domain = normalizeHost(contentDomain);
	return domain ? `auth.${domain}` : null;
}

export function compileUserPoolIssuerRoutes(
	contentDomain: string,
	platform: { host: string; upstream: string }
): CaddyRoute[] {
	const host = userPoolIssuerHost(contentDomain);
	if (!host) return [];
	const upstream = platform.upstream.replace(/^https?:\/\//, '');
	return USER_POOL_ISSUER_ROUTES.map((route) => ({
		'@id': `user-pool:${route.id}`,
		match: [{ host: [host], path_regexp: { name: route.name, pattern: route.pattern } }],
		terminal: true,
		handle: [
			{ handler: 'rewrite', uri: route.uri },
			{ handler: 'encode', encodings: { zstd: {}, gzip: {} } },
			{
				handler: 'reverse_proxy',
				upstreams: [{ dial: upstream }],
				headers: {
					request: {
						set: {
							'X-Forwarded-Host': ['{http.request.host}'],
							'X-Forwarded-Proto': ['{http.request.scheme}']
						}
					}
				}
			}
		]
	}));
}

/**
 * Per-pool routes for the separate identity process (docs/IAM.md §11.2). Only pools assigned to
 * this node are proxied; every other issuer path keeps the control-plane fallback below. Both
 * `/<pool>/…` and the mail-link shape `/pool/<pool>/…` are accepted, path preserved, because the
 * engine builds links from `platformOrigin` and an older control plane may use either.
 */
export function compileIdentityIssuerRoutes(identity: IdentityDesired): CaddyRoute[] {
	const host = normalizeHost(identity.host);
	const upstream = identity.upstream.replace(/^https?:\/\//, '');
	return identity.pools.flatMap((pool) => {
		const id = pool.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const proxy = [
			{ handler: 'encode', encodings: { zstd: {}, gzip: {} } },
			{
				handler: 'reverse_proxy',
				upstreams: [{ dial: upstream }],
				headers: {
					request: {
						set: {
							'X-Forwarded-Host': ['{http.request.host}'],
							'X-Forwarded-Proto': ['{http.request.scheme}'],
						},
					},
				},
			},
		];
		return [
			{
				'@id': `identity:${pool.id}`,
				match: [
					{
						host: [host],
						path_regexp: {
							name: `yoal_identity_${pool.id.replace(/[^A-Za-z0-9_]/g, '_')}`,
							pattern: `^(?:pool/)?${id}(/|$)`,
						},
					},
				],
				terminal: true,
				handle: proxy,
			},
			{
				// The engine builds social callbacks against `platformOrigin`, which is the issuer
				// host in the standalone process: keep that absolute path on the identity upstream.
				'@id': `identity:${pool.id}:callback`,
				match: [
					{
						host: [host],
						path_regexp: {
							name: `yoal_identity_callback_${pool.id.replace(/[^A-Za-z0-9_]/g, '_')}`,
							pattern: `^/api/v1/user-pools/${id}/oauth/callback/`,
						},
					},
				],
				terminal: true,
				handle: proxy,
			},
		];
	});
}

/** Only the loopback may carry the internal gateway; a public listener would expose private S3. */
export function isLoopbackListen(listen: string): boolean {
	return /^(127\.0\.0\.1|\[::1\]|localhost):\d{1,5}$/.test(listen);
}

/**
 * Caddy's Caddyfile `redir` directive is sugar for a `static_response` with a Location header;
 * `http.handlers.redir` is not a real JSON module. site-config emits the directive shape, so the
 * agent rewrites it into valid Caddy JSON before loading the config.
 */
function normalizeHandlers(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeHandlers);
	if (typeof value !== 'object' || value === null) return value;

	const record = value as Record<string, unknown>;
	if (record.handler === 'redir') {
		const status = typeof record.status_code === 'number' ? record.status_code : 302;
		const to = typeof record.to === 'string' ? record.to : undefined;
		const normalized: Record<string, unknown> = { handler: 'static_response', status_code: status };
		if (status >= 300 && status < 400 && to !== undefined) normalized.headers = { Location: [to] };
		return normalized;
	}

	const normalized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) normalized[key] = normalizeHandlers(child);
	return normalized;
}

/**
 * Caddy's `forward_auth` copies named response headers onto the upstream request; the long-form
 * JSON the compiler emits has to say so explicitly. Only Yoal Access routes need the two headers,
 * so the patch is limited to their hosts (IAM.md I25).
 */
function enableAccessHeaderCopy(routes: CaddyRoute[], hosts: ReadonlySet<string>): void {
	if (hosts.size === 0) return;
	for (const route of routes) {
		const matcher = route.match?.[0] as { host?: string[] } | undefined;
		if (!matcher?.host?.some((host) => hosts.has(normalizeHost(host)))) continue;
		patchAccessAuthHandlers(route.handle);
	}
}

function patchAccessAuthHandlers(handlers: CaddyHandler[] | undefined): void {
	if (!handlers) return;
	for (const handler of handlers) {
		if (handler.handler === 'reverse_proxy') {
			const rewrite = handler.rewrite as { uri?: string } | undefined;
			if (rewrite?.uri !== '/_yoal/verify') continue;
			const responses = handler.handle_response as
				| Array<{ match?: { status_code?: number[] }; routes?: Array<{ handle?: CaddyHandler[] }> }>
				| undefined;
			for (const response of responses ?? []) {
				if (!response.match?.status_code?.includes(2)) continue;
				for (const responseRoute of response.routes ?? []) {
					responseRoute.handle ??= [];
					// `forward_auth`'s `copy_headers` is the expanded form's `request_header` handler:
					// it copies from the auth response (`{rp.header.*}`) onto the original request.
					responseRoute.handle.unshift({
						handler: 'headers',
						request: {
							set: {
								'Yoal-Access-Jwt': ['{rp.header.Yoal-Access-Jwt}'],
								'Yoal-Access-Email': ['{rp.header.Yoal-Access-Email}'],
							},
						},
					});
				}
			}
		}
		// A site is a subroute; walk into it and anything else nested.
		for (const value of Object.values(handler)) {
			if (Array.isArray(value)) {
				for (const child of value) {
					if (child && typeof child === 'object') patchAccessAuthHandlers([child as CaddyHandler]);
				}
			}
		}
	}
}

function caddySocketAddress(socketPath: string): string {
	if (socketPath.includes('|')) return socketPath.startsWith('unix/') ? socketPath : `unix/${socketPath}`;
	const base = socketPath.startsWith('unix/') ? socketPath : `unix/${socketPath}`;
	// Caddy defaults the admin socket to 0200. The agent is a different user, so request group
	// read/write via Caddy's address suffix (the socket is still only reachable on the host).
	return `${base}|0660`;
}

/**
 * Full Caddy config for one reconcile. Caddy reloads its whole config per admin call, so this is
 * applied with a single POST /load (SPIKES §4).
 */
export function buildCaddyConfig(options: CompileAgentConfigOptions): Record<string, unknown> {
	const entries: SiteEntry[] = [];
	// HA-PLAN H25: the app's drain window is on its workload; the route needs it for Caddy's
	// connection draining. A project with no local copy (a remote upstream on this ingress) has
	// no entry, and the route renders exactly as before.
	const drainByProject = new Map<string, number>();
	for (const workload of options.state.workloads) {
		if (workload.drainSeconds !== undefined) drainByProject.set(workload.projectId, workload.drainSeconds);
	}
	const toEntry = (route: RouteSpec): SiteCompileInput => {
		const site = toSiteCompileInput(route, {
			...options,
			contentDomain: options.state.contentDomain,
			// Only a managed overlay has a CIDR. A bring-your-own network exempts nothing: its desired
			// state does not list the ingress addresses (a known gap, OPS.md §7.3).
			healthProbeCidr: options.state.wireguard?.mode !== 'external' ? (options.state.wireguard?.cidr ?? null) : null,
			...(drainByProject.has(route.projectId) ? { drainSeconds: drainByProject.get(route.projectId) } : {}),
		});
		entries.push({ site, route });
		return site;
	};
	const sites = options.state.routes.map(toEntry);
	const siteHosts = new Set(options.state.routes.map((route) => normalizeHost(route.host)));

	// A verified custom host serves exactly the project's production route: same release, site
	// config, access mode and worker upstream, with only the host replaced. `www` siblings are
	// redirects, not clones, so they never serve the site twice.
	for (const domain of options.state.domains) {
		if (domain.redirectTo) continue;
		const host = normalizeHost(domain.host);
		if (siteHosts.has(host)) continue;
		const production = productionRouteFor(options.state, domain.projectId);
		if (!production) continue;
		siteHosts.add(host);
		sites.push(
			toEntry(
				// The clone is by definition the production route: `production: true` keeps serving
				// from the project symlink even though the custom host is not `<slug>.<contentDomain>`.
				{ ...production, host: domain.host, production: true },
			),
		);
	}

	const config = compileCaddyConfig({
		listen: options.listen,
		...(options.httpListen ? { httpListen: options.httpListen } : {}),
		sites,
		catchAllStatus: 404,
		tls: options.tls,
		platform: options.platform,
		contentDomain: options.state.contentDomain,
	});

	const apps = config.apps as
		| { http: { servers: Record<string, HttpServerConfig> }; tls?: Record<string, unknown> }
		| undefined;
	const server = apps?.http.servers.content;
	if (!server) throw new Error('site-config compiler did not produce an HTTP server config');

	// User-pool issuers (`auth.<contentDomain>`) rewrite to the control-plane OIDC and hosted paths.
	// Put them before the platform route: an operator may point the platform at the same host.
	if (options.platform) {
		const issuerRoutes = compileUserPoolIssuerRoutes(options.state.contentDomain, options.platform);
		if (issuerRoutes.length > 0) server.routes = [...issuerRoutes, ...server.routes];
	}

	// The separate identity process owns its assigned pools before the control-plane fallback
	// (IAM.md §11.2). Unassigned pools still reach the platform routes above, which is the dev path.
	if (options.state.identity) {
		const identityRoutes = compileIdentityIssuerRoutes(options.state.identity);
		if (identityRoutes.length > 0) server.routes = [...identityRoutes, ...server.routes];
	}

	// Functions (D110): swap the compiled static/worker route for assets-first routing with the
	// workerd host as the fallback. Custom-domain clones are in `entries` too, so they inherit the
	// production route's `function` spec with only their host changed.
	const functionRoutes = new Map<string, CaddyRoute>();
	for (const { site, route } of entries) {
		if (!route.function) continue;
		functionRoutes.set(
			`site:${site.projectId}:${site.deploymentId ?? site.host}:${site.host}`,
			compileFunctionRoute(site, route.function),
		);
	}
	if (functionRoutes.size > 0) {
		server.routes = server.routes.map((route) =>
			(typeof route['@id'] === 'string' ? functionRoutes.get(route['@id']) : undefined) ?? route,
		);
	}

	// A route the control plane marked unavailable (D225) never proxies and never serves its
	// release as files: the app is not up, or its loopback port belongs to someone else.
	const unavailableRoutes = new Map<string, CaddyRoute>();
	for (const { site, route } of entries) {
		if (!route.unavailable) continue;
		unavailableRoutes.set(`site:${site.projectId}:${site.deploymentId ?? site.host}:${site.host}`, {
			...compileUnavailableRoute(site.host),
			terminal: true,
		});
	}
	if (unavailableRoutes.size > 0) {
		server.routes = server.routes.map((route) =>
			(typeof route['@id'] === 'string' ? unavailableRoutes.get(route['@id']) : undefined) ?? route,
		);
	}

	const redirects = options.state.hostRedirects
		.filter((redirect) => !siteHosts.has(normalizeHost(redirect.host)))
		.map((redirect) => compileHostRedirect(redirect.host, redirect.to));
	const domainRedirects = options.state.domains
		.filter((domain): domain is DesiredDomain & { redirectTo: string } => Boolean(domain.redirectTo))
		.filter((domain) => !siteHosts.has(normalizeHost(domain.host)))
		.map((domain) => compileHostRedirect(domain.host, withScheme(domain.redirectTo)));
	// Never-deployed projects get a default page at their production host; a real route always wins.
	const placeholderRoutes = (options.state.placeholders ?? [])
		.filter((placeholder) => !siteHosts.has(normalizeHost(placeholder.host)))
		.map((placeholder) => compileAwaitingDeployRoute(normalizeHost(placeholder.host), placeholder.dashboardUrl));
	// Public storage endpoints match on a dedicated host and never collide with site routes (S3).
	const storageRoutes = options.state.storageRoutes.map(compileStorageRoute);
	// Kubernetes API and ingress hosts never collide with site routes (docs/KUBERNETES.md).
	const kubernetesRoutes = (options.state.kubernetesRoutes ?? []).map(compileKubernetesRoute);
	server.routes = [...kubernetesRoutes, ...storageRoutes, ...redirects, ...domainRedirects, ...placeholderRoutes, ...server.routes];

	// Yoal Access needs its two response headers copied from the auth response to the upstream.
	const accessHosts = new Set(
		entries
			.filter((entry) => entry.route.accessMode === 'access')
			.map((entry) => normalizeHost(entry.site.host)),
	);
	enableAccessHeaderCopy(server.routes, accessHosts);

	// The control plane's object browser reaches instances through an internal gateway (D82).
	// The edge gets a loopback listener; a worker puts its routes on the WireGuard-only server.
	const gateway = options.state.storageGateway;
	const gatewayRoutes = gateway.routes.map((route) =>
		compileProxyRoute(`gateway:${route.host}`, route.host, route.upstream),
	);
	if (gateway.listen) {
		if (!isLoopbackListen(gateway.listen))
			throw new Error(`storageGateway.listen must be loopback, got "${gateway.listen}"`);
		if (apps) {
			apps.http.servers.storage_gateway = {
				listen: [gateway.listen],
				// The control plane dials this listener over plain HTTP. Host-matched routes would
				// otherwise switch on automatic HTTPS, so Caddy would answer plaintext requests with
				// `400 Client sent an HTTP request to an HTTPS server`.
				automatic_https: { disable: true },
				routes: gatewayRoutes,
				...(server.logs ? { logs: server.logs } : {}),
			};
		}
	} else if (gatewayRoutes.length > 0) {
		server.routes = [...gatewayRoutes, ...server.routes];
	}

	// The native database studio (D96) uses the same internal-gateway pattern: one route per node's
	// studio front, on a loopback listener on the edge or the WireGuard-only server on a worker.
	const databaseGateway = options.state.databaseGateway;
	const databaseGatewayRoutes = databaseGateway.routes.map((route) =>
		compileProxyRoute(`gateway:${route.host}`, route.host, route.upstream),
	);
	if (databaseGateway.listen) {
		if (!isLoopbackListen(databaseGateway.listen))
			throw new Error(`databaseGateway.listen must be loopback, got "${databaseGateway.listen}"`);
		if (apps) {
			apps.http.servers.database_gateway = {
				listen: [databaseGateway.listen],
				automatic_https: { disable: true },
				routes: databaseGatewayRoutes,
				...(server.logs ? { logs: server.logs } : {}),
			};
		}
	} else if (databaseGatewayRoutes.length > 0) {
		server.routes = [...databaseGatewayRoutes, ...server.routes];
	}

	// Verified custom domains get certificates up front, as soon as the control plane sends them,
	// not on demand at the first handshake. On-demand issuance never starts behind the Cloudflare
	// proxy: Cloudflare refuses (525/526) to talk to an origin without a certificate, so the request
	// that would trigger issuance is never forwarded. The domain list is already the authorization
	// (only verified domains of live projects are sent), so no `ask` round-trip is needed. Caddy
	// manages the names because the routes above match them; this policy only picks the issuers.
	// The wildcard policy is left untouched.
	const customHosts = [...new Set(options.state.domains.map((domain) => normalizeHost(domain.host)))];
	if (customHosts.length > 0 && apps && options.tls) {
		const tls = (apps.tls ??= {});
		const automation = (tls.automation ??= {}) as Record<string, unknown>;
		const policies = (automation.policies as Record<string, unknown>[] | undefined) ?? [];
		policies.push({ subjects: customHosts, issuers: customDomainIssuers(options.tls) });
		automation.policies = policies;
	}

	// Kubernetes API hosts are `<cluster>.k8s.<contentDomain>`, one label deeper than the content
	// wildcard covers (D14), so the node that terminates them gets `*.k8s.<contentDomain>` over
	// DNS-01 (docs/KUBERNETES.md K7). The record must be DNS-only: Cloudflare's proxy would neither
	// cover the second label nor keep idle streams open.
	const apiRoutes = (options.state.kubernetesRoutes ?? []).filter(
		(route) => route.kind === 'api' && route.host.endsWith(`.k8s.${options.state.contentDomain}`),
	);
	if (apiRoutes.length > 0 && apps && options.tls) {
		const wildcard = `*.k8s.${normalizeHost(options.state.contentDomain)}`;
		const tls = (apps.tls ??= {});
		const certificates = ((tls as Record<string, unknown>).certificates ??= {}) as Record<string, unknown>;
		certificates.automate = [...new Set([...((certificates.automate as string[] | undefined) ?? []), wildcard])];
		const automation = ((tls as Record<string, unknown>).automation ??= {}) as Record<string, unknown>;
		const policies = (automation.policies as Record<string, unknown>[] | undefined) ?? [];
		policies.push({ subjects: [wildcard], issuers: customDomainIssuers(options.tls) });
		automation.policies = policies;
	}

	// Email (docs/EMAIL.md §3.2): on the mail node Caddy obtains the submission and MX certificates.
	// No route serves these names; `automate` manages a certificate without one. The helper copies
	// the submission certificate out of Caddy's storage for yoal-mail.
	if (options.state.mail && apps && options.tls) {
		const names = [...new Set([options.state.mail.hostnames.submission, options.state.mail.hostnames.mx].map(normalizeHost))];
		const tls = (apps.tls ??= {});
		const certificates = ((tls as Record<string, unknown>).certificates ??= {}) as Record<string, unknown>;
		certificates.automate = [...new Set([...((certificates.automate as string[] | undefined) ?? []), ...names])];
		const automation = ((tls as Record<string, unknown>).automation ??= {}) as Record<string, unknown>;
		const policies = (automation.policies as Record<string, unknown>[] | undefined) ?? [];
		policies.push({ subjects: names, issuers: customDomainIssuers(options.tls) });
		automation.policies = policies;
	}

	if (options.accessLog) {
		// Without a logging app Caddy writes no access log and agent telemetry stays empty (§8).
		// Raw logs stay on the node for 7 days, compressed; only 1-minute aggregates leave it.
		server.logs = {
			default_logger_name: ACCESS_LOGGER,
			...(options.platform ? { skip_hosts: [options.platform.host] } : {}),
		};
		config.logging = {
			logs: {
				default: { exclude: [`http.log.access.${ACCESS_LOGGER}`] },
				[ACCESS_LOGGER]: {
					writer: {
						output: 'file',
						filename: options.accessLog,
						// Readable by the agent through the caddy group; Caddy's default is 0600.
						mode: '0640',
						roll_size_mb: 50,
						roll_gzip: true,
						roll_keep_days: 7,
					},
					encoder: { format: 'json' },
					include: [`http.log.access.${ACCESS_LOGGER}`],
				},
			},
		};
	}

	// HA-PLAN H19: only an ingress renders the health endpoint, lame duck, PROXY protocol and
	// trusted proxies. Additive, so a worker's config (and every pre-Wave-2 one) is unchanged.
	if (options.ingress && options.ingressHealthDir) {
		compileIngressProtection(config, {
			proxyProtocol: options.ingress.proxyProtocol,
			trustedProxies: options.ingress.trustedProxies,
			healthPort: options.ingress.healthPort ?? INGRESS_HEALTH_PORT,
			healthDir: options.ingressHealthDir,
			tls: Boolean(options.tls),
			drainSeconds: options.ingress.drainSeconds,
		});
		// Probes are not requests to a site: keep them out of the 1-minute analytics buckets.
		if (server.logs) (server.logs as Record<string, unknown>).skip_uris = [INGRESS_HEALTH_PATH];
	}

	// Preserve the unix-socket admin endpoint when replacing the config; a full /load without it
	// would let Caddy fall back to its default TCP admin listener (D7).
	config.admin = { listen: caddySocketAddress(options.caddyAdminSocket) };
	return normalizeHandlers(config) as Record<string, unknown>;
}
