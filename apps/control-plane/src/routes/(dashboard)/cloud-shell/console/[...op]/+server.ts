import type { RequestHandler } from './$types';
import { handleContainerConsole } from '#lib/server/container-console.js';
import { CLOUD_SHELL_CONSOLE_SLUG, cloudShellConsoleDeps } from '#lib/server/cloud-shell-console.js';

/**
 * The cloud shell terminal's calls (D236): open, stream, type, resize and close a shell in the
 * caller's own cloud shell container, plus reading and downloading files from it. The dashboard
 * session authenticates; the console token is added on the gateway hop and never reaches the
 * browser.
 */
const handle: RequestHandler = (event) =>
	handleContainerConsole(cloudShellConsoleDeps, {
		principal: event.locals.principal,
		slug: CLOUD_SHELL_CONSOLE_SLUG,
		op: event.params.op,
		request: event.request,
		url: event.url
	});

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
