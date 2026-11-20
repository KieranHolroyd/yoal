import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * The installer's bootstrap Caddyfile. Caddy's admin API is never on TCP (D7): the bootstrap file
 * puts it on a unix socket the agent can reach, and the agent replaces the rest of the config
 * through that socket. A host that already had Caddy (HA-PLAN Wave 1 F12) gets the same file: the
 * package's stock Caddyfile has the admin API on TCP :2019, which the agent cannot drive.
 */
export const BOOTSTRAP_ADMIN_SOCKET = '/var/lib/caddy/admin.sock';

export function bootstrapCaddyfile(listen: string, bind?: string): string {
	return [
		'# Bootstrap config written by the Yoal installer. The Yoal agent replaces it at runtime',
		'# through the admin socket below; this only serves until the agent starts.',
		'{',
		`\tadmin unix/${BOOTSTRAP_ADMIN_SOCKET}|0660`,
		'}',
		'',
		`${listen} {`,
		// A site address alone does not limit the socket; Caddy binds every interface without this.
		...(bind ? [`\tbind ${bind}`] : []),
		'\trespond "Yoal is starting." 503',
		'}',
		'',
	].join('\n');
}

export interface EnsureNodeCaddyfileOptions {
	path: string;
	listen: string;
	bind?: string;
	run: (cmd: string[]) => void;
	log: (message: string) => void;
	dryRun?: boolean;
	/** Enable and restart Caddy after writing, so a running stock config (TCP admin) is dropped. */
	restart?: boolean;
	now?: () => number;
}

/**
 * Write the bootstrap Caddyfile unless the current one already keeps the admin API on a unix
 * socket (a re-run, or a file the installer or operator already set up). Any other file is backed
 * up first, never over an earlier backup. True when the file was written.
 */
export function ensureNodeCaddyfile(options: EnsureNodeCaddyfileOptions): boolean {
	const current = existsSync(options.path) ? readFileSync(options.path, 'utf8') : '';
	if (current.includes('admin unix/')) return false;
	if (options.dryRun) {
		options.log(
			current
				? `would back up ${options.path} and replace it with Yoal's bootstrap Caddyfile (admin API on a unix socket, not TCP)`
				: `would write Yoal's bootstrap Caddyfile to ${options.path}`,
		);
		return false;
	}
	if (current) {
		const backup = existsSync(`${options.path}.dist`) ? `${options.path}.dist.${(options.now ?? Date.now)()}` : `${options.path}.dist`;
		writeFileSync(backup, current);
		options.log(
			`backed up the existing ${options.path} to ${backup}; Yoal's bootstrap Caddyfile replaces it so Caddy's admin API ` +
				`is on ${BOOTSTRAP_ADMIN_SOCKET}, never on TCP`,
		);
	}
	const tmp = `${options.path}.yoal-new`;
	writeFileSync(tmp, bootstrapCaddyfile(options.listen, options.bind));
	renameSync(tmp, options.path);
	if (options.restart) {
		options.run(['systemctl', 'enable', 'caddy']);
		options.run(['systemctl', 'restart', 'caddy']);
	}
	return true;
}
