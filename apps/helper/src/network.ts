import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { defaultRunner, type CommandRunner } from './wireguard.ts';

/**
 * Overlay firewall (docs/CLUSTERING.md §4.1, phase C1).
 *
 * The helper owns one small firewall policy: the underlay WireGuard port and only the overlay
 * ports a node actually serves. It prefers the host's existing manager (ufw or firewalld) when one
 * is active, and otherwise writes a dedicated `inet yoal` nftables table. It never edits the
 * host's own filter table.
 */

/** One TCP port, or an inclusive `[from, to]` range. */
export type OverlayPort = number | readonly [number, number];

/**
 * Provider listeners another node dials over the overlay (docs/CLUSTERING.md §4.3): the agent
 * listens on the overlay address with the service's own host port, for cross-node database and
 * private-storage attachments and for read replicas streaming from their primary (C7). Each
 * listener requires a pinned client certificate, so opening the range on the overlay interface
 * exposes nothing without one. Mirrors `DATABASE_PORT_MIN/MAX` and `STORAGE_PORT_MIN/MAX`.
 */
export const OVERLAY_PROVIDER_PORTS: readonly OverlayPort[] = [
	[15432, 16431],
	[19000, 19999],
];

export interface NetworkPaths {
	interface: string;
	wireguardPort: number;
	/** TCP ports reachable over the overlay: Caddy 8080 plus the provider listener ranges. */
	overlayTcpPorts: OverlayPort[];
	nftPath: string;
	ufwPath: string;
	firewallCmdPath: string;
	configPath: string;
}

export const DEFAULT_NETWORK_PATHS: NetworkPaths = {
	interface: 'wg0',
	wireguardPort: 51820,
	overlayTcpPorts: [8080, ...OVERLAY_PROVIDER_PORTS],
	nftPath: 'nft',
	ufwPath: 'ufw',
	firewallCmdPath: 'firewall-cmd',
	configPath: '/etc/yoal/network/yoal.nft',
};

export type FirewallBackend = 'ufw' | 'firewalld' | 'nftables' | 'none';

export class NetworkManager {
	private readonly paths: NetworkPaths;
	private readonly runner: CommandRunner;

	constructor(options: { paths?: Partial<NetworkPaths>; runner?: CommandRunner } = {}) {
		this.paths = { ...DEFAULT_NETWORK_PATHS, ...options.paths };
		this.runner = options.runner ?? defaultRunner;
	}

	/**
	 * Open the underlay port and restrict overlay TCP to the served ports. Idempotent.
	 *
	 * `forwardCidrs` are routed prefixes behind this node (the Kubernetes machine supernet, docs/
	 * KUBERNETES.md §10): traffic from the overlay to a machine container is forwarded, not
	 * delivered locally, so it needs a forward allowance rather than an input port.
	 */
	async apply(options: { forwardCidrs?: string[] } = {}): Promise<{ backend: FirewallBackend; opened: number }> {
		const forward = (options.forwardCidrs ?? []).filter((cidr) => /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(cidr));
		const ufw = await this.runner([this.paths.ufwPath, 'status']);
		if (ufw.code === 0 && /Status:\s*active/i.test(ufw.stdout)) {
			await this.expect([this.paths.ufwPath, 'allow', `${this.paths.wireguardPort}/udp`], 'ufw allow wireguard');
			for (const cidr of forward)
				await this.expect(
					[this.paths.ufwPath, 'route', 'allow', 'in', 'on', this.paths.interface, 'to', cidr],
					'ufw route allow machines',
				);
			for (const port of this.paths.overlayTcpPorts)
				await this.expect(
					[this.paths.ufwPath, 'allow', 'in', 'on', this.paths.interface, 'to', 'any', 'port', portSpec(port, ':'), 'proto', 'tcp'],
					'ufw allow overlay',
				);
			await this.applyMachineNat(forward);
			return { backend: 'ufw', opened: 1 + this.paths.overlayTcpPorts.length };
		}

		const firewalld = await this.runner([this.paths.firewallCmdPath, '--state']);
		if (firewalld.code === 0 && /^running\s*$/i.test(firewalld.stdout.trim())) {
			await this.expect(
				[this.paths.firewallCmdPath, '--permanent', `--add-port=${this.paths.wireguardPort}/udp`],
				'firewalld wireguard port',
			);
			await this.expect(
				[this.paths.firewallCmdPath, '--permanent', '--zone=trusted', `--add-interface=${this.paths.interface}`],
				'firewalld trusted overlay',
			);
			await this.expect([this.paths.firewallCmdPath, '--reload'], 'firewalld reload');
			await this.applyMachineNat(forward);
			return { backend: 'firewalld', opened: 1 + this.paths.overlayTcpPorts.length };
		}

		// No host manager detected: a dedicated table with a default-drop overlay chain.
		await this.applyMachineNat(forward);
		await fs.mkdir(dirname(this.paths.configPath), { recursive: true, mode: 0o755 });
		await fs.writeFile(this.paths.configPath, this.renderNftables(forward), { mode: 0o644 });
		const check = await this.runner([this.paths.nftPath, '-c', '-f', this.paths.configPath]);
		if (check.code !== 0) throw new Error(`nftables check failed: ${check.stderr.trim()}`);
		await this.expect([this.paths.nftPath, '-f', this.paths.configPath], 'nftables apply');
		return { backend: 'nftables', opened: this.paths.overlayTcpPorts.length };
	}

	/**
	 * Kubernetes machine traffic between nodes (docs/KUBERNETES.md §10, S3). netavark masquerades
	 * everything leaving a bridge, so a machine on node B would see machine A's traffic coming from
	 * A's `wg0` address, and etcd's peer check (source IP against the peer certificate) refuses the
	 * join. A source NAT to itself, before netavark's chain, keeps machine-to-machine traffic on its
	 * real addresses. Its own table, so it applies whichever firewall backend the host uses.
	 */
	async applyMachineNat(cidrs: string[]): Promise<void> {
		const path = this.paths.configPath.replace(/yoal\.nft$/, 'yoal-k8s.nft');
		if (cidrs.length === 0) {
			const exists = await this.runner([this.paths.nftPath, 'list', 'table', 'inet', 'yoal-k8s']);
			if (exists.code === 0) await this.runner([this.paths.nftPath, 'delete', 'table', 'inet', 'yoal-k8s']);
			await fs.rm(path, { force: true });
			return;
		}
		await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 });
		await fs.writeFile(path, this.renderMachineNat(cidrs), { mode: 0o644 });
		const check = await this.runner([this.paths.nftPath, '-c', '-f', path]);
		if (check.code !== 0) throw new Error(`nftables check failed: ${check.stderr.trim()}`);
		await this.expect([this.paths.nftPath, '-f', path], 'nftables machine nat');
	}

	renderMachineNat(cidrs: string[]): string {
		const rules = cidrs.map((cidr) => `\t\tip saddr ${cidr} ip daddr ${cidr} snat ip to ip saddr`).join('\n');
		return `table inet yoal-k8s
delete table inet yoal-k8s
table inet yoal-k8s {
\tchain postrouting {
\t\ttype nat hook postrouting priority srcnat - 10; policy accept;
${rules}
\t}
}
`;
	}

	/**
	 * Ruleset rendered for review and for `nft -f`; no shell interpolation.
	 *
	 * Declare, delete, recreate: one `nft -f` transaction replaces the table, so a re-apply never
	 * appends a second copy of the chain (it did, once per reconcile). Replies to connections this
	 * node opened over the overlay come back to an ephemeral port, so established and related
	 * traffic is accepted before the port allowlist; without it an ingress could not reach a worker.
	 */
	renderNftables(forwardCidrs: string[] = []): string {
		const iface = this.paths.interface;
		const forward =
			forwardCidrs.length > 0
				? `\tchain forward {
\t\ttype filter hook forward priority -10; policy accept;
${forwardCidrs.map((cidr) => `\t\tiifname "${iface}" ip daddr ${cidr} accept`).join('\n')}
\t}
`
				: '';
		const accept = this.paths.overlayTcpPorts
			.map((port) => `\t\tiifname "${iface}" tcp dport ${portSpec(port, '-')} accept`)
			.join('\n');
		return `table inet yoal
delete table inet yoal
table inet yoal {
\tchain input {
\t\ttype filter hook input priority -10; policy accept;
\t\tiifname "${iface}" ct state established,related accept
\t\tiifname "${iface}" icmp type echo-request accept
${accept}
\t\tiifname "${iface}" drop
\t}
${forward}}
`;
	}

	private async expect(argv: string[], label: string): Promise<void> {
		const result = await this.runner(argv);
		if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim()}`);
	}
}

/** `8080`, or `15432:16431` (ufw) / `15432-16431` (nftables) for a range. Validated, never free text. */
function portSpec(port: OverlayPort, separator: ':' | '-'): string {
	const valid = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65_535;
	if (typeof port === 'number') {
		if (!valid(port)) throw new Error(`invalid overlay port ${port}`);
		return String(port);
	}
	const [from, to] = port;
	if (!valid(from) || !valid(to) || from > to) throw new Error(`invalid overlay port range ${from}-${to}`);
	return `${from}${separator}${to}`;
}
