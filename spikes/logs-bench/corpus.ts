/**
 * Synthetic, realistic log lines for spikes S3 and S5 (docs/LOGS.md §12): web access lines,
 * app logs (plain, logfmt and JSON), database lines, platform lines and multi-line stack traces.
 * Deterministic (seeded) so runs are comparable.
 */

export function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		// mulberry32
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const METHODS = ['GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const ROUTES = ['/api/v1/orders', '/api/v1/users', '/api/v1/invoices', '/health', '/', '/static/app.js', '/api/v2/search', '/webhooks/stripe'];
const STATUSES = [200, 200, 200, 200, 201, 204, 301, 304, 400, 401, 403, 404, 404, 429, 500, 502, 503];
const USERS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
const TABLES = ['users', 'orders', 'invoices', 'sessions', 'events', 'payments'];
const SERVICES = ['payment-svc', 'auth', 'search', 'mailer', 'billing'];
const ERRORS = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'];

export function makeLineGenerator(seed = 42): (scope: number) => string {
	const r = rng(seed);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
	const int = (n: number) => Math.floor(r() * n);
	const hex = (n: number) => {
		let s = '';
		for (let i = 0; i < n; i++) s += '0123456789abcdef'[int(16)];
		return s;
	};
	const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
	const ip = () => `${10 + int(200)}.${int(255)}.${int(255)}.${int(255)}`;
	const ts = () => `2026-11-25T${String(int(24)).padStart(2, '0')}:${String(int(60)).padStart(2, '0')}:${String(int(60)).padStart(2, '0')}.${String(int(1000)).padStart(3, '0')}Z`;
	const route = () => {
		const base = pick(ROUTES);
		return base.startsWith('/api') && r() < 0.6 ? `${base}/${int(100000)}` : base;
	};

	const makers: ((scope: number) => string)[] = [
		// web access (Caddy-ish) — the most common shape
		() => `${pick(METHODS)} ${route()} ${pick(STATUSES)} ${int(2000)}ms ${int(50000)}B ${ip()}`,
		() => `${ip()} - - [25/Nov/2026:14:02:${String(int(60)).padStart(2, '0')} +0000] "${pick(METHODS)} ${route()} HTTP/1.1" ${pick(STATUSES)} ${int(9000)} "-" "Mozilla/5.0 (X11; Linux x86_64)"`,
		() => `request completed method=${pick(METHODS)} path=${route()} status=${pick(STATUSES)} duration=${int(900)}ms request_id=${uuid()}`,
		// app logs
		() => `${ts()} INFO user ${pick(USERS)}@example.com logged in from ${ip()}`,
		() => `${ts()} WARN retrying ${pick(SERVICES)} (attempt ${1 + int(5)} of 5) after ${int(3000)}ms`,
		() => `${ts()} ERROR upstream timeout after ${int(30000)}ms calling ${pick(SERVICES)} at http://${pick(SERVICES)}.internal:${8000 + int(100)}/v1/charge`,
		() => `Processed job ${uuid()} in ${(r() * 5).toFixed(2)}s (queue=${pick(['default', 'mail', 'billing'])}, attempts=${1 + int(3)})`,
		() => `cache miss for key "user:${int(100000)}:profile" (ttl ${int(600)}s)`,
		() => `{"level":"info","ts":"${ts()}","msg":"order created","order_id":${int(1e6)},"user":"${pick(USERS)}","total":${(r() * 500).toFixed(2)}}`,
		() => `{"level":"error","ts":"${ts()}","msg":"payment failed","error":"card_declined","attempt":${1 + int(3)},"trace_id":"${hex(32)}"}`,
		() => `level=info msg="http request" method=${pick(METHODS)} path=${route()} status=${pick(STATUSES)} latency_ms=${int(800)}`,
		() => `Worker ${int(16)} started, pid ${1000 + int(60000)}, listening on 0.0.0.0:${3000 + int(10)}`,
		() => `Connection ${int(100000)} closed by peer: ${pick(ERRORS)}`,
		() => `Sending email to ${pick(USERS)}@example.org (template welcome, message id <${hex(16)}@mail.example.org>)`,
		() => `GC pause ${(r() * 40).toFixed(1)}ms, heap ${int(900)}MB/${1024}MB`,
		() => `deployed commit ${hex(40)} to ${pick(['production', 'staging', 'preview'])}`,
		// database
		() => `${ts()} [${1000 + int(9000)}] LOG:  duration: ${(r() * 200).toFixed(3)} ms  statement: SELECT * FROM ${pick(TABLES)} WHERE id = ${int(100000)}`,
		() => `${ts()} [${1000 + int(9000)}] LOG:  connection authorized: user=app database=app_${int(5)} SSL enabled`,
		() => `${ts()} [${1000 + int(9000)}] ERROR:  duplicate key value violates unique constraint "${pick(TABLES)}_pkey"`,
		() => `${ts()} [${1000 + int(9000)}] LOG:  checkpoint complete: wrote ${int(5000)} buffers (${(r() * 10).toFixed(1)}%); 0 WAL file(s) added, ${int(5)} removed`,
		() => `slow query (${int(5000)}ms): UPDATE ${pick(TABLES)} SET updated_at = now() WHERE org_id = '${uuid()}'`,
		// platform
		() => `agent: drained ${int(500)} lines from yoal-${uuid().slice(0, 8)}.service cursor=s=${hex(32)};i=${hex(6)}`,
		() => `caddy: tls: certificate obtained successfully for ${pick(['app', 'api', 'www'])}.example.com (issuer acme-v02.api.letsencrypt.org-directory)`,
		() => `Pulled image registry.example.com/org/app@sha256:${hex(64)} in ${(r() * 8).toFixed(1)}s`,
		// stack traces (multi-line records, §4.3.1)
		() =>
			`TypeError: Cannot read properties of undefined (reading '${pick(['id', 'name', 'total'])}')\n    at OrderService.create (/app/src/orders.ts:${int(400)}:${int(40)})\n    at async Router.handle (/app/node_modules/express/lib/router/index.js:${int(300)}:${int(30)})\n    at async next (/app/src/middleware.ts:${int(90)}:${int(20)})`,
		() =>
			`Traceback (most recent call last):\n  File "/app/worker.py", line ${int(500)}, in run\n    self.handle(job)\n  File "/app/handlers.py", line ${int(200)}, in handle\nKeyError: '${pick(['user_id', 'amount'])}'`,
		() =>
			`java.lang.IllegalStateException: Pool exhausted after ${int(30000)}ms\n\tat com.example.db.Pool.acquire(Pool.java:${int(300)})\n\tat com.example.api.OrdersController.list(OrdersController.java:${int(120)})\n\t... ${int(40)} more`,
	];

	return (scope: number) => {
		// Each scope gets a skew: some scopes are mostly access logs, some mostly app/db logs, and
		// every scope has a few templates of its own (unique words) so trees differ per scope.
		if (r() < 0.04) return `scope${scope} custom event ${pick(['alpha', 'beta', 'gamma', 'delta'])}-${scope % 7} value=${int(1000)} flag=${r() < 0.5}`;
		const bias = (scope * 7) % makers.length;
		const index = r() < 0.5 ? (bias + int(4)) % makers.length : int(makers.length);
		return makers[index]!(scope);
	};
}

export function percentile(sorted: Float64Array, p: number): number {
	if (sorted.length === 0) return 0;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[i]!;
}

export function fmt(us: number): string {
	return `${us.toFixed(2)} µs`;
}
