import { isIP } from 'node:net';
import type { SteeringCapabilities, SteeringDriver } from '@yoal/contracts';
import { ingressNodes, isDraining, isHealthy } from '../snapshot.ts';
import type { SteeringDriverContext, SteeringFinding, SteeringNode } from '../types.ts';

/**
 * `vip` (HA-PLAN H18, W8): keepalived owns one floating address and moves it between ingress
 * nodes by VRRP. Yoal is the only thing that changes a node's priority: it probes the ingress set
 * itself (`probes: 'yoal'`), lowers the priority of a node that is failing, draining or no longer
 * an ingress, and lets keepalived fail over in the 3–5 s VRRP bound.
 *
 * The driver never runs a command. It hands a validated structured state to `VipControl`, whose
 * production implementation is the helper's fixed `install`/`configure`/`start`/`stop` verbs. The
 * helper renders the only configuration keepalived sees; there are no script or notify hooks.
 *
 * One floating address, one VRRP instance. The address is bound on the current master; a second
 * address would be a second driver or a stacked one, not a list here.
 */

export interface VipConfig {
	/** The floating address. IPv4 or IPv6. */
	address: string;
	/** The shared L2 interface every ingress has. */
	interface: string;
	/** VRRP virtual router id, unique on the segment. */
	routerId: number;
	/** keepalived PASS authentication: 1–8 letters, digits, dots, dashes or underscores. */
	authPass: string;
	/** VRRP advertisement interval in seconds (1–10; 1 is the 3–5 s failover bound). */
	advertInterval: number;
	/** Fixed instance name. */
	instance: string;
}

/** The structured state one node's keepalived receives. It contains the VRRP secret. */
export interface VipNodeState {
	instance: string;
	state: 'MASTER' | 'BACKUP';
	interface: string;
	virtualRouterId: number;
	priority: number;
	advertInterval: number;
	localAddress: string;
	unicastPeers: string[];
	virtualAddress: string;
	authPass: string;
}

export interface VipControlStatus {
	running: boolean;
	interface: string | null;
	virtualAddress: string | null;
	addressPresent: boolean;
}

/**
 * The privileged side: the helper verbs, one call per ingress node. A fake in tests counts calls,
 * so "writes nothing the second time" and "never withdraws the last healthy node" are checkable
 * without keepalived or a network.
 */
export interface VipControl {
	/** False when no helper transport reaches this node (preflight refuses rather than silently steering nothing). */
	available?(nodeId: string): boolean;
	configure(nodeId: string, state: VipNodeState): Promise<{ changed: boolean }>;
	start(nodeId: string): Promise<void>;
	stop(nodeId: string): Promise<void>;
	status(nodeId: string): Promise<VipControlStatus>;
}

export interface VipDriverOptions {
	config: VipConfig | null;
	control: VipControl;
	/** The node's address on the shared segment, or null when it has none. */
	addressOf?: (node: SteeringNode) => string | null;
	/** The node Yoal prefers as master while it is healthy. */
	preferredNodeId?: string | null;
}

export const VIP_MASTER_PRIORITY = 150;
export const VIP_BACKUP_PRIORITY = 100;
export const VIP_INSTANCE = 'YOAL';

export interface VipReport {
	withdrawn: string[];
	added: string[];
	/** The intended serving set after the pass. Never empty while a previous one was. */
	records: string[];
	holder: string | null;
	writes: number;
	error: string | null;
}

const INTERFACE_PATTERN = /^[A-Za-z0-9_.:-]{1,15}$/;
const AUTH_PATTERN = /^[A-Za-z0-9._-]{1,8}$/;
const INSTANCE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

/** Validate a config once, for preflight and before every write. */
export function vipConfigFindings(config: VipConfig | null): string[] {
	if (!config) return ['The vip driver has no floating address. Set YOAL_VIP_ADDRESS (and YOAL_VIP_INTERFACE) before enabling it.'];
	const findings: string[] = [];
	if (isIP(config.address) === 0) findings.push('The vip floating address is not an IP address.');
	if (!INTERFACE_PATTERN.test(config.interface)) findings.push('The vip interface name is not a valid interface name.');
	if (!Number.isInteger(config.routerId) || config.routerId < 1 || config.routerId > 255)
		findings.push('The VRRP virtual router id must be an integer between 1 and 255.');
	if (!AUTH_PATTERN.test(config.authPass)) findings.push('The VRRP authentication password must be 1 to 8 letters, digits, dots, dashes or underscores.');
	if (!Number.isInteger(config.advertInterval) || config.advertInterval < 1 || config.advertInterval > 10)
		findings.push('The VRRP advertisement interval must be an integer between 1 and 10 seconds.');
	if (!INSTANCE_PATTERN.test(config.instance)) findings.push('The VRRP instance name must be an upper-case identifier.');
	return findings;
}

export class VipDriver implements SteeringDriver {
	readonly kind = 'vip' as const;
	get capabilities(): SteeringCapabilities {
		return { probes: 'yoal', writes: true, preservesClientIp: 'native' };
	}

	readonly #options: VipDriverOptions;
	private readonly context: SteeringDriverContext;
	#serving: string[] | null = null;
	#master: string | null = null;
	/** Fingerprint of the state last accepted by each node's helper. */
	readonly #configured = new Map<string, string>();
	readonly #running = new Set<string>();
	#report: VipReport = { withdrawn: [], added: [], records: [], holder: null, writes: 0, error: null };

	constructor(context: SteeringDriverContext, options: VipDriverOptions) {
		this.context = context;
		this.#options = options;
	}

	preflight(): SteeringFinding[] {
		const findings: SteeringFinding[] = [];
		for (const reason of vipConfigFindings(this.#options.config)) findings.push({ nodeId: null, reason });
		const nodes = ingressNodes(this.context);
		if (nodes.length === 0) {
			findings.push({
				nodeId: null,
				reason: 'vip needs at least one ingress node: give a node the ingress role and an agent with the ingress-set capability first.',
			});
			return findings;
		}
		const seen = new Map<string, string>();
		for (const node of nodes) {
			if (!node.capable) {
				findings.push({
					nodeId: node.id,
					reason: `${node.name} cannot serve the ingress health endpoint: its agent does not advertise ingress-set, so Yoal cannot decide whether it may hold the floating address.`,
				});
				continue;
			}
			if (this.#options.control.available && !this.#options.control.available(node.id)) {
				findings.push({
					nodeId: node.id,
					reason: `${node.name} has no helper transport for keepalived; the vip driver cannot configure its VRRP instance.`,
				});
				continue;
			}
			const address = this.#address(node);
			if (address && seen.has(address)) {
				findings.push({ nodeId: node.id, reason: `${node.name} and ${seen.get(address)} share the address ${address}; VRRP needs one unique address per node.` });
				continue;
			}
			if (address) seen.set(address, node.name);
		}
		if (this.#options.config) {
			const address = this.#options.config.address;
			for (const node of nodes)
				if (this.#address(node) === address)
					findings.push({ nodeId: node.id, reason: `The floating address ${address} is also ${node.name}'s own address; the same address cannot be both the VIP and a node address.` });
		}
		return findings;
	}

	async desired(): Promise<void> {
		const now = this.context.now();
		const findings = vipConfigFindings(this.#options.config);
		if (findings.length > 0) {
			this.#report = { withdrawn: [], added: [], records: [...(this.#serving ?? [])], holder: this.#master, writes: 0, error: findings[0]! };
			return;
		}
		const config = this.#options.config!;
		const nodes = ingressNodes(this.context);
		const byId = new Map(nodes.map((node) => [node.id, node]));
		const eligible = nodes
			.filter((node) => node.capable && isHealthy(node, now) && !isDraining(node) && this.#address(node) !== null)
			.map((node) => node.id);

		const previous = this.#serving;
		// The last healthy ingress is never withdrawn. An empty eligible set keeps the previous
		// intent, and a first pass with no eligible node keeps the fleet's ingress ids, so keepalived
		// is never told to leave every node without the address.
		const next = eligible.length > 0 ? eligible : previous && previous.length > 0 ? previous.filter((id) => byId.has(id)) : nodes.map((node) => node.id);
		const serving = next.length > 0 ? next : (previous ?? []);
		this.#serving = serving;

		const master =
			this.#master && serving.includes(this.#master)
				? this.#master
				: this.#options.preferredNodeId && serving.includes(this.#options.preferredNodeId)
					? this.#options.preferredNodeId
					: serving[0]!;
		this.#master = master;

		const report: VipReport = { withdrawn: [], added: [], records: [...serving], holder: master, writes: 0, error: null };
		const family = isIP(config.address);
		const localAddresses = new Map(
			nodes.map((node) => [node.id, this.#address(node)]).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
		);

		for (const nodeId of serving) {
			const node = byId.get(nodeId);
			if (!node) continue;
			const localAddress = localAddresses.get(nodeId) ?? '';
			if (!localAddress) {
				// Kept in the intended set (never remove the last healthy ingress) but not configured:
				// next tick, when it has an address, it joins.
				report.error ??= `${node.name} has no address on the shared segment, so keepalived cannot be configured on it.`;
				continue;
			}
			const peers = serving
				.filter((id) => id !== nodeId)
				.map((id) => localAddresses.get(id) ?? '')
				.filter((peer) => peer.length > 0 && isIP(peer) === family && peer !== localAddress);
			const state: VipNodeState = {
				instance: config.instance,
				state: nodeId === master ? 'MASTER' : 'BACKUP',
				interface: config.interface,
				virtualRouterId: config.routerId,
				priority: nodeId === master ? VIP_MASTER_PRIORITY : VIP_BACKUP_PRIORITY,
				advertInterval: config.advertInterval,
				localAddress,
				unicastPeers: peers,
				virtualAddress: config.address,
				authPass: config.authPass,
			};
			const fingerprint = JSON.stringify(state);
			try {
				if (this.#configured.get(nodeId) !== fingerprint) {
					await this.#options.control.configure(nodeId, state);
					this.#configured.set(nodeId, fingerprint);
					report.writes += 1;
				}
				if (!this.#running.has(nodeId)) {
					await this.#options.control.start(nodeId);
					this.#running.add(nodeId);
					report.writes += 1;
				}
				if (!previous?.includes(nodeId)) report.added.push(nodeId);
			} catch (error) {
				this.#configured.delete(nodeId);
				report.error = message(error);
				break;
			}
		}

		// Withdraw nodes that are no longer intended, but only after a healthy target exists and no
		// configure failed. A stop is what proves the node is not the holder.
		if (report.error === null && serving.length > 0) {
			for (const nodeId of [...this.#running]) {
				if (serving.includes(nodeId)) continue;
				try {
					await this.#options.control.stop(nodeId);
					this.#running.delete(nodeId);
					this.#configured.delete(nodeId);
					report.withdrawn.push(nodeId);
					report.writes += 1;
				} catch (error) {
					report.error = message(error);
					break;
				}
			}
		}
		this.#report = report;
	}

	async observe(): Promise<Record<string, unknown>> {
		const now = this.context.now();
		const config = this.#options.config;
		const nodes = ingressNodes(this.context);
		const healthy = nodes.filter((node) => isHealthy(node, now)).map((node) => node.id);
		const serving = this.#serving ?? healthy;
		const statuses: Record<string, VipControlStatus | { error: string }> = {};
		let holder: string | null = null;
		for (const node of nodes) {
			try {
				const status = await this.#options.control.status(node.id);
				statuses[node.id] = status;
				if (!holder && (status.addressPresent || (status.running && node.id === this.#master))) holder = node.id;
			} catch (error) {
				statuses[node.id] = { error: message(error) };
			}
		}
		return {
			kind: this.kind,
			observedAt: now,
			provider: 'keepalived',
			probes: 'yoal',
			writes: true,
			clientIp: 'native',
			vip: config ? { address: config.address, interface: config.interface, routerId: config.routerId } : null,
			healthy,
			serving,
			holder,
			statuses,
			nodes: nodes.map((node) => ({
				id: node.id,
				name: node.name,
				zone: node.zone,
				status: node.status,
				healthy: isHealthy(node, now),
				draining: isDraining(node),
				capable: node.capable,
				address: this.#address(node),
				master: node.id === this.#master,
			})),
			total: nodes.length,
		};
	}

	/** The last apply's outcome, for status and the conformance last-healthy case. */
	report(): VipReport {
		return { ...this.#report, records: [...this.#report.records], withdrawn: [...this.#report.withdrawn], added: [...this.#report.added] };
	}

	#address(node: SteeringNode): string | null {
		return this.#options.addressOf?.(node) ?? node.address ?? null;
	}
}

export function createVipDriver(context: SteeringDriverContext, options: VipDriverOptions): SteeringDriver & { report(): VipReport } {
	return new VipDriver(context, options);
}

/** Parse the VRRP environment (used when the core adapter has no sealed settings document). */
export function vipConfigFromEnv(env: Record<string, string | undefined> = process.env): VipConfig | null {
	const address = env.YOAL_VIP_ADDRESS?.trim();
	if (!address) return null;
	const routerId = Number(env.YOAL_VIP_ROUTER_ID ?? 51);
	const advertInterval = Number(env.YOAL_VIP_ADVERT_INTERVAL ?? 1);
	return {
		address,
		interface: env.YOAL_VIP_INTERFACE?.trim() || 'eth0',
		routerId: Number.isInteger(routerId) ? routerId : 51,
		authPass: env.YOAL_VIP_AUTH_PASS?.trim() || 'yoalvrrp',
		advertInterval: Number.isInteger(advertInterval) ? advertInterval : 1,
		instance: 'YOAL',
	};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
