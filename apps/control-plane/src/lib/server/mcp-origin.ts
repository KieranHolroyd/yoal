/**
 * Whether an install can serve MCP. MCP's OAuth resource must be HTTPS, or plain HTTP on a
 * loopback host for development (@better-auth/mcp refuses anything else at startup and would take
 * the whole control plane down). An IP-only install without TLS (`http://<server-ip>`, the
 * installer's default) therefore has no MCP.
 */
export function mcpCapableOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		if (url.protocol === 'https:') return true;
		if (url.protocol !== 'http:') return false;
		const host = url.hostname;
		return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
	} catch {
		return false;
	}
}
