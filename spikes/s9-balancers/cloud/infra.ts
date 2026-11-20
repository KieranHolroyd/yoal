/**
 * S9 cloud infrastructure: one LB11, three of the cheapest Debian 13 servers and one private
 * network in one location, all labelled `yoal-w0=s9` and named `yoal-w0-s9-*`, plus a fresh SSH key.
 * `up` checks the project and the price first; `down` deletes only labelled resources, then proves
 * nothing labelled remains. Every create and delete is written to the ledger the cost is computed from.
 */
import { $ } from 'bun';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, guardOwned, inventory, LABEL_SELECTOR, labels, list, NAME_PREFIX, waitAction } from './hcloud.ts';

$.throws(false);
export const RIG = join(import.meta.dir, '..');
export const DIR = join(RIG, 'tmp', 'cloud');
export const OUT = join(DIR, 'out');
const STATE = join(DIR, 'state.json');
const LEDGER = join(DIR, 'ledger.json');
const SSH_DIR = join(DIR, 'ssh');
export const KEY = join(SSH_DIR, 'id_ed25519');

export const PLAN = {
	location: 'hel1',
	networkZone: 'eu-central',
	lbType: 'lb11',
	ipRange: '10.209.0.0/16',
	subnet: '10.209.1.0/24',
	lbPrivateIp: '10.209.1.5',
	nodes: ['ing-a', 'ing-b', 'ing-c'] as const,
	maxHours: 3,
	budgetEur: 2,
	/** Hard stop: the watchdog tears everything down after this long, whatever else happens. */
	watchdogSeconds: 2.5 * 3600,
	bunVersion: '1.4.4',
};

export interface Node {
	name: string;
	id: number;
	publicIp: string;
	privateIp: string;
}
export interface State {
	sshKeyId?: number;
	networkId?: number;
	lbId?: number;
	lbPublicIp?: string;
	serverType?: string;
	nodes: Node[];
	macIp?: string;
	health?: Record<string, unknown>;
	prices?: Record<string, number>;
	startedAt?: number;
}
interface LedgerEntry {
	kind: string;
	name: string;
	id: number;
	created: number;
	deleted?: number;
	hourlyGross: number;
}

export const say = (msg: string) => console.error(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
export const loadState = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { nodes: [] });
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const loadLedger = (): LedgerEntry[] => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : []);
const saveLedger = (l: LedgerEntry[]) => writeFileSync(LEDGER, JSON.stringify(l, null, 2));
function ledgerAdd(entry: LedgerEntry) {
	const l = loadLedger();
	l.push(entry);
	saveLedger(l);
}
function ledgerDelete(kind: string, id: number) {
	const l = loadLedger();
	for (const e of l) if (e.kind === kind && e.id === id && !e.deleted) e.deleted = Date.now();
	saveLedger(l);
}

/** Live prices (gross, EUR/h) for the plan; picks the cheapest Debian 13 type in the location. */
export async function priceCheck() {
	const { pricing } = await api('GET', '/pricing');
	const lb = Number(pricing.load_balancer_types.find((t: any) => t.name === PLAN.lbType).prices.find((p: any) => p.location === PLAN.location).price_hourly.gross);
	const ipv4 = Number(pricing.primary_ips.find((p: any) => p.type === 'ipv4').prices.find((p: any) => p.location === PLAN.location).price_hourly.gross);
	const images = await list('images', 'name=debian-13&architecture=x86');
	if (images.length === 0) throw new Error('no debian-13 x86 image');
	const types = (await list('server_types')).filter((t: any) => !t.deprecation && t.architecture === 'x86');
	const priced = types
		.map((t: any) => ({ name: t.name as string, price: Number(t.prices.find((p: any) => p.location === PLAN.location)?.price_hourly.gross ?? NaN) }))
		.filter((t) => Number.isFinite(t.price))
		.sort((a, b) => a.price - b.price);
	const projected = PLAN.maxHours * (lb + PLAN.nodes.length * (priced[0]!.price + ipv4));
	return { lb, ipv4, cheapest: priced.slice(0, 4), projected, currency: pricing.currency as string };
}

async function ssh(node: Node, command: string, opts: { quiet?: boolean } = {}) {
	const r = await $`ssh -i ${KEY} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 root@${node.publicIp} ${command}`.quiet();
	if (r.exitCode !== 0 && !opts.quiet) say(`ssh ${node.name} "${command.slice(0, 60)}" exit ${r.exitCode}: ${r.stderr.toString().trim().slice(0, 300)}`);
	return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
export { ssh };

export async function scp(node: Node, local: string, remote: string) {
	const r = await $`scp -q -i ${KEY} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR ${local} root@${node.publicIp}:${remote}`.quiet();
	if (r.exitCode !== 0) throw new Error(`scp to ${node.name} failed: ${r.stderr}`);
}

function cloudInit(): string {
	return `#cloud-config
package_update: true
packages: [tcpdump, unzip, curl, ca-certificates]
write_files:
  - path: /etc/systemd/system/caddy.service
    content: |
      [Unit]
      Description=S9 ingress Caddy (pinned build)
      After=network-online.target
      [Service]
      ExecStartPre=/bin/mkdir -p /run/caddy /run/yoal/health /var/log/caddy
      ExecStart=/usr/local/bin/caddy run --config /etc/caddy/config.json
      Restart=no
      LimitNOFILE=1048576
      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/system/s9-app.service
    content: |
      [Unit]
      Description=S9 upstream app
      [Service]
      Environment=APP_NAME=%H
      ExecStart=/usr/local/bin/bun /opt/s9/app.ts
      Restart=always
      [Install]
      WantedBy=multi-user.target
  - path: /etc/sysctl.d/90-s9.conf
    content: |
      net.core.somaxconn=4096
runcmd:
  - mkdir -p /etc/caddy /opt/s9 /srv/site /var/log/caddy
  - curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v${PLAN.bunVersion}/bun-linux-x64.zip
  - unzip -q -o /tmp/bun.zip -d /opt && install -m 0755 /opt/bun-linux-x64/bun /usr/local/bin/bun
  - sysctl --system
  - touch /var/lib/s9-ready
`;
}

/** Starts a detached watchdog that runs `down` after `watchdogSeconds`, whatever happens to this process. */
async function startWatchdog() {
	const cmd = `sleep ${PLAN.watchdogSeconds}; cd ${RIG}; exec bun cloud/infra.ts down`;
	await $`sh -c ${`nohup sh -c '${cmd}' > ${DIR}/watchdog.log 2>&1 & echo $! > ${DIR}/watchdog.pid`}`.quiet();
}
async function stopWatchdog() {
	const pidFile = join(DIR, 'watchdog.pid');
	if (!existsSync(pidFile)) return;
	const pid = readFileSync(pidFile, 'utf8').trim();
	// Kill the sleeping shell and its children.
	await $`pkill -P ${pid}`.quiet();
	await $`kill ${pid}`.quiet();
	rmSync(pidFile, { force: true });
}

async function waitServerRunning(id: number) {
	for (let i = 0; i < 180; i++) {
		const { server } = await api('GET', `/servers/${id}`);
		if (server.status === 'running') return server;
		await Bun.sleep(2000);
	}
	throw new Error(`server ${id} not running`);
}

export async function waitSsh(node: Node, marker = '/var/lib/s9-ready') {
	for (let i = 0; i < 200; i++) {
		const r = await ssh(node, `test -f ${marker} && echo ok`, { quiet: true });
		if (r.out === 'ok') return;
		await Bun.sleep(3000);
	}
	throw new Error(`${node.name}: cloud-init did not finish`);
}

export async function up() {
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });
	mkdirSync(SSH_DIR, { recursive: true });
	const inv = await inventory();
	say(`inventory: ${JSON.stringify(inv.report)}`);
	if (!inv.safe) throw new Error('project is not a throwaway yoal-w0 project: refusing to create anything');
	for (const [kind, r] of Object.entries(inv.report)) if (r.count > 0) throw new Error(`project already holds ${kind}: ${r.names.join(', ')}; run down first`);

	const price = await priceCheck();
	say(`prices (${price.currency}/h gross): lb11 ${price.lb}, ipv4 ${price.ipv4}, cheapest ${JSON.stringify(price.cheapest)}; projected ${PLAN.maxHours} h: ${price.projected.toFixed(4)}`);
	if (price.projected > PLAN.budgetEur) throw new Error(`projected cost ${price.projected} exceeds budget ${PLAN.budgetEur}`);

	const state: State = { nodes: [], startedAt: Date.now(), prices: { lb: price.lb, ipv4: price.ipv4, server: price.cheapest[0]!.price } };
	saveState(state);
	saveLedger([]);
	await startWatchdog();

	rmSync(KEY, { force: true });
	rmSync(`${KEY}.pub`, { force: true });
	await $`ssh-keygen -q -t ed25519 -N '' -C yoal-w0-s9 -f ${KEY}`.quiet();
	const { ssh_key } = await api('POST', '/ssh_keys', { name: `${NAME_PREFIX}key`, public_key: readFileSync(`${KEY}.pub`, 'utf8').trim(), labels });
	state.sshKeyId = ssh_key.id;
	saveState(state);

	const { network } = await api('POST', '/networks', {
		name: `${NAME_PREFIX}net`,
		ip_range: PLAN.ipRange,
		subnets: [{ type: 'cloud', network_zone: PLAN.networkZone, ip_range: PLAN.subnet }],
		labels,
	});
	state.networkId = network.id;
	saveState(state);

	// Cheapest first; fall back to the next type if the location is out of stock.
	const userData = cloudInit();
	for (const name of PLAN.nodes) {
		let created: any = null;
		for (const type of price.cheapest) {
			try {
				created = await api('POST', '/servers', {
					name: `${NAME_PREFIX}${name}`,
					server_type: type.name,
					image: 'debian-13',
					location: PLAN.location,
					ssh_keys: [ssh_key.id],
					networks: [network.id],
					user_data: userData,
					labels,
					public_net: { enable_ipv4: true, enable_ipv6: false },
				});
				state.serverType = type.name;
				ledgerAdd({ kind: 'server', name, id: created.server.id, created: Date.parse(created.server.created), hourlyGross: type.price + price.ipv4 });
				break;
			} catch (error) {
				say(`create ${name} as ${type.name} failed: ${(error as Error).message}`);
			}
		}
		if (!created) throw new Error(`could not create ${name}`);
		state.nodes.push({ name, id: created.server.id, publicIp: created.server.public_net.ipv4.ip, privateIp: '' });
		saveState(state);
	}

	const { load_balancer } = await api('POST', '/load_balancers', {
		name: `${NAME_PREFIX}lb`,
		load_balancer_type: PLAN.lbType,
		location: PLAN.location,
		algorithm: { type: 'least_connections' },
		public_interface: true,
		labels,
	});
	state.lbId = load_balancer.id;
	state.lbPublicIp = load_balancer.public_net.ipv4.ip;
	ledgerAdd({ kind: 'load_balancer', name: 'lb', id: load_balancer.id, created: Date.parse(load_balancer.created), hourlyGross: price.lb });
	saveState(state);
	const attach = await api('POST', `/load_balancers/${load_balancer.id}/actions/attach_to_network`, { network: network.id, ip: PLAN.lbPrivateIp });
	await waitAction(attach.action.id);

	for (const node of state.nodes) {
		const server = await waitServerRunning(node.id);
		node.privateIp = server.private_net.find((p: any) => p.network === network.id)?.ip ?? '';
	}
	saveState(state);
	say(`servers ${state.nodes.map((n) => `${n.name} ${n.privateIp}`).join(', ')}; lb ${state.lbPublicIp} / ${PLAN.lbPrivateIp}; type ${state.serverType}`);
	await ready();
}

/** Waits for cloud-init on every node and records this Mac's public address as the nodes see it. */
export async function ready() {
	const state = loadState();
	await Promise.all(state.nodes.map((n) => waitSsh(n)));
	state.macIp = (await ssh(state.nodes[0]!, 'echo $SSH_CLIENT')).out.split(' ')[0];
	saveState(state);
	say(`cloud-init done; client address ${state.macIp}`);
}

/** Deletes every resource labelled `yoal-w0=s9` (and nothing else), then proves none remain. */
export async function down() {
	say('teardown: deleting every resource labelled yoal-w0=s9');
	const q = `label_selector=${encodeURIComponent(LABEL_SELECTOR)}`;
	for (const lb of await list('load_balancers', q)) {
		guardOwned(lb);
		await api('DELETE', `/load_balancers/${lb.id}`);
		ledgerDelete('load_balancer', lb.id);
		say(`deleted load balancer ${lb.name}`);
	}
	const actions: number[] = [];
	for (const s of await list('servers', q)) {
		guardOwned(s);
		const r = await api('DELETE', `/servers/${s.id}`);
		ledgerDelete('server', s.id);
		actions.push(r.action.id);
		say(`deleting server ${s.name}`);
	}
	for (const id of actions) await waitAction(id).catch((e) => say(`wait delete: ${e.message}`));
	for (const kind of ['networks', 'firewalls', 'primary_ips', 'floating_ips', 'volumes', 'certificates', 'ssh_keys']) {
		for (const r of await list(kind, q)) {
			guardOwned(r);
			for (let i = 0; i < 10; i++) {
				try {
					await api('DELETE', `/${kind}/${r.id}`);
					say(`deleted ${kind} ${r.name}`);
					break;
				} catch (error) {
					say(`delete ${kind} ${r.name}: ${(error as Error).message}; retrying`);
					await Bun.sleep(3000);
				}
			}
		}
	}
	// Proof: nothing labelled remains, and the project inventory is empty again.
	const remaining: Record<string, string[]> = {};
	for (const kind of ['servers', 'load_balancers', 'networks', 'firewalls', 'primary_ips', 'floating_ips', 'volumes', 'certificates', 'ssh_keys'])
		remaining[kind] = (await list(kind, q)).map((r: any) => r.name);
	const inv = await inventory();
	writeFileSync(join(DIR, 'teardown.json'), JSON.stringify({ at: Date.now(), labelled: remaining, inventory: inv.report }, null, 2));
	say(`labelled resources remaining: ${JSON.stringify(remaining)}`);
	say(`project inventory after teardown: ${JSON.stringify(inv.report)}`);
	rmSync(SSH_DIR, { recursive: true, force: true });
	await stopWatchdog();
	const leftovers = Object.values(remaining).flat().length;
	if (leftovers > 0) throw new Error(`${leftovers} labelled resources remain`);
}

/** Actual cost: resource lifetimes (rounded up to started hours, as Hetzner bills) × live prices. */
export function cost() {
	const l = loadLedger();
	const rows = l.map((e) => {
		const ms = (e.deleted ?? Date.now()) - e.created;
		const hours = Math.max(1, Math.ceil(ms / 3_600_000));
		return { ...e, minutes: +(ms / 60_000).toFixed(1), billedHours: hours, eur: +(hours * e.hourlyGross).toFixed(5), exactEur: +((ms / 3_600_000) * e.hourlyGross).toFixed(5) };
	});
	return { rows, totalBilledEur: +rows.reduce((a, r) => a + r.eur, 0).toFixed(4), totalExactEur: +rows.reduce((a, r) => a + r.exactEur, 0).toFixed(4) };
}

if (import.meta.main) {
	const cmd = process.argv[2];
	if (cmd === 'price') console.log(JSON.stringify(await priceCheck()));
	else if (cmd === 'up') await up();
	else if (cmd === 'ready') await ready();
	else if (cmd === 'down') await down();
	else if (cmd === 'cost') console.log(JSON.stringify(cost(), null, 2));
	else throw new Error('usage: infra.ts price|up|down|cost');
}
