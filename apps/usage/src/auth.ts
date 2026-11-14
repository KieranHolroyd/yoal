import { timingSafeEqual } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { passkey } from '@better-auth/passkey';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { admin, twoFactor } from 'better-auth/plugins';
import type { UsageConfig } from './config.ts';

/**
 * Operator sign-in for the analytics dashboard (Better Auth 1.7, the same version as the control
 * plane).
 *
 * - Email and password, with public sign-up off. The first account is made on `/setup` with the
 *   setup token. Admins add everyone after that.
 * - A second factor (authenticator app or passkey) is required before any data is shown, and
 *   before any admin action.
 * - Roles: `admin` manages accounts. `user` (shown as "viewer") reads the dashboard.
 * - Cookies are `__Host-` and Secure on HTTPS. Better Auth's limiter is on, keyed by the
 *   `X-Forwarded-For` address Caddy sets, with tighter limits on the credential endpoints.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export async function createUsageAuth(db: Database, config: UsageConfig) {
	const secure = config.publicUrl.startsWith('https://');
	const rpID = new URL(config.publicUrl).hostname;

	const hasSecondFactor = (userId: string, twoFactorEnabled?: boolean | null): boolean => {
		if (twoFactorEnabled) return true;
		try {
			return (db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM passkey WHERE userId = ?').get(userId)?.count ?? 0) > 0;
		} catch {
			return false;
		}
	};

	const options = {
		appName: 'Yoal Analytics',
		baseURL: config.publicUrl,
		basePath: '/api/auth',
		secret: config.authSecret,
		database: db,
		telemetry: { enabled: false },
		trustedOrigins: [config.publicUrl],
		emailAndPassword: {
			enabled: true,
			disableSignUp: true,
			minPasswordLength: MIN_PASSWORD_LENGTH,
			maxPasswordLength: MAX_PASSWORD_LENGTH,
			revokeSessionsOnPasswordReset: true
		},
		session: {
			expiresIn: 7 * 24 * 60 * 60,
			updateAge: 24 * 60 * 60,
			freshAge: 15 * 60
		},
		rateLimit: {
			enabled: true,
			storage: 'memory' as const,
			window: 60,
			max: 120,
			customRules: {
				'/sign-in/email': { window: 60, max: 5 },
				'/two-factor/verify-totp': { window: 60, max: 5 },
				'/two-factor/verify-backup-code': { window: 60, max: 5 },
				'/passkey/verify-authentication': { window: 60, max: 10 },
				'/change-password': { window: 60, max: 5 }
			}
		},
		advanced: {
			cookiePrefix: secure ? '__Host-yoal-ae' : 'yoal-ae',
			useSecureCookies: secure,
			ipAddress: { ipAddressHeaders: config.trustProxy ? ['x-forwarded-for'] : ['x-real-ip'] }
		},
		hooks: {
			// Account management is only for an admin who has proved a second factor in this account.
			before: createAuthMiddleware(async (ctx) => {
				if (!ctx.path.startsWith('/admin/')) return;
				// Server-side calls (the first admin from `/setup`) carry no HTTP request.
				if (!ctx.request) return;
				const session = await getSessionFromCtx(ctx);
				if (!session) throw new APIError('UNAUTHORIZED');
				const user = session.user as { id: string; role?: string | null; twoFactorEnabled?: boolean | null };
				if (user.role !== 'admin') throw new APIError('FORBIDDEN', { message: 'Only admins manage accounts.' });
				if (!hasSecondFactor(user.id, user.twoFactorEnabled))
					throw new APIError('FORBIDDEN', { message: 'Set up a second factor before managing accounts.' });
			})
		},
		plugins: [
			twoFactor({ issuer: 'Yoal Analytics' }),
			passkey({ rpID, rpName: 'Yoal Analytics', origin: config.publicUrl }),
			admin({ defaultRole: 'user', adminRoles: ['admin'] })
		]
	} satisfies BetterAuthOptions;

	// Create or update Better Auth's tables before the instance exists, so it never starts against
	// a missing schema. Additive only: it never drops a column.
	const { runMigrations } = await getMigrations(options);
	await runMigrations();
	const auth = betterAuth(options);

	return {
		auth,
		hasSecondFactor,
		userCount(): number {
			try {
				return db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM user').get()?.count ?? 0;
			} catch {
				return 0;
			}
		},
		/**
		 * The first account, made from `/setup`. Refused once any account exists, so a leaked token
		 * stops mattering the moment the dashboard is set up.
		 */
		async createFirstAdmin(input: { token: string; email: string; name: string; password: string }, setupToken: string | null) {
			if (this.userCount() > 0) return { ok: false as const, status: 409, error: 'already_set_up' };
			if (!setupToken || !tokenEqual(input.token, setupToken)) return { ok: false as const, status: 403, error: 'invalid_setup_token' };
			if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > MAX_PASSWORD_LENGTH)
				return { ok: false as const, status: 400, error: 'weak_password' };
			try {
				await auth.api.createUser({ body: { email: input.email, name: input.name, password: input.password, role: 'admin' } });
			} catch (error) {
				if (error instanceof APIError) return { ok: false as const, status: 400, error: 'invalid_setup' };
				throw error;
			}
			return { ok: true as const };
		}
	};
}

export type UsageAuth = Awaited<ReturnType<typeof createUsageAuth>>;

function tokenEqual(given: string, expected: string): boolean {
	const left = Buffer.from(given.trim());
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}
