import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { formatTime, printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';

/**
 * `yoal db public-access`: reach a database from outside Yoal through the TLS proxy on the ingress
 * nodes (docs/DATABASES.md §19, D241). Every rule is checked on the server; this parses flags.
 */

// --- mirrored from @yoal/contracts (database-public-access.ts) ------------------------------------

export interface DatabasePublicAccessInput {
	rules: Array<{ cidr: string; label: string }>;
	allowAnywhere: boolean;
	credentials: string[];
	expiresAt: string | null;
	maxConnections?: number;
}

export interface DatabasePublicAccessView {
	enabled: boolean;
	status: 'disabled' | 'pending' | 'active' | 'degraded' | 'unsupported';
	statusDetail: string | null;
	protocol: 'postgres' | 'tls' | null;
	host: string | null;
	port: number | null;
	rules: Array<{ cidr: string; label: string }>;
	allowAnywhere: boolean;
	anywhereAvailable: boolean;
	credentials: Array<{ id: string; role: string; username: string; usable: boolean }>;
	maxConnections: number;
	expiresAt: string | null;
	enabledAt: string | null;
	enabledBy: string | null;
	updatedAt: string | null;
	updatedBy: string | null;
	disabledAt: string | null;
	disabledReason: 'manual' | 'expired' | null;
	connectionTemplate: string | null;
	nodes: Array<{
		nodeId: string;
		nodeName: string;
		state: string;
		error: string | null;
		open: number;
		accepted: number;
		refused: number;
		authFailures: number;
		banned: number;
		reportedAt: string | null;
	}>;
	events: Array<{ at: string; nodeId: string; source: string; reason: string; detail: string | null }>;
}

// ---------------------------------------------------------------------------------------------

export const publicAccessUsage = `Usage: yoal db public-access <name>                 Show public access: URL, rules, roles, nodes, refusals
       yoal db public-access enable <name> --allow <cidr>[=label] … [options]
                                                    Turn it on, or replace the whole configuration
       yoal db public-access disable <name>         Turn it off (listeners close; the port is kept)

Lets apps outside Yoal connect over TLS to <name>-<org>.db.<domain>:<port>, only from the listed
addresses. Enabling needs the database:expose permission (owner or admin, with a recent sign-in).

Options for enable:
      --allow <cidr>[=label]   A source range, e.g. 203.0.113.0/24=office (repeatable, 1–50).
                               Private, loopback and reserved ranges are refused
      --anywhere               Admit any address (only if the install allows it)
      --credential <id|role>   Postgres: a credential that may log in (repeatable, required):
                               a dbc_… id, or owner/app/readonly/backup
      --expires <when>         Turn off by itself: 12h, 7d, 30d, or an ISO time (max 1 year)
      --max-connections <n>    Concurrent connections per ingress (1–500, default 20)
      --json                   JSON output
  -h, --help                   Show this help

Examples:
  yoal db credentials create main --role app --purpose vercel
  yoal db public-access enable main --allow 203.0.113.0/24=office --credential app --expires 30d
  yoal db credentials reveal main <id>     # includes publicUrl while access is on
  yoal db public-access disable main`;

const flags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
	allow: { type: 'string', multiple: true },
	anywhere: { type: 'boolean' },
	credential: { type: 'string', multiple: true },
	expires: { type: 'string' },
	'max-connections': { type: 'string' },
};

/** `203.0.113.0/24=office` → `{ cidr, label }`. The label may contain `=`; the CIDR may not. */
export function parseAllowRule(value: string): { cidr: string; label: string } {
	const index = value.indexOf('=');
	const cidr = (index === -1 ? value : value.slice(0, index)).trim();
	const label = index === -1 ? '' : value.slice(index + 1).trim();
	if (!cidr) throw new UsageError(`--allow needs a CIDR, e.g. --allow 203.0.113.0/24=office (got "${value}").`);
	if (label.length > 80) throw new UsageError('--allow labels are at most 80 characters.');
	return { cidr, label };
}

/** `12h`, `7d`, `30m`, or an ISO time → ISO string. `never`/`none` → null. */
export function parseExpires(value: string, now = Date.now()): string | null {
	const trimmed = value.trim().toLowerCase();
	if (trimmed === 'never' || trimmed === 'none') return null;
	const relative = /^(\d+)\s*(m|h|d)$/.exec(trimmed);
	if (relative) {
		const amount = Number(relative[1]);
		if (amount <= 0) throw new UsageError('--expires must be in the future.');
		const unit = relative[2] === 'm' ? 60_000 : relative[2] === 'h' ? 3_600_000 : 86_400_000;
		return new Date(now + amount * unit).toISOString();
	}
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) throw new UsageError('--expires must be like 12h, 7d or 30d, or an ISO time (2026-12-31T00:00:00Z).');
	return new Date(parsed).toISOString();
}

export function parseMaxConnections(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500)
		throw new UsageError('--max-connections must be a whole number between 1 and 500.');
	return parsed;
}

/** Build the PUT body from parsed flags. Exported for tests. */
export function enableInput(
	options: { allow: string[]; anywhere: boolean; credentials: string[]; expires?: string; maxConnections?: string },
	now = Date.now(),
): DatabasePublicAccessInput {
	if (options.allow.length === 0 && !options.anywhere)
		throw new UsageError('List at least one source with --allow <cidr>[=label] (or --anywhere, if the install allows it).');
	const maxConnections = parseMaxConnections(options.maxConnections);
	return {
		rules: options.allow.map(parseAllowRule),
		allowAnywhere: options.anywhere,
		credentials: options.credentials.map((value) => value.trim()).filter(Boolean),
		expiresAt: options.expires === undefined ? null : parseExpires(options.expires, now),
		...(maxConnections !== undefined ? { maxConnections } : {}),
	};
}

export function publicAccessDetails(view: DatabasePublicAccessView): string {
	const lines: string[] = [];
	const status = view.statusDetail ? `${view.status} — ${view.statusDetail}` : view.status;
	lines.push(`Status:       ${status}`);
	if (view.host && view.port !== null) lines.push(`Address:      ${view.host}:${view.port}`);
	if (view.connectionTemplate) lines.push(`URL:          ${view.connectionTemplate}`);
	if (view.status === 'unsupported' || (!view.enabled && view.rules.length === 0)) return lines.join('\n');
	const sources = view.allowAnywhere
		? ['any address (0.0.0.0/0, ::/0)']
		: view.rules.map((rule) => (rule.label ? `${rule.cidr}  ${rule.label}` : rule.cidr));
	lines.push(`Sources:      ${sources[0] ?? '(none)'}`);
	for (const source of sources.slice(1)) lines.push(`              ${source}`);
	if (view.protocol === 'postgres') {
		const roles = view.credentials.map(
			(item) => `${item.username} (${item.role}${item.usable ? '' : ', not usable'})`,
		);
		lines.push(`Roles:        ${roles.join(', ') || '(none)'}`);
	}
	lines.push(`Connections:  up to ${view.maxConnections} per ingress`);
	lines.push(`Expires:      ${view.expiresAt ? formatTime(view.expiresAt) : 'never'}`);
	if (!view.enabled && view.disabledReason)
		lines.push(`Turned off:   ${view.disabledAt ? formatTime(view.disabledAt) : ''} (${view.disabledReason})`);
	if (view.nodes.length > 0) {
		lines.push('', 'Ingress nodes:');
		lines.push(
			renderTable(
				['NODE', 'STATE', 'OPEN', 'ACCEPTED', 'REFUSED', 'AUTH FAILS', 'BANNED'],
				view.nodes.map((node) => [
					node.nodeName,
					node.error ? `${node.state}: ${node.error}` : node.state,
					String(node.open),
					String(node.accepted),
					String(node.refused),
					String(node.authFailures),
					String(node.banned),
				]),
			),
		);
	}
	if (view.events.length > 0) {
		lines.push('', 'Recent refusals:');
		lines.push(
			renderTable(
				['TIME', 'SOURCE', 'REASON', 'DETAIL'],
				view.events.slice(0, 10).map((event) => [formatTime(event.at), event.source, event.reason, event.detail ?? '']),
			),
		);
	}
	return lines.join('\n');
}

export async function publicAccessCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(publicAccessUsage);
		return;
	}
	const first = args.positionals[0];
	const verb = first === 'enable' || first === 'disable' || first === 'show' ? first : null;
	const offset = verb ? 1 : 0;
	const name = requirePositional(args, offset, `database name.\n\n${publicAccessUsage}`);
	rejectExtraPositionals(args, offset + 1, publicAccessUsage);
	const json = args.boolean('json');
	if (verb !== 'enable' && (args.strings('allow').length > 0 || args.strings('credential').length > 0 || args.boolean('anywhere')))
		throw new UsageError('--allow, --anywhere and --credential go with `yoal db public-access enable <name>`.');
	const client = await authenticatedClient();

	if (verb === 'enable') {
		const input = enableInput({
			allow: args.strings('allow'),
			anywhere: args.boolean('anywhere'),
			credentials: args.strings('credential'),
			expires: args.string('expires'),
			maxConnections: args.string('max-connections'),
		});
		const { publicAccess, raw } = await client.enableDatabasePublicAccess(name, input);
		if (json) return printJson(raw);
		console.log(`Public access to "${name}" is on.`);
		console.log(publicAccessDetails(publicAccess));
		if (publicAccess.protocol === 'postgres')
			console.log(`\nThe password: yoal db credentials reveal ${name} <id> (its publicUrl is ready to paste).`);
		return;
	}
	if (verb === 'disable') {
		const { publicAccess, raw } = await client.disableDatabasePublicAccess(name);
		if (json) return printJson(raw);
		console.log(`Public access to "${name}" is off.${publicAccess.port !== null ? ` Port ${publicAccess.port} stays reserved for it.` : ''}`);
		return;
	}
	const { publicAccess, raw } = await client.databasePublicAccess(name);
	if (json) return printJson(raw);
	console.log(publicAccessDetails(publicAccess));
}
