import {
	INGRESS_DRIFT_WINDOW_MS,
	ingressHealthWords,
	type IngressHealth,
	type IngressHealthWord,
} from '@yoal/contracts';

/**
 * What `GET /.well-known/yoal/health` answers (HA-PLAN H19, I14). Pure state so the reasons can
 * be tested without Caddy or a clock: the agent writes the resulting word to a state file that
 * Caddy stats on every probe.
 *
 * `200` needs all four conditions, in this order when more than one fails:
 * 1. Caddy loaded a config (`caddy`);
 * 2. routes are at the desired version, or the last successful converge is inside the drift
 *    window (`desired-state`);
 * 3. every release this node must serve is on disk (`releases`);
 * 4. the loaded certificate fingerprint is the fleet's, when one is expected (`certificates`).
 *
 * A lame duck wins over every reason: it is a deliberate `503`, not a failure.
 */
export interface IngressHealthInput {
	draining: boolean;
	caddyOk: boolean;
	desiredStateVersion: number | null;
	appliedStateVersion: number | null;
	/** When the last successful full converge finished, or null before the first one. */
	lastConvergedAt: number | null;
	now: number;
	/** Release hashes the applied routes need that are not on disk. */
	missingReleases?: readonly string[];
	/** The fleet fingerprint from desired state (lane B); null means "do not verify". */
	expectedCertificateFingerprint?: string | null;
	/** The fingerprint this node's Caddy actually serves, when it could be read. */
	loadedCertificateFingerprint?: string | null;
	driftWindowMs?: number;
}

export function ingressHealth(input: IngressHealthInput): IngressHealth {
	const versions = {
		desiredStateVersion: input.desiredStateVersion,
		appliedStateVersion: input.appliedStateVersion,
		certificateFingerprint:
			normalizeFingerprint(input.loadedCertificateFingerprint ?? null) ??
			normalizeFingerprint(input.expectedCertificateFingerprint ?? null),
	};
	if (input.draining) return { status: 'draining', reason: null, ...versions };
	if (!input.caddyOk) return { status: 'unready', reason: 'caddy', ...versions };

	const window = input.driftWindowMs ?? INGRESS_DRIFT_WINDOW_MS;
	const convergedRecently = input.lastConvergedAt !== null && input.now - input.lastConvergedAt <= window;
	const routesCurrent =
		input.desiredStateVersion !== null &&
		input.appliedStateVersion !== null &&
		(input.appliedStateVersion === input.desiredStateVersion || convergedRecently);
	if (!routesCurrent) return { status: 'unready', reason: 'desired-state', ...versions };

	if ((input.missingReleases?.length ?? 0) > 0)
		return { status: 'unready', reason: 'releases', ...versions };

	const expected = normalizeFingerprint(input.expectedCertificateFingerprint ?? null);
	if (expected !== null && normalizeFingerprint(input.loadedCertificateFingerprint ?? null) !== expected)
		return { status: 'unready', reason: 'certificates', ...versions };

	return { status: 'ok', reason: null, ...versions };
}

/** The one word the endpoint returns for a decision. */
export function ingressHealthWord(health: IngressHealth): IngressHealthWord {
	if (health.status === 'draining') return ingressHealthWords.draining;
	if (health.status === 'ok') return ingressHealthWords.ok;
	return health.reason ?? ingressHealthWords.caddy;
}

/** SHA-256 fingerprints are compared without colons and in lower case (Caddy adds colons). */
export function normalizeFingerprint(value: string | null): string | null {
	if (!value) return null;
	const normalized = value.replace(/:/g, '').trim().toLowerCase();
	return normalized.length > 0 ? normalized : null;
}
