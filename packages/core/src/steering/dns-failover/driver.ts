import type { SteeringDriver } from '@yoal/contracts';
import {
	DnsProviderError,
	isDnsName,
	normalizeDnsName,
	type DnsProvider,
	type DnsRecordInput,
	type DnsRecordType,
} from '../dns/provider.ts';
import {
	DnsFailoverHealth,
	type DnsFailoverHealthPolicy,
	type DnsFailoverNode,
	type ProbeObservation,
} from './health.ts';
import type { IngressProber } from './probe.ts';

/**
 * The `dns-failover` steering driver (HA-PLAN H18, CLUSTERING §7.2).
 *
 * One pass (`apply`) probes the ingress set, asks `DnsFailoverHealth` what should leave or rejoin
 * the records, persists the intended set, and then reconciles the provider to it. Every write is
 * guarded by the controller lease, and every provider change is recorded as a `failover_events`
 * row by the caller.
 *
 * The contract's `desired()` is implemented too, but it runs read-only: a driver that wrote without
 * a lease would violate H18. The failover controller calls `apply({ epoch, holds })` while it holds
 * the lease, which is the only path that can change a record.
 */

export interface DnsFailoverRecordTarget {
	/** Apex, wildcard or platform host. */
	name: string;
	/** Sixty seconds in the reference fleet; proxied names use Cloudflare's automatic TTL 1. */
	ttl: number;
	proxied: boolean;
}

export interface DnsFailoverState {
	/** Node ids in the intended record set; null before the first pass adopts the fleet. */
	records: string[] | null;
	/** Node id → withdrawal times inside the flap window. */
	withdrawals: Record<string, number[]>;
	pinnedUntil: Record<string, number>;
	lastAddAt: Record<string, number>;
}

export interface DnsFailoverStateStore {
	load(): DnsFailoverState;
	save(state: DnsFailoverState): void;
}

export interface DnsFailoverLease {
	/** The controller lease epoch the decision is made under (the fencing token). */
	epoch: number;
	holds(): boolean;
}

export interface DnsFailoverEvent {
	action: 'remove' | 'add' | 'update';
	status: 'completed' | 'failed';
	nodeId: string | null;
	nodeName: string | null;
	recordName: string;
	recordType: DnsRecordType;
	content: string;
	reason: string;
	epoch: number;
	/** When the decision was made (the first failed probe or the re-add hold-down start). */
	detectedAt: number;
	/** When the provider accepted the change; null for a failed attempt. */
	appliedAt: number | null;
}

export interface DnsFailoverAlert {
	key: string;
	title: string;
	detail: string;
	severity: 'info' | 'warning' | 'critical';
}

export interface DnsFailoverReport {
	fenced: boolean;
	probed: number;
	withdrawn: string[];
	added: string[];
	written: number;
	failed: number;
	/** The intended record set after the pass. */
	records: string[];
	alerts: DnsFailoverAlert[];
}

export interface DnsFailoverDriverOptions {
	/** Null when the install has no provider configured: preflight refuses, apply writes nothing. */
	provider: DnsProvider | null;
	nodes: () => DnsFailoverNode[];
	records: DnsFailoverRecordTarget[];
	prober: IngressProber;
	observer: { id: string; zone: string };
	now: () => number;
	state: DnsFailoverStateStore;
	onEvent: (event: DnsFailoverEvent) => void;
	health?: Partial<DnsFailoverHealthPolicy>;
	probeIntervalMs?: number;
	readdIntervalMs?: number;
	flapWindowMs?: number;
	pinnedMs?: number;
	/** Provider retries after a failure: 5 s, 15 s, 45 s, then every 60 s (CLUSTERING §7.2). */
	retryDelaysMs?: number[];
}

const RETRY_DEFAULTS = [5_000, 15_000, 45_000, 60_000];

export class DnsFailoverDriver implements SteeringDriver {
	readonly kind = 'dns-failover' as const;
	readonly capabilities = { probes: 'yoal' as const, writes: true, preservesClientIp: 'native' as const };

	readonly #options: Required<Pick<DnsFailoverDriverOptions, 'probeIntervalMs' | 'readdIntervalMs' | 'flapWindowMs' | 'pinnedMs' | 'retryDelaysMs'>> &
		DnsFailoverDriverOptions;
	readonly #health: DnsFailoverHealth;
	#lastProbeAt = Number.NEGATIVE_INFINITY;
	#lastProbeReports: ProbeObservation[] = [];
	#offlineSince = new Map<string, number>();
	#retryAt = 0;
	#retryIndex = 0;

	constructor(options: DnsFailoverDriverOptions) {
		this.#options = {
			...options,
			probeIntervalMs: options.probeIntervalMs ?? 10_000,
			readdIntervalMs: options.readdIntervalMs ?? 10 * 60_000,
			flapWindowMs: options.flapWindowMs ?? 30 * 60_000,
			pinnedMs: options.pinnedMs ?? 30 * 60_000,
			retryDelaysMs: options.retryDelaysMs ?? RETRY_DEFAULTS,
		};
		this.#health = new DnsFailoverHealth(options.health);
		this.#health.setPrimaryObserver(options.observer.id, options.observer.zone);
	}

	/** Sync and read-only: enough to refuse a single ingress or a missing provider before enabling. */
	preflight(): Array<{ nodeId: string | null; reason: string }> {
		const findings: Array<{ nodeId: string | null; reason: string }> = [];
		const nodes = this.#options.nodes();
		if (!this.#options.provider) {
			findings.push({
				nodeId: null,
				reason: 'No DNS provider is configured. Set YOAL_CLOUDFLARE_API_TOKEN and YOAL_CLOUDFLARE_ZONE_ID or YOAL_CLOUDFLARE_ZONE_NAME.',
			});
		}
		if (nodes.length < 2) {
			for (const node of nodes) findings.push({ nodeId: node.id, reason: 'dns-failover needs at least two ingress nodes; one ingress keeps `direct`.' });
			if (!nodes.length) findings.push({ nodeId: null, reason: 'There are no ingress nodes.' });
		}
		for (const node of nodes)
			if (!node.address.trim()) findings.push({ nodeId: node.id, reason: 'The node has no public address to put in a record.' });
		for (const node of nodes)
			if (node.status !== 'online') findings.push({ nodeId: node.id, reason: `The node is ${node.status}; converge it before enabling dns-failover.` });
		if (!this.#options.records.length) findings.push({ nodeId: null, reason: 'No managed record names are configured for the DNS driver.' });
		for (const target of this.#options.records)
			if (!isDnsName(target.name)) findings.push({ nodeId: null, reason: `The managed record name "${target.name}" is not a hostname.` });
		return findings;
	}

	/** Read-only view for the dashboard and `yoal ha status`; never writes. */
	async observe(): Promise<Record<string, unknown>> {
		const nodes = this.#options.nodes();
		const records = this.#options.state.load().records ?? [];
		if (!this.#options.provider) return { provider: null, nodes: nodes.map((node) => node.id), records };
		const observed: Record<string, Array<{ id: string; type: string; content: string; ttl: number; proxied: boolean }>> = {};
		try {
			for (const target of this.#options.records)
				observed[normalizeDnsName(target.name)] = (await this.#options.provider.listRecords(target.name)).map((record) => ({
					id: record.id,
					type: record.type,
					content: record.content,
					ttl: record.ttl,
					proxied: record.proxied,
				}));
		} catch (error) {
			return { provider: this.#options.provider.kind, nodes: nodes.map((node) => node.id), records, error: message(error) };
		}
		return { provider: this.#options.provider.kind, nodes: nodes.map((node) => node.id), records, observed };
	}

	/** Contract path: probes and decides, but a write needs a lease, so this one is read-only. */
	async desired(): Promise<void> {
		await this.apply({ epoch: 0, holds: () => false });
	}

	async apply(lease: DnsFailoverLease): Promise<DnsFailoverReport> {
		const now = this.#options.now();
		const alerts: DnsFailoverAlert[] = [];
		const report: DnsFailoverReport = { fenced: false, probed: 0, withdrawn: [], added: [], written: 0, failed: 0, records: [], alerts };
		if (!lease.holds()) return { ...report, fenced: true };

		const nodes = this.#options.nodes();
		const known = new Set(nodes.map((node) => node.id));
		const state = normalizeState(this.#options.state.load());
		// A node that leaves the ingress set must not be re-added from an old streak.
		for (const id of [...this.#offlineSince.keys()]) if (!known.has(id)) this.#offlineSince.delete(id);
		for (const id of [...(state.records ?? [])]) if (!known.has(id)) state.records = state.records?.filter((candidate) => candidate !== id) ?? null;

		await this.#probe(nodes, now, report);

		for (const node of nodes) {
			if (node.status === 'offline') {
				if (!this.#offlineSince.has(node.id)) this.#offlineSince.set(node.id, node.offlineSince ?? now);
			} else this.#offlineSince.delete(node.id);
			this.#health.observeNodeStatus(node.id, this.#offlineSince.get(node.id) ?? node.offlineSince ?? null);
		}

		if (nodes.length < 2) {
			report.records = state.records ?? nodes.map((node) => node.id);
			alerts.push({
				key: 'steering:dns-failover:one-ingress',
				title: 'dns-failover needs a second ingress',
				detail: 'The driver writes nothing with one ingress. Add a second node or switch the driver to `direct`.',
				severity: 'warning',
			});
			return report;
		}
		if (!this.#options.provider) {
			report.records = state.records ?? nodes.map((node) => node.id);
			alerts.push({
				key: 'steering:dns-failover:no-provider',
				title: 'dns-failover has no DNS provider',
				detail: 'The driver is selected but no Cloudflare token and zone are configured, so it is not changing any record. Set YOAL_CLOUDFLARE_API_TOKEN and a zone, or switch the driver to `direct`.',
				severity: 'critical',
			});
			return report;
		}

		if (state.records === null || state.records.length === 0) {
			// Adopt the fleet as the initial set. It is never empty, so the first pass cannot remove
			// the only record before a decision has been made.
			state.records = nodes.map((node) => node.id);
			if (!this.#save(lease, state)) return { ...report, fenced: true };
		}

		const decision = this.#health.decision(nodes, state.records, now);
		for (const nodeId of decision.lastHealthyRefused) {
			const node = nodes.find((candidate) => candidate.id === nodeId);
			alerts.push({
				key: `steering:dns-failover:last-healthy:${nodeId}`,
				title: `Refused to withdraw ${node?.name ?? nodeId}`,
				detail: 'It would leave no healthy record. The last healthy ingress is never removed.',
				severity: 'critical',
			});
		}
		for (const disagreement of decision.disagreements) {
			const node = nodes.find((candidate) => candidate.id === disagreement.nodeId);
			alerts.push({
				key: `steering:dns-failover:probe:${disagreement.nodeId}`,
				title: `Probes disagree about ${node?.name ?? disagreement.nodeId}`,
				detail: `The primary observer and ${disagreement.observers.join(', ')} disagree for 60 s. The primary's result decides; this is an alert about the vantage point, not an automatic removal.`,
				severity: 'warning',
			});
		}
		if (decision.singleWitness)
			alerts.push({
				key: 'steering:dns-failover:single-witness',
				title: 'dns-failover is running single-witness',
				detail: 'No probe from another zone corroborated the primary. The hold-down is doubled until a second vantage point reports.',
				severity: 'warning',
			});

		let changed = false;
		for (const removal of decision.remove) {
			const index = state.records.indexOf(removal.nodeId);
			if (index === -1) continue;
			state.records.splice(index, 1);
			const times = [...(state.withdrawals[removal.nodeId] ?? []), now].filter((at) => now - at < this.#options.flapWindowMs);
			state.withdrawals[removal.nodeId] = times;
			const pinned = times.length >= 2;
			if (pinned) state.pinnedUntil[removal.nodeId] = now + this.#options.pinnedMs;
			changed = true;
			report.withdrawn.push(removal.nodeId);
			const node = nodes.find((candidate) => candidate.id === removal.nodeId);
			alerts.push({
				key: `steering:dns-failover:withdraw:${removal.nodeId}`,
				title: `Withdraw ingress ${node?.name ?? removal.nodeId}`,
				detail:
					`${removal.reason} It will not be re-added for at least ${Math.round(this.#options.health?.readdHoldDownMs ?? 120_000) / 1000}s.` +
					(pinned ? ` Withdrawn twice in 30 minutes: it stays out until ${new Date(now + this.#options.pinnedMs).toISOString()}.` : ''),
				severity: 'warning',
			});
			if (pinned)
				alerts.push({
					key: `steering:dns-failover:pinned:${removal.nodeId}`,
					title: `Pinned ingress ${node?.name ?? removal.nodeId} out of rotation`,
					detail: 'Two withdrawals inside 30 minutes. It is not re-added until the pin expires, even if its probes recover.',
					severity: 'warning',
				});
		}
		for (const addition of decision.add) {
			if (state.records.includes(addition.nodeId)) continue;
			const pinnedUntil = state.pinnedUntil[addition.nodeId] ?? 0;
			if (pinnedUntil > now) continue;
			const lastAdd = state.lastAddAt[addition.nodeId];
			if (lastAdd !== undefined && now - lastAdd < this.#options.readdIntervalMs) continue;
			state.records.push(addition.nodeId);
			state.lastAddAt[addition.nodeId] = now;
			changed = true;
			report.added.push(addition.nodeId);
			const node = nodes.find((candidate) => candidate.id === addition.nodeId);
			alerts.push({
				key: `steering:dns-failover:readd:${addition.nodeId}`,
				title: `Re-add ingress ${node?.name ?? addition.nodeId}`,
				detail: addition.reason,
				severity: 'info',
			});
		}
		report.records = [...state.records];
		if (changed && !this.#save(lease, state)) return { ...report, fenced: true };

		if (now < this.#retryAt) return report;
		if (!(await this.#reconcile(lease, nodes, state.records, now, report, alerts))) return { ...report, fenced: true };
		return report;
	}

	async #probe(nodes: DnsFailoverNode[], now: number, report: DnsFailoverReport): Promise<void> {
		if (now - this.#lastProbeAt < this.#options.probeIntervalMs && this.#lastProbeReports.length) return;
		this.#lastProbeReports = await this.#options.prober.probe(nodes, now);
		this.#lastProbeAt = now;
		report.probed = this.#lastProbeReports.length;
		for (const observation of this.#lastProbeReports) this.#health.observe(observation);
	}

	#save(lease: DnsFailoverLease, state: DnsFailoverState): boolean {
		if (!lease.holds()) return false;
		this.#options.state.save(state);
		return true;
	}

	async #reconcile(
		lease: DnsFailoverLease,
		nodes: DnsFailoverNode[],
		records: string[],
		now: number,
		report: DnsFailoverReport,
		alerts: DnsFailoverAlert[],
	): Promise<boolean> {
		const provider = this.#options.provider;
		if (!provider) return true;
		const byId = new Map(nodes.map((node) => [node.id, node]));
		const desired = records
			.map((id) => byId.get(id))
			.filter((node): node is DnsFailoverNode => node !== undefined && node.address.trim().length > 0)
			.map((node) => ({ node, type: recordType(node.address), content: node.address.trim() }));
		// A set with no address is a preflight failure, not an instruction to empty every managed
		// name. Refusing here is the provider-level half of "never remove the last healthy record".
		if (!desired.length) {
			alerts.push({
				key: 'steering:dns-failover:no-address',
				title: 'No ingress address to publish',
				detail: 'Every ingress in the set has an empty public address. The record set is left untouched; fix the node addresses before enabling dns-failover.',
				severity: 'critical',
			});
			return true;
		}
		const decidedAt = now;
		let failure: unknown = null;

		for (const target of this.#options.records) {
			const name = normalizeDnsName(target.name);
			let observed;
			try {
				observed = await provider.listRecords(name);
			} catch (error) {
				failure = error;
				report.failed += 1;
				continue;
			}
			const ttl = target.proxied ? 1 : target.ttl;
			for (const entry of desired) {
				const match = observed.find((record) => record.content === entry.content && record.type === entry.type);
				if (!match) {
					if (!lease.holds()) return false;
					try {
						const created = await provider.createRecord({ name, type: entry.type, content: entry.content, ttl, proxied: target.proxied });
						report.written += 1;
						this.#event(lease, {
							action: 'add',
							status: 'completed',
							nodeId: entry.node.id,
							nodeName: entry.node.name,
							recordName: created.name,
							recordType: entry.type,
							content: entry.content,
							reason: `Added ${entry.node.name} to ${name} (${entry.type} ${entry.content}).`,
							epoch: lease.epoch,
							detectedAt: decidedAt,
							appliedAt: now,
						});
					} catch (error) {
						failure = error;
						report.failed += 1;
						this.#failedEvent(lease, entry.node, name, entry.type, entry.content, error, lease.epoch, decidedAt);
					}
					continue;
				}
				if (match.proxied !== target.proxied) {
					report.failed += 1;
					this.#event(lease, {
						action: 'update',
						status: 'failed',
						nodeId: entry.node.id,
						nodeName: entry.node.name,
						recordName: name,
						recordType: entry.type,
						content: entry.content,
						reason: `Refused to change the proxy state of ${name}: found ${match.proxied ? 'proxied' : 'DNS-only'}, the plan says ${target.proxied ? 'proxied' : 'DNS-only'}. Nothing was written.`,
						epoch: lease.epoch,
						detectedAt: decidedAt,
						appliedAt: null,
					});
					alerts.push({
						key: `steering:dns-failover:proxy:${name}`,
						title: `Proxy state differs for ${name}`,
						detail: `Found ${match.proxied ? 'proxied' : 'DNS-only'}, the plan says ${target.proxied ? 'proxied' : 'DNS-only'}. dns-failover never flips a name's proxy state; fix the record or the plan.`,
						severity: 'critical',
					});
					continue;
				}
				if (match.ttl !== ttl) {
					if (!lease.holds()) return false;
					try {
						const updated = await provider.updateRecord(match.id, {
							name,
							type: entry.type,
							content: entry.content,
							ttl,
							proxied: target.proxied,
						});
						report.written += 1;
						this.#event(lease, {
							action: 'update',
							status: 'completed',
							nodeId: entry.node.id,
							nodeName: entry.node.name,
							recordName: updated.name,
							recordType: entry.type,
							content: entry.content,
							reason: `Set TTL ${ttl}s on ${name} ${entry.type} ${entry.content}.`,
							epoch: lease.epoch,
							detectedAt: decidedAt,
							appliedAt: now,
						});
					} catch (error) {
						failure = error;
						report.failed += 1;
						this.#failedEvent(lease, entry.node, name, entry.type, entry.content, error, lease.epoch, decidedAt);
					}
				}
			}
			// A record whose address is not in the intended set is a withdrawal, or drift left by an
			// earlier failed pass. Removing it is what makes the reconcile idempotent.
			const keep = new Set(desired.map((entry) => entry.content));
			for (const record of observed) {
				if (keep.has(record.content)) continue;
				if (!lease.holds()) return false;
				const owner = nodes.find((node) => node.address.trim() === record.content);
				try {
					await provider.deleteRecord(record.id);
					report.written += 1;
					this.#event(lease, {
						action: 'remove',
						status: 'completed',
						nodeId: owner?.id ?? null,
						nodeName: owner?.name ?? null,
						recordName: name,
						recordType: record.type,
						content: record.content,
						reason: owner
							? `Removed ${owner.name} (${record.type} ${record.content}) from ${name}.`
							: `Removed ${record.type} ${record.content} from ${name}: it does not belong to an ingress in the set.`,
						epoch: lease.epoch,
						detectedAt: decidedAt,
						appliedAt: now,
					});
				} catch (error) {
					failure = error;
					report.failed += 1;
					this.#event(lease, {
						action: 'remove',
						status: 'failed',
						nodeId: owner?.id ?? null,
						nodeName: owner?.name ?? null,
						recordName: name,
						recordType: record.type,
						content: record.content,
						reason: `Could not remove ${record.type} ${record.content} from ${name}: ${message(error)}`,
						epoch: lease.epoch,
						detectedAt: decidedAt,
						appliedAt: null,
					});
				}
			}
		}

		if (failure) {
			const retryable = failure instanceof DnsProviderError ? failure.retryable : true;
			const delay = retryable ? (this.#options.retryDelaysMs[Math.min(this.#retryIndex, this.#options.retryDelaysMs.length - 1)] ?? 60_000) : 60_000;
			this.#retryIndex = retryable ? this.#retryIndex + 1 : 0;
			this.#retryAt = now + delay;
			alerts.push({
				key: 'steering:dns-failover:api',
				title: 'DNS provider write failed',
				detail: `${message(failure)} The record set was left as it was; retrying in ${Math.round(delay / 1000)}s. Sites keep serving from the records the provider still has.`,
				severity: 'critical',
			});
		} else {
			this.#retryIndex = 0;
			this.#retryAt = 0;
		}
		return true;
	}

	#failedEvent(
		lease: DnsFailoverLease,
		node: DnsFailoverNode,
		name: string,
		type: DnsRecordType,
		content: string,
		error: unknown,
		epoch: number,
		detectedAt: number,
	): void {
		this.#event(lease, {
			action: 'update',
			status: 'failed',
			nodeId: node.id,
			nodeName: node.name,
			recordName: name,
			recordType: type,
			content,
			reason: `DNS write failed for ${node.name} on ${name}: ${message(error)}`,
			epoch,
			detectedAt,
			appliedAt: null,
		});
	}

	#event(_lease: DnsFailoverLease, event: DnsFailoverEvent): void {
		// A completed provider write must be recorded even if the lease was lost while the API call
		// was in flight: the row describes what happened, it does not make a decision.
		this.#options.onEvent(event);
	}
}

function normalizeState(state: DnsFailoverState): DnsFailoverState {
	return {
		records: state.records ? [...state.records] : null,
		withdrawals: Object.fromEntries(Object.entries(state.withdrawals ?? {}).map(([id, times]) => [id, [...times]])),
		pinnedUntil: { ...(state.pinnedUntil ?? {}) },
		lastAddAt: { ...(state.lastAddAt ?? {}) },
	};
}

export function emptyDnsFailoverState(): DnsFailoverState {
	return { records: null, withdrawals: {}, pinnedUntil: {}, lastAddAt: {} };
}

function recordType(address: string): DnsRecordType {
	return address.includes(':') ? 'AAAA' : 'A';
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
