import { passkeyClient } from '@better-auth/passkey/client';
import { adminClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Better Auth on the same origin, at `/api/auth` (see `src/auth.ts`). */
export const authClient = createAuthClient({
	plugins: [twoFactorClient(), passkeyClient(), adminClient()]
});

/** A Better Auth error as one readable sentence. */
export function authMessage(error: { message?: string; status?: number; code?: string } | null | undefined, fallback: string): string {
	if (!error) return fallback;
	if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
	return error.message || fallback;
}
