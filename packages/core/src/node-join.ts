import type { CoreContext } from './context.ts';
import { ConflictError } from './errors.ts';
import { randomToken, sha256Hex } from './util.ts';

/**
 * Join retries (HA-PLAN Wave 1 F11). A node join is one request; when its response is lost the
 * installer runs it again with the same token and the same WireGuard key. That used to reach the
 * `nodes.wg_public_key` unique index and fail as an HTTP 500.
 *
 * - A retry returns the node it created with a fresh node token (the first one never arrived), but
 *   only while the join is plainly the same one: within `JOIN_RETRY_WINDOW_MS` of the token's use,
 *   before the node's first heartbeat, with the same name and, on the overlay, the same WireGuard
 *   key and endpoint. A bring-your-own-network join has no key, so it retries only with the same
 *   public address and version, and never without an address. Anything else is the existing 401
 *   for a used token, so a replayed token is not a credential for its node.
 * - A key another node already holds is a 409 naming that node. A different token never takes
 *   over a key, and the refused token is not consumed.
 */

/** How long after a join token is used a retry of that join may still return its node. */
export const JOIN_RETRY_WINDOW_MS = 10 * 60_000;

export interface JoinRetryInput {
	token: string;
	name: string;
	publicAddress?: string;
	version?: string;
	networkMode?: 'yoal' | 'external';
	wireguardPublicKey?: string;
}

/** `host` → `host:port`, as the join stores a WireGuard endpoint (nodes.ts `withPort`). */
function endpointOf(address: string, port: number): string {
	if (/^\[.*\]:\d+$/.test(address) || /^[^:\[\]]+:\d+$/.test(address)) return address;
	if (address.includes(':') && !address.startsWith('[')) return `[${address}]:${port}`;
	return `${address}:${port}`;
}

/** The node a retried join returns, with its new node token; null when this is not a retry. */
export function retriedJoin(ctx: CoreContext, input: JoinRetryInput): { nodeId: string; token: string; mode: 'edge' | 'worker' } | null {
	const now = ctx.now();
	const node = ctx.sqlite
		.query<
			{
				id: string;
				name: string;
				mode: 'edge' | 'worker';
				networkMode: string;
				wgPublicKey: string | null;
				wgEndpoint: string | null;
				wgListenPort: number | null;
				publicAddress: string | null;
				version: string | null;
			},
			[string, number, number]
		>(
			`SELECT n.id, n.name, n.mode, n.network_mode AS networkMode, n.wg_public_key AS wgPublicKey,
			        n.wg_endpoint AS wgEndpoint, n.wg_listen_port AS wgListenPort, n.public_address AS publicAddress,
			        n.version
			   FROM node_join_tokens t JOIN nodes n ON n.id = t.used_by_node_id
			  WHERE t.token_hash = ? AND t.used_at IS NOT NULL AND t.used_at >= ? AND t.expires_at >= ?
			    AND n.last_heartbeat_at IS NULL`,
		)
		.get(sha256Hex(input.token), now - JOIN_RETRY_WINDOW_MS, now);
	if (!node || node.name !== input.name) return null;
	const same =
		input.networkMode === 'yoal'
			? node.networkMode === 'yoal' &&
				Boolean(input.wireguardPublicKey) &&
				node.wgPublicKey === input.wireguardPublicKey &&
				node.wgEndpoint === (input.publicAddress && node.wgListenPort ? endpointOf(input.publicAddress, node.wgListenPort) : null)
			: node.networkMode === 'external' &&
				Boolean(input.publicAddress) &&
				node.publicAddress === input.publicAddress &&
				node.version === (input.version ?? null);
	if (!same) return null;
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
