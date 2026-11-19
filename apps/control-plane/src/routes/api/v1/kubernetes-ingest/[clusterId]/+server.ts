import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/**
 * The log shipper's ingest (docs/KUBERNETES.md K23). Not a user API: the bearer is the cluster's
 * ingest token, which only its shipper holds. Accepts a JSON array or newline-delimited JSON.
 */
const MAX_BODY = 8 * 1024 * 1024;

export const POST: RequestHandler = (event) =>
	route(async () => {
		const header = event.request.headers.get('authorization') ?? '';
		const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? '';
		const text = await event.request.text();
		if (text.length > MAX_BODY) return json({ error: 'payload_too_large' }, 413);
		const trimmed = text.trim();
		let lines: unknown;
		try {
			lines = trimmed.startsWith('[')
				? JSON.parse(trimmed)
				: trimmed
						.split('\n')
						.filter((line) => line.trim())
						.map((line) => JSON.parse(line));
		} catch {
			return json({ error: 'invalid_json' }, 400);
		}
		return { accepted: core.kubernetes.ingestLogs(event.params.clusterId, bearer, lines) };
	});
