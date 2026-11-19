import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec, type ParsedArgs } from '../args.ts';
import { configDirectory } from '../config.ts';
import { CliError, UsageError } from '../errors.ts';
import { parseCpus, parseMegabytes } from '../databases.ts';
import {
	KUBERNETES_ACCESS_ROLES,
	KUBERNETES_API_ACCESS,
	KUBERNETES_MIN_MEMORY_MB,
	KUBERNETES_TIERS,
	accessKeyTable,
	backupTable,
	clusterDetails,
	clusterTable,
	execCredential,
	formatLogLine,
	formatPodLogLine,
	parseAgents,
	parseChoice,
	parseCidrs,
	parseNodeList,
	parseServers,
	parseWholeNumber,
	readCachedToken,
	tokenCachePath,
	writeCachedToken,
	type KubernetesCreateInput,
	type KubernetesUpdateInput,
} from '../kubernetes.ts';
import {
	formatApplyResult,
	formatGenerateResult,
	generateFailed,
	objectLabel,
	progressLine,
	type KubernetesGenerateInput,
	type KubernetesObjectRef,
} from '../kubernetes-write.ts';
import { parseDuration } from '../object-storage.ts';
import { formatTime, indent, printJson, renderTable } from '../output.ts';
import { authenticatedClient, authenticatedContext } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/** Managed Kubernetes (docs/KUBERNETES.md §11). Every check lives on the server; this is a thin client. */

const usage = `Usage: yoal k8s <command> [options]

Commands:
  list                           List clusters (the default); --all includes the trash
  create <name>                  Create a k3s cluster on a node with the Kubernetes component
  get <name>                     Status, version, endpoint, machines, routes and attachments
  upgrade <name> [--to <minor>]  Move to the next minor (one at a time; default: the next one)
  scale <name> --agents <n>      Add or remove agent machines (0–8); --memory/--cpus resize each
  update <name>                  Change --api, --allow, --memory, --cpus, --[no-]auto-patch, --production,
                                 --backup-hours, --backup-retention, --[no-]shipper or --log-retention
  ha <name>                      Make a production cluster highly available: three servers on embedded
                                 etcd (converts SQLite in place, then adds two servers)
  restart <name>                 Restart the cluster's machines (data is kept)
  delete <name>                  Move it to the trash (restorable for 7 days)
  restore <name>                 Bring it back from the trash
  restore <backup-id> --name <new> [--node <id>]
                                 Create a new cluster from a backup (never overwrites a live one)
  backup <name>                  Take a datastore snapshot now
  backups <name>                 List snapshots (scheduled, manual and pre-upgrade)
  purge <name>                   Permanently delete a trashed cluster and its data
  kubeconfig <name> [--write]    Print a kubeconfig that runs \`yoal k8s token\` (no secret inside);
                                 --write saves it to ~/.kube/yoal-<name>.yaml (or --out <path>)
  token <name>                   A 15-minute cluster token; --output exec-credential is the
                                 kubectl exec plugin format (cached until a minute before expiry)
  route ls|add|rm <name> [host]  Public hostnames routed to the cluster's Traefik ingress
  attach <name> database|broker <resource> [--namespace ns] [--secret name]
                                 Write a database's or broker's connection Secret into the cluster
  detach <name> <attachment-id>  Remove it (or: detach <name> database|broker <resource>)
  access-key ls|create|revoke <name> [key]
                                 Static kubeconfigs for Argo CD, Lens, …; shown once on create
  logs <name>                    Cluster machine and system logs (--follow to stream)
  pod-logs <name>                Pod logs the shipper sent (-n <namespace>, --pod, -q <text>, -f)
  write <name> "<what to run>"   Write a config from plain language for this cluster (needs Settings →
                                 Assistant): -n <namespace>, --from <file.yaml> to change existing YAML,
                                 -o <out.yaml>, --dry-run to check it on the cluster, --apply to apply it
                                 (asks first unless --yes), -v for info findings
  apply <name> -f <file.yaml>    Server-side apply YAML as you (-f - reads stdin); --dry-run checks only,
                                 -n <namespace> for objects that name none

Create options:
      --version <minor>          Kubernetes minor, e.g. 1.37 (default: the newest)
      --node <id>                auto (default) or a node id with the component
      --agents <n>               Agent machines besides the server, 0–8 (default 0)
      --memory <size>            Memory per machine, e.g. 4G (default 2G, at least 2G)
      --cpus <n>                 CPUs per machine (default 1)
      --tier <tier>              userns (default) or trusted (granted orgs, dedicated nodes)
      --api <access>             public (default) or private
      --allow <cidr>             Only these addresses may reach the public API (repeatable)
      --disk <where>             system, fast, bulk or a disk name (default: Settings → Storage)
      --servers <1|3>            One server on SQLite (default) or three on embedded etcd (HA)
      --nodes <a,b,c>            Spread machines across these nodes (multi-node)
      --production               Production purpose: hourly snapshots and the log shipper by default
      --backup-hours <n>         Snapshot interval, 1–168 hours (default 24, 1 for production)
      --backup-retention <days>  Keep snapshots this many days (default 7)
      --[no-]shipper             Ship pod logs to Yoal (default on for production)

Options:
  -y, --yes                      Don't ask for confirmation (required when stdin isn't a terminal)
      --json                     JSON output
  -h, --help                     Show this help

Your access inside a cluster follows your Yoal role: kubernetes:view, :edit or :admin map to the
view, edit and cluster-admin ClusterRoles. Tokens expire after 15 minutes; kubectl refreshes them.

Examples:
  yoal k8s create lab --agents 2
  yoal k8s kubeconfig lab --write && export KUBECONFIG=~/.kube/yoal-lab.yaml
  kubectl get nodes
  yoal k8s route add lab shop                  # shop.<content domain> → the cluster's ingress
  yoal k8s attach lab database orders --namespace shop
  yoal k8s access-key create lab argocd --role admin > argocd.kubeconfig
  yoal k8s write lab "nginx serving a static site on shop, 2 replicas" -o shop.yaml --dry-run
  yoal k8s write lab "make it 3 replicas" --from shop.yaml -o shop.yaml
  yoal k8s apply lab -f shop.yaml`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const listFlags: FlagSpec = { ...baseFlags, all: { type: 'boolean', short: 'a' } };
const sizeFlags: FlagSpec = {
	memory: { type: 'string' },
	cpus: { type: 'string' },
	agents: { type: 'string' },
};
const createFlags: FlagSpec = {
	...baseFlags,
	...sizeFlags,
	version: { type: 'string' },
	node: { type: 'string' },
	placement: { type: 'string' },
	tier: { type: 'string' },
	api: { type: 'string' },
	allow: { type: 'string', multiple: true },
	disk: { type: 'string' },
	servers: { type: 'string' },
	nodes: { type: 'string', multiple: true },
	production: { type: 'boolean' },
	'backup-hours': { type: 'string' },
	'backup-retention': { type: 'string' },
	shipper: { type: 'boolean' },
};
const updateFlags: FlagSpec = {
	...baseFlags,
	...sizeFlags,
	api: { type: 'string' },
	allow: { type: 'string', multiple: true },
	'auto-patch': { type: 'boolean' },
	production: { type: 'boolean' },
	'backup-hours': { type: 'string' },
	'backup-retention': { type: 'string' },
	shipper: { type: 'boolean' },
	'log-retention': { type: 'string' },
};
const restoreFlags: FlagSpec = { ...baseFlags, name: { type: 'string' }, node: { type: 'string' } };
const podLogsFlags: FlagSpec = {
	...baseFlags,
	namespace: { type: 'string', short: 'n' },
	pod: { type: 'string' },
	q: { type: 'string', short: 'q' },
	follow: { type: 'boolean', short: 'f' },
	limit: { type: 'string' },
	after: { type: 'string' },
};
const upgradeFlags: FlagSpec = { ...baseFlags, to: { type: 'string' }, yes: { type: 'boolean', short: 'y' } };
const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };
const kubeconfigFlags: FlagSpec = { ...baseFlags, write: { type: 'boolean', short: 'w' }, out: { type: 'string', short: 'o' } };
const tokenFlags: FlagSpec = { ...baseFlags, output: { type: 'string' }, 'no-cache': { type: 'boolean' } };
const attachFlags: FlagSpec = { ...baseFlags, namespace: { type: 'string', short: 'n' }, secret: { type: 'string' } };
const keyCreateFlags: FlagSpec = { ...baseFlags, role: { type: 'string' }, expires: { type: 'string' }, ttl: { type: 'string' } };
const writeFlags: FlagSpec = {
	...baseFlags,
	namespace: { type: 'string', short: 'n' },
	from: { type: 'string' },
	out: { type: 'string', short: 'o' },
	'dry-run': { type: 'boolean' },
	apply: { type: 'boolean' },
	yes: { type: 'boolean', short: 'y' },
	verbose: { type: 'boolean', short: 'v' },
};
const applyFlags: FlagSpec = {
	...baseFlags,
	file: { type: 'string', short: 'f' },
	namespace: { type: 'string', short: 'n' },
	'dry-run': { type: 'boolean' },
	verbose: { type: 'boolean', short: 'v' },
};
const logsFlags: FlagSpec = {
	...baseFlags,
	follow: { type: 'boolean', short: 'f' },
	limit: { type: 'string' },
	after: { type: 'string' },
};

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listClusters,
	ls: listClusters,
	create: createCluster,
	get: showCluster,
	info: showCluster,
	show: showCluster,
	upgrade: upgradeCluster,
	scale: scaleCluster,
	update: updateCluster,
	restart: restartCluster,
	delete: deleteCluster,
	rm: deleteCluster,
	restore: restoreCluster,
	purge: purgeCluster,
	ha: makeHighlyAvailable,
	backup: backupCluster,
	backups: listBackups,
	'pod-logs': podLogs,
	kubeconfig: kubeconfig,
	token: token,
	route: routeCommand,
	routes: routeCommand,
	attach: attach,
	detach: detach,
	'access-key': accessKeyCommand,
	'access-keys': accessKeyCommand,
	logs: clusterLogs,
	write: writeConfig,
	apply: applyConfig,
};

export async function k8sCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown k8s command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listClusters(argv);
}

/** Parse, handle --help, and return the `<name>` positional plus up to `extra` more. */
function parseNamed(argv: string[], spec: FlagSpec, command: string, extra = 0) {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const line = `Usage: yoal k8s ${command}`;
	rejectExtraPositionals(args, 1 + extra, line);
	const name = requirePositional(args, 0, `cluster name.\n\n${line}`);
	return { args, name };
}

function where(cluster: { nodeName: string | null; nodeId: string }): string {
	return cluster.nodeName ?? cluster.nodeId;
}

/** The size flags shared by create, scale and update. */
function sizes(args: ParsedArgs): KubernetesUpdateInput {
	const out: KubernetesUpdateInput = {};
	const memory = args.string('memory');
	if (memory) {
		out.memoryMb = parseMegabytes(memory, '--memory');
		if (out.memoryMb < KUBERNETES_MIN_MEMORY_MB)
			throw new UsageError(`--memory must be at least ${KUBERNETES_MIN_MEMORY_MB} MB per machine.`);
	}
	const cpus = args.string('cpus');
	if (cpus) out.cpus = parseCpus(cpus);
	const agents = args.string('agents');
	if (agents !== undefined) out.agents = parseAgents(agents);
	return out;
}

async function listClusters(argv: string[]): Promise<void> {
	const args = parseArgs(argv, listFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal k8s list [--all] [--json]');
	const client = await authenticatedClient();
	const { clusters, raw } = await client.listKubernetes({ includeDeleted: args.boolean('all') });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (clusters.length === 0) {
		console.log('No Kubernetes clusters yet. Create one with `yoal k8s create <name>`.');
		return;
	}
	console.log(clusterTable(clusters));
}

async function createCluster(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, createFlags, 'create <name> [options]');
	if (!parsed) return;
	const { args, name } = parsed;
	const input: KubernetesCreateInput = { name, ...sizes(args) };
	const version = args.string('version');
	if (version) input.version = version;
	const placement = args.string('node') ?? args.string('placement');
	if (placement) input.placement = placement;
	const tier = args.string('tier');
	if (tier) input.tier = parseChoice(tier, KUBERNETES_TIERS, '--tier');
	const api = args.string('api');
	if (api) input.apiAccess = parseChoice(api, KUBERNETES_API_ACCESS, '--api');
	const allow = args.strings('allow');
	if (allow.length > 0) input.allowCidrs = parseCidrs(allow);
	const disk = args.string('disk');
	if (disk) input.storage = disk;
	const servers = args.string('servers');
	if (servers) input.servers = parseServers(servers);
	const nodes = parseNodeList(args.strings('nodes'));
	if (nodes.length > 0) {
		if (placement) throw new UsageError('Use --node or --nodes, not both.');
		input.nodes = nodes;
	}
	if (args.boolean('production')) input.purpose = 'production';
	Object.assign(input, backupAndLogs(args));

	const client = await authenticatedClient();
	const { cluster, raw } = await client.createKubernetes(input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Created Kubernetes ${cluster.displayVersion} cluster "${cluster.name}" on node ${where(cluster)} (${cluster.tier} tier, ${cluster.status}).`,
	);
	if (cluster.tier === 'trusted') console.log('Note: trusted tier: cluster admins can become root on this node.');
	const steps = [
		`Follow it:    yoal k8s get ${cluster.name}`,
		cluster.apiUrl
			? `Use kubectl:  yoal k8s kubeconfig ${cluster.name} --write && export KUBECONFIG=~/.kube/yoal-${cluster.name}.yaml`
			: `Private API:  switch to public with \`yoal k8s update ${cluster.name} --api public\` to reach it from here`,
	];
	console.log(`\nNext steps:\n${indent(steps)}`);
}

async function showCluster(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'get <name>');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { cluster, raw } = await client.getKubernetes(name, { includeDeleted: true });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(clusterDetails(cluster));
	if (cluster.deletedAt)
		console.log(`\nIn the trash. Restore with \`yoal k8s restore ${cluster.name}\`; delete for good with \`yoal k8s purge ${cluster.name}\`.`);
}

async function upgradeCluster(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, upgradeFlags, 'upgrade <name> [--to <minor>]');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	let target = args.string('to');
	const { cluster: current } = await client.getKubernetes(name);
	if (!target) {
		if (!current.upgradeTo) {
			console.log(`"${name}" runs ${current.displayVersion}, the newest minor Yoal ships. Patches apply in its maintenance window.`);
			return;
		}
		target = current.upgradeTo;
	}
	const confirmed = await confirmOrRefuse(
		`Upgrade "${name}" from ${current.minor} to ${target}? Machines restart one by one; check for removed APIs first. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before upgrading "${name}".`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const { cluster, raw } = await client.updateKubernetes(name, { version: target });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Upgrading "${cluster.name}" to ${target}. Follow it with \`yoal k8s get ${cluster.name}\`.`);
}

async function scaleCluster(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, { ...baseFlags, ...sizeFlags }, 'scale <name> --agents <n>');
	if (!parsed) return;
	const { args, name } = parsed;
	const patch = sizes(args);
	if (Object.keys(patch).length === 0) throw new UsageError('Nothing to change. Pass --agents, --memory or --cpus.');
	const client = await authenticatedClient();
	const { cluster, raw } = await client.updateKubernetes(name, patch);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`"${cluster.name}" now has 1 server and ${cluster.agents} agent machine${cluster.agents === 1 ? '' : 's'} (${cluster.memoryMb} MB · ${cluster.cpus} vCPU each).`,
	);
}

async function updateCluster(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, updateFlags, 'update <name> [options]');
	if (!parsed) return;
	const { args, name } = parsed;
	const patch = sizes(args);
	const api = args.string('api');
	if (api) patch.apiAccess = parseChoice(api, KUBERNETES_API_ACCESS, '--api');
	const allow = args.strings('allow');
	if (allow.length > 0) patch.allowCidrs = parseCidrs(allow);
	if (args.has('auto-patch')) patch.autoPatch = args.boolean('auto-patch');
	if (args.boolean('production')) patch.purpose = 'production';
	Object.assign(patch, backupAndLogs(args));
	const logRetention = args.string('log-retention');
	if (logRetention) patch.logRetentionDays = parseWholeNumber(logRetention, '--log-retention', 1, 90);
	if (Object.keys(patch).length === 0)
		throw new UsageError(
			'Nothing to update. Pass --api, --allow, --memory, --cpus, --agents, --[no-]auto-patch, --production, --backup-hours, --backup-retention, --[no-]shipper or --log-retention.',
		);
	const client = await authenticatedClient();
	const { cluster, raw } = await client.updateKubernetes(name, patch);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Updated "${cluster.name}". API: ${cluster.apiUrl ?? 'private'}${cluster.allowCidrs.length ? ` (allow ${cluster.allowCidrs.join(', ')})` : ''}.`);
}

async function restartCluster(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'restart <name>');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { cluster, raw } = await client.restartKubernetes(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Restarting "${cluster.name}" on node ${where(cluster)}. Follow it with \`yoal k8s get ${cluster.name}\`.`);
}

async function deleteCluster(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'delete <name>');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { cluster: current } = await client.getKubernetes(name);
	const confirmed = await confirmOrRefuse(
		`Delete Kubernetes cluster "${name}"? Its machines stop now; its data stays on node ${where(current)} and it is restorable for 7 days. [y/N] `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => /^y(es)?$/i.test(answer),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before deleting "${name}".`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const { cluster, raw } = await client.deleteKubernetes(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Deleted "${cluster.name}".${cluster.purgeAt ? ` It is purged for good after ${formatTime(cluster.purgeAt)}.` : ''}`);
	console.log(`Undo: yoal k8s restore ${cluster.name}`);
}

async function restoreCluster(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, restoreFlags, 'restore <name> | restore <backup-id> --name <new> [--node <id>]');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	// A backup id (`kb_…`) or --name restores a snapshot into a new cluster; otherwise undo a delete.
	const newName = args.string('name');
	if (newName || name.startsWith('kb_')) {
		if (!newName) throw new UsageError(`Name the new cluster: yoal k8s restore ${name} --name <new>`);
		const node = args.string('node');
		const { cluster, raw } = await client.restoreKubernetesBackup({
			backup: name,
			name: newName,
			...(node ? { placement: node } : {}),
		});
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(
			`Restoring backup ${name} into new cluster "${cluster.name}" on node ${where(cluster)}. Follow it with \`yoal k8s get ${cluster.name}\`.`,
		);
		return;
	}
	if (args.string('node')) throw new UsageError('--node only applies when restoring a backup (with --name).');
	const { cluster, raw } = await client.restoreKubernetes(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Restored "${cluster.name}" on node ${where(cluster)} (${cluster.status}).`);
}

async function purgeCluster(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'purge <name>');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { cluster } = await client.getKubernetes(name, { includeDeleted: true });
	if (!cluster.deletedAt)
		throw new CliError(`Kubernetes cluster "${name}" is not in the trash. Delete it first.`, {
			code: 'conflict',
			suggestions: [`yoal k8s delete ${name}`],
		});
	const confirmed = await confirmOrRefuse(
		`This permanently deletes cluster "${name}" and its data on node ${where(cluster)}. It cannot be undone. Type ${name} to confirm: `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => answer === name,
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before purging "${name}".`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const raw = await client.purgeKubernetes(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Purging "${name}": its node deletes the data, then it disappears from \`yoal k8s list --all\`.`);
}

async function kubeconfig(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, kubeconfigFlags, 'kubeconfig <name> [--write] [--out <path>]');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const yaml = await client.kubernetesKubeconfig(name);
	const out = args.string('out') ?? (args.boolean('write') ? join(homedir(), '.kube', `yoal-${name}.yaml`) : undefined);
	if (!out) {
		process.stdout.write(yaml.endsWith('\n') ? yaml : `${yaml}\n`);
		if (process.stderr.isTTY)
			process.stderr.write(
				`\nSave it with \`yoal k8s kubeconfig ${name} --write\` (~/.kube/yoal-${name}.yaml), then export KUBECONFIG=~/.kube/yoal-${name}.yaml.\n`,
			);
		return;
	}
	await mkdir(join(out, '..'), { recursive: true, mode: 0o700 });
	await writeFile(out, yaml, { mode: 0o600 });
	await chmod(out, 0o600).catch(() => undefined);
	if (args.boolean('json')) {
		printJson({ path: out, cluster: name });
		return;
	}
	console.log(`Wrote ${out}. It holds no secret: kubectl runs \`yoal k8s token ${name}\` for each 15-minute token.`);
	console.log(
		`\nUse it:\n${indent([
			`export KUBECONFIG=${out}`,
			`# or merge: KUBECONFIG=~/.kube/config:${out} kubectl config view --flatten > /tmp/kubeconfig && mv /tmp/kubeconfig ~/.kube/config`,
		])}`,
	);
}

/**
 * The kubectl exec credential plugin (K8). With `--output exec-credential` stdout carries only the
 * ExecCredential JSON; errors go to stderr through the CLI's error handler.
 */
async function token(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, tokenFlags, 'token <name> [--output exec-credential]');
	if (!parsed) return;
	const { args, name } = parsed;
	const output = args.string('output');
	if (output !== undefined && output !== 'exec-credential' && output !== 'token' && output !== 'json')
		throw new UsageError('--output must be exec-credential, token or json.');
	const { client, config } = await authenticatedContext();
	const cachePath = tokenCachePath(configDirectory(), {
		url: config.url,
		credential: config.token,
		cluster: name,
		...(config.profile ? { profile: config.profile } : {}),
	});
	let minted = args.boolean('no-cache') ? null : await readCachedToken(cachePath);
	if (!minted) {
		minted = await client.kubernetesToken(name);
		await writeCachedToken(cachePath, minted);
	}
	if (output === 'exec-credential') {
		process.stdout.write(`${execCredential(minted)}\n`);
		return;
	}
	if (output === 'json' || args.boolean('json')) {
		printJson(minted);
		return;
	}
	console.log(minted.token);
	if (process.stderr.isTTY) process.stderr.write(`Expires ${formatTime(minted.expiresAt)} (${minted.groups.join(', ') || 'no groups'}).\n`);
}

async function routeCommand(argv: string[]): Promise<void> {
	const [action, ...rest] = argv;
	if (!action || action === '--help' || action === '-h') {
		console.log(usage);
		return;
	}
	if (action === 'ls' || action === 'list') {
		const parsed = parseNamed(rest, baseFlags, 'route ls <name>');
		if (!parsed) return;
		const { routes, raw } = await (await authenticatedClient()).listKubernetesRoutes(parsed.name);
		if (parsed.args.boolean('json')) return printJson(raw);
		if (routes.length === 0) {
			console.log(`No routes yet. Add one with \`yoal k8s route add ${parsed.name} <name>\`.`);
			return;
		}
		console.log(renderTable(['HOST', 'CREATED'], routes.map((route) => [route.host, formatTime(route.createdAt)])));
		return;
	}
	if (action === 'add') {
		const parsed = parseNamed(rest, baseFlags, 'route add <name> <label>', 1);
		if (!parsed) return;
		const label = requirePositional(parsed.args, 1, 'route name.\n\nUsage: yoal k8s route add <name> <label>');
		const { route, raw } = await (await authenticatedClient()).addKubernetesRoute(parsed.name, label);
		if (parsed.args.boolean('json')) return printJson(raw);
		console.log(`https://${route.host} now routes to "${parsed.name}"'s ingress.`);
		console.log(`Create an Ingress for host ${route.host} (Traefik entrypoint web, plain HTTP); Yoal terminates TLS.`);
		return;
	}
	if (action === 'rm' || action === 'remove' || action === 'delete') {
		const parsed = parseNamed(rest, baseFlags, 'route rm <name> <host>', 1);
		if (!parsed) return;
		const host = requirePositional(parsed.args, 1, 'host.\n\nUsage: yoal k8s route rm <name> <host>');
		const raw = await (await authenticatedClient()).removeKubernetesRoute(parsed.name, host);
		if (parsed.args.boolean('json')) return printJson(raw);
		console.log(`Removed route ${host} from "${parsed.name}".`);
		return;
	}
	throw new UsageError(`Unknown route command "${action}". Use ls, add or rm.`);
}

function parseKind(value: string | undefined): 'database' | 'broker' {
	if (value === 'database' || value === 'db') return 'database';
	if (value === 'broker' || value === 'queue') return 'broker';
	throw new UsageError('Name what to attach: database <name> or broker <name>.');
}

async function attach(argv: string[]): Promise<void> {
	const line = 'attach <name> database|broker <resource> [--namespace ns] [--secret name]';
	const parsed = parseNamed(argv, attachFlags, line, 2);
	if (!parsed) return;
	const { args, name } = parsed;
	const kind = parseKind(args.positionals[1]);
	const resource = requirePositional(args, 2, `${kind} name.\n\nUsage: yoal k8s ${line}`);
	const client = await authenticatedClient();
	const { attachment, raw } = await client.attachToKubernetes(name, {
		kind,
		name: resource,
		...(args.string('namespace') ? { namespace: args.string('namespace') } : {}),
		...(args.string('secret') ? { secret: args.string('secret') } : {}),
	});
	if (args.boolean('json')) return printJson(raw);
	console.log(`Attached ${kind} "${resource}" to "${name}" as Secret ${attachment.namespace}/${attachment.secret}.`);
	console.log(`Reference it from a pod with envFrom.secretRef.name: ${attachment.secret}.`);
}

async function detach(argv: string[]): Promise<void> {
	const line = 'detach <name> <attachment-id> | detach <name> database|broker <resource> [--namespace ns]';
	const parsed = parseNamed(argv, attachFlags, line, 2);
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	let id = requirePositional(args, 1, `attachment.\n\nUsage: yoal k8s ${line}`);
	if (args.positionals.length === 3) {
		const kind = parseKind(args.positionals[1]);
		const resource = args.positionals[2]!;
		const namespace = args.string('namespace');
		const { cluster } = await client.getKubernetes(name);
		const matches = cluster.attachments.filter(
			(item) => item.kind === kind && item.name === resource && (!namespace || item.namespace === namespace),
		);
		if (matches.length === 0) throw new CliError(`"${name}" has no ${kind} attachment named "${resource}".`, { code: 'not_found' });
		if (matches.length > 1)
			throw new UsageError(
				`"${resource}" is attached in ${matches.map((item) => item.namespace).join(', ')}. Pass --namespace to pick one.`,
			);
		id = matches[0]!.id;
	}
	const raw = await client.detachFromKubernetes(name, id);
	if (args.boolean('json')) return printJson(raw);
	console.log(`Detached from "${name}". The Secret is removed from the cluster; the resource itself is untouched.`);
}

async function accessKeyCommand(argv: string[]): Promise<void> {
	const [action, ...rest] = argv;
	if (!action || action === '--help' || action === '-h') {
		console.log(usage);
		return;
	}
	if (action === 'ls' || action === 'list') {
		const parsed = parseNamed(rest, baseFlags, 'access-key ls <name>');
		if (!parsed) return;
		const { keys, raw } = await (await authenticatedClient()).listKubernetesAccessKeys(parsed.name);
		if (parsed.args.boolean('json')) return printJson(raw);
		if (keys.length === 0) {
			console.log(`No access keys. Create one with \`yoal k8s access-key create ${parsed.name} <key> --role view\`.`);
			return;
		}
		console.log(accessKeyTable(keys));
		return;
	}
	if (action === 'create') {
		const line = 'access-key create <name> <key> --role view|edit|admin [--expires <ISO time> | --ttl 30d]';
		const parsed = parseNamed(rest, keyCreateFlags, line, 1);
		if (!parsed) return;
		const { args, name } = parsed;
		const key = requirePositional(args, 1, `key name.\n\nUsage: yoal k8s ${line}`);
		const roleValue = args.string('role');
		if (!roleValue) throw new UsageError(`Pass --role view, edit or admin.\n\nUsage: yoal k8s ${line}`);
		const role = parseChoice(roleValue, KUBERNETES_ACCESS_ROLES, '--role');
		if (args.string('expires') && args.string('ttl')) throw new UsageError('Use --expires or --ttl, not both.');
		let expiresAt = args.string('expires');
		if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new UsageError('--expires expects an ISO time.');
		if (expiresAt) expiresAt = new Date(expiresAt).toISOString();
		const ttl = args.string('ttl');
		if (ttl) expiresAt = new Date(Date.now() + parseDuration(ttl, '--ttl')).toISOString();
		const { key: created, raw } = await (await authenticatedClient()).createKubernetesAccessKey(name, {
			name: key,
			role,
			...(expiresAt ? { expiresAt } : {}),
		});
		if (args.boolean('json')) return printJson(raw);
		// The kubeconfig alone on stdout, so `… > argocd.kubeconfig` works; it is shown only once.
		process.stdout.write(created.kubeconfig.endsWith('\n') ? created.kubeconfig : `${created.kubeconfig}\n`);
		process.stderr.write(
			`Access key "${created.name}" (${created.role}) created${created.expiresAt ? `, expires ${formatTime(created.expiresAt)}` : ''}. ` +
				`This kubeconfig carries its token and is not shown again. Revoke with \`yoal k8s access-key revoke ${name} ${created.name}\`.\n`,
		);
		return;
	}
	if (action === 'revoke' || action === 'rm') {
		const line = 'access-key revoke <name> <key>';
		const parsed = parseNamed(rest, confirmFlags, line, 1);
		if (!parsed) return;
		const key = requirePositional(parsed.args, 1, `key name.\n\nUsage: yoal k8s ${line}`);
		const raw = await (await authenticatedClient()).revokeKubernetesAccessKey(parsed.name, key);
		if (parsed.args.boolean('json')) return printJson(raw);
		console.log(`Revoked "${key}". Its ServiceAccount leaves "${parsed.name}" on the next reconcile, which ends its access.`);
		return;
	}
	throw new UsageError(`Unknown access-key command "${action}". Use ls, create or revoke.`);
}

async function clusterLogs(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, logsFlags, 'logs <name> [--follow] [--limit n]');
	if (!parsed) return;
	const { args, name } = parsed;
	const limit = args.string('limit') ? Number(args.string('limit')) : undefined;
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000))
		throw new UsageError('--limit must be a whole number between 1 and 1000.');
	const after = args.string('after') ? Number(args.string('after')) : undefined;
	const follow = args.boolean('follow');
	const client = await authenticatedClient();
	let cursor = after;
	do {
		const page = await client.kubernetesLogs(name, {
			...(cursor !== undefined ? { after: cursor } : {}),
			limit: limit ?? (follow ? 200 : 500),
		});
		if (args.boolean('json') && !follow) return printJson(page.raw);
		if (page.events.length > 0) for (const event of page.events) console.log(formatLogLine(event));
		else if (!follow) {
			console.log(`No logs for "${name}" yet.`);
			return;
		}
		cursor = page.cursor;
		if (!follow) return;
		await new Promise((done) => setTimeout(done, 2_000));
	} while (follow);
}

/** Backup interval/retention and the log shipper, shared by create and update. */
function backupAndLogs(args: ParsedArgs): Pick<KubernetesUpdateInput, 'backupHours' | 'backupRetentionDays' | 'shipper'> {
	const out: Pick<KubernetesUpdateInput, 'backupHours' | 'backupRetentionDays' | 'shipper'> = {};
	const hours = args.string('backup-hours');
	if (hours) out.backupHours = parseWholeNumber(hours, '--backup-hours', 1, 168);
	const retention = args.string('backup-retention');
	if (retention) out.backupRetentionDays = parseWholeNumber(retention, '--backup-retention', 1, 90);
	if (args.has('shipper')) out.shipper = args.boolean('shipper');
	return out;
}

async function makeHighlyAvailable(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'ha <name>');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { cluster: current } = await client.getKubernetes(name);
	if ((current.servers ?? 1) >= 3) {
		console.log(`"${name}" already runs ${current.servers} servers on ${current.datastore ?? 'etcd'}.`);
		return;
	}
	if (current.purpose !== 'production')
		throw new CliError(`"${name}" is a lab cluster; only production clusters can be made highly available.`, {
			code: 'conflict',
			suggestions: [`yoal k8s update ${name} --production`],
		});
	const confirmed = await confirmOrRefuse(
		`Make "${name}" highly available? Yoal snapshots it, converts SQLite to embedded etcd in place, then adds two servers on other nodes. Servers never go back down to one. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before converting "${name}".`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const { cluster, raw } = await client.updateKubernetes(name, { servers: 3 });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Converting "${cluster.name}" to three servers on etcd. Follow the rollout with \`yoal k8s get ${cluster.name}\`.`);
}

async function backupCluster(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'backup <name>');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { backup, raw } = await client.backupKubernetes(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Snapshot ${backup.id} queued (${backup.datastore}). List it with \`yoal k8s backups ${name}\`.`);
}

async function listBackups(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'backups <name>');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { backups, raw } = await client.listKubernetesBackups(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (backups.length === 0) {
		console.log(`No snapshots of "${name}" yet. Take one with \`yoal k8s backup ${name}\`.`);
		return;
	}
	console.log(backupTable(backups));
	console.log(`\nRestore one into a new cluster: yoal k8s restore <id> --name <new>`);
}

async function podLogs(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, podLogsFlags, 'pod-logs <name> [-n <namespace>] [--pod <pod>] [-q <text>] [-f]');
	if (!parsed) return;
	const { args, name } = parsed;
	const limit = args.string('limit') ? parseWholeNumber(args.string('limit')!, '--limit', 1, 1000) : undefined;
	let cursor = args.string('after') ? parseWholeNumber(args.string('after')!, '--after', 0, Number.MAX_SAFE_INTEGER) : undefined;
	const follow = args.boolean('follow');
	const filters = {
		...(args.string('namespace') ? { namespace: args.string('namespace') } : {}),
		...(args.string('pod') ? { pod: args.string('pod') } : {}),
		...(args.string('q') ? { q: args.string('q') } : {}),
	};
	const client = await authenticatedClient();
	do {
		const page = await client.kubernetesPodLogs(name, {
			...filters,
			...(cursor !== undefined ? { after: cursor } : {}),
			limit: limit ?? 200,
		});
		if (args.boolean('json') && !follow) return printJson(page.raw);
		// The first page (no cursor) comes newest first; print oldest first either way.
		const lines = [...page.lines].sort((a, b) => a.seq - b.seq);
		for (const line of lines) console.log(args.boolean('json') ? JSON.stringify(line) : formatPodLogLine(line));
		if (lines.length === 0 && cursor === undefined && !follow) {
			console.log(`No pod logs for "${name}". The shipper must be on: yoal k8s update ${name} --shipper`);
			return;
		}
		if (lines.length > 0) cursor = lines.at(-1)!.seq;
		else if (cursor === undefined) cursor = 0;
		if (!follow) return;
		await new Promise((done) => setTimeout(done, 2_000));
	} while (follow);
}

// ---------------------------------------------------------------- configs from plain language (§18)

async function readYamlFile(path: string, flag: string): Promise<string> {
	if (path === '-') {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
		return Buffer.concat(chunks).toString('utf8');
	}
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		throw new UsageError(`${flag}: cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? String(error)}).`);
	}
}

function confirmApplyQuestion(cluster: string, objects: KubernetesObjectRef[]): string {
	const list = objects.length > 0 ? `\n${indent(objects.map(objectLabel))}\n` : ' ';
	return `Apply ${objects.length} ${objects.length === 1 ? 'object' : 'objects'} to "${cluster}" as you?${list}[y/N] `;
}

async function writeConfig(argv: string[]): Promise<void> {
	const line = 'write <name> "<what to run>" [-n ns] [--from file.yaml] [-o out.yaml] [--dry-run] [--apply [-y]] [--json] [-v]';
	const parsed = parseNamed(argv, writeFlags, line, 1);
	if (!parsed) return;
	const { args, name } = parsed;
	const prompt = requirePositional(args, 1, `description of what to run.\n\nUsage: yoal k8s ${line}`).trim();
	if (prompt.length < 3) throw new UsageError('Describe what to run in a few words.');
	const namespace = args.string('namespace');
	const from = args.string('from');
	const out = args.string('out');
	const verbose = args.boolean('verbose');
	const json = args.boolean('json');
	const input: KubernetesGenerateInput = {
		prompt,
		...(namespace ? { namespace } : {}),
		...(from ? { yaml: await readYamlFile(from, '--from') } : {}),
		dryRun: args.boolean('dry-run'),
	};

	const client = await authenticatedClient();
	const tty = process.stderr.isTTY;
	let last = '';
	const result = await client.generateKubernetesConfig(name, input, {
		onProgress: (progress) => {
			const text = progressLine(progress);
			if (text === last) return;
			last = text;
			process.stderr.write(tty ? `\r\x1b[2K${text}` : `${text}\n`);
		},
	});
	if (tty && last) process.stderr.write('\r\x1b[2K');

	if (out && result.yaml) {
		await writeFile(out, result.yaml.endsWith('\n') ? result.yaml : `${result.yaml}\n`);
	}
	// The YAML alone on stdout when there is no -o, so `> app.yaml` works; the report goes to stderr.
	const report = (text: string) => (out || json ? console.log(text) : process.stderr.write(`${text}\n`));
	const applying = args.boolean('apply');
	// With --apply, --json prints one document at the end: the result plus `applied`.
	if (json && !applying) printJson(result);
	else if (!json) {
		report(formatGenerateResult(result, { verbose, cluster: name }));
		if (out) report(`\nWrote ${out}.`);
		else if (result.yaml) process.stdout.write(result.yaml.endsWith('\n') ? result.yaml : `${result.yaml}\n`);
	}
	if (generateFailed(result)) process.exitCode = 1;

	if (!applying) return;
	const refuse = (message: string) => {
		if (json) printJson({ ...result, applied: null });
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	};
	if (!result.yaml || result.objects.length === 0) return refuse('Nothing to apply.');
	if (generateFailed(result)) return refuse('Not applying: the config has errors or failed the dry run.');
	const confirmed = await confirmOrRefuse(confirmApplyQuestion(name, result.objects), {
		yes: args.boolean('yes'),
		refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before applying to "${name}".`,
	});
	if (!confirmed) return refuse('Cancelled. Nothing was applied.');
	const { result: applied, raw } = await client.applyKubernetesConfig(name, {
		yaml: result.yaml,
		dryRun: false,
		...(namespace ? { namespace } : {}),
	});
	if (json) printJson({ ...result, applied: raw });
	else report(`\n${formatApplyResult(applied, { verbose, cluster: name })}`);
	if (!applied.ok) process.exitCode = 1;
}

async function applyConfig(argv: string[]): Promise<void> {
	const line = 'apply <name> -f <file.yaml|-> [--dry-run] [-n ns] [--json] [-v]';
	const parsed = parseNamed(argv, applyFlags, line);
	if (!parsed) return;
	const { args, name } = parsed;
	const file = args.string('file');
	if (!file) throw new UsageError(`Pass the YAML with -f <file> (or -f - for stdin).\n\nUsage: yoal k8s ${line}`);
	const yaml = await readYamlFile(file, '-f');
	if (!yaml.trim()) throw new UsageError(`${file === '-' ? 'stdin' : file} is empty.`);
	const namespace = args.string('namespace');
	const client = await authenticatedClient();
	const { result, raw } = await client.applyKubernetesConfig(name, {
		yaml,
		dryRun: args.boolean('dry-run'),
		...(namespace ? { namespace } : {}),
	});
	if (args.boolean('json')) printJson(raw);
	else console.log(formatApplyResult(result, { verbose: args.boolean('verbose'), cluster: name }));
	if (!result.ok) process.exitCode = 1;
}
