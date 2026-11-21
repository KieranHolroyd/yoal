import { core } from '#lib/server/core.js';
import { renderNodeScript } from '#lib/server/install-node.js';
import { currentChannel, updateSource } from '#lib/server/self-update.js';
import type { RequestHandler } from './$types';

/**
 * Public, cacheable installer script; the origin, repo and channel are baked in, the token/name
 * stay arguments. The repo/channel are this control plane's, so a fresh worker matches it.
 */
export const GET: RequestHandler = () =>
	new Response(
		renderNodeScript(core.ctx.config.platformOrigin, {
			repo: updateSource().repo,
			channel: currentChannel(),
		}),
		{
			headers: {
				'content-type': 'text/x-shellscript; charset=utf-8',
				'cache-control': 'public, max-age=300',
				'x-content-type-options': 'nosniff',
			},
		}
	);
