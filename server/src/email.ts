import { createTransport } from 'nodemailer';
import type { MagicLink } from './auth.ts';
import { smtpFrom, smtpUrl } from './config.ts';
import { AUTH_DEFAULTS } from './defaults.ts';

/**
 * Emails a sign-in link through `SMTP_URL`. The link is never logged.
 *
 * @param link - The address, and the link to send it.
 * @returns Resolves once the SMTP server has accepted the message.
 */
export async function sendMagicLinkEmail({ email, url }: MagicLink): Promise<void> {
  const transport = createTransport(smtpUrl());
  await transport.sendMail({
    from: smtpFrom(),
    to: email,
    subject: 'Your Telos sign-in link',
    text: `Sign in to Telos:\n\n${url}\n\nThe link works once, for ${AUTH_DEFAULTS.magicLinkTtlMinutes} minutes. If you did not ask for it, ignore this email.`,
  });
}
