import * as z from 'zod';
import type { UsageAuth } from './auth.ts';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './auth.ts';
import { RateLimiter, clientAddress } from './http.ts';
import type { UsageStore } from './store.ts';

/**
 * The operator dashboard's JSON API (everything under `/api/v1/` except the public ingest and
 * health routes, plus Better Auth under `/api/auth/`).
 *
 * Every data route needs a signed-in account that has a second factor (authenticator app or
 * passkey). Without one the answer is 403 `second_factor_required`, and the UI sends the person to
 * Account to enrol. Writes check that the request came from the dashboard's own origin.
 */

export interface DashboardContext {
	store: UsageStore;
	usageAuth: UsageAuth;
	publicUrl: string;
	/** The current setup token; null once an account exists. */
	setupToken: () => string | null;
	/** Called after the first account is created, so the token is forgotten. */
	onSetupComplete: () => void;
	trustProxy: boolean;
	now?: () => number;
	limiter?: RateLimiter;
	log?: (message: string) => void;
}

export interface SessionUser {
	id: string;
	email: string;
	name: string;
	role: string;
	twoFactorEnabled: boolean;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const setupSchema = z.object({
	token: z.string().min(1).max(200),
	name: z.string().trim().min(1).max(100),
	email: z.string().trim().toLowerCase().email().max(254),
	password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH)
});

/** Setup attempts: a token is 43 random characters, but there is no reason to allow guessing. */
const setupLimiter = new RateLimiter(5, 60_000);

/** The signed-in person, or null. Never throws: a broken cookie is just "signed out". */
export async function sessionUser(usageAuth: UsageAuth, request: Request): Promise<{ user: SessionUser; secondFactor: boolean } | null> {
	try {
		const session = await usageAuth.auth.api.getSession({ headers: request.headers });
		if (!session) return null;
		const raw = session.user as { id: string; email: string; name: string; role?: string | null; twoFactorEnabled?: boolean | null };
		const user: SessionUser = {
			id: raw.id,
			email: raw.email,
			name: raw.name,
			role: raw.role ?? 'user',
			twoFactorEnabled: Boolean(raw.twoFactorEnabled)
		};
		return { user, secondFactor: usageAuth.hasSecondFactor(user.id, user.twoFactorEnabled) };
	} catch {
		return null;
	}
}

function sameOrigin(request: Request, publicUrl: string): boolean {
	const origin = request.headers.get('origin');
	if (origin) return origin === publicUrl;
	const fetchSite = request.headers.get('sec-fetch-site');
	return fetchSite === 'same-origin';
}

function windowDays(url: URL): number {
	const days = Number(url.searchParams.get('days') ?? '30');
	return Number.isInteger(days) && days >= 1 && days <= 400 ? days : 30;
}

/** Handle a dashboard route, or return null when the path is not one. */
export async function handleDashboardRequest(request: Request, ctx: DashboardContext): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;
	const now = ctx.now ?? Date.now;

	if (path === '/api/auth' || path.startsWith('/api/auth/')) return ctx.usageAuth.auth.handler(request);

	if (path === '/api/v1/session') {
		if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
		const signedIn = await sessionUser(ctx.usageAuth, request);
		return json({
			setupRequired: ctx.usageAuth.userCount() === 0,
			user: signedIn?.user ?? null,
			secondFactor: signedIn?.secondFactor ?? false
		});
	}

	if (path === '/api/v1/setup') {
		if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
		if (!sameOrigin(request, ctx.publicUrl)) return json({ error: 'cross_origin' }, 403);
		if (!(ctx.limiter ?? setupLimiter).take(`setup:${clientAddress(request, ctx.trustProxy)}`, now()))
			return json({ error: 'rate_limited' }, 429);
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return json({ error: 'invalid_json' }, 400);
		}
		const parsed = setupSchema.safeParse(body);
		if (!parsed.success) return json({ error: 'invalid_setup', issues: parsed.error.issues.map((issue) => issue.path.join('.')) }, 400);
		const result = await ctx.usageAuth.createFirstAdmin(parsed.data, ctx.setupToken());
		if (!result.ok) {
			ctx.log?.(`setup refused: ${result.error}`);
			return json({ error: result.error }, result.status);
		}
		ctx.onSetupComplete();
		ctx.log?.('the first operator account was created; setup is closed');
		return json({ ok: true }, 201);
	}

	const isData = path === '/api/v1/overview' || path === '/api/v1/installs';
	if (!isData) return null;
	if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
	const signedIn = await sessionUser(ctx.usageAuth, request);
	if (!signedIn) return json({ error: 'unauthorized' }, 401);
	if (!signedIn.secondFactor) return json({ error: 'second_factor_required' }, 403);

	if (path === '/api/v1/overview') {
		const days = windowDays(url);
		return json({ stats: ctx.store.stats(now(), days), daily: ctx.store.daily(now(), days) });
	}

	const limit = Number(url.searchParams.get('limit') ?? '50');
	const offset = Number(url.searchParams.get('offset') ?? '0');
	const version = url.searchParams.get('version')?.slice(0, 40) || null;
	return json(ctx.store.installs({ limit: Number.isFinite(limit) ? limit : 50, offset: Number.isFinite(offset) ? offset : 0, version }));
}
