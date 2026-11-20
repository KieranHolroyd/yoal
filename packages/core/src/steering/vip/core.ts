import { isIP } from 'node:net';
import { nodes } from '@yoal/db';
import type { CoreContext } from '../../context.ts';
import type { SteeringNode } from '../types.ts';
import { VIP_INSTANCE, VipDriver, vipConfigFromEnv, type VipConfig, type VipControl } from './driver.ts';
import { HelperVipControl, vipHelperSocketsFromEnv } from './helper-control.ts';

/**
 * The production adapter for `vip` (HA-PLAN H18, W8).
 *
 * Configuration is ordinary data; the VRRP password is sealed with the platform key and opened
 * only when a node state is built. The settings document lives under `ha:steering_vip`, so no
 * migration is needed:
 *
 *   { "address": "192.0.2.100", "interface": "eth0", "routerId": 51,
 *     "authPassSealed": "<nonce.ciphertext>", "preferredNodeId": null,
 *     "sockets": { "<node id>": "/run/yoal-helper/helper.sock" } }
 *
 * The helper transport is intentionally explicit: the control plane can only reach a helper socket
 * where one is mounted. A node without an entry is refused by preflight, never silently left out of
 * the VRRP group.
 */

export const VIP_SETTINGS_KEY = 'ha:steering_vip';
const PLATFORM_KEY_ORG = 'platform';

export interface SealedVipSettings {
	address: string;
	interface: string;
	routerId: number;
	advertInterval?: number;
	authPassSealed: string;
	preferredNodeId?: string | null;
	sockets?: Record<string, string>;
}

export function setVipSettings(
	ctx: Pick<CoreContext, 'secrets' | 'sqlite' | 'now'>,
	input: {
		address: string;
		interface: string;
		routerId: number;
		authPass: string;
		advertInterval?: number;
		preferredNodeId?: string | null;
		sockets?: Record<string, string>;
	},
): SealedVipSettings {
	const settings: SealedVipSettings = {
		address: input.address,
		interface: input.interface,
		routerId: input.routerId,
		...(input.advertInterval ? { advertInterval: input.advertInterval } : {}),
		authPassSealed: ctx.secrets.seal(PLATFORM_KEY_ORG, input.authPass),
		preferredNodeId: input.preferredNodeId ?? null,
		...(input.sockets ? { sockets: input.sockets } : {}),
	};
	ctx.sqlite.run(
		'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
		[VIP_SETTINGS_KEY, JSON.stringify(settings), ctx.now()],
	);
	return settings;
}

export function readVipSettings(ctx: Pick<CoreContext, 'sqlite'>): SealedVipSettings | null {
	const row = ctx.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(VIP_SETTINGS_KEY);
	if (!row) return null;
	try {
		const parsed = JSON.parse(row.value) as Partial<SealedVipSettings>;
		if (typeof parsed.address !== 'string' || typeof parsed.interface !== 'string' || typeof parsed.authPassSealed !== 'string') return null;
		return {
			address: parsed.address,
			interface: parsed.interface,
			routerId: typeof parsed.routerId === 'number' ? parsed.routerId : 51,
			advertInterval: typeof parsed.advertInterval === 'number' ? parsed.advertInterval : 1,
			authPassSealed: parsed.authPassSealed,
			preferredNodeId: typeof parsed.preferredNodeId === 'string' ? parsed.preferredNodeId : null,
			sockets: isStringRecord(parsed.sockets) ? parsed.sockets : undefined,
		};
	} catch {
		return null;
	}
}

export function createVipDriverFromCore(ctx: CoreContext): VipDriver {
	const stored = readVipSettings(ctx);
	let config: VipConfig | null = null;
	if (stored) {
		try {
			config = {
				address: stored.address,
				interface: stored.interface,
				routerId: stored.routerId,
				advertInterval: stored.advertInterval ?? 1,
				authPass: ctx.secrets.open(PLATFORM_KEY_ORG, stored.authPassSealed),
				instance: VIP_INSTANCE,
			};
		} catch {
			// A sealed password that cannot be opened is a preflight refusal, not a crash.
			config = null;
		}
	} else config = vipConfigFromEnv();
	const control: VipControl =
		ctx.config.vipControl ?? new HelperVipControl({ sockets: stored?.sockets ?? vipHelperSocketsFromEnv() });
	return new VipDriver(ctx.steering.driverContext(), {
		config,
		control,
		preferredNodeId: stored?.preferredNodeId ?? (process.env.YOAL_VIP_PREFERRED_NODE?.trim() || null),
		addressOf: (node: SteeringNode) => addressOf(ctx, node.id),
	});
}

function addressOf(ctx: CoreContext, nodeId: string): string | null {
	const snapshot = ctx.steering.driverContext().nodes().find((entry) => entry.id === nodeId);
	if (snapshot?.address) return snapshot.address;
	const row = ctx.db
		.select({ id: nodes.id, publicAddress: nodes.publicAddress, wgEndpoint: nodes.wgEndpoint })
		.from(nodes)
		.all()
		.find((entry) => entry.id === nodeId);
	return row ? publicHost(row.wgEndpoint, row.publicAddress) : null;
}

/** The same address rule `dns-failover` uses: overlay endpoint, then public address, both must be IPs. */
function publicHost(wgEndpoint: string | null, publicAddress: string | null): string | null {
	for (const candidate of [wgEndpoint, publicAddress]) {
		const raw = candidate?.trim();
		if (!raw) continue;
		const host = raw.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '');
		if (isIP(host)) return host;
	}
	return null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	return Object.values(value).every((entry) => typeof entry === 'string');
}
