/**
 * Minimal Hetzner Cloud API client for the S9 cloud rig. The token comes from `HCLOUD_TOKEN` in the
 * environment of the one command that needs it; it is never printed, and every error message is
 * scrubbed of it. Writes are allowed only on resources labelled `yoal-w0=s9` (see `guardOwned`).
 */
const TOKEN = process.env.HCLOUD_TOKEN ?? '';
const BASE = 'https://api.hetzner.cloud/v1';
export const LABEL_KEY = 'yoal-w0';
export const LABEL_VALUE = 's9';
export const LABEL_SELECTOR = `${LABEL_KEY}=${LABEL_VALUE}`;
export const NAME_PREFIX = 'yoal-w0-s9-';
/** The owner's production worker (edge-b): the project must never contain it. */
const FORBIDDEN_IPV4 = '37.27.251.51';

export function scrub(text: string): string {
	return TOKEN ? text.split(TOKEN).join('[token]') : text;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
	if (!TOKEN) throw new Error('HCLOUD_TOKEN is not set');
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	const json = text ? JSON.parse(text) : {};
	if (!response.ok) {
		const err = json.error ?? {};
		throw new Error(scrub(`${method} ${path.split('?')[0]}: HTTP ${response.status} ${err.code ?? ''} ${err.message ?? ''} ${err.details ? JSON.stringify(err.details) : ''}`));
	}
	return json as T;
}

/** GETs every page of a collection. */
export async function list<T = any>(collection: string, query = ''): Promise<T[]> {
	const out: T[] = [];
	for (let page = 1; page; ) {
		const r = await api('GET', `/${collection}?per_page=50&page=${page}${query ? `&${query}` : ''}`);
		out.push(...(r[collection] as T[]));
		page = r.meta?.pagination?.next_page ?? 0;
	}
	return out;
}

export const labels = { [LABEL_KEY]: LABEL_VALUE };
export const owned = (r: { labels?: Record<string, string> }) => r.labels?.[LABEL_KEY] === LABEL_VALUE;
export function guardOwned(r: { name: string; labels?: Record<string, string> }) {
	if (!owned(r) || !r.name.startsWith(NAME_PREFIX)) throw new Error(`refusing to touch ${r.name}: not labelled ${LABEL_SELECTOR}`);
}

/** Waits for an action to finish. */
export async function waitAction(id: number, timeoutMs = 300_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const { action } = await api('GET', `/actions/${id}`);
		if (action.status === 'success') return action;
		if (action.status === 'error') throw new Error(`action ${action.command} failed: ${action.error?.code} ${action.error?.message}`);
		await Bun.sleep(1000);
	}
	throw new Error(`action ${id} timed out`);
}

/**
 * Safety rule: the first call. Lists servers, load balancers, networks, firewalls and SSH keys and
 * refuses to go on if the project holds anything that is not a `yoal-w0` throwaway (in particular
 * the owner's edge-b). Prints counts and names only.
 */
export async function inventory(): Promise<{ safe: boolean; report: Record<string, { count: number; names: string[] }> }> {
	const report: Record<string, { count: number; names: string[] }> = {};
	let safe = true;
	for (const collection of ['servers', 'load_balancers', 'networks', 'firewalls', 'ssh_keys']) {
		const items = await list<any>(collection);
		report[collection] = { count: items.length, names: items.map((i) => i.name) };
		if (collection === 'servers') {
			for (const s of items) {
				const ip = s.public_net?.ipv4?.ip;
				if (ip === FORBIDDEN_IPV4 || s.name === 'edge-b' || s.name === 'edge' || !String(s.name).startsWith('yoal-w0')) safe = false;
			}
		}
	}
	return { safe, report };
}

if (import.meta.main) {
	const cmd = process.argv[2];
	if (cmd === 'inventory') {
		const { safe, report } = await inventory();
		console.log(JSON.stringify({ safe, report }));
		process.exit(safe ? 0 : 3);
	}
}
