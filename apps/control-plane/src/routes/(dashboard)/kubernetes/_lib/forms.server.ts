import { hasPermission, type Principal } from '@yoal/contracts';

/** What the viewer may do with Kubernetes clusters; the dashboard hides actions they can't take. */
export function kubernetesCan(principal: Principal) {
	return {
		create: hasPermission(principal, 'kubernetes:create'),
		update: hasPermission(principal, 'kubernetes:update'),
		delete: hasPermission(principal, 'kubernetes:delete'),
		/** Attaching also needs read on the database or broker; core checks that per call. */
		attach: hasPermission(principal, 'kubernetes:update'),
		/** Access keys of each role need that role as well as `kubernetes:update` (K19). */
		keyRoles: (['view', 'edit', 'admin'] as const).filter(
			(role) =>
				hasPermission(principal, 'kubernetes:update') &&
				hasPermission(principal, `kubernetes:${role}`)
		)
	};
}

export type KubernetesCan = ReturnType<typeof kubernetesCan>;

/** A textarea or comma list of CIDRs, trimmed; the schema validates each. */
export function cidrList(raw: string): string[] {
	return raw
		.split(/[\s,]+/)
		.map((value) => value.trim())
		.filter(Boolean);
}
