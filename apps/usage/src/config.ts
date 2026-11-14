import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Configuration for the usage collector (docs/USAGE-ANALYTICS.md).
 *
 * The collector is a plain Bun process with one SQLite file. It is small on purpose: it receives
 * one validated ping per install per day, so a single process and one disk are enough for a very
 * large number of installs, and there is no second database to operate.
 *
 * The operator dashboard signs people in with Better Auth. Its secret is read from
 * `YOAL_USAGE_AUTH_SECRET` or, failing that, generated once and kept in the data directory, so a
 * fresh deploy needs no secret set up by hand and a restart never signs everyone out.
 */

export interface UsageConfig {
	host: string;
	port: number;
	dataDir: string;
	dbPath: string;
	/** Bearer token for `GET /api/v1/stats`. Without it only signed-in operators can read stats. */
	adminToken: string | null;
	/** Keep raw pings this long; installs and their latest state are kept indefinitely. */
	retentionDays: number;
	/** Behind Caddy, `X-Forwarded-For` carries the client address used for rate limiting. */
	trustProxy: boolean;
	/** The collector's own version, shown by `/healthz`. */
	version: string;
	/** Public origin of the dashboard (Better Auth's base URL, the passkey relying party). */
	publicUrl: string;
	/** Better Auth's signing secret. */
	authSecret: string;
	/**
	 * Token that unlocks creating the first account. From `YOAL_USAGE_SETUP_TOKEN`, or generated
	 * at boot (and logged) while no account exists. Null once someone has set the dashboard up.
	 */
	setupToken: string | null;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** Read the persisted secret, or create it (0600) on first boot. */
function persistedSecret(dataDir: string, name: string): string {
	const path = join(dataDir, name);
	if (existsSync(path)) {
		const value = readFileSync(path, 'utf8').trim();
		if (value.length >= 32) return value;
	}
	const value = randomBytes(32).toString('base64url');
	writeFileSync(path, `${value}\n`, { mode: 0o600 });
	return value;
}

export function loadUsageConfig(env: NodeJS.ProcessEnv = process.env): UsageConfig {
	// On Yoal the process app gets `PORT`, `HOST` and a private `$STATE_DIRECTORY`; the
	// collector's own variables win when set.
	const dataDir = env.YOAL_USAGE_DATA_DIR?.trim() || env.STATE_DIRECTORY?.split(':')[0]?.trim() || '/var/lib/yoal/usage';
	const dbPath = env.YOAL_USAGE_DB?.trim() || join(dataDir, 'usage.db');
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const port = integer(env.YOAL_USAGE_PORT ?? env.PORT, 8790, 1, 65_535);
	const publicUrl = (env.YOAL_USAGE_PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, '');
	const authSecret = env.YOAL_USAGE_AUTH_SECRET?.trim() || persistedSecret(dataDir, 'auth-secret');
	return {
		host: env.YOAL_USAGE_HOST?.trim() || env.HOST?.trim() || '127.0.0.1',
		port,
		dataDir,
		dbPath,
		adminToken: env.YOAL_USAGE_ADMIN_TOKEN?.trim() || null,
		retentionDays: integer(env.YOAL_USAGE_RETENTION_DAYS, 400, 30, 3_650),
		trustProxy: env.YOAL_USAGE_TRUST_PROXY !== '0',
		version: env.YOAL_USAGE_VERSION?.trim() || '0.2.0',
		publicUrl,
		authSecret,
		setupToken: env.YOAL_USAGE_SETUP_TOKEN?.trim() || null
	};
}
