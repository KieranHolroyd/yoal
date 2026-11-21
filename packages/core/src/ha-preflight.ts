import { haFindingStatus, type HaCheck, type HaCheckFixKind, type HaProfile } from '@yoal/contracts';
import type { CoreContext } from './context.ts';

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
