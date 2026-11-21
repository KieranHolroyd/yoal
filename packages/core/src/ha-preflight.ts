import { eq } from 'drizzle-orm';
import { DEFAULT_REGION, haFindingStatus, regionOf, zoneRegions, type HaCheck, type HaCheckFixKind, type HaProfile } from '@yoal/contracts';
import { nodes as nodeTable } from '@yoal/db';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { parseJson } from './util.ts';

/**
 * The platform-dependency preflight (HA-PLAN H28/W12). Pure over the context's existing facts so
 * the same list serves the profile refusal, the HA page and the REST surface. It deliberately
 * checks the things this lane owns: the platform object store, the registry's blobs, identity and
 * mail placement, and whether agents are reporting their telemetry spool.
 *
 * A `blocker` is a reason the `ha` profile must not be asserted; a `warning` is a fact the operator
 * should see but that does not violate H28. Every finding carries the exact fix.
 */
export interface HaFinding {
	key: 'platform-store' | 'registry-storage' | 'identity' | 'mail' | 'telemetry-spool';
	severity: 'blocker' | 'warning' | 'info';
	title: string;
	detail: string;
	/** The exact change that clears it, or null for information. */
	fix: string | null;
}

export function haFindings(ctx: CoreContext, profile: HaProfile): HaFinding[] {
	const findings: HaFinding[] = [];
	const store = ctx.config.platformStore;

	// H28: an install that claims HA may not keep its own artifacts on the control host's disk.
	if (!store || store.kind === 'local') {
		findings.push({
			key: 'platform-store',
			severity: 'blocker',
			title: 'The platform object store is on one node',
			detail:
				'YOAL_OBJECT_STORE is unset or `local`, so releases, uploads, Litestream and backups live on the control host. Losing that host loses the artifacts a failover needs.',
			fix: 'Set YOAL_OBJECT_STORE=r2 (or another external S3 store) and its R2_* keys in yoal.env, restart the control plane, then re-run the preflight.',
		});
	} else if (!store.s3 && store.kind !== 'azure' && store.kind !== 'gcs') {
		findings.push({
			key: 'platform-store',
			severity: 'warning',
			title: 'The platform store kind is unknown',
			detail: `The store reports kind "${store.kind}" but no S3 coordinates, so the registry cannot use it directly.`,
			fix: 'Check YOAL_OBJECT_STORE and the matching credentials in yoal.env.',
		});
	}

	if (ctx.registry.enabled()) {
		const placement = ctx.registry.storagePlacement();
		if (placement.mode === 'local' || placement.mode === 'managed') {
			findings.push({
				key: 'registry-storage',
				severity: 'blocker',
				title: 'Registry blobs live on one node',
				detail:
					placement.mode === 'local'
						? 'The registry stores blobs in its node’s data directory, so losing that node loses every image.'
						: `The registry stores blobs on the RustFS instance${placement.nodeName ? ` on ${placement.nodeName}` : ''}, so losing that node loses every image.`,
				fix: 'Settings → Registry → Storage: choose the platform store (an external S3 store). Existing blobs are not copied: re-push old images (or copy the bucket) before moving the registry, then confirm an old digest pulls.',
			});
		}
	}

	// Identity and mail are allowed to stay on one node each (H28); they must be movable, and a
	// missing or incapable node is what turns "movable" into an outage.
	const identity = ctx.ha.identityPlacement();
	if (identity.pools > 0 && !identity.nodeId) {
		findings.push({
			key: 'identity',
			severity: 'warning',
			title: 'Identity has no node',
			detail: `${identity.pools} user pool${identity.pools === 1 ? '' : 's'} need a node that advertises the identity capability.`,
			fix: 'Update a node’s agent so it declares `identity`, then choose it in Settings → High availability → Identity and mail.',
		});
	} else if (identity.nodeId && !identity.online) {
		findings.push({
			key: 'identity',
			severity: 'warning',
			title: 'The identity node is not online',
			detail: `Identity is pinned to ${identity.nodeName ?? identity.nodeId}, which is not reporting. Hosted sign-in is down until it returns or you move it.`,
			fix: 'Bring the node back, or move identity to another capable node from Settings → High availability → Identity and mail.',
		});
	} else if (identity.nodeId) {
		findings.push({
			key: 'identity',
			severity: 'info',
			title: 'Identity runs on one node',
			detail: `Identity runs on ${identity.nodeName ?? identity.nodeId}. It is movable; the operator steps are in docs/OPS.md §3.9.`,
			fix: null,
		});
	}

	const mail = ctx.ha.mailPlacement();
	if (mail.nodeId && !mail.online) {
		findings.push({
			key: 'mail',
			severity: 'warning',
			title: 'The mail node is not online',
			detail: `Email is pinned to ${mail.nodeName ?? mail.nodeId}, which is not reporting. Queued mail waits until it returns or you move it.`,
			fix: 'Bring the node back, or choose another mail-capable node in Settings → Email → Mail server.',
		});
	} else if (mail.nodeId) {
		findings.push({
			key: 'mail',
			severity: 'info',
			title: 'Mail runs on one node',
			detail: `Email runs on ${mail.nodeName ?? mail.nodeId}. It is movable; the operator steps are in docs/OPS.md §3.9.`,
			fix: null,
		});
	}

	// The spool is an agent feature; a fleet that never reports one is running agents that drop
	// buckets in memory during a control-plane outage.
	const spools = ctx.telemetrySpool.nodes();
	if (spools.length === 0) {
		findings.push({
			key: 'telemetry-spool',
			severity: 'warning',
			title: 'No agent is reporting a telemetry spool',
			detail:
				'Agents buffer access-log buckets in memory only, so a control-plane outage longer than the 5,000-bucket cap loses the older traffic history.',
			fix: 'Update the node agents to this release; the disk spool starts on the next telemetry POST.',
		});
	} else if (spools.some((node) => node.dropped > 0)) {
		const dropped = spools.reduce((sum, node) => sum + node.dropped, 0);
		findings.push({
			key: 'telemetry-spool',
			severity: 'warning',
			title: 'A telemetry spool reached its bound',
			detail: `${dropped} bucket${dropped === 1 ? '' : 's'} were dropped on disk. The affected ranges are shaded on the traffic charts.`,
			fix: 'Raise YOAL_TELEMETRY_SPOOL_BYTES on the affected node if control-plane outages are expected to be long.',
		});
	}

	// `profile` is accepted for future profile-specific rules; today `ha` and `ha-dr` share the
	// same platform-dependency bar.
	void profile;
	return findings;
}

export function haBlockers(ctx: CoreContext, profile: HaProfile): HaFinding[] {
	return haFindings(ctx, profile).filter((finding) => finding.severity === 'blocker');
}

/** How each W12 finding's fix is applied, for the `HaCheck` shape (HA-PLAN W14). */
const FINDING_FIX_KINDS: Readonly<Record<HaFinding['key'], HaCheckFixKind>> = {
	'platform-store': 'env',
	'registry-storage': 'setting',
	identity: 'setting',
	mail: 'setting',
	'telemetry-spool': 'manual',
};

/**
 * The W12 findings as `HaCheck`s (Wave 5 foundation). Every finding keeps its key as the check id,
 * its title, its detail as evidence and its fix; `blocker` is `fail`, `warning` is `warn`, `info`
 * is `pass`. Nothing is dropped: the preflight, doctor and `ha init` all start from these.
 */
export function haFindingChecks(findings: readonly HaFinding[]): HaCheck[] {
	return findings.map((finding) => ({
		id: finding.key,
		title: finding.title,
		status: haFindingStatus(finding.severity),
		evidence: [finding.detail],
		fix: finding.fix && finding.severity !== 'info' ? { kind: FINDING_FIX_KINDS[finding.key], value: finding.fix } : null,
		subject: null,
	}));
}

/**
 * The `regions` check (HA-PLAN H26, W13; Wave 5 lane A). One entry per finding, each with its fix:
 * - while `REGIONS` is off: region values stored from when it was on (placed as zone) warn, and
 *   `ha-dr` fails because it needs regions;
 * - a zone whose nodes name different regions fails (only a direct database write can make one);
 * - `ha-dr` needs a second region with an online data node, and warns without a control-plane
 *   standby there (the promotion runs on it) or without any database standby region;
 * - a database whose standby region holds no live replica fails; one whose standby lags warns;
 * - a fleet whose ingress spans regions without a cross-region driver (`dns-failover` or
 *   `webhook`, alone or stacked) warns.
 * A clean fleet is one `pass` naming each region and its zones.
 */
export function regionChecks(ctx: CoreContext, profile: HaProfile): HaCheck[] {
	const title = 'Regions';
	const checks: HaCheck[] = [];
	const nodes = ctx.sqlite
		.query<{ id: string; name: string; zone: string; region: string; status: string; roles_json: string | null; mode: string; can_build: number }, []>(
			'SELECT id, name, zone, region, status, roles_json, mode, can_build FROM nodes ORDER BY name',
		)
		.all();
	const roles = (id: string) => ctx.nodes.view(ctx.db.select().from(nodeTable).where(eq(nodeTable.id, id)).get()!).roles;
	if (!featureEnabled(ctx.config, 'REGIONS')) {
		const evidence = storedRegionValues(ctx);
		if (evidence.length > 0)
			checks.push({
				id: 'regions',
				title: 'Region values are stored while regions are off',
				status: 'warn',
				evidence: [...evidence, 'A spread: region is placed as zone while REGIONS is off.'],
				fix: { kind: 'env', value: 'YOAL_FEATURE_REGIONS=1, or put each value back to node/zone and the default region.' },
				subject: null,
			});
		if (profile === 'ha-dr')
			checks.push({
				id: 'regions',
				title,
				status: 'fail',
				evidence: ['ha-dr needs a standby region, and regions are off on this platform.'],
				fix: { kind: 'env', value: 'YOAL_FEATURE_REGIONS=1' },
				subject: null,
			});
		if (checks.length === 0)
			checks.push({ id: 'regions', title, status: 'pass', evidence: ['Regions are off; every node is in the default region.'], fix: null, subject: null });
		return checks;
	}

	for (const conflict of zoneRegions(nodes).conflicts)
		checks.push({
			id: 'regions',
			title: `Zone ${conflict.zone} is in more than one region`,
			status: 'fail',
			evidence: [`Nodes ${conflict.nodes.join(', ')} name regions ${conflict.regions.join(', ')}; a zone belongs to exactly one region.`],
			fix: { kind: 'command', value: `yoal nodes set <node> --region ${conflict.regions[0]} (for each node in zone ${conflict.zone} that names another region)` },
			subject: { kind: 'zone', id: conflict.zone, name: conflict.zone },
		});

	const regionOfId = new Map(nodes.map((node) => [node.id, regionOf(node)]));
	const names = [...new Set(nodes.map((node) => regionOf(node)))].sort();
	const active = ctx.regions.activeRegion();
	if (profile === 'ha-dr') {
		const standby = nodes.filter((node) => regionOf(node) !== active && node.status === 'online' && roles(node.id).includes('data'));
		if (standby.length === 0)
			checks.push({
				id: 'regions',
				title: 'No standby region',
				status: 'fail',
				evidence: [`Every online data node is in region ${active} (regions: ${names.join(', ')}).`],
				fix: { kind: 'command', value: 'yoal nodes set <node> --zone <zone> --region <standby-region> (an online data node in another region)' },
				subject: null,
			});
		else {
			const standbyControl = ctx.sqlite
				.query<{ node_id: string }, []>("SELECT node_id FROM control_state WHERE role IN ('standby', 'standby-behind', 'joining')")
				.all()
				.filter((row) => (regionOfId.get(row.node_id) ?? DEFAULT_REGION) !== active);
			if (standbyControl.length === 0)
				checks.push({
					id: 'regions',
					title: 'No control-plane standby outside the active region',
					status: 'warn',
					evidence: [`A region promotion runs on the control plane in the surviving region; none is enrolled outside ${active}.`],
					fix: { kind: 'command', value: `yoal ha control enrol --node <node in ${standby[0]!.region}> --csr <file>` },
					subject: null,
				});
			const withStandby = ctx.sqlite.query('SELECT 1 FROM databases WHERE standby_region IS NOT NULL AND deleted_at IS NULL LIMIT 1').get();
			if (!withStandby)
				checks.push({
					id: 'regions',
					title: 'No database has a standby region',
					status: 'warn',
					evidence: ['A region promotion moves only databases with a replica in the surviving region.'],
					fix: { kind: 'command', value: `yoal db update <database> --standby-region ${standby[0]!.region}` },
					subject: null,
				});
		}
	}

	const replicas = ctx.sqlite
		.query<{ database_id: string; node_id: string; lag_seconds: number | null; status: string }, []>(
			'SELECT database_id, node_id, lag_seconds, status FROM database_replicas WHERE removing_at IS NULL',
		)
		.all();
	for (const database of ctx.sqlite
		.query<{ id: string; name: string; standby_region: string }, []>(
			'SELECT id, name, standby_region FROM databases WHERE standby_region IS NOT NULL AND deleted_at IS NULL ORDER BY name',
		)
		.all()) {
		const there = replicas.filter((row) => row.database_id === database.id && regionOfId.get(row.node_id) === database.standby_region);
		const subject = { kind: 'database' as const, id: database.id, name: database.name };
		if (there.length === 0)
			checks.push({
				id: 'regions',
				title: `${database.name} has no replica in its standby region`,
				status: 'fail',
				evidence: [`Standby region ${database.standby_region} holds no live replica of ${database.name}, so a region promotion would leave it behind.`],
				fix: { kind: 'command', value: `yoal db replicas add ${database.name} --node <data node in ${database.standby_region}>` },
				subject,
			});
		else {
			const worst = Math.max(...there.map((row) => row.lag_seconds ?? 0));
			if (worst > 30)
				checks.push({
					id: 'regions',
					title: `${database.name}'s standby replica lags`,
					status: 'warn',
					evidence: [`The standby replica in ${database.standby_region} is ${worst} s behind: a region promotion now would lose about that much.`],
					fix: { kind: 'manual', value: `Check the link between the primary's region and ${database.standby_region}.` },
					subject,
				});
		}
	}

	const ingress = new Set(ctx.ingressSet.nodes());
	const ingressRegions = new Set(nodes.filter((node) => ingress.has(node.id)).map((node) => regionOf(node)));
	const selection = ctx.cluster.get().steering;
	const drivers = [selection.driver, ...selection.stacked];
	if (ingressRegions.size > 1 && !drivers.some((kind) => kind === 'dns-failover' || kind === 'webhook'))
		checks.push({
			id: 'regions',
			title: 'Ingress spans regions without a cross-region driver',
			status: 'warn',
			evidence: [`Ingress nodes are in ${[...ingressRegions].sort().join(', ')}; steering is ${drivers.join(' + ')}.`],
			fix: { kind: 'setting', value: 'Settings → High availability → Steering: driver dns-failover, stacked external-lb (a balancer in each region, DNS across regions).' },
			subject: null,
		});

	if (!checks.some((check) => check.status === 'fail' || check.status === 'warn'))
		checks.push({
			id: 'regions',
			title,
			status: 'pass',
			evidence: names.map((name) => `${name}: zones ${[...new Set(nodes.filter((node) => regionOf(node) === name).map((node) => node.zone))].sort().join(', ')}${name === active ? ' (active)' : ''}`),
			fix: null,
			subject: null,
		});
	return checks;
}

/** Region values stored anywhere, as evidence lines (nodes, standby regions, spreads). */
function storedRegionValues(ctx: CoreContext): string[] {
	const evidence: string[] = [];
	if (ctx.cluster.get().replicas.spread === 'region') evidence.push('cluster replicas.spread is region');
	for (const row of ctx.sqlite
		.query<{ slug: string; placement: string | null; workload: string | null }, []>(
			'SELECT slug, placement_json AS placement, workload_json AS workload FROM projects WHERE deleted_at IS NULL ORDER BY slug',
		)
		.all()) {
		if (parseJson<{ spread?: string } | null>(row.placement, null)?.spread === 'region') evidence.push(`project ${row.slug} placementSpec.spread is region`);
		if (parseJson<{ placement?: { spread?: string } } | null>(row.workload, null)?.placement?.spread === 'region')
			evidence.push(`project ${row.slug} placement.spread is region`);
	}
	for (const row of ctx.sqlite.query<{ name: string; region: string }, []>("SELECT name, region FROM nodes WHERE region <> 'default' ORDER BY name").all())
		evidence.push(`node ${row.name} is in region ${row.region}`);
	for (const row of ctx.sqlite
		.query<{ name: string; region: string }, []>('SELECT name, standby_region AS region FROM databases WHERE standby_region IS NOT NULL AND deleted_at IS NULL ORDER BY name')
		.all())
		evidence.push(`database ${row.name} has standby region ${row.region}`);
	return evidence;
}
