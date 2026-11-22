import { ConflictError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import type { ContainerConsoleDeps } from '#lib/server/container-console.js';

/**
 * The cloud shell's console calls (D236) reuse the container console's proxy (D127): the same
 * exec, stream, input, resize and file verbs, but the token names the caller's own shell. Minting
 * it checks `cloudShell:use`, that a signed-in person is asking and that the shell runs, and
 * records the activity that keeps the shell from being stopped as idle.
 */
export const cloudShellConsoleDeps: ContainerConsoleDeps = {
	console: {
		enabled: () => core.cloudShells.enabled(),
		endpoint: (principal) => core.containerConsole.cloudShellEndpoint(principal),
		targets: () => [],
		record: (principal, _slug, activity) => {
			const { op, ...args } = activity;
			core.cloudShells.record(principal, op, args);
		},
		restart: () => {
			throw new ConflictError('Stop and start the cloud shell instead.');
		}
	},
	gatewayPort: () => core.ctx.config.databaseGatewayPort ?? 8082
};

/** The slug the proxy uses in its token cache key; a cloud shell is one per person, not per project. */
export const CLOUD_SHELL_CONSOLE_SLUG = 'cloud-shell';
