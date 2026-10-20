// Environment checks that must run before anything opens a connection or signs a
// token. Imported for its side effects as the very first import of index.ts, so
// a misconfigured instance fails with a sentence rather than a stack trace.

import { isPrivateHost } from '@telos/db/ssl';
import {
  allowsPublicLocalNet,
  appUrl,
  configuredAuthSecret,
  describeWeakSecret,
  OIDC_CLIENT_AUTH_METHODS,
  secureLocalNet,
} from './config.ts';

function fatal(message: string): never {
  console.error(`[preflight] ${message}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  fatal('DATABASE_URL is required. Copy .env.example to .env, then run `npm run db:up` for a local Postgres.');
}

// Renamed in 6.0.0. Ignoring the old names would be worse than refusing them:
// an old AUTH_SECRET would silently sign with the development secret, and an old
// AUTH_MAGIC_LINK=false would leave nobody able to sign in, with no clue why.
const RENAMED = [
  { from: 'AUTH_SECRET', to: 'Rename it to BETTER_AUTH_SECRET.' },
  { from: 'JWT_SECRET', to: 'Rename it to BETTER_AUTH_SECRET.' },
  { from: 'AUTH_MAGIC_LINK', to: 'Use SECURE_LOCAL_NET=true in place of AUTH_MAGIC_LINK=false, or remove it.' },
  {
    from: 'EXPOSE_MAGIC_LINK',
    to: 'Links are only emailed now: set SMTP_URL, sign in through an OIDC provider, or use SECURE_LOCAL_NET on a private network.',
  },
];
for (const { from, to } of RENAMED) {
  if (process.env[from] !== undefined) fatal(`${from} is no longer read. ${to}`);
}

if (process.env.NODE_ENV === 'production') {
  // Sessions are signed with this. A known or guessable secret means anyone can forge one.
  const weakness = describeWeakSecret(configuredAuthSecret());
  if (weakness !== undefined) {
    fatal(`BETTER_AUTH_SECRET ${weakness}. Set a strong random value: generate one with \`openssl rand -hex 32\`.`);
  }
}

if (secureLocalNet()) {
  const hostname = new URL(appUrl()).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // With SECURE_LOCAL_NET, typing any address signs in as that account.
  if (!isPrivateHost(hostname) && !allowsPublicLocalNet()) {
    fatal(
      `SECURE_LOCAL_NET is on but APP_URL (${appUrl()}) is not a private address. Turn it off, or set I_KNOW_SECURE_LOCAL_NET_IS_PUBLIC=true if nothing hostile can reach this port.`,
    );
  }
}

// Half an OIDC setup would leave the login page without its button and no
// clue why; a typo in the issuer would only show up as a skipped provider.
const oidcIssuer = process.env.OIDC_ISSUER?.trim();
const oidcClientId = process.env.OIDC_CLIENT_ID?.trim();
if (Boolean(oidcIssuer) !== Boolean(oidcClientId)) {
  fatal('OIDC_ISSUER and OIDC_CLIENT_ID go together: set both to sign in with an OIDC provider, or neither.');
}
if (oidcIssuer && !URL.canParse(oidcIssuer)) {
  fatal(`OIDC_ISSUER is not a URL: ${oidcIssuer}`);
}
// The audience is the protected-resource metadata's `resource`, which RFC 9728 makes a URL.
const oidcApiAudience = process.env.OIDC_API_AUDIENCE?.trim();
if (oidcApiAudience && !URL.canParse(oidcApiAudience)) {
  fatal(`OIDC_API_AUDIENCE is not a URL: ${oidcApiAudience}`);
}
const oidcClientAuth = process.env.OIDC_CLIENT_AUTH?.trim();
if (oidcClientAuth && !(OIDC_CLIENT_AUTH_METHODS as readonly string[]).includes(oidcClientAuth)) {
  fatal(`OIDC_CLIENT_AUTH must be one of ${OIDC_CLIENT_AUTH_METHODS.join(', ')}.`);
}
