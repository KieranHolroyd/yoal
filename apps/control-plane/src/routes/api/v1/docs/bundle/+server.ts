import type { RequestHandler } from './$types';
import { json, route } from '#lib/server/api.js';
import { docsBundle, docsDatabase } from '#lib/server/docs.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Every docs page split into sections, in the shape the CLI bundles (HA-PLAN F5). `yoal docs`
 * fetches it when the platform it is logged in to is not the one its own docs came from, and
 * caches it by `fingerprint`, so it reads this platform's docs with its usual search.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		requirePrincipal(event);
		const { version, fingerprint } = await docsDatabase.info();
		return json({ version, fingerprint, bundle: docsBundle() }, 200, { 'cache-control': 'private, max-age=300' });
	});
