#!/usr/bin/env bun
/**
 * s3lab: an S3-compatible endpoint for the HA lab (docs/HA-PLAN.md W1, CLUSTERING §19.3) that can
 * misbehave on demand. It forwards every request to a pinned MinIO and, when a rule matches,
 * answers instead with 412, 409, 5xx or 501, adds delay, or serves a stale read (the previous
 * version of an object with its old ETag), which is how a lease client meets a broken arbiter.
 *
 *   S3 API      :9000  (what lab nodes and the CAS lease client talk to)
 *   control API :9001  (what `lab s3 …` talks to; never exposed beyond the lab network + loopback)
 *
 * Control API (JSON):
 *   GET    /rules                     active rules with their remaining counts
 *   POST   /rules                     add { match?, action, count?, probability?, durationS? }
 *   DELETE /rules/<id>                remove one rule
 *   POST   /clear                     remove every rule
 *   GET    /log?limit=n               the most recent requests and what s3lab did with each
 *   GET    /healthz
 *
 * match:  { method?: 'GET'|'PUT'|'HEAD'|'DELETE'|'POST', bucket?: string, keyPrefix?: string,
 *           conditional?: boolean  (only requests carrying If-Match / If-None-Match) }
 * action: { status?: 412|409|500|502|503|504|501, delayMs?: 0–60000, stale?: true }
 *           status answers with an S3 XML error; delayMs waits first (then forwards or answers);
 *           stale serves the object's previous version (GET only). An unreachable arbiter is the
 *           helper's `block-arbiter` fault verb on the node, not an s3lab rule.
 *
 * The proxy keeps the request's Host header when it forwards, so SigV4 signatures stay valid.
 */

export {};

interface Match {
	method?: string;
	bucket?: string;
	keyPrefix?: string;
	conditional?: boolean;
}
interface Action {
	status?: number;
	delayMs?: number;
	stale?: boolean;
}
interface Rule {
	id: string;
	match: Match;
	action: Action;
	remaining: number | null;
	probability: number;
	expiresAt: number | null;
	hits: number;
}
interface Version {
	body: Uint8Array;
	etag: string;
	contentType: string;
	storedAt: number;
}

const UPSTREAM = (process.env.S3LAB_UPSTREAM ?? 'http://127.0.0.1:9100').replace(/\/+$/, '');
const S3_PORT = Number(process.env.S3LAB_PORT ?? 9000);
const CONTROL_PORT = Number(process.env.S3LAB_CONTROL_PORT ?? 9001);
const MAX_HISTORY = 4;
const MAX_LOG = 2000;
const STATUS_CODES: Record<number, string> = {
	409: 'ConditionalRequestConflict',
	412: 'PreconditionFailed',
	500: 'InternalError',
	501: 'NotImplemented',
	502: 'BadGateway',
	503: 'SlowDown',
	504: 'GatewayTimeout',
};

const rules = new Map<string, Rule>();
const versionsByKey = new Map<string, Version[]>();
const log: Array<{ t: string; method: string; path: string; status: number; ruleId: string | null; ms: number }> = [];
let nextRule = 1;

function parsePath(url: URL): { bucket: string; key: string } {
	const parts = url.pathname.replace(/^\/+/, '').split('/');
	return { bucket: decodeURIComponent(parts[0] ?? ''), key: decodeURIComponent(parts.slice(1).join('/')) };
}

function matches(rule: Rule, request: Request, bucket: string, key: string): boolean {
	if (rule.expiresAt !== null && Date.now() > rule.expiresAt) return false;
	if (rule.remaining !== null && rule.remaining <= 0) return false;
	const match = rule.match;
	if (match.method && match.method !== request.method) return false;
	if (match.bucket && match.bucket !== bucket) return false;
	if (match.keyPrefix && !key.startsWith(match.keyPrefix)) return false;
	if (match.conditional && !request.headers.has('if-match') && !request.headers.has('if-none-match')) return false;
	return rule.probability >= 1 || Math.random() < rule.probability;
}

function s3Error(status: number, resource: string): Response {
	const code = STATUS_CODES[status] ?? 'InternalError';
	const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>injected by s3lab</Message><Resource>${resource}</Resource><RequestId>s3lab</RequestId></Error>`;
	return new Response(body, { status, headers: { 'content-type': 'application/xml', 'x-s3lab-injected': code } });
}

async function forward(request: Request, url: URL): Promise<Response> {
	const headers = new Headers(request.headers);
	const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer());
	const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
		method: request.method,
		headers,
		body,
		redirect: 'manual',
	});
	const responseBody = new Uint8Array(await upstream.arrayBuffer());
	const { bucket, key } = parsePath(url);
	// Remember each successful object write so a stale-read rule can serve the one before it.
	if (request.method === 'PUT' && upstream.status === 200 && key && body && !url.searchParams.has('uploadId')) {
		const versions = versionsByKey.get(`${bucket}/${key}`) ?? [];
		versions.push({ body, etag: upstream.headers.get('etag') ?? '', contentType: request.headers.get('content-type') ?? 'application/octet-stream', storedAt: Date.now() });
		versionsByKey.set(`${bucket}/${key}`, versions.slice(-MAX_HISTORY));
	}
	const out = new Headers(upstream.headers);
	out.delete('content-encoding');
	out.delete('transfer-encoding');
	return new Response(request.method === 'HEAD' ? null : responseBody, { status: upstream.status, headers: out });
}

async function handleS3(request: Request): Promise<Response> {
	const started = performance.now();
	const url = new URL(request.url);
	const { bucket, key } = parsePath(url);
	const rule = [...rules.values()].find((candidate) => matches(candidate, request, bucket, key)) ?? null;
	let response: Response;
	if (rule) {
		rule.hits++;
		if (rule.remaining !== null) rule.remaining--;
		const action = rule.action;
		if (action.delayMs) await Bun.sleep(action.delayMs);
		if (action.status) response = s3Error(action.status, url.pathname);
		else if (action.stale && request.method === 'GET') {
			const versions = versionsByKey.get(`${bucket}/${key}`) ?? [];
			const previous = versions.length >= 2 ? versions[versions.length - 2]! : null;
			response = previous
				? new Response(previous.body as Uint8Array<ArrayBuffer>, { status: 200, headers: { etag: previous.etag, 'content-type': previous.contentType, 'x-s3lab-injected': 'stale' } })
				: await forward(request, url);
		} else response = await forward(request, url);
	} else response = await forward(request, url);
	record(request, url, response.status, rule?.id ?? null, started);
	return response;
}

function record(request: Request, url: URL, status: number, ruleId: string | null, started: number): void {
	log.push({ t: new Date().toISOString(), method: request.method, path: url.pathname, status, ruleId, ms: Math.round(performance.now() - started) });
	if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
}

function bad(message: string): Response {
	return Response.json({ error: message }, { status: 400 });
}

function parseRule(input: unknown): Rule | string {
	if (typeof input !== 'object' || input === null) return 'rule must be an object';
	const body = input as Record<string, unknown>;
	const match = (body.match ?? {}) as Record<string, unknown>;
	const action = (body.action ?? {}) as Record<string, unknown>;
	if (typeof match !== 'object' || typeof action !== 'object') return 'match and action must be objects';
	if (match.method !== undefined && !['GET', 'PUT', 'HEAD', 'DELETE', 'POST'].includes(String(match.method))) return 'match.method is not an S3 method';
	for (const field of ['bucket', 'keyPrefix'] as const)
		if (match[field] !== undefined && (typeof match[field] !== 'string' || (match[field] as string).length > 512)) return `match.${field} must be a string`;
	if (action.status !== undefined && !(Number(action.status) in STATUS_CODES)) return `action.status must be one of ${Object.keys(STATUS_CODES).join(', ')}`;
	if (action.delayMs !== undefined && (!Number.isInteger(action.delayMs) || Number(action.delayMs) < 0 || Number(action.delayMs) > 60_000)) return 'action.delayMs must be 0–60000';
	if (!action.status && !action.delayMs && !action.stale) return 'action needs status, delayMs or stale';
	const count = body.count === undefined ? null : Number(body.count);
	if (count !== null && (!Number.isInteger(count) || count < 1 || count > 1_000_000)) return 'count must be a positive integer';
	const probability = body.probability === undefined ? 1 : Number(body.probability);
	if (!(probability > 0 && probability <= 1)) return 'probability must be in (0, 1]';
	const durationS = body.durationS === undefined ? null : Number(body.durationS);
	if (durationS !== null && (!Number.isInteger(durationS) || durationS < 1 || durationS > 86_400)) return 'durationS must be 1–86400';
	return {
		id: `r${nextRule++}`,
		match: {
			...(match.method ? { method: String(match.method) } : {}),
			...(match.bucket ? { bucket: String(match.bucket) } : {}),
			...(match.keyPrefix ? { keyPrefix: String(match.keyPrefix) } : {}),
			...(match.conditional ? { conditional: true } : {}),
		},
		action: {
			...(action.status ? { status: Number(action.status) } : {}),
			...(action.delayMs ? { delayMs: Number(action.delayMs) } : {}),
			...(action.stale ? { stale: true } : {}),
		},
		remaining: count,
		probability,
		expiresAt: durationS === null ? null : Date.now() + durationS * 1000,
		hits: 0,
	};
}

async function handleControl(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === '/healthz') return Response.json({ ok: true, upstream: UPSTREAM, rules: rules.size });
	if (url.pathname === '/rules' && request.method === 'GET') return Response.json({ rules: [...rules.values()] });
	if (url.pathname === '/rules' && request.method === 'POST') {
		const rule = parseRule(await request.json().catch(() => null));
		if (typeof rule === 'string') return bad(rule);
		rules.set(rule.id, rule);
		return Response.json({ rule }, { status: 201 });
	}
	if (url.pathname.startsWith('/rules/') && request.method === 'DELETE') {
		const removed = rules.delete(url.pathname.slice('/rules/'.length));
		return Response.json({ removed }, { status: removed ? 200 : 404 });
	}
	if (url.pathname === '/clear' && request.method === 'POST') {
		const removed = rules.size;
		rules.clear();
		return Response.json({ removed });
	}
	if (url.pathname === '/log' && request.method === 'GET') {
		const limit = Math.min(MAX_LOG, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
		return Response.json({ log: log.slice(-limit) });
	}
	return Response.json({ error: 'not_found' }, { status: 404 });
}

Bun.serve({ port: S3_PORT, hostname: '0.0.0.0', fetch: handleS3, idleTimeout: 120, maxRequestBodySize: 512 * 1024 * 1024 });
Bun.serve({ port: CONTROL_PORT, hostname: '0.0.0.0', fetch: handleControl });
console.log(`s3lab: S3 on :${S3_PORT} → ${UPSTREAM}, control on :${CONTROL_PORT}`);
