import { createHash } from 'node:crypto';
import { chmodSync, chownSync, copyFileSync, existsSync, linkSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { STOCK_CADDY_UNIT, caddyUnit } from '../systemd/caddy.ts';

/**
 * The installer's bootstrap Caddyfile. Caddy's admin API is never on TCP (D7): the bootstrap file
 * puts it on a unix socket the agent can reach, and the agent replaces the rest of the config
 * through that socket. A host that already had Caddy (HA-PLAN Wave 1 F12) gets the same file: the
 * package's stock Caddyfile has the admin API on TCP :2019, which the agent cannot drive.
 *
 * It is replaced only where that is safe (F12 review): Caddy runs as the packaged `caddy.service`
 * (a host whose proxy is `yoal-caddy.service`, such as a converted Skiff host, is left alone, or a
 * second Caddy would fight it for :80 and :443), and on the control plane only on its first install,
 * when the file is still the package's own, or when the operator passes --replace-caddyfile.
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

/**
 * True when a live `admin` directive puts the API on a unix socket. A Caddyfile comment starts at
 * `#` at the start of a line or after whitespace, so a commented-out directive does not count.
 */
export function adminOnUnixSocket(content: string): boolean {
	return content
		.split('\n')
		.map((line) => line.replace(/(^|\s)#.*$/, '').trim())
		.some((line) => /^admin\s+unix\/\/\S+/.test(line));
}

/** True when `content` is byte-for-byte the Caddyfile the caddy package shipped (dpkg's md5). */
export function isPackageCaddyfile(content: string, conffiles: string | null, path: string): boolean {
	if (!conffiles) return false;
	const md5 = createHash('md5').update(content).digest('hex');
	return conffiles.split('\n').some((line) => {
		const [file, sum] = line.trim().split(/\s+/);
		return file === path && sum === md5;
	});
}

/** What the installer needs from the host; injected so tests drive the real decisions. */
export interface CaddyfileHost {
	path: string;
	run: (cmd: string[]) => void;
	/** stdout of a command, or null when it failed. */
	capture: (cmd: string[]) => string | null;
	log: (message: string) => void;
	dryRun?: boolean;
	now?: () => number;
}

/** Hard-link the original to the backup: same inode, so its mode and owner come with it. */
function backUp(path: string, now: () => number): string {
	const backup = existsSync(`${path}.dist`) ? `${path}.dist.${now()}` : `${path}.dist`;
	try {
		linkSync(path, backup);
	} catch {
		// A filesystem without hard links: copy, then give the copy the original's mode and owner.
		const stat = statSync(path);
		copyFileSync(path, backup);
		chmodSync(backup, stat.mode & 0o7777);
		try {
			chownSync(backup, stat.uid, stat.gid);
		} catch {
			/* not root (tests): the copy is already ours */
		}
	}
	return backup;
}

function replace(host: CaddyfileHost, current: string, listen: string, bind?: string): void {
	if (current) {
		const backup = backUp(host.path, host.now ?? Date.now);
		host.log(
			`backed up the existing ${host.path} to ${backup}; Yoal's bootstrap Caddyfile replaces it so Caddy's admin API ` +
				`is on ${BOOTSTRAP_ADMIN_SOCKET}, never on TCP`,
		);
	}
	const tmp = `${host.path}.yoal-new`;
	writeFileSync(tmp, bootstrapCaddyfile(listen, bind), { mode: 0o644 });
	renameSync(tmp, host.path);
	// The running Caddy still has the old config, admin API on TCP included: only a restart drops it.
	host.run(['systemctl', 'enable', STOCK_CADDY_UNIT]);
	host.run(['systemctl', 'restart', STOCK_CADDY_UNIT]);
}

/** The Caddy unit this host runs, preferring the release-managed one (systemd/caddy.ts). */
function unitOf(host: CaddyfileHost): string | null {
	return caddyUnit((cmd) => {
		const stdout = host.capture(cmd);
		return { code: stdout === null ? 1 : 0, stdout: stdout ?? '', stderr: '' };
	});
}

/**
 * Shared checks: nothing to do when the admin API is already on a unix socket, and never anything
 * unless Caddy runs as `caddy.service`. Returns the current content when a replacement may go ahead.
 */
function preflight(host: CaddyfileHost): string | null {
	const current = existsSync(host.path) ? readFileSync(host.path, 'utf8') : '';
	if (adminOnUnixSocket(current)) return null;
	const unit = unitOf(host);
	if (unit !== STOCK_CADDY_UNIT) {
		host.log(
			unit
				? `leaving ${host.path} alone: this host's Caddy runs as ${unit}, not ${STOCK_CADDY_UNIT}`
				: `leaving ${host.path} alone: no Caddy unit is installed`,
		);
		return null;
	}
	return current;
}

/**
 * The control plane's install. Replaces the Caddyfile (backup, then enable and restart Caddy) on
 * the first install, when the file is missing or still the package's own, or with `force`
 * (--replace-caddyfile). Any other file on an existing install is left alone with a warning. True
 * when the file was written.
 */
export function controlPlaneCaddyfile(host: CaddyfileHost & { firstInstall: boolean; force: boolean }): boolean {
	const current = preflight(host);
	if (current === null) return false;
	const packaged = isPackageCaddyfile(current, host.capture(['dpkg-query', '-W', '-f=${Conffiles}\n', 'caddy']), host.path);
	if (current && !host.firstInstall && !packaged && !host.force) {
		host.log(
			`warning: ${host.path} is not Yoal's and does not put Caddy's admin API on a unix socket, so the agent cannot ` +
				'drive Caddy. It was left alone because this is not a first install. Re-run with --replace-caddyfile to back it ' +
				'up and replace it.',
		);
		return false;
	}
	if (host.dryRun) {
		host.log(`would back up ${host.path}, write Yoal's bootstrap Caddyfile (admin API on a unix socket) and restart Caddy`);
		return false;
	}
	replace(host, current, ':80');
	return true;
}

/** A worker's join: the overlay is not up yet, so the bootstrap listens on loopback only. */
export function workerCaddyfile(host: CaddyfileHost): boolean {
	const current = preflight(host);
	if (current === null) return false;
	if (host.dryRun) {
		host.log(`would back up ${host.path}, write Yoal's loopback-only bootstrap Caddyfile and restart Caddy`);
		return false;
	}
	replace(host, current, 'http://127.0.0.1:8080', '127.0.0.1');
	return true;
}

/**
 * Right after the installer installs the caddy package itself: its stock file is replaced
 * unconditionally; the caller enables and restarts Caddy.
 */
export function freshPackageCaddyfile(host: Pick<CaddyfileHost, 'path' | 'log' | 'now'>): boolean {
	const current = existsSync(host.path) ? readFileSync(host.path, 'utf8') : '';
	if (adminOnUnixSocket(current)) return false;
	if (current) {
		const backup = backUp(host.path, host.now ?? Date.now);
		host.log(`backed up the package's ${host.path} to ${backup}`);
	}
	const tmp = `${host.path}.yoal-new`;
	writeFileSync(tmp, bootstrapCaddyfile(':80'), { mode: 0o644 });
	renameSync(tmp, host.path);
	return true;
}
