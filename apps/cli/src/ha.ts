/**
 * The failover controller's status (docs/CLUSTERING.md §8.3, §12.3): wire types and the text
 * `yoal ha status` prints. Types mirror `FailoverStatusView` in packages/contracts/src/failover.ts;
 * the CLI bundle stays free of runtime dependencies (D40), so keep them in sync.
 */
import { formatTime, renderTable, truncate } from './output.ts';

export interface HaEventView {
	id: string;
	kind: 'replica' | 'ingress' | 'database' | 'lease';
	status: string;
	stage: string;
	subjectId: string;
	subjectName: string | null;
	fromNodeId: string | null;
	fromNodeName: string | null;
	toNodeId: string | null;
	toNodeName: string | null;
	reason: string;
	epoch: number;
	detectedAt: string;
	appliedAt: string | null;
	finishedAt: string | null;
}

export interface HaStatusView {
	enabled: boolean;
	policy: {
		graceSeconds: number;
		replicaGraceSeconds: number;
		maxPerMinute: number;
		perTargetPerMinute: number;
		queueExpirySeconds: number;
		leaseTtlSeconds: number;
		tickSeconds: number;
	};
	lease: { state: string; epoch: number; holderId: string | null; self: boolean; expiresAt: string | null };
	lastTickAt: string | null;
	nodes: Array<{
		id: string;
		name: string;
		zone: string;
		status: string;
		silentSeconds: number | null;
		lost: boolean;
		replicaFailoverAt: string | null;
		copies: number;
	}>;
	ingress: {
		driver: string;
		steers: boolean;
		rotates: boolean;
		nodes: Array<{ id: string; name: string; healthy: boolean; inRotation: boolean; pinned: boolean }>;
	};
	databases: Array<{
		name: string;
		nodeName: string | null;
		primaryLost: boolean;
		replicas: number;
		candidate: { nodeName: string | null; nodeId: string } | null;
		refusals: string[];
		automatic: boolean;
	}>;
	counts: { lastMinute: number; inProgress: number; queued: number };
	recent: HaEventView[];
	/** Control-plane standby nodes (HA-PLAN H21, W9); present only while CONTROL_STANDBY is on. */
	controlPlane?: HaControlNodeView[];
	/** The install CA; present only while ENDPOINTS_GATEWAY is on. */
	nodeCa?: NodeCaStatusView;
}

/** Mirrors `NodeCaStatus` in packages/core/src/node-ca.ts. */
export interface NodeCaStatusView {
	inUse: boolean;
	authorities: Array<{ fingerprint: string; subject: string; notBefore: string; notAfter: string; state: 'active' | 'previous' | 'retired'; createdAt: string }>;
	leaves: { issued: number; live: number; nodes: number; revoked: number; renewDue: number; nextExpiry: string | null };
}

/** Mirrors `AttachmentMigrationView` in packages/core/src/service-endpoints.ts. */
export interface AttachmentMigrationView {
	apply: boolean;
	gateway: boolean;
	alreadyMoved: number;
	projects: Array<{
		projectId: string;
		slug: string;
		runtime: string;
		nodes: string[];
		databases: string[];
		status: 'will-move' | 'moved' | 'blocked';
		reason: string;
	}>;
}

/** Mirrors `AttachmentsView` in packages/core/src/service-endpoints.ts. */
export interface AttachmentsView {
	attachments: Array<{
		projectId: string;
		project: string;
		runtime: string;
		databaseId: string;
		database: string;
		databaseNode: string;
		envPrefix: string;
		gateway: boolean;
		consumers: Array<{
			nodeId: string;
			node: string;
			mode: 'gateway' | 'endpoint' | 'direct' | 'none';
			host: string | null;
			port: number | null;
			poolPort: number | null;
			readPort: number | null;
			upstreamNode: string | null;
			version: number | null;
		}>;
	}>;
}

/** The install CA's lines in `yoal ha status` and `yoal ha ca`. */
export function formatNodeCa(ca: NodeCaStatusView): string {
	const active = ca.authorities.find((item) => item.state === 'active');
	const previous = ca.authorities.find((item) => item.state === 'previous');
	const lines = [
		active
			? `Install CA: active ${active.fingerprint.slice(0, 16)}, valid until ${formatTime(active.notAfter)}`
			: 'Install CA: not created yet (the first node that needs a certificate creates it)',
	];
	if (previous) lines.push(`  previous ${previous.fingerprint.slice(0, 16)} still trusted until every node renews`);
	const leaves = ca.leaves;
	lines.push(
		`  ${leaves.nodes} ${leaves.nodes === 1 ? 'node holds' : 'nodes hold'} a leaf, ${leaves.renewDue} due to renew, ${leaves.revoked} revoked` +
			(leaves.nextExpiry ? `; next expiry ${formatTime(leaves.nextExpiry)}` : ''),
	);
	return lines.join('\n');
}

/** `yoal ha migrate attachments`: what moves (or moved) to its stable endpoint. */
export function formatMigration(view: AttachmentMigrationView): string {
	if (!view.gateway && view.projects.every((item) => item.status === 'blocked'))
		return view.projects.length === 0
			? 'ENDPOINTS_GATEWAY is off: apps connect to their databases as before, and there is nothing to migrate.'
			: `ENDPOINTS_GATEWAY is off: ${view.projects.length} ${view.projects.length === 1 ? 'app stays' : 'apps stay'} as ${view.projects.length === 1 ? 'it is' : 'they are'}.`;
	const lines: string[] = [];
	if (view.projects.length === 0) lines.push('Every app with a database attachment already uses its stable endpoint.');
	else
		lines.push(
			renderTable(
				['APP', 'RUNTIME', 'NODES', 'DATABASES', 'STATUS', 'WHY'],
				view.projects.map((item) => [
					item.slug,
					item.runtime,
					item.nodes.join(',') || '-',
					item.databases.join(','),
					item.status === 'will-move' ? 'will move' : item.status,
					truncate(item.reason, 70),
				]),
			),
		);
	const moving = view.projects.filter((item) => item.status === (view.apply ? 'moved' : 'will-move')).length;
	if (view.apply) lines.push('', `Moved ${moving} ${moving === 1 ? 'app' : 'apps'}; each restarts once on its node's next heartbeat.`);
	else if (moving > 0)
		lines.push(
			'',
			`Dry run: nothing changed. ${moving} ${moving === 1 ? 'app would move' : 'apps would move'} to ${moving === 1 ? 'its' : 'their'} stable endpoint and restart once.`,
			'Run `yoal ha migrate attachments --apply` to move them now, or let each move on its own next deploy.',
		);
	if (view.alreadyMoved > 0) lines.push(`${view.alreadyMoved} ${view.alreadyMoved === 1 ? 'app already uses its endpoint' : 'apps already use their endpoints'}.`);
	return lines.join('\n');
}

/** `yoal ha attachments`: how each copy reaches each attached database. */
export function formatAttachments(view: AttachmentsView): string {
	const rows = view.attachments.flatMap((item) =>
		(item.consumers.length ? item.consumers : [null]).map((consumer) => [
			item.project,
			item.database,
			consumer?.node ?? '-',
			consumer?.mode ?? 'no copy',
			consumer?.host && consumer.port !== null ? `${consumer.host}:${consumer.port}` : '-',
			consumer?.poolPort === null || consumer?.poolPort === undefined ? '-' : String(consumer.poolPort),
			consumer?.readPort === null || consumer?.readPort === undefined ? '-' : String(consumer.readPort),
			consumer?.upstreamNode ?? item.databaseNode,
		]),
	);
	if (rows.length === 0) return 'No app has a database attached.';
	return renderTable(['APP', 'DATABASE', 'NODE', 'MODE', 'ENDPOINT', 'POOL', 'READ', 'REACHES'], rows);
}

export interface HaControlNodeView {
	nodeId: string;
	name: string;
	role: string;
	epoch: number;
	holderNodeId: string | null;
	leaseExpiresAt: string | null;
	canPromote: boolean;
	replicationLagSeconds: number | null;
	version: string | null;
	updatedAt: string | null;
}

/** `yoal ha control status`: role, epoch and replay for every control node. */
export function formatControlStatus(nodes: readonly HaControlNodeView[]): string {
	if (nodes.length === 0) return 'No control nodes have reported. Is CONTROL_STANDBY on?';
	return renderTable(
		['NODE', 'ROLE', 'EPOCH', 'HOLDER', 'CAN PROMOTE', 'REPLAY LAG', 'VERSION', 'UPDATED'],
		nodes.map((node) => [
			node.name,
			node.role,
			String(node.epoch),
			node.holderNodeId ?? '-',
			node.canPromote ? 'yes' : 'no',
			node.replicationLagSeconds === null ? '-' : `${node.replicationLagSeconds}s`,
			node.version ?? '-',
			formatTime(node.updatedAt ?? undefined),
		]),
	);
}

export function formatHaStatus(view: HaStatusView, options: { events?: number } = {}): string {
	const lines: string[] = [];
	const lease = view.lease;
	lines.push(
		`Automatic failover: ${view.enabled ? 'on' : 'off (drains still move replica copies)'}`,
		`Lease: ${lease.state}${lease.epoch ? ` at epoch ${lease.epoch}` : ''}${lease.holderId ? `, held by ${lease.holderId}${lease.self ? ' (this control plane)' : ''}` : ''}${lease.expiresAt ? `, expires ${formatTime(lease.expiresAt)}` : ''}`,
		`Last tick: ${formatTime(view.lastTickAt ?? undefined)} · every ${view.policy.tickSeconds}s`,
		`Policy: node lost after ${view.policy.graceSeconds}s, copies move after ${view.policy.replicaGraceSeconds}s, ` +
			`${view.policy.maxPerMinute}/min fleet-wide, ${view.policy.perTargetPerMinute}/min per target, queue expires after ${Math.round(view.policy.queueExpirySeconds / 60)} min`,
		`Actions: ${view.counts.lastMinute} in the last minute, ${view.counts.inProgress} in progress, ${view.counts.queued} waiting`,
		'',
		renderTable(
			['NODE', 'ZONE', 'STATUS', 'SILENT', 'LOST', 'COPIES', 'COPIES MOVE AT'],
			view.nodes.map((node) => [
				node.name,
				node.zone,
				node.status,
				node.silentSeconds === null ? '-' : `${node.silentSeconds}s`,
				node.lost ? 'yes' : 'no',
				String(node.copies),
				formatTime(node.replicaFailoverAt ?? undefined),
			]),
		),
	);
	lines.push('', `Ingress (${view.ingress.driver}): ${view.ingress.rotates ? 'record set tracked; withdrawals and re-adds are manual DNS steps' : 'no record set to rotate'}`);
	if (view.ingress.nodes.length)
		lines.push(
			renderTable(
				['INGRESS', 'HEALTHY', 'IN ROTATION', 'PINNED'],
				view.ingress.nodes.map((node) => [node.name, yes(node.healthy), yes(node.inRotation), yes(node.pinned)]),
			),
		);
	if (view.databases.length) {
		lines.push(
			'',
			renderTable(
				['DATABASE', 'PRIMARY', 'LOST', 'REPLICAS', 'CANDIDATE', 'AUTOMATIC'],
				view.databases.map((database) => [
					database.name,
					database.nodeName ?? '-',
					yes(database.primaryLost),
					String(database.replicas),
					database.candidate ? (database.candidate.nodeName ?? database.candidate.nodeId) : `none (${truncate(database.refusals.join('; ') || 'no replica', 50)})`,
					yes(database.automatic),
				]),
			),
		);
	}
	if (view.nodeCa?.inUse) lines.push('', formatNodeCa(view.nodeCa));
	if (options.events === 0) return lines.join('\n');
	const events = view.recent.slice(0, options.events ?? 10);
	lines.push('', events.length ? 'Recent events:' : 'No failover events yet.');
	if (events.length)
		lines.push(
			renderTable(
				['WHEN', 'KIND', 'STATUS', 'SUBJECT', 'FROM', 'TO', 'REASON'],
				events.map((event) => [
					formatTime(event.detectedAt),
					event.kind,
					event.status,
					truncate(event.subjectName ?? event.subjectId, 28),
					event.fromNodeName ?? event.fromNodeId ?? '-',
					event.toNodeName ?? event.toNodeId ?? '-',
					truncate(event.reason, 70),
				]),
			),
		);
	return lines.join('\n');
}

function yes(value: boolean): string {
	return value ? 'yes' : 'no';
}
