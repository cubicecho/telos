import type { DB } from '@telos/db';
import { extendSchema, GraphQLError, type GraphQLSchema, parse } from 'graphql';
import type { QueryResolvers } from '../../__generated__/resolvers.ts';
import { secureLocalNet } from '../core/config.ts';
import type { Context } from '../core/context.ts';
import { forbidden } from '../core/errors.ts';
import { attachResolvers } from '../graphql/attach-resolvers.ts';
import { SSO_START_PATH } from '../http/sso.ts';
import { instanceAiOn } from '../instance/settings.ts';
import { effectiveOidc } from '../sso/settings.ts';
import { sendsMagicLinks } from './better-auth.ts';

// What this instance offers, and who a request is. Signing in is better-auth's
// own `signInMagicLink` and `magicLinkVerify`, served by auth/endpoints.ts.

const AUTH_SDL = parse(`
  "What this instance offers, readable before signing in."
  type AuthConfig {
    "Any email address signs in at once, with no link (SECURE_LOCAL_NET). Private networks only."
    secureLocalNet: Boolean!
    "Whether the instance can email sign-in links (SMTP_URL is set)."
    magicLink: Boolean!
    "Whether AI is on for the instance: offered, and switched on by an admin. Off, the app shows no AI surface."
    ai: Boolean!
    "Whether the server offers AI at all (AI_ENABLED is not false), so an admin has a switch to flip."
    aiAvailable: Boolean!
    "The OIDC provider to sign in with (OIDC_ISSUER, or paired from the app), or null when there is none."
    sso: SsoProvider
  }

  "An OpenID Connect provider the login page offers."
  type SsoProvider {
    "What the button calls it (OIDC_NAME, or the name in the setup URL)."
    name: String!
    "Where the button sends the browser, on the API's origin. A path, not a URL: the app prefixes the API's address, which in development it works out from the page's own host."
    signInPath: String!
  }

  extend type Query {
    authConfig: AuthConfig!
  }
`);

export function requireAuth(ctx: Context): string {
  if (!ctx.userId) {
    throw new GraphQLError('Unauthenticated', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  return ctx.userId;
}

/**
 * Only a person signed in with a session. An API key acts for its owner but
 * may not manage the account itself: a leaked key that could mint its own
 * successor would outlive being revoked.
 */
export function requireSession(ctx: Context): string {
  const userId = requireAuth(ctx);
  if (ctx.actor.kind !== 'user') {
    throw forbidden('Only a signed-in person can do this');
  }
  return userId;
}

/**
 * The login page's OIDC button, when there is a provider: the environment's,
 * or one paired from the app. Read afresh, so a pairing shows without a restart.
 *
 * @param db The database.
 * @returns The button, or null.
 */
export async function ssoProvider(db: DB) {
  const { config } = await effectiveOidc(db);
  return config ? { name: config.name, signInPath: SSO_START_PATH } : null;
}

/**
 * What the instance offers, as `authConfig` answers it.
 *
 * @param context - The request, for its auth instance and database.
 * @param ai - Whether AI is on for the instance, as the caller has worked it out.
 * @param aiAvailable - Whether the server offers AI at all.
 * @returns The `AuthConfig`.
 */
export async function authConfigFor(context: Context, ai: boolean, aiAvailable: boolean) {
  return {
    secureLocalNet: secureLocalNet(),
    magicLink: sendsMagicLinks(context.auth),
    ai,
    aiAvailable,
    sso: await ssoProvider(context.db),
  };
}

export function applyAuthExtension(schema: GraphQLSchema, options: { ai: boolean }): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AUTH_SDL);
  const queries: QueryResolvers = {};
  queries.authConfig = async (_parent, _args, context) =>
    authConfigFor(context, options.ai && (await instanceAiOn(context.db)), options.ai);

  return attachResolvers(extendedSchema, { Query: queries });
}
