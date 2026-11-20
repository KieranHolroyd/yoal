import type { CoreContext } from './context.ts';
import { ConflictError } from './errors.ts';
import { sha256Hex } from './util.ts';

/**
 * Join refusals (HA-PLAN Wave 1 F11). A second join used to reach the `nodes.wg_public_key` unique
 * index and fail as an HTTP 500. Both refusals are now clear 409s, checked before anything is
 * written:
 *
 * - A join token is used once. A second use names the node it created and says to create a new
 *   token, or to remove that node first if it never came up. There is no idempotent retry: every
 *   field a retry could be matched on (the token, name and address on the install command line,
 *   the public WireGuard key, the version) is visible or public, so a retry would make a used token
 *   a credential for its node. The node's own token never changes.
 * - A WireGuard key another node already holds names that node. A different token never takes
 *   over a key, and the refused token is not consumed.
 */

export interface JoinRefusalInput {
	token: string;
	networkMode?: 'yoal' | 'external';
	wireguardPublicKey?: string;
}

/** Refuse a second use of a join token, naming the node its first use created. */
export function assertJoinTokenUnused(ctx: CoreContext, input: JoinRefusalInput): void {
	const used = ctx.sqlite
		.query<{ nodeId: string | null; name: string | null; heartbeat: number | null }, [string]>(
			`SELECT t.used_by_node_id AS nodeId, n.name, n.last_heartbeat_at AS heartbeat
			   FROM node_join_tokens t LEFT JOIN nodes n ON n.id = t.used_by_node_id
			  WHERE t.token_hash = ? AND t.used_at IS NOT NULL`,
		)
		.get(sha256Hex(input.token));
	if (!used) return;
	const node = used.name ? `node "${used.name}" (${used.nodeId})` : `node ${used.nodeId ?? 'that has since been removed'}`;
	throw new ConflictError(
		`This join token was already used, by ${node}. A join token works once: create a new join token on the Nodes page ` +
			(used.heartbeat === null && used.name
				? `and run the join again. "${used.name}" has never sent a heartbeat, so if that join did not finish, remove "${used.name}" on the Nodes page first.`
				: 'and run the join again.'),
	);
}

/** Refuse a join whose WireGuard key belongs to an existing node, before anything is written. */
export function assertJoinKeyFree(ctx: CoreContext, input: JoinRefusalInput): void {
	if (input.networkMode !== 'yoal' || !input.wireguardPublicKey) return;
	const holder = ctx.sqlite
		.query<{ id: string; name: string }, [string]>('SELECT id, name FROM nodes WHERE wg_public_key = ?')
		.get(input.wireguardPublicKey);
	if (!holder) return;
	throw new ConflictError(
		`This machine's WireGuard key already belongs to node "${holder.name}" (${holder.id}). A join token cannot take over ` +
			'another node\'s key. If this machine is that node, it is already joined; to join it again, remove ' +
			`"${holder.name}" on the Nodes page first.`,
	);
}
