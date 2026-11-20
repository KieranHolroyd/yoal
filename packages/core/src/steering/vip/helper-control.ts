import type { VipControl, VipControlStatus, VipNodeState } from './driver.ts';

/**
 * The production `VipControl`: the helper's fixed keepalived verbs over its root-only unix socket.
 *
 * The control plane reaches a helper socket only where one is reachable (the helper lives on the
 * node, not behind the public API). `YOAL_VIP_HELPER_SOCKETS` is a JSON object from node id or
 * name to socket path; a node without an entry is refused by preflight instead of being silently
 * left out of the VRRP group.
 */
export interface VipHelperControlOptions {
	sockets: Record<string, string>;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

interface HelperResponse {
	ok?: boolean;
	changed?: boolean;
	service?: string;
	running?: boolean;
	interface?: string | null;
	virtualAddress?: string | null;
	addressPresent?: boolean;
	error?: string;
}

export class HelperVipControl implements VipControl {
	readonly #sockets: Record<string, string>;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(options: VipHelperControlOptions) {
		this.#sockets = options.sockets;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#timeoutMs = Math.min(30_000, Math.max(500, options.timeoutMs ?? 5_000));
	}

	available(nodeId: string): boolean {
		return this.#socketFor(nodeId) !== null;
	}

	async configure(nodeId: string, state: VipNodeState): Promise<{ changed: boolean }> {
		const body = await this.#post(nodeId, 'configure', state);
		return { changed: body.changed === true };
	}

	async start(nodeId: string): Promise<void> {
		await this.#post(nodeId, 'start');
	}

	async stop(nodeId: string): Promise<void> {
		await this.#post(nodeId, 'stop');
	}

	async status(nodeId: string): Promise<VipControlStatus> {
		const body = await this.#request(nodeId, 'status', { method: 'GET' });
		return {
			running: body.running === true,
			interface: body.interface ?? null,
			virtualAddress: body.virtualAddress ?? null,
			addressPresent: body.addressPresent === true,
		};
	}

	#socketFor(nodeId: string): string | null {
		const value = this.#sockets[nodeId]?.trim();
		return value ? value : null;
	}

	async #post(nodeId: string, verb: string, payload?: unknown): Promise<HelperResponse> {
		return this.#request(nodeId, verb, {
			method: 'POST',
			...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
		});
	}

	async #request(nodeId: string, verb: string, init: RequestInit): Promise<HelperResponse> {
		const socket = this.#socketFor(nodeId);
		if (!socket) throw new Error(`no keepalived helper transport is configured for node ${nodeId}`);
		const options = {
			...init,
			signal: AbortSignal.timeout(this.#timeoutMs),
			redirect: 'manual',
			// Bun's fetch connects over the helper's unix socket; the URL supplies only the path.
			unix: socket,
		} as RequestInit;
		const response = await this.#fetch(`http://localhost/v1/keepalived/${verb}`, options);
		const body = (await response.json().catch(() => ({}))) as HelperResponse;
		if (!response.ok || body.ok === false) throw new Error(body.error ?? `helper answered HTTP ${response.status} for keepalived/${verb}`);
		return body;
	}
}

/** Read the socket map; a malformed value disables the transport rather than guessing a path. */
export function vipHelperSocketsFromEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
	const raw = env.YOAL_VIP_HELPER_SOCKETS?.trim();
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		const sockets: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value !== 'string' || !value.startsWith('/')) continue;
			sockets[key] = value;
		}
		return sockets;
	} catch {
		return {};
	}
}
