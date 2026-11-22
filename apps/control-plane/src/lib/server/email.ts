import type { EmailTransport } from '@yoal/core';
import { platformMail } from './platform-mail';

/** Yoal Email when a mail node can take it, else the SMTP relay, else the journal (D238). */
function emailTransport(): EmailTransport {
	return platformMail;
}

/**
 * Magic-link lifetime, passed to Better Auth's plugin (auth.ts) so the email can't promise a
 * different window than the link really has. Better Auth's own default is 5 minutes.
 */
export const MAGIC_LINK_TTL_SECONDS = 10 * 60;

export async function sendMagicLinkEmail(email: string, url: string): Promise<void> {
	await emailTransport().send({
		to: email,
		subject: 'Sign into your cloud',
		tags: { yoal: 'sign-in' },
		text: `Sign into your cloud: ${url}\n\nThis link expires in ${MAGIC_LINK_TTL_SECONDS / 60} minutes. If you didn't request it, ignore this email.`
	});
}

/** `ttlSeconds` is the link's real lifetime (auth.ts passes `PASSWORD_RESET_TTL_SECONDS`). */
export async function sendPasswordResetEmail(
	email: string,
	url: string,
	ttlSeconds: number
): Promise<void> {
	await emailTransport().send({
		to: email,
		subject: 'Reset your Yoal password',
		tags: { yoal: 'password-reset' },
		text:
			`Someone asked to reset the password for ${email} on Yoal. To choose a new password, open:\n\n${url}\n\n` +
			`The link works once and expires in ${Math.round(ttlSeconds / 60)} minutes. Resetting signs you out everywhere. ` +
			`If you didn't ask for this, ignore this email: your password stays the same.`
	});
}

export async function sendInviteEmail(email: string, orgName: string, url: string): Promise<void> {
	await emailTransport().send({
		to: email,
		subject: `You're invited to ${orgName} on Yoal`,
		tags: { yoal: 'invite' },
		text: `Join ${orgName} on Yoal: ${url}`
	});
}

export { emailTransport };
