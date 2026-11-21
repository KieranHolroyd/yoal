import { nodeDrillLimits, type NodeOfflineDrillDesired } from '@yoal/contracts';

/**
 * The agent's half of a node offline drill (D235, `packages/contracts/src/node-drill.ts`).
 *
 * Pure state, so the rules are testable without a clock or a control plane:
 * - a drill is armed only from a freshly pulled desired state, never from the cached copy, so
 *   restarting the agent is a local way out;
 * - it ends at `endsAt`, or earlier when the cancel poll stops returning it, and is capped locally
 *   at the longest drill the control plane allows, so a skewed or stale `endsAt` cannot keep the
 *   node dark;
 * - an id that already ended is never armed again (the control plane's clock may still show it
 *   running for a moment after this node's clock ended it).
 */
export class OfflineDrill {
	#current: { id: string; until: number } | null = null;
	readonly #ended = new Set<string>();

	/** Arm the drill desired state carries; returns true when this call started it. */
	arm(drill: NodeOfflineDrillDesired | null | undefined, now: number): boolean {
		if (!drill || this.#ended.has(drill.id) || this.#current?.id === drill.id) return false;
		const until = Math.min(drill.endsAt, now + nodeDrillLimits.maxSeconds * 1000);
		if (until <= now) return false;
		this.#current = { id: drill.id, until };
		return true;
	}

	/**
	 * The cancel poll's answer. Returns true when it ended the drill: the control plane no longer
	 * lists it (cancelled or failed), or lists a different one.
	 */
	poll(drill: NodeOfflineDrillDesired | null, now: number): boolean {
		const current = this.#current;
		if (!current) return false;
		if (drill?.id === current.id) {
			// The end may only move earlier: a poll never extends the dark window.
			current.until = Math.min(current.until, drill.endsAt);
			return !this.active(now);
		}
		this.#end();
		return true;
	}

	/** Whether the node is dark right now; ends the drill once its time is up. */
	active(now: number): boolean {
		if (!this.#current) return false;
		if (now < this.#current.until) return true;
		this.#end();
		return false;
	}

	/** The running drill's id, for logs. */
	get id(): string | null {
		return this.#current?.id ?? null;
	}

	/** Milliseconds left, or 0 when not dark. */
	remainingMs(now: number): number {
		return this.#current ? Math.max(0, this.#current.until - now) : 0;
	}

	#end(): void {
		if (this.#current) this.#ended.add(this.#current.id);
		this.#current = null;
	}
}
