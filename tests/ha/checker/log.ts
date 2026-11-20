/** What the checker itself saw: one record per request it sent. */
export type RequestKind = 'write' | 'read' | 'verify';

export interface RequestRecord {
	id: number;
	kind: RequestKind;
	n: number;
	/** Epoch ms, checker clock. */
	startedAt: number;
	endedAt: number;
	/** HTTP status; 0 when no response arrived (see `error`). */
	status: number;
	error?: 'network' | 'timeout';
	/** From the app's x-checker-node / x-checker-copy response headers. */
	node?: string;
	copy?: string;
	/** Reads and verifies of a 200: whether the row matched what was written. */
	match?: boolean;
}

export interface SingletonRun {
	job: string;
	run: string;
	node?: string;
	copy?: string;
	/** Epoch ms. */
	at: number;
}

export interface CheckerLog {
	seed: number;
	writer: string;
	/** Epoch ms. */
	startedAt: number;
	endedAt: number;
	requests: RequestRecord[];
	/** From the app's GET /singletons at the end of the run; empty when unavailable. */
	singletonRuns: SingletonRun[];
}

export function isFailed(r: RequestRecord): boolean {
	return r.status !== 200;
}

export function failureKey(r: RequestRecord): string {
	return r.status === 0 ? (r.error ?? 'network') : String(r.status);
}
