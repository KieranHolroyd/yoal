import type { NodeCaView, NodeCsr, NodeTrustDesired } from '@yoal/contracts';
import type { CoreContext } from './context.ts';

/**
 * The per-install CA (HA-PLAN H24 "Trust", CLUSTERING §4.3). Owned by Wave 1 lane B (issuance in
 * core); lane A makes nodes generate keys, send `nodeCsr` and trust `nodeTrust`. Backed by
 * `node_ca` and `node_ca_certificates` (0118). The CA key is sealed with the master key and never
 * leaves this service; nothing here ever handles a node's private key. Unreachable while
 * `ENDPOINTS_GATEWAY` is off: no desired state carries `nodeTrust` and no CSR is signed.
 */
export interface SignedNodeCertificate {
	serial: string;
	certPem: string;
	/** ISO 8601. */
	notAfter: string;
}

export class NodeCaService {
	constructor(private readonly ctx: CoreContext) {}

	/** Create the install CA if there is none; return the active one. */
	issue(): NodeCaView {
		void this.ctx;
		throw new Error('not implemented (HA Wave 1 lane B): install CA');
	}

	/**
	 * Sign a CSR from `nodeId`. Refuses a CSR whose subject is not that node, whose key is weak,
	 * or that asks for anything beyond CN = node id and URI SAN `yoal://node/<id>`.
	 */
	signCsr(_nodeId: string, _csr: NodeCsr): SignedNodeCertificate {
		throw new Error('not implemented (HA Wave 1 lane B): sign node CSR');
	}

	/** Every CA a node should trust right now, as one PEM bundle. */
	bundle(): string {
		throw new Error('not implemented (HA Wave 1 lane B): CA bundle');
	}

	/** `nodeTrust` for one node's desired state, or null before the CA exists. */
	trustFor(_nodeId: string): NodeTrustDesired | null {
		throw new Error('not implemented (HA Wave 1 lane B): node trust');
	}

	/** Revoke every leaf of `nodeId` (node removed or re-keyed). */
	revoke(_nodeId: string, _reason: string): number {
		throw new Error('not implemented (HA Wave 1 lane B): revoke node certificates');
	}
}
