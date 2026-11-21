import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ControlDesired, ControlNodeAddress } from '@yoal/contracts';
import { atomicWriteFile } from './state.ts';

/**
 * The agent's control address list and epoch fence (docs/build-plan/W9-SPEC.md §4.4, CLUSTERING §6.3).
 *
 * Desired state carries the list in preference order and the highest epoch the control plane has
 * asserted. This class:
 * - persists the highest epoch seen **before** applying anything at it (atomic rename);
 * - refuses a desired state whose epoch is lower than the one on disk, so a stale or fenced control
 *   plane cannot talk an agent back into an older term;
 * - moves to the next address when one does not answer or answers `503` with a non-primary role;
 * - never depends on any of it for serving traffic: when every address is silent the agent keeps
 *   its cached desired state (I11).
 */
export interface ControlEndpointsOptions {
	dataDir: string;
	/** The URL from `agent.env`, used until desired state delivers a list. */
	initialUrl: string;
	fetchImpl?: typeof fetch;
	log?: (level: 'info' | 'warn', message: string) => void;
	/** Per-request timeout. A control node that hangs must not hold the agent forever. */
	timeoutMs?: number;
}

export interface ControlEndpointsState {
	epoch: number;
	nodes: ControlNodeAddress[];
	current: number;
	url: string;
}

export class ControlEndpoints {
	readonly #epochPath: string;
	readonly #initialUrl: string;
	readonly #fetch: typeof fetch;
	readonly #log?: (level: 'info' | 'warn', message: string) => void;
	readonly #timeoutMs: number;
	#nodes: ControlNodeAddress[] = [];
	#epoch = 0;
	#current = 0;
	#loaded = false;

	constructor(options: ControlEndpointsOptions) {
		this.#epochPath = join(options.dataDir, 'epoch.json');
		this.#initialUrl = options.initialUrl.replace(/\/+$/, '');
		this.#fetch = options.fetchImpl ?? fetch;
		this.#log = options.log;
		this.#timeoutMs = options.timeoutMs ?? 30_000;
	}

	async load(): Promise<number> {
		if (this.#loaded) return this.#epoch;
		this.#loaded = true;
		try {
			const parsed = JSON.parse(await fs.readFile(this.#epochPath, 'utf8')) as { epoch?: unknown };
			if (typeof parsed.epoch === 'number' && Number.isInteger(parsed.epoch) && parsed.epoch >= 0) this.#epoch = parsed.epoch;
		} catch {
			// Missing or corrupt means "nothing seen"; a lower state is then accepted, which is safe
			// on a fresh agent and cannot lower an epoch that was ever persisted.
		}
		return this.#epoch;
	}

	get epoch(): number {
		return this.#epoch;
	}

	baseUrl(): string {
		return this.#nodes[this.#current]?.url.replace(/\/+$/, '') ?? this.#initialUrl;
	}

	state(): ControlEndpointsState {
		return { epoch: this.#epoch, nodes: [...this.#nodes], current: this.#current, url: this.baseUrl() };
	}

	/**
	 * Apply a desired-state control block. Returns false and leaves the current list untouched when
	 * the block would move the agent to a lower epoch; the caller must then drop the whole state.
	 */
	async apply(control: ControlDesired): Promise<{ ok: true } | { ok: false; reason: string }> {
		await this.load();
		if (control.epoch < this.#epoch) {
			return {
				ok: false,
				reason: `desired state asserts epoch ${control.epoch}, below the persisted epoch ${this.#epoch}; refusing it`,
			};
		}
		// Persist the higher epoch first. A crash between the write and the list update leaves the
		// safe side: the agent will refuse a stale term on the next boot.
		if (control.epoch > this.#epoch) await this.#persistEpoch(control.epoch);
		this.#nodes = [...control.nodes];
		const currentUrl = this.#nodes[this.#current]?.url;
		if (!currentUrl) this.#current = 0;
		return { ok: true };
	}

	/** Record an epoch asserted by a response header. A lower value is refused, never adopted. */
	async observeEpoch(epoch: number): Promise<boolean> {
		await this.load();
		if (!Number.isInteger(epoch) || epoch < 0) return false;
		if (epoch < this.#epoch) return false;
		if (epoch > this.#epoch) await this.#persistEpoch(epoch);
		return true;
	}

	/**
	 * The current address refused a state (a lower epoch, or a bad payload). Move on rather than
	 * retrying the same stale control plane; the caller keeps its cached state (I11).
	 */
	refuseCurrent(): void {
		this.#rotate();
	}

	/**
	 * One request with rotation. Network errors, 5xx and a `503` from a non-primary move to the next
	 * address; an authentication or validation answer (4xx) is returned to the caller as-is.
	 */
	async request(path: string, init: RequestInit = {}): Promise<Response> {
		await this.load();
		const candidates = this.#nodes.length > 0 ? this.#nodes : [{ nodeId: 'initial', url: this.#initialUrl, zone: 'default' }];
		let lastError: unknown = null;
		for (let attempt = 0; attempt < candidates.length; attempt++) {
			const url = `${this.baseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new Error('control request timed out')), this.#timeoutMs);
			timer.unref?.();
			try {
				const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
				const response = await this.#fetch(url, { ...init, signal });
				if (response.status === 503) {
					const role = response.headers.get('x-yoal-role');
					const epochHeader = response.headers.get('x-yoal-epoch');
					const epoch = epochHeader === null ? null : Number(epochHeader);
					if (epoch !== null && Number.isInteger(epoch) && !(await this.observeEpoch(epoch))) return response;
					if (role && role !== 'primary') {
						this.#log?.('warn', `control ${url} is ${role}; trying the next address`);
						this.#rotate();
						continue;
					}
				}
				if (response.status >= 500) {
					this.#log?.('warn', `control ${url} answered ${response.status}; trying the next address`);
					this.#rotate();
					continue;
				}
				return response;
			} catch (error) {
				lastError = error;
				if (init.signal?.aborted) throw error;
				this.#log?.('warn', `control ${url} unreachable: ${error instanceof Error ? error.message : String(error)}`);
				this.#rotate();
			} finally {
				clearTimeout(timer);
			}
		}
		if (lastError) throw lastError;
		throw new Error(`No control node answered (${candidates.length} address(es) tried).`);
	}

	#rotate(): void {
		if (this.#nodes.length === 0) return;
		this.#current = (this.#current + 1) % this.#nodes.length;
	}

	async #persistEpoch(epoch: number): Promise<void> {
		this.#epoch = epoch;
		await fs.mkdir(dirname(this.#epochPath), { recursive: true });
		await atomicWriteFile(this.#epochPath, `${JSON.stringify({ epoch, seenAt: new Date().toISOString() })}\n`);
	}
}
