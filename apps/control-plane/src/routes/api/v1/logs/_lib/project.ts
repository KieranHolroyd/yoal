import type { Principal } from '@yoal/contracts';
import { core } from '#lib/server/core.js';

/**
 * `?project=<slug or id>` → the project row inside the caller's org, for the cost-and-safety routes
 * (docs/LOGS.md §10). Another org's project reads as not found.
 */
export function projectParam(principal: Principal, value: string | null | undefined): { id: string; slug: string; orgId: string } | null {
	const ref = value?.trim();
	if (!ref) return null;
	const row = core.projects.requireRow(principal, ref);
	return { id: row.id, slug: row.slug, orgId: row.orgId };
}
