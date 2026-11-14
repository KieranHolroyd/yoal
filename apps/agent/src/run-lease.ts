import { promises as fs } from 'node:fs';
import type { DesiredState } from '@yoal/contracts';

/**
 * Run leases (docs/CLUSTERING.md §8.4, docs/SCALING.md §8).
 *
 * A workload that must not run twice carries a lease: this node may run it only while it has
 * heard from the control plane within the lease's TTL. When contact is lost for longer, the node
 * removes the workload's units by itself (self-fencing), which is what lets the control plane
 * start it somewhere else without the two ever overlapping for long.
 *
 * The time of the last contact is written to disk, as wall-clock time, so the rule survives an
 * agent restart and a reboot: a node that comes back in the middle of a partition finds a stale
 * timestamp and fences at once, before the control plane's copy and its own can both run. An
 * agent restarted while the control plane is reachable finds a fresh one and touches nothing.
 */
export class RunLeaseClock {
	private lastContactMs: number | null = null;
	private loaded = false;

	constructor(
		private readonly options: {
			path: string | null;
			now?: () => number;
			log?: (level: 'info' | 'warn', message: string) => void;
		},
	) {}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	/** Read the last contact a previous run recorded. No file means no contact is known. */
	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		if (!this.options.path) return;
		try {
			const parsed = JSON.parse(await fs.readFile(this.options.path, 'utf8')) as { lastContactMs?: unknown };
			if (typeof parsed.lastContactMs === 'number' && Number.isFinite(parsed.lastContactMs)) this.lastContactMs = parsed.lastContactMs;
		} catch {
			// Missing or unreadable: treated as never having had contact, the safe side.
		}
	}

	/** The control plane just answered. `persist` writes it down, which only leased nodes need. */
	async touch(persist: boolean): Promise<void> {
		this.lastContactMs = this.now();
		if (!persist || !this.options.path) return;
		try {
			const temp = `${this.options.path}.tmp`;
			await fs.writeFile(temp, JSON.stringify({ lastContactMs: this.lastContactMs }), { mode: 0o600 });
			await fs.rename(temp, this.options.path);
		} catch (error) {
			this.options.log?.('warn', `Could not record the control-plane contact time: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * May a workload with this TTL run right now? A clock that jumped backwards (contact "in the
	 * future") is not trusted either: the lease is only valid for a contact within the last TTL.
	 */
	valid(ttlSeconds: number): boolean {
		if (this.lastContactMs === null) return false;
		const age = this.now() - this.lastContactMs;
		return age >= -5_000 && age <= ttlSeconds * 1000;
	}

	/** Seconds since the control plane last answered; null when it never has. */
	silentSeconds(): number | null {
		return this.lastContactMs === null ? null : Math.max(0, Math.round((this.now() - this.lastContactMs) / 1000));
	}
}

/** The leased workloads in a desired state, and which of them this node must not run right now. */
export function leaseState(state: Pick<DesiredState, 'workloads'> | null, clock: RunLeaseClock): { leased: string[]; fenced: string[] } {
	const leased = (state?.workloads ?? []).filter((workload) => workload.runLease && workload.status !== 'stopped');
	return {
		leased: leased.map((workload) => workload.id),
		fenced: leased.filter((workload) => !clock.valid(workload.runLease!.ttlSeconds)).map((workload) => workload.id),
	};
}
