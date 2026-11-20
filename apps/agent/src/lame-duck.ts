/**
 * The ingress lame duck (HA-PLAN H19, I15): before an ingress stops for a shutdown, an update or a
 * role removal, it must answer `503 draining` for `ingress.drainSeconds` while still serving, so a
 * balancer or DNS record has time to take it out. Then the caller stops Caddy.
 *
 * Pure timing with injected effects, so the ordering is a unit test: `onChange(true)` happens
 * before the wait, and the caller's stop happens only after `begin` resolves.
 */
export type LameDuckReason = 'shutdown' | 'update' | 'role-removal';

export interface LameDuckOptions {
	/** `ingress.drainSeconds` at the moment the drain begins. */
	drainSeconds: () => number;
	/** Write (or clear) the 503/`Connection: close` state Caddy reads. */
	onChange: (draining: boolean) => void | Promise<void>;
	now?: () => number;
	wait?: (ms: number) => Promise<void>;
}

export class LameDuck {
	private readonly now: () => number;
	private readonly wait: (ms: number) => Promise<void>;
	private startedAt: number | null = null;
	private deadline = 0;
	private finished: Promise<void> | null = null;

	constructor(private readonly options: LameDuckOptions) {
		this.now = options.now ?? Date.now;
		this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	get draining(): boolean {
		return this.startedAt !== null;
	}

	/** Remaining milliseconds in the current drain, zero when not draining. */
	remaining(): number {
		return this.startedAt === null ? 0 : Math.max(0, this.deadline - this.now());
	}

	/**
	 * Enter the lame duck. Idempotent: a second caller (a signal racing a role removal) waits for
	 * the same drain instead of restarting it. Resolves after `drainSeconds`; the caller then stops.
	 */
	begin(_reason: LameDuckReason = 'shutdown'): Promise<void> {
		if (this.finished) return this.finished;
		this.startedAt = this.now();
		const seconds = Math.max(0, Math.trunc(this.options.drainSeconds()));
		this.deadline = this.startedAt + seconds * 1_000;
		this.finished = (async () => {
			// The 503 must be visible before any waiting, and while the old config still serves.
			await this.options.onChange(true);
			const remaining = this.remaining();
			if (remaining > 0) await this.wait(remaining);
		})();
		return this.finished;
	}

	/** Leave the lame duck without stopping (an update that failed, before Caddy is touched). */
	async reset(): Promise<void> {
		this.startedAt = null;
		this.deadline = 0;
		this.finished = null;
		await this.options.onChange(false);
	}
}
