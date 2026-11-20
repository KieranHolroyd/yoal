import type { CoreContext } from './context.ts';
import { ConflictError } from './errors.ts';
import { randomToken, sha256Hex } from './util.ts';

/**
 * Join retries (HA-PLAN Wave 1 F11). A node join is one request; when its response is lost the
 * installer runs it again with the same token and the same WireGuard key. That used to reach the
 * `nodes.wg_public_key` unique index and fail as an HTTP 500.
 *
 * - The same token, name and key, for a node that has never reported in, is the same join: the
 *   node gets a fresh node token (the first one never arrived) and the same identity.
 * - A key another node already holds is a 409 naming that node. A different token never takes
 *   over a key, and the refused token is not consumed.
 */

export interface JoinRetryInput {
	token: string;
	name: string;
	networkMode?: 'yoal' | 'external';
	wireguardPublicKey?: string;
}

/** The node a retried join returns, with its new node token; null when this is not a retry. */
export function retriedJoin(ctx: CoreContext, input: JoinRetryInput): { nodeId: string; token: string; mode: 'edge' | 'worker' } | null {
	const now = ctx.now();
	const managed = input.networkMode === 'yoal';
	const node = ctx.sqlite
		.query<
			{ id: string; name: string; mode: 'edge' | 'worker'; networkMode: string; wgPublicKey: string | null },
			[string, number]
		>(
			`SELECT n.id, n.name, n.mode, n.network_mode AS networkMode, n.wg_public_key AS wgPublicKey
			   FROM node_join_tokens t JOIN nodes n ON n.id = t.used_by_node_id
			  WHERE t.token_hash = ? AND t.used_at IS NOT NULL AND t.expires_at >= ? AND n.last_heartbeat_at IS NULL`,
		)
		.get(sha256Hex(input.token), now);
	if (!node || node.name !== input.name) return null;
	if (managed ? node.networkMode !== 'yoal' || node.wgPublicKey !== input.wireguardPublicKey : node.networkMode !== 'external')
		return null;
	const token = randomToken(32);
	ctx.sqlite.run('UPDATE nodes SET token_hash = ?, updated_at = ? WHERE id = ?', [sha256Hex(token), now, node.id]);
	ctx.audit.record({
		action: 'node.join',
		resource: 'node',
		resourceId: node.id,
		args: { name: node.name, mode: node.mode, retried: true },
		result: 'ok',
	});
	return { nodeId: node.id, token, mode: node.mode };
}

/** Refuse a join whose WireGuard key belongs to an existing node, before anything is written. */
export function assertJoinKeyFree(ctx: CoreContext, input: JoinRetryInput): void {
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
