import type { DB } from '@telos/db';
import { extendSchema, GraphQLError, type GraphQLSchema, parse } from 'graphql';
import type { QueryResolvers } from '../../__generated__/resolvers.ts';
import { attachResolvers } from '../attach-resolvers.ts';
import type { Context } from '../context.ts';
import { forbidden } from '../errors.ts';
import { instanceAiOn } from '../instance.ts';
import { effectiveOidc } from '../oidc-settings.ts';
import { SSO_START_PATH } from '../routes/sso.ts';

// What this instance offers, and who a request is. Signing in is better-auth's
// own `signInMagicLink` and `magicLinkVerify`, served by resolvers/better-auth.ts.

const AUTH_SDL = parse(`
  "What this instance offers, readable before signing in."
  type AuthConfig {
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
    "Where the button sends the browser, on the API's origin."
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

export function applyAuthExtension(schema: GraphQLSchema, options: { ai: boolean }): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AUTH_SDL);
  const queries: QueryResolvers = {};
  queries.authConfig = async (_parent, _args, context) => ({
    ai: options.ai && (await instanceAiOn(context.db)),
    aiAvailable: options.ai,
    sso: await ssoProvider(context.db),
  });

  return attachResolvers(extendedSchema, { Query: queries });
}
