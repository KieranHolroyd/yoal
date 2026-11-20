/**
 * Counting pass-through for a real S3 store (R2), so the rig can count operations the way it
 * reads MinIO's metrics. Containers reach it as `http://<store host>` (an --add-host entry points
 * that name here); it forwards each request unchanged to `https://<store host>`. The SigV4 signature
 * covers the Host header and the payload hash, not the scheme, so it stays valid.
 *
 * It records per operation: count, HTTP status counts and latency. It never logs a URL, a key or a
 * header. Counts are served on S2_COUNTS_PORT (default 9999) at GET /counts.
 *
 *   S2_UPSTREAM_HOST=<host> bun /rig/proxy.ts
 */
const upstream = process.env.S2_UPSTREAM_HOST!;
if (!upstream) throw new Error('S2_UPSTREAM_HOST is required');

type Op = { n: number; status: Record<string, number>; ms: number[] };
const ops: Record<string, Op> = {};
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

function classify(method: string, url: URL): string {
	const q = url.searchParams;
	const path = url.pathname.replace(/^\/+/, '');
	const isBucket = !path.includes('/'); // path-style: /<bucket> or /<bucket>/
	if (method === 'GET' && (q.has('list-type') || (isBucket && !q.has('location')))) return 'ListObjects';
	if (method === 'GET' && q.has('location')) return 'GetBucketLocation';
	if (method === 'GET') return 'GetObject';
	if (method === 'HEAD') return isBucket ? 'HeadBucket' : 'HeadObject';
	if (method === 'PUT' && q.has('partNumber')) return 'UploadPart';
	if (method === 'PUT') return isBucket ? 'PutBucket' : 'PutObject';
	if (method === 'POST' && q.has('uploads')) return 'CreateMultipartUpload';
	if (method === 'POST' && q.has('uploadId')) return 'CompleteMultipartUpload';
	if (method === 'POST' && q.has('delete')) return 'DeleteObjects';
	if (method === 'DELETE' && q.has('uploadId')) return 'AbortMultipartUpload';
	if (method === 'DELETE') return 'DeleteObject';
	return `${method}-other`;
}

Bun.serve({
	port: 80,
	hostname: '0.0.0.0',
	idleTimeout: 255,
	async fetch(req) {
		const url = new URL(req.url);
		const op = classify(req.method, url);
		const headers = new Headers();
		for (const [k, v] of req.headers) if (!HOP.has(k.toLowerCase())) headers.set(k, v);
		const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(await req.arrayBuffer());
		const t0 = performance.now();
		let status = 'error';
		try {
			const res = await fetch(`https://${upstream}${url.pathname}${url.search}`, { method: req.method, headers, body, decompress: false, redirect: 'manual' } as RequestInit);
			status = String(res.status);
			const out = new Headers();
			for (const [k, v] of res.headers) if (!HOP.has(k.toLowerCase())) out.set(k, v);
			const buf = req.method === 'HEAD' ? null : new Uint8Array(await res.arrayBuffer());
			return new Response(buf, { status: res.status, headers: out });
		} catch {
			return new Response('upstream error', { status: 502 });
		} finally {
			const o = (ops[op] ??= { n: 0, status: {}, ms: [] });
			o.n++;
			o.status[status] = (o.status[status] ?? 0) + 1;
			o.ms.push(Math.round(performance.now() - t0));
		}
	},
});

Bun.serve({
	port: Number(process.env.S2_COUNTS_PORT ?? 9999),
	hostname: '0.0.0.0',
	fetch() {
		const summary: Record<string, unknown> = {};
		for (const [k, o] of Object.entries(ops)) {
			const s = [...o.ms].sort((a, b) => a - b);
			const p = (x: number) => s[Math.min(s.length - 1, Math.ceil(x * s.length) - 1)] ?? 0;
			summary[k] = { n: o.n, status: o.status, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: s.at(-1) ?? 0 };
		}
		return Response.json(summary);
	},
});
console.log('s2 counting proxy up');
