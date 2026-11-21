import { controlReportSchema, type ControlReport } from '@yoal/contracts';

/**
 * A control node's own view of the lease, read from its **local** `/readyz` and reported in the
 * heartbeat (W9-SPEC §4.6, HA-PLAN H21).
 *
 * The agent already authenticates as this node, so a co-located control plane can be asked over its
 * unix socket (or an explicit loopback URL). This must never be read through the public platform
 * origin on a standby: that would report whichever node answers, not this host. The caller passes
 * `null` when it has no local control plane, and the heartbeat omits `control` as before.
 *
 * Any failure returns `null`: a control-plane restart must not make the heartbeat fail (I11).
 */
export interface ControlReportOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

interface ReadyzBody {
	role?: unknown;
	epoch?: unknown;
	canPromote?: unknown;
	lease?: { holder?: unknown; expiresAt?: unknown } | null;
	replication?: { lagSeconds?: unknown } | null;
	/** HA Wave 5: the flags this host's control plane runs with; only on the local `/readyz`. */
	featureFlags?: unknown;
}

export async function readControlReport(
	url: string,
	options: ControlReportOptions = {},
): Promise<ControlReport | null> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error('control readyz timed out')), options.timeoutMs ?? 2_000);
	timer.unref?.();
	try {
		const response = await fetchImpl(url, {
			headers: { accept: 'application/json' },
			signal: controller.signal,
			redirect: 'error',
		});
		// A standby answers 200; `joining`, `standby-behind` and `unavailable` answer 503 with a
		// complete body, which is exactly what the fleet needs to see.
		const body = (await response.json().catch(() => null)) as ReadyzBody | null;
		if (!body || typeof body !== 'object') return null;
		const candidate = {
			role: body.role,
			epoch: body.epoch,
			leaseHolderNodeId: body.lease?.holder ?? null,
			leaseExpiresAt: body.lease?.expiresAt ?? null,
			canPromote: body.canPromote,
			replicationLagSeconds: body.replication?.lagSeconds ?? null,
		};
		// Flags are extra evidence: a malformed set is dropped, never the whole report.
		const flags = controlReportSchema.shape.featureFlags.safeParse(body.featureFlags);
		if (flags.success && flags.data) Object.assign(candidate, { featureFlags: flags.data });
		const parsed = controlReportSchema.safeParse(candidate);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
