import { eq } from 'drizzle-orm';
import { nodes } from '@yoal/db';
import {
	OBJECT_STORE_KINDS_CAPABILITY,
	isPitrStoreRepo,
	objectStoreKindIssue,
	pitrRepositoryKind,
	type DatabasePitrActivation,
	type DatabasePitrRepository,
	type DatabasePitrStoreActivation,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { missingCapabilityMessage, nodeCapabilityList, objectStoreKindAllowed } from './capability-gate.ts';

/**
 * PITR repositories on Azure or GCS (HA-PLAN W3, lane E). An S3 repository is unaffected. For any
 * other kind the backend's flag must be on and the database's node must declare
 * `object-store-kinds`, both when PITR is turned on and every time a node fetches an activation
 * (a node can be downgraded after). A database move with PITR on is already refused
 * (`service-moves.ts` `assertNoPitr`), so turning PITR on again after a move re-checks the new node.
 */
export function pitrStoreProblem(ctx: Pick<CoreContext, 'config' | 'db'>, repo: DatabasePitrRepository, nodeId: string | null): string | null {
	const kind = pitrRepositoryKind(repo);
	if (kind === 's3') return null;
	// W10 owns the non-S3 data path (the helper's pgBackRest Azure/GCS client). With its flag off
	// PITR stays S3-only, exactly as it shipped, even if an object-store kind is otherwise enabled.
	if (!featureEnabled(ctx.config, 'PITR_REWIND'))
		return 'A non-S3 point-in-time recovery repository needs YOAL_FEATURE_PITR_REWIND, which is off; use an S3-compatible repository.';
	const flagged = objectStoreKindIssue(kind, {
		OBJECT_STORE_AZURE: featureEnabled(ctx.config, 'OBJECT_STORE_AZURE'),
		OBJECT_STORE_GCS: featureEnabled(ctx.config, 'OBJECT_STORE_GCS'),
	});
	if (flagged) return flagged;
	const node = nodeId
		? ctx.db.select({ name: nodes.name, capabilitiesJson: nodes.capabilitiesJson }).from(nodes).where(eq(nodes.id, nodeId)).get()
		: undefined;
	if (node && objectStoreKindAllowed(nodeCapabilityList(node.capabilitiesJson), kind)) return null;
	return missingCapabilityMessage(
		`Point-in-time recovery on ${kind === 'azure' ? 'Azure Blob Storage' : 'Google Cloud Storage'}`,
		OBJECT_STORE_KINDS_CAPABILITY,
		[{ name: node?.name ?? nodeId ?? 'the database node' }],
	);
}

/** The activation for `repo`: `repo` for S3 as always, top-level `store` otherwise (fails closed on older agents). */
export function pitrActivationFor(
	base: Omit<DatabasePitrActivation, 'repo'>,
	repo: DatabasePitrRepository,
): DatabasePitrActivation | DatabasePitrStoreActivation {
	if (!isPitrStoreRepo(repo)) return { ...base, repo };
	return { ...base, store: repo.store, storeCredentials: repo.storeCredentials };
}
