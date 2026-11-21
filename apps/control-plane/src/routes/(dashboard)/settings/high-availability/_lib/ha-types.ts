import type { NodeCaView } from '@yoal/contracts';

/**
 * Response shapes of the HA REST routes whose types live in `@yoal/core` but are not exported from
 * it (`NodeCaStatus`, `AttachmentMigrationView`). They mirror what the routes return; the browser
 * never imports `@yoal/core` values, and the dashboard does not change core.
 */

/** `GET /api/v1/ha/ca` and `POST /api/v1/ha/ca/rotate`. */
export interface CaStatusResponse {
	/** ENDPOINTS_GATEWAY is on, so nodes use the CA for endpoint mTLS. */
	inUse: boolean;
	/** The active CA first, then a previous one still trusted after a rotation. */
	authorities: NodeCaView[];
	leaves: {
		issued: number;
		live: number;
		nodes: number;
		revoked: number;
		renewDue: number;
		/** Nodes whose leaf the previous CA signed: rotating again before this is 0 cuts them off. */
		onPreviousCa: number;
		nextExpiry: string | null;
	};
}

/** `GET`/`POST /api/v1/ha/attachments/migrate`. */
export interface AttachmentMigrationResponse {
	apply: boolean;
	/** Both ENDPOINTS_GATEWAY and SERVICE_ENDPOINTS are on. */
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
