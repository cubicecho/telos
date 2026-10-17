import {
  applyBetterAuthGraphQL,
  betterAuthGraphQL,
  type JsonSchema,
  type OperationOptions,
} from '@cubicecho/better-auth-graphql';
import type { DB } from '@telos/db';
import { GraphQLError, type GraphQLSchema } from 'graphql';
import { captureMagicToken, createAuth, magicLinkUrl, signInDirectly } from '../auth.ts';
import { magicLinkExposed, magicLinkRequired } from '../config.ts';
import type { Context } from '../context.ts';
import { badInput, forbidden } from '../errors.ts';
import { createRateLimiter } from '../rate-limit.ts';
import { requireKeyManager } from './api-keys.ts';

// better-auth's own endpoints, served as GraphQL by @cubicecho/better-auth-graphql:
// signing in with a magic link, a person's sessions, and minting and revoking
// API keys. The fields, their arguments and their types are read off the auth
// config, so a better-auth upgrade moves them with it. What telos adds goes in
// `operations` below: the rate limit and no-link mode on sign-in, and the AI
// switches over keys.
//
// Email and password is not configured, so its endpoints would only ever
// refuse. Listing keys and their tool switches stay with resolvers/api-keys.ts,
// which reads them beside the door's tools.

/** The better-auth endpoints served, by name. */
export const BETTER_AUTH_OPERATIONS = [
  'signInMagicLink',
  'magicLinkVerify',
  'verifyOneTimeToken',
  'getSession',
  'listSessions',
  'signOut',
  'revokeSession',
  'revokeSessions',
  'revokeOtherSessions',
];

/** Served only while the instance offers AI: keys are the AI door. */
export const BETTER_AUTH_KEY_OPERATIONS = ['createApiKey', 'deleteApiKey'];

// Five sign-in attempts per address per quarter hour. Signing in is
// unauthenticated, so without this anyone who can reach the port can mint magic
// tokens at will. Per-IP limiting belongs in the reverse proxy, which is the
// only thing that reliably knows the client's address.
const signInLimiter = createRateLimiter(5, 15 * 60 * 1000);

const NULLABLE_STRING: JsonSchema = { type: ['string', 'null'] };

/**
 * Sign-in. Takes only an address: where the link points is the app's verify
 * screen, always, and `metadata` is how the token is caught on its way out.
 *
 * The result says more than better-auth's `{ status }`. With
 * AUTH_MAGIC_LINK=false there is no link to follow, so a live session comes back
 * at once in `token`/`userId`. With links on, `magicLink` is filled in only
 * where exposing it is enabled.
 */
const signInMagicLink: OperationOptions<Context> = {
  omitArgs: ['name', 'metadata', 'callbackURL', 'newUserCallbackURL', 'errorCallbackURL'],
  result: (documented) => ({
    ...documented,
    type: 'object',
    properties: {
      ...documented?.properties,
      magicLink: { ...NULLABLE_STRING, description: 'The link itself, where exposing it is enabled.' },
      token: { ...NULLABLE_STRING, description: 'A live session, when magic links are off.' },
      userId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: "The session's user, when magic links are off.",
      },
    },
  }),
  around: async (call, next) => {
    const email = String(call.body.email).toLowerCase().trim();
    if (!signInLimiter.allow(email)) {
      throw new GraphQLError('Too many sign-in attempts. Try again in a few minutes.', {
        extensions: { code: 'TOO_MANY_REQUESTS' },
      });
    }
    call.body.email = email;

    // No-link mode: the address alone is the credential. Only ever appropriate
    // on a private instance — see config.ts and the README's "Before you expose
    // it".
    if (!magicLinkRequired()) {
      const session = await signInDirectly(call.context.auth, email);
      console.log(`[auth] Magic links are off; signed ${email} in directly.`);
      return { status: true, magicLink: null, ...session };
    }

    // The link itself is logged by auth.ts, which is the delivery channel.
    const { result, token } = await captureMagicToken((metadata) => {
      call.body.metadata = metadata;
      return next();
    });
    const magicLink = token && magicLinkExposed() ? magicLinkUrl(token) : null;
    return { ...(result as object), magicLink, token: null, userId: null };
  },
};

/**
 * The last leg of an OIDC sign-in: the app's /auth/sso screen spends the
 * one-time token routes/sso.ts put on its URL. Answers like `magicLinkVerify`,
 * with the session's bearer token, rather than better-auth's whole session row.
 */
const verifyOneTimeToken: OperationOptions<Context> = {
  result: () => ({
    type: 'object',
    properties: {
      token: { type: 'string', description: 'The session, to send as `Authorization: Bearer <token>`.' },
      userId: { type: 'string', format: 'uuid', description: "The session's user." },
    },
    required: ['token', 'userId'],
  }),
  around: async (_call, next) => {
    const result = (await next()) as { session: { token: string }; user: { id: string } };
    return { token: result.session.token, userId: result.user.id };
  },
};

/**
 * Minting a key: a name and how long it lasts, nothing better-auth keeps for
 * the server (its owner, limits, permissions). Only a person with AI on.
 */
const createApiKey: OperationOptions<Context> = {
  omitArgs: [
    'configId',
    'prefix',
    'remaining',
    'metadata',
    'refillAmount',
    'refillInterval',
    'rateLimitTimeWindow',
    'rateLimitMax',
    'rateLimitEnabled',
    'permissions',
    'userId',
    'organizationId',
  ],
  around: async (call, next) => {
    await requireKeyManager(call.context);
    const name = typeof call.body.name === 'string' ? call.body.name.trim() : '';
    if (!name) throw badInput('A key needs a name');
    call.body.name = name;
    return next();
  },
};

/** Revoking one of the caller's keys. Someone else's is NOT_FOUND. */
const deleteApiKey: OperationOptions<Context> = {
  omitArgs: ['configId'],
  around: async (call, next) => {
    await requireKeyManager(call.context);
    return next();
  },
};

/**
 * Adds the endpoints above. Each call goes to the request's own `auth` with
 * the request's headers, which is where better-auth finds the session.
 *
 * @param schema The schema so far.
 * @param db The database: the fields are described from an auth instance over it.
 * @param options `ai`: whether the server offers AI, and so API keys.
 * @returns The schema with them.
 */
export function applyBetterAuthExtension(schema: GraphQLSchema, db: DB, options: { ai: boolean }): GraphQLSchema {
  // Described from an instance with no OIDC provider: the fields are the same
  // either way, and describing one would fetch its discovery document.
  const built = betterAuthGraphQL<Context>(createAuth(db, { oidc: null }), {
    include: options.ai ? [...BETTER_AUTH_OPERATIONS, ...BETTER_AUTH_KEY_OPERATIONS] : BETTER_AUTH_OPERATIONS,
    auth: (ctx) => ctx.auth,
    headers: (ctx) => ctx.headers,
    // All of this is a person's: a key or a run token has no session, must not
    // reach the ones its user has, and must not mint its own successor.
    before: ({ context }) => {
      if (context.actor.kind !== 'user' && context.actor.kind !== 'anonymous') {
        throw forbidden('Only a signed-in person can do this');
      }
    },
    operations: { signInMagicLink, verifyOneTimeToken, createApiKey, deleteApiKey },
  });
  return applyBetterAuthGraphQL(schema, built);
}
