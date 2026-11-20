/**
 * Probe state, quorum and hold-down for `dns-failover` (CLUSTERING §7.2, HA-PLAN H18).
 *
 * The rules this encodes, in the order they matter:
 *
 * 1. A node is withdrawn only after the primary's probe has failed for the hold-down.
 * 2. The hold-down doubles (`single-witness`) unless a probe from another zone also failed, or the
 *    node's replicated status has said `offline` for two minutes. A false removal costs capacity,
 *    so an uncorroborated failure waits longer.
 * 3. A success in the ten seconds before the first failure starts the streak again: a flapping
 *    probe cannot accumulate failures across a recent success.
 * 4. A recovered node is added back only after `readdHoldDownMs` of consecutive primary successes.
 * 5. The last healthy record is never withdrawn (`minHealthy`), whatever the probes say.
 *
 * The class is pure: the caller supplies probe reports, node status and the clock. That is what
 * makes hold-down and quorum testable without a network or a real zone.
 */

export interface DnsFailoverNode {
	id: string;
	name: string;
	zone: string;
	/** Public address the record set would carry. */
	address: string;
	/** The replicated node status (`online`, `offline`, `draining`, ...). */
	status: string;
	/** When the row first said `offline`; null while it is not offline. */
	offlineSince: number | null;
}

export interface ProbeObservation {
	nodeId: string;
	observerId: string;
	observerZone: string;
	ok: boolean;
	at: number;
	reason: 'ok' | 'http-status' | 'timeout' | 'error';
}

export interface DnsFailoverHealthPolicy {
	holdDownMs: number;
	readdHoldDownMs: number;
	minHealthy: number;
	/** A probe older than this is not evidence in either direction. */
	staleAfterMs: number;
	/** A success this close before a failure restarts the failure streak. */
	successGraceMs: number;
	/** How recent another zone's failure must be to corroborate the primary. */
	corroborationWindowMs: number;
	/** A replicated `offline` status this old corroborates without a second probe. */
	offlineCorroborationMs: number;
}

export const DNS_FAILOVER_HEALTH_DEFAULTS: DnsFailoverHealthPolicy = {
	holdDownMs: 45_000,
	readdHoldDownMs: 120_000,
	minHealthy: 1,
	staleAfterMs: 60_000,
	successGraceMs: 10_000,
	corroborationWindowMs: 60_000,
	offlineCorroborationMs: 120_000,
};

export type RemovalWitness = 'quorum' | 'offline' | 'single-witness';

export interface DnsFailoverRemoval {
	nodeId: string;
	failedSince: number;
	holdDownMs: number;
	witness: RemovalWitness;
	reason: string;
}

export interface DnsFailoverAddition {
	nodeId: string;
	healthySince: number;
	reason: string;
}

export interface ProbeDisagreement {
	nodeId: string;
	/** The primary saw the opposite of these observers. */
	observers: string[];
}

export interface DnsFailoverDecision {
	remove: DnsFailoverRemoval[];
	add: DnsFailoverAddition[];
	keep: string[];
	/** Nodes whose primary probe currently succeeds. */
	healthy: string[];
	/** Removals refused to protect the last healthy record. */
	lastHealthyRefused: string[];
	singleWitness: boolean;
	disagreements: ProbeDisagreement[];
}

export class DnsFailoverHealth {
	readonly policy: DnsFailoverHealthPolicy;
	#reports = new Map<string, Map<string, ProbeObservation>>();
	#failedSince = new Map<string, number>();
	#healthySince = new Map<string, number>();
	#lastSuccessAt = new Map<string, number>();
	#offlineSince = new Map<string, number>();

	constructor(policy: Partial<DnsFailoverHealthPolicy> = {}) {
		this.policy = { ...DNS_FAILOVER_HEALTH_DEFAULTS, ...policy };
	}

	observe(observation: ProbeObservation): void {
		let observers = this.#reports.get(observation.nodeId);
		if (!observers) {
			observers = new Map();
			this.#reports.set(observation.nodeId, observers);
		}
		observers.set(observation.observerId, observation);
		if (observation.observerId !== this.primaryObserverId) return;
		if (observation.ok) {
			this.#failedSince.delete(observation.nodeId);
			this.#lastSuccessAt.set(observation.nodeId, observation.at);
			if (!this.#healthySince.has(observation.nodeId)) this.#healthySince.set(observation.nodeId, observation.at);
			return;
		}
		this.#healthySince.delete(observation.nodeId);
		if (this.#failedSince.has(observation.nodeId)) return;
		const lastSuccess = this.#lastSuccessAt.get(observation.nodeId);
		// A success within the grace window pushes the streak forward; failures that began before
		// that success do not count toward the hold-down.
		const start = lastSuccess !== undefined && observation.at - lastSuccess <= this.policy.successGraceMs ? lastSuccess + this.policy.successGraceMs : observation.at;
		this.#failedSince.set(observation.nodeId, Math.max(observation.at, start));
	}

	/** Set the primary observer once; reports from any other id are corroboration only. */
	setPrimaryObserver(observerId: string, observerZone: string): void {
		this.primaryObserverId = observerId;
		this.primaryObserverZone = observerZone;
	}

	primaryObserverId = '';
	primaryObserverZone = '';

	/** Derived on every apply from the node row: null clears a previous offline start. */
	observeNodeStatus(nodeId: string, offlineSince: number | null): void {
		if (offlineSince === null) this.#offlineSince.delete(nodeId);
		else this.#offlineSince.set(nodeId, offlineSince);
	}

	/** Forget a node that is no longer an ingress, so its streak cannot be resurrected. */
	forget(nodeId: string): void {
		this.#reports.delete(nodeId);
		this.#failedSince.delete(nodeId);
		this.#healthySince.delete(nodeId);
		this.#lastSuccessAt.delete(nodeId);
		this.#offlineSince.delete(nodeId);
	}

	decision(nodes: readonly DnsFailoverNode[], records: readonly string[], now: number): DnsFailoverDecision {
		const known = new Set(nodes.map((node) => node.id));
		const current = records.filter((id) => known.has(id));
		const healthy: string[] = [];
		const candidates: DnsFailoverRemoval[] = [];
		let singleWitness = false;

		for (const node of nodes) {
			const primary = this.#latestPrimary(node.id);
			if (!primary) continue;
			if (primary.ok) {
				if (now - primary.at <= this.policy.staleAfterMs) healthy.push(node.id);
				continue;
			}
			if (now - primary.at > this.policy.staleAfterMs) continue;
			const failedSince = this.#failedSince.get(node.id);
			if (failedSince === undefined) continue;
			const quorum = this.#corroboratingFailure(node.id, now);
			const offline = this.#offlineSince.get(node.id);
			const offlineCorroborated = offline !== undefined && now - offline >= this.policy.offlineCorroborationMs;
			const witness: RemovalWitness = quorum !== null ? 'quorum' : offlineCorroborated ? 'offline' : 'single-witness';
			const holdDownMs = witness === 'single-witness' ? this.policy.holdDownMs * 2 : this.policy.holdDownMs;
			if (witness === 'single-witness') singleWitness = true;
			if (now - failedSince < holdDownMs) continue;
			candidates.push({
				nodeId: node.id,
				failedSince,
				holdDownMs,
				witness,
				reason:
					witness === 'single-witness'
						? `No corroborating probe from another zone; failed for ${Math.round((now - failedSince) / 1000)}s (single-witness hold-down ${Math.round(holdDownMs / 1000)}s).`
						: witness === 'offline'
							? `Probe failed for ${Math.round((now - failedSince) / 1000)}s and the node has been offline for ${Math.round((now - (offline ?? now)) / 1000)}s.`
							: `Probe failed for ${Math.round((now - failedSince) / 1000)}s and ${quorum} corroborates from another zone.`,
			});
		}

		candidates.sort((left, right) => left.failedSince - right.failedSince);
		const accepted: DnsFailoverRemoval[] = [];
		const lastHealthyRefused: string[] = [];
		for (const candidate of candidates) {
			const remaining = current.filter((id) => id !== candidate.nodeId && !accepted.some((removal) => removal.nodeId === id));
			const healthyRemaining = remaining.filter((id) => healthy.includes(id));
			if (remaining.length < this.policy.minHealthy || healthyRemaining.length < this.policy.minHealthy) {
				lastHealthyRefused.push(candidate.nodeId);
				continue;
			}
			accepted.push(candidate);
		}

		const removed = new Set(accepted.map((removal) => removal.nodeId));
		const add: DnsFailoverAddition[] = [];
		for (const node of nodes) {
			if (current.includes(node.id)) continue;
			const primary = this.#latestPrimary(node.id);
			if (!primary?.ok) continue;
			if (this.#offlineSince.has(node.id)) continue;
			const healthySince = this.#healthySince.get(node.id);
			if (healthySince === undefined || now - healthySince < this.policy.readdHoldDownMs) continue;
			add.push({
				nodeId: node.id,
				healthySince,
				reason: `Healthy for ${Math.round((now - healthySince) / 1000)}s; adding it back to the record set.`,
			});
		}

		return {
			remove: accepted,
			add,
			keep: current.filter((id) => !removed.has(id)),
			healthy,
			lastHealthyRefused,
			singleWitness,
			disagreements: this.#disagreements(nodes, now),
		};
	}

	#latestPrimary(nodeId: string): ProbeObservation | null {
		return this.#reports.get(nodeId)?.get(this.primaryObserverId) ?? null;
	}

	#corroboratingFailure(nodeId: string, now: number): string | null {
		const observers = this.#reports.get(nodeId);
		if (!observers) return null;
		for (const report of observers.values()) {
			if (report.observerId === this.primaryObserverId) continue;
			if (report.observerZone === this.primaryObserverZone) continue;
			if (report.ok) continue;
			if (now - report.at > this.policy.corroborationWindowMs) continue;
			return report.observerId;
		}
		return null;
	}

	#disagreements(nodes: readonly DnsFailoverNode[], now: number): ProbeDisagreement[] {
		const result: ProbeDisagreement[] = [];
		for (const node of nodes) {
			const primary = this.#latestPrimary(node.id);
			if (!primary || now - primary.at > this.policy.staleAfterMs) continue;
			const opposing: string[] = [];
			for (const report of this.#reports.get(node.id)?.values() ?? []) {
				if (report.observerId === this.primaryObserverId || report.observerZone === this.primaryObserverZone) continue;
				if (now - report.at > this.policy.staleAfterMs) continue;
				if (report.ok !== primary.ok) opposing.push(report.observerId);
			}
			if (opposing.length) result.push({ nodeId: node.id, observers: opposing });
		}
		return result;
	}
}
