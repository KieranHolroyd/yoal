/**
 * Lab-only HTTP relay over stdio, run on lab-a through `docker exec -i` (tests/lab/lib/relay.ts
 * starts it). The host cannot route to the lab network or the overlay, and a worker's Caddy listens
 * only on its overlay address, so a scenario that must reach each app copy directly (bypassing the
 * edge's balancer) sends its requests here: one JSON line in, one JSON line out, matched by id.
 *
 *   in:  {"id":1,"url":"http://10.47.1.2:8080/whoami","method":"GET","headers":[["host","…"]],"body":null,"timeoutMs":3000}
 *   out: {"id":1,"status":200,"headers":[["x-checker-node","lab-b"]],"body":"<base64>"}
 *        {"id":1,"error":"…","timeout":false}
 *   in:  {"id":2,"op":"dials","host":"app.example"}   the edge's upstream dials for that host
 *   out: {"id":2,"dials":["127.0.0.1:8080","10.47.1.2:8080"]}
 *
 * It exits when stdin closes. Nothing listens on a port.
 */
const CADDY_ADMIN = '/var/lib/caddy/admin.sock';

interface RelayRequest {
	id: number;
	op?: 'dials';
	host?: string;
	url?: string;
	method?: string;
	headers?: [string, string][];
	body?: string | null;
	timeoutMs?: number;
}

const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

function dialsFor(config: unknown, host: string): string[] {
	const dials = new Set<string>();
	const walk = (node: unknown, inHost: boolean): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item, inHost);
			return;
		}
		if (!node || typeof node !== 'object') return;
		const record = node as Record<string, unknown>;
		const matched = inHost || (Array.isArray(record.match) && record.match.some((match) => Array.isArray((match as { host?: unknown }).host) && ((match as { host: unknown[] }).host).includes(host)));
		if (matched && typeof record.dial === 'string') dials.add(record.dial);
		for (const [key, value] of Object.entries(record)) if (key !== 'match') walk(value, matched);
	};
	walk(config, false);
	return [...dials];
}

async function handle(request: RelayRequest): Promise<void> {
	try {
		if (request.op === 'dials') {
			const response = await fetch('http://localhost/config/apps/http/servers', { unix: CADDY_ADMIN } as RequestInit);
			write({ id: request.id, dials: dialsFor(await response.json(), request.host ?? '') });
			return;
		}
		const response = await fetch(request.url!, {
			method: request.method ?? 'GET',
			headers: request.headers ?? [],
			body: request.body ? Buffer.from(request.body, 'base64') : undefined,
			redirect: 'manual',
			signal: AbortSignal.timeout(request.timeoutMs ?? 3000),
		});
		const body = Buffer.from(await response.arrayBuffer()).toString('base64');
		write({ id: request.id, status: response.status, headers: [...response.headers], body });
	} catch (error) {
		write({ id: request.id, error: error instanceof Error ? error.message : String(error), timeout: error instanceof Error && error.name === 'TimeoutError' });
	}
}

// No top-level await or exports: the host runs this file with `bun -e` (tests/lab/lib/relay.ts).
void (async () => {
	const decoder = new TextDecoder();
	let buffer = '';
	const pending: Promise<void>[] = [];
	for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline: number;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) pending.push(handle(JSON.parse(line) as RelayRequest));
		}
	}
	await Promise.all(pending);
})();
