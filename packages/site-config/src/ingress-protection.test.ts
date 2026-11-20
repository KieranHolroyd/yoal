import { describe, expect, test } from 'bun:test';
import { INGRESS_HEALTH_PATH, ingressHealthWords } from '@yoal/contracts';
import {
	compileCaddyConfig,
	compileIngressProtection,
	ingressHealthBody,
	type IngressProtectionOptions,
} from './compile.ts';

type Json = Record<string, any>;

const baseOptions: IngressProtectionOptions = {
	proxyProtocol: 'off',
	trustedProxies: [],
	healthPort: 8099,
	healthDir: '/run/yoal/health',
	tls: true,
	drainSeconds: 20,
};

function config(extra: Partial<IngressProtectionOptions> = {}): Json {
	const compiled = compileCaddyConfig({
		listen: [':443'],
		sites: [],
		tls: { email: 'ops@example.com', subjects: ['*.example.com', 'example.com'] },
		contentDomain: 'example.com',
	});
	return compileIngressProtection(compiled, { ...baseOptions, ...extra }) as Json;
}

const serversOf = (value: Json): Json => value.apps.http.servers;

describe('ingress protection (HA-PLAN H19)', () => {
	test('the health route answers any Host before every host route, on 443, 80 and the health port', () => {
		const value = config();
		const servers = serversOf(value);
		for (const name of ['content', 'http_redirect', 'ingress_health']) {
			const route = (servers[name].routes as Json[])[0]!;
			expect(route['@id']).toBe(`yoal-health:${name}`);
			expect(route.match).toEqual([{ path: [INGRESS_HEALTH_PATH] }]);
			expect(route.match[0].host).toBeUndefined();
		}
		expect(servers.ingress_health.listen).toEqual([':8099']);
		expect(servers.ingress_health.automatic_https).toEqual({ disable: true });
		// The lame-duck Close header is second, non-terminal, so it applies to every answer.
		const drain = (servers.content.routes as Json[])[1]!;
		expect(drain.match).toEqual([{ file: { root: '/', try_files: ['/run/yoal/health/draining'] } }]);
		expect(drain.handle).toEqual([{ handler: 'headers', response: { set: { Connection: ['close'] } } }]);
		expect(drain.terminal).toBeUndefined();
	});

	test('every answer is one padded word: 200 ok, 503 with the agent\'s reason', () => {
		const value = config();
		const subroutes = (serversOf(value).content.routes[0].handle as Json[])[0]!.routes as Json[];
		const answers = subroutes.flatMap((route) => route.handle as Json[]).filter((handler) => handler.handler === 'static_response');
		const words = ['draining', 'caddy', 'desired-state', 'releases', 'certificates', 'caddy', 'ok'];
		expect(answers.map((answer) => answer.status_code)).toEqual([503, 503, 503, 503, 503, 503, 200]);
		expect(answers.map((answer) => answer.body)).toEqual(words.map((word) => ingressHealthBody(word)));
		for (const answer of answers) expect((answer.body as string).length).toBe(16);
		expect(ingressHealthWords.ok).toBe('ok');
		// No version, host or topology in any answer.
		expect(JSON.stringify(answers)).not.toMatch(/version|node|host/i);
	});

	test('PROXY v1 and v2 render the listener wrapper only with trusted proxies', () => {
		for (const version of ['v1', 'v2'] as const) {
			const value = config({ proxyProtocol: version, trustedProxies: ['10.0.0.5/32'] });
			const servers = serversOf(value);
			expect(servers.content.listener_wrappers).toEqual([
				{ wrapper: 'proxy_protocol', timeout: '5s', allow: ['10.0.0.5/32'], fallback_policy: 'ignore' },
				{ wrapper: 'tls' },
			]);
			expect(servers.http_redirect.listener_wrappers).toEqual([
				{ wrapper: 'proxy_protocol', timeout: '5s', allow: ['10.0.0.5/32'], fallback_policy: 'ignore' },
			]);
			expect(servers.ingress_health.listener_wrappers).toHaveLength(1);
			// The resolved client address, and nothing else, is believed.
			for (const name of ['content', 'http_redirect', 'ingress_health'])
				expect(servers[name]).toMatchObject({
					trusted_proxies: { source: 'static', ranges: ['10.0.0.5/32'] },
					client_ip_headers: ['X-Forwarded-For'],
					trusted_proxies_strict: true,
				});
		}
	});

	test('today\'s behaviour: no proxy protocol, no trusted proxies, no wrapper', () => {
		const value = config({ proxyProtocol: 'off', trustedProxies: [] });
		const servers = serversOf(value);
		for (const name of ['content', 'http_redirect', 'ingress_health']) {
			expect(servers[name].listener_wrappers).toBeUndefined();
			expect(servers[name].trusted_proxies).toBeUndefined();
			expect(servers[name].client_ip_headers).toBeUndefined();
		}
		// A protocol was asked for but nobody is listed: accept no header at all.
		const noTrust = config({ proxyProtocol: 'v2', trustedProxies: [] });
		expect(serversOf(noTrust).content.listener_wrappers).toBeUndefined();
	});

	test('refuses a non-CIDR trusted proxy and the public ports, before Caddy ever loads it', () => {
		expect(() => config({ proxyProtocol: 'v2', trustedProxies: ['10.0.0.5'] })).toThrow(/CIDR/);
		expect(() => config({ trustedProxies: ['not-an-address'] })).toThrow(/CIDR/);
		expect(() => config({ healthPort: 80 })).toThrow(/80\/443/);
		expect(() => config({ healthPort: 0 })).toThrow(/port/);
	});

	test('YOAL_CADDY_LISTEN entries are honoured with TLS on', () => {
		const compiled = compileCaddyConfig({
			listen: ['10.0.0.2:443'],
			httpListen: ['10.0.0.2:80'],
			sites: [],
			tls: { email: 'ops@example.com', subjects: ['example.com'] },
		}) as Json;
		expect(compiled.apps.http.servers.content.listen).toEqual(['10.0.0.2:443']);
		expect(compiled.apps.http.servers.http_redirect.listen).toEqual(['10.0.0.2:80']);
		// No :80 entry: no redirect server is invented.
		const noHttp = compileCaddyConfig({
			listen: ['10.0.0.2:443'],
			httpListen: [],
			sites: [],
			tls: { email: 'ops@example.com', subjects: ['example.com'] },
		}) as Json;
		expect(noHttp.apps.http.servers.http_redirect).toBeUndefined();
	});

	test('Caddy gets a grace period no shorter than the drain', () => {
		expect(config({ drainSeconds: 20 }).apps.http.grace_period).toBe('30s');
		expect(config({ drainSeconds: 45 }).apps.http.grace_period).toBe('45s');
	});
});
