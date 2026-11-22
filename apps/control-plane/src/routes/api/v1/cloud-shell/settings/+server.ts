import { cloudShellSettingsInputSchema } from '@yoal/contracts';
import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * The caller's cloud shell settings (D236, docs/CLOUD-SHELL.md §2): node, disk size, memory, CPUs
 * and idle stop. They apply at the next start; a smaller disk or another node needs a reset.
 *
 *   GET   → { settings }
 *   PUT   any subset of { nodeId, diskMb, memoryMb, cpus, idleMinutes } → { settings }
 */
export const GET: RequestHandler = (event) =>
	route(() => ({ settings: core.cloudShells.settings(requirePrincipal(event)) }));

export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, cloudShellSettingsInputSchema);
		return { settings: core.cloudShells.updateSettings(principal, input) };
	});
