import { isIP } from 'node:net';
import { hostname } from 'node:os';
import { failoverEvents, nodes } from '@yoal/db';
import type { CoreContext } from '../../context.ts';
import { OFFLINE_AFTER_MS } from '../../nodes.ts';
import { newId, parseJson } from '../../util.ts';
import { CloudflareDnsProvider, cloudflareDnsConfigFromEnv } from '../dns/cloudflare/provider.ts';
import type { DnsProvider } from '../dns/provider.ts';
import {
	DnsFailoverDriver,
	type DnsFailoverEvent,
	type DnsFailoverRecordTarget,
	type DnsFailoverState,
} from './driver.ts';
import type { DnsFailoverNode } from './health.ts';
import { httpIngressProber } from './probe.ts';

/**
 * The production adapter for `dns-failover` (HA-PLAN H18, Wave 2 lane E).
 *
 * It is deliberately one function: the driver itself has no `@yoal/db` dependency, so the
 * probe/quorum/hold-down logic is testable against a fake provider. The adapter supplies the four
 * things the driver does not own:
 *
 * - the ingress set and its public addresses (the same `IngressSetService` the desired state uses);
 * - the managed record names, from the content domain and the platform host;
 * - the controller lease, through `apply()` from the failover tick;
 * - `failover_events`, one row per provider change.
 *
 * The intended set lives under the same `ha:ingress_rotation` key the C5 controller used, so the
 * existing status view (`inRotation`, `pinned`) reads the DNS driver's state without a new table.
 */

const STATE_KEY = 'ha:ingress_rotation';

export function createDnsFailoverDriver(ctx: CoreContext): DnsFailoverDriver {
	const provider = ctx.config.dnsProvider === undefined ? providerFromEnv() : ctx.config.dnsProvider;
	const platformHost = hostnameOf(ctx.config.platformOrigin);
	return new DnsFailoverDriver({
		provider,
		nodes: () => ingressNodes(ctx),
		records: managedRecords(ctx),
		prober:
			ctx.config.ingressProber ??
			httpIngressProber({
				observerId: `control-plane:${hostname()}`,
				observerZone: 'control',
				host: platformHost,
			}),
		observer: { id: `control-plane:${hostname()}`, zone: 'control' },
		now: () => ctx.now(),
		state: {
			load: () => loadState(ctx),
			save: (state) => saveState(ctx, state),
		},
		onEvent: (event) => recordEvent(ctx, event),
	});
}

/**
 * The address a DNS A/AAAA record may publish: the host part of the node's WireGuard endpoint (its
 * public reachability), else its public address, and only when that host is an IP. The managed
 * install's `public_address` is an internal `host:8080`, never a DNS answer.
 */
function publicHost(wgEndpoint: string | null, publicAddress: string | null): string {
	for (const candidate of [wgEndpoint, publicAddress]) {
		const raw = candidate?.trim();
		if (!raw) continue;
		const host = raw.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '');
		if (isIP(host)) return host;
	}
	return '';
}

function providerFromEnv(): DnsProvider | null {
	const config = cloudflareDnsConfigFromEnv();
	return config ? new CloudflareDnsProvider(config) : null;
}

function ingressNodes(ctx: CoreContext): DnsFailoverNode[] {
	const ids = new Set(ctx.ingressSet.nodes());
	const rows = ctx.db
		.select({
			id: nodes.id,
			name: nodes.name,
			zone: nodes.zone,
			status: nodes.status,
			publicAddress: nodes.publicAddress,
			wgEndpoint: nodes.wgEndpoint,
			lastHeartbeatAt: nodes.lastHeartbeatAt,
			updatedAt: nodes.updatedAt,
		})
		.from(nodes)
		.all();
	return rows
		.filter((row) => ids.has(row.id))
		.map((row) => ({
			id: row.id,
			name: row.name,
			zone: row.zone,
			address: publicHost(row.wgEndpoint, row.publicAddress),
			status: row.status,
			// The row flips to `offline` one heartbeat window after the last beat; count from then.
			offlineSince: row.status === 'offline' ? (row.lastHeartbeatAt ?? row.updatedAt) + OFFLINE_AFTER_MS : null,
		}));
}

/**
 * The records a `dns-failover` install manages: the content apex, its one-level wildcard and the
 * platform host. A name that is not dedicated to Yoal must not be listed here (the driver removes
 * unknown A/AAAA records at a managed name).
 *
 * `YOAL_DNS_FAILOVER_PROXIED` defaults to `true` for the reference fleet's orange-cloud records;
 * `YOAL_DNS_FAILOVER_TTL` defaults to 60 s. A Settings → High availability surface should replace
 * both once the dashboard lane owns that page.
 */
function managedRecords(ctx: CoreContext): DnsFailoverRecordTarget[] {
	const proxied = (process.env.YOAL_DNS_FAILOVER_PROXIED ?? 'true') !== 'false';
	const parsed = Number(process.env.YOAL_DNS_FAILOVER_TTL ?? 60);
	const ttl = Number.isInteger(parsed) ? Math.min(3_600, Math.max(60, parsed)) : 60;
	const names = new Set<string>([ctx.config.contentDomain.toLowerCase(), `*.${ctx.config.contentDomain.toLowerCase()}`]);
	const platform = hostnameOf(ctx.config.platformOrigin);
	if (platform) names.add(platform);
	return [...names].sort().map((name) => ({ name, ttl, proxied }));
}

function loadState(ctx: CoreContext): DnsFailoverState {
	const row = ctx.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(STATE_KEY);
	const raw = parseJson<Partial<DnsFailoverState>>(row?.value, {});
	return {
		records: Array.isArray(raw.records) ? raw.records.filter((id): id is string => typeof id === 'string') : null,
		withdrawals: isRecord(raw.withdrawals) ? (raw.withdrawals as Record<string, number[]>) : {},
		pinnedUntil: isRecord(raw.pinnedUntil) ? (raw.pinnedUntil as Record<string, number>) : {},
		lastAddAt: isRecord(raw.lastAddAt) ? (raw.lastAddAt as Record<string, number>) : {},
	};
}

function saveState(ctx: CoreContext, state: DnsFailoverState): void {
	const now = ctx.now();
	ctx.sqlite.run(
		'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
		[STATE_KEY, JSON.stringify(state), now],
	);
}

function recordEvent(ctx: CoreContext, event: DnsFailoverEvent): void {
	const now = event.appliedAt ?? ctx.now();
	const applied = event.appliedAt !== null;
	ctx.db
		.insert(failoverEvents)
		.values({
			id: newId('fov_'),
			kind: 'ingress',
			status: event.status,
			stage: 'repoint',
			subjectId: event.nodeId ?? event.recordName,
			subjectName: event.nodeName,
			fromNodeId: event.action === 'remove' ? event.nodeId : null,
			toNodeId: event.action === 'remove' ? null : event.nodeId,
			reason: event.reason.slice(0, 1000),
			epoch: event.epoch,
			generation: null,
			detectedAt: event.detectedAt,
			appliedAt: event.appliedAt,
			updatedAt: now,
			finishedAt: applied ? event.appliedAt : now,
		})
		.run();
}

function hostnameOf(origin: string): string {
	try {
		return new URL(origin).hostname.toLowerCase();
	} catch {
		return origin.replace(/^https?:\/\//, '').split('/')[0]?.toLowerCase() ?? '';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
