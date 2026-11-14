import { randomBytes } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { createUsageAuth, type UsageAuth } from './auth.ts';
import type { UsageConfig } from './config.ts';
import { handleDashboardRequest, sessionUser } from './dashboard-api.ts';
import { handleUsageRequest, RateLimiter } from './http.ts';
import { UsageStore } from './store.ts';
import app from './ui/index.html';

/**
 * Run the collector and its operator dashboard (docs/USAGE-ANALYTICS.md).
 *
 * One Bun process, one SQLite file in WAL mode. It holds the pings, the installs and Better
 * Auth's tables. It listens on loopback behind Caddy like every other Yoal service, so TLS and
 * the public hostname are Caddy's job. The dashboard is a React app that Bun bundles from
 * `ui/index.html`. Every dashboard path serves it, and everything else is the JSON API.
 */

export interface UsageServer {
	server: ReturnType<typeof Bun.serve>;
	store: UsageStore;
	usageAuth: UsageAuth;
	db: Database;
	stop(): void;
}

/** Dashboard pages; the client router picks the screen. */
export const DASHBOARD_PATHS = ['/', '/login', '/setup', '/installs', '/account', '/users'] as const;

export async function startUsageServer(
	config: UsageConfig,
	options: { development?: boolean } = {}
): Promise<UsageServer> {
	const db = new Database(config.dbPath, { create: true });
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA synchronous = NORMAL');
	db.run('PRAGMA busy_timeout = 5000');
	const store = new UsageStore(db, config.retentionDays);
	// A restart should not delete anything; the window is the retention policy.
	store.prune();

	const log = (message: string) => console.log(`[usage] ${message}`);
	const usageAuth = await createUsageAuth(db, config);

	// Until someone has set the dashboard up, `/setup` takes a token. One from the environment is
	// used as given; otherwise a fresh one is made at each boot and only ever written to the log.
	let setupToken: string | null = null;
	if (usageAuth.userCount() === 0) {
		setupToken = config.setupToken ?? randomBytes(32).toString('base64url');
		log(
			config.setupToken
				? `no operator account yet: open ${config.publicUrl}/setup with YOAL_USAGE_SETUP_TOKEN`
				: `no operator account yet: open ${config.publicUrl}/setup and enter the setup token ${setupToken}`
		);
	}

	const limiter = new RateLimiter(60, 60_000);
	const sessionAllowed = async (request: Request) => (await sessionUser(usageAuth, request))?.secondFactor ?? false;
	const routes = Object.fromEntries(DASHBOARD_PATHS.map((path) => [path, app]));

	const server = Bun.serve({
		hostname: config.host,
		port: config.port,
		development: options.development ?? false,
		// The collector never needs a large request; refuse before buffering it.
		maxRequestBodySize: 64 * 1024,
		routes,
		fetch: async (request) => {
			try {
				const dashboard = await handleDashboardRequest(request, {
					store,
					usageAuth,
					publicUrl: config.publicUrl,
					setupToken: () => setupToken,
					onSetupComplete: () => {
						setupToken = null;
					},
					trustProxy: config.trustProxy,
					log
				});
				if (dashboard) return dashboard;
				return await handleUsageRequest(request, {
					store,
					version: config.version,
					adminToken: config.adminToken,
					trustProxy: config.trustProxy,
					limiter,
					log,
					sessionAllowed
				});
			} catch (error) {
				// A failure to handle one request must never take the collector down.
				log(`request failed: ${(error as Error).name}: ${(error as Error).message || "(no message)"}`);
				return new Response(JSON.stringify({ error: 'internal_error' }), {
					status: 500,
					headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
				});
			}
		}
	});

	return {
		server,
		store,
		usageAuth,
		db,
		stop() {
			server.stop();
			db.close();
		}
	};
}
