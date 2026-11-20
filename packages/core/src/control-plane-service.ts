import { eq } from 'drizzle-orm';
import { controlState, nodes } from '@yoal/db';
import type { ControlLease, ControlStatus } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';

/**
 * Control-plane standby status (HA-PLAN H21/C6, Wave 3 opening). The lease store and the state
 * machine are lane A, written against docs/build-plan/W9-SPEC.md. Until then `status()` reports what
 * nodes have heartbeated, and every control action fails loudly instead of pretending.
 */
export class ControlPlaneService {
	constructor(private readonly ctx: CoreContext) {}

	status(): ControlStatus[] {
		return this.ctx.db
			.select({ state: controlState, node: nodes })
			.from(controlState)
			.innerJoin(nodes, eq(nodes.id, controlState.nodeId))
			.all()
			.map(({ state, node }) => ({
				nodeId: node.id,
				name: node.name,
				role: state.role as ControlStatus['role'],
				epoch: state.epoch,
				holderNodeId: state.holderNodeId,
				leaseExpiresAt: state.leaseExpiresAt === null ? null : new Date(state.leaseExpiresAt).toISOString(),
				canPromote: state.canPromote,
				replicationLagSeconds: state.replicationLagSeconds,
				version: node.version,
				updatedAt: new Date(state.updatedAt).toISOString(),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** The lease as this control plane last observed it; the arbiter is the authority. */
	lease(): ControlLease | null {
		return null;
	}

	promote(): never {
		throw new CoreError('conflict', 'not implemented (HA Wave 3 lane A): control-plane promotion', 409);
	}

	enrol(): never {
		throw new CoreError('conflict', 'not implemented (HA Wave 3 lane A): standby enrolment', 409);
	}
}
