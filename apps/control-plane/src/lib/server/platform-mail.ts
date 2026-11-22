import { ConsoleEmailTransport, PlatformMailTransport, SmtpEmailTransport } from '@yoal/core';
import { smtp } from './config';

/**
 * The one transport for the platform's own mail (D238): sign-in links, invites, password resets,
 * step-up codes and alerts. It sends through Yoal Email when a mail node can take the mail (and
 * Settings → Notifications doesn't pin the relay), else through the SMTP relay (`YOAL_SMTP_*`,
 * D22), else to the journal. `core.ts` attaches the email service once the core exists; this module
 * stays free of the core so `email.ts` can import it without a cycle.
 */
export const platformMail = new PlatformMailTransport(
	smtp ? new SmtpEmailTransport(smtp) : new ConsoleEmailTransport()
);
