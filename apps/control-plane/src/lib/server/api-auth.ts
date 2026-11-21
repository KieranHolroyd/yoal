/** Public user-pool OIDC discovery and code flow (IAM.md §11.2): no session required. */
export const USER_POOL_PUBLIC_API = /^\/api\/v1\/user-pools\/[^/]+\/(?:oauth\/|\.well-known\/)/;

/**
 * `/api/v1/**` except endpoints that authenticate themselves: CLI code exchange, public user-pool
 * OIDC, Yoal Access sign-in, SSO routing, the Kubernetes log shipper and (W15) the external prober.
 * A path listed here must prove its own credential in its handler; hooks never requires a session.
 */
export function isAuthenticatedApi(pathname: string): boolean {
	if (pathname === '/api/v1') return true;
	return (
		pathname.startsWith('/api/v1/') &&
		pathname !== '/api/v1/cli/token' &&
		!USER_POOL_PUBLIC_API.test(pathname) &&
		// Yoal Access sign-in: the agent sends an unauthenticated browser here, and the handler
		// redirects to `/login` (IAM.md I25, §11.1).
		pathname !== '/api/v1/access/authorize' &&
		// `/login` asks this before a session exists (email → IdP routing).
		pathname !== '/api/v1/sso/resolve' &&
		// A cluster's log shipper authenticates with its own ingest token (docs/KUBERNETES.md K23).
		!pathname.startsWith('/api/v1/kubernetes-ingest/') &&
		// W15 external prober: the Bearer registration token is the only credential (no session).
		pathname !== '/api/v1/ha/prober/report'
	);
}
