/**
 * Absolute URL for a deployed content host.
 *
 * Production content is HTTPS on port 443. Loopback hosts (`localhost` and any RFC 6761
 * `*.localhost` subdomain) are development-only, so they reuse the platform origin's scheme and
 * port: `bun run dev` serves them on the same Vite port over HTTP.
 *
 * An install without TLS (the installer's IP-only default: platform `http://<server-ip>`, sites on
 * `<name>.<ip>.sslip.io` port 80) serves content over plain HTTP too, so its URLs say `http://`.
 * A loopback platform origin is a dev control plane and does not count: its real content domains
 * stay HTTPS.
 */
export function contentUrl(platformOrigin: string, host: string): string {
	const normalized = host
		.trim()
		.toLowerCase()
		.replace(/\.$/, '');
	const loopback = normalized === 'localhost' || normalized.endsWith('.localhost');
	if (loopback) {
		try {
			const platform = new URL(platformOrigin);
			const port = platform.port ? `:${platform.port}` : '';
			return `${platform.protocol}//${normalized}${port}`;
		} catch {
			// Invalid platform origin (e.g. a build-time placeholder): use the dev default.
		}
	}
	return `${tlsOffInstall(platformOrigin) ? 'http' : 'https'}://${normalized}`;
}

/** A plain-HTTP platform origin on a non-loopback host: Caddy serves everything on port 80. */
function tlsOffInstall(platformOrigin: string): boolean {
	try {
		const platform = new URL(platformOrigin);
		if (platform.protocol !== 'http:') return false;
		const host = platform.hostname;
		return !(host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host));
	} catch {
		return false;
	}
}
