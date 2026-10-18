import {
  applyBetterAuthGraphQL,
  betterAuthGraphQL,
  type JsonSchema,
  type OperationOptions,
} from '@cubicecho/graphql-better-auth';
import type { DB } from '@telos/db';
import { GraphQLError, type GraphQLSchema } from 'graphql';
import { z } from 'zod';
import { createAuth, nameFor, sendsMagicLinks, signInOnLocalNet } from '../auth.ts';
import { secureLocalNet } from '../config.ts';
import type { Context } from '../context.ts';
import { badInput, forbidden } from '../errors.ts';
import { AuthFlow, throttle } from '../throttle.ts';
import { requireKeyManager } from './api-keys.ts';

// better-auth's own endpoints, served as GraphQL by @cubicecho/graphql-better-auth:
// signing in with a magic link, a person's sessions, and minting and revoking
// API keys. The fields, their arguments and their types are read off the auth
// config, so a better-auth upgrade moves them with it. What telos adds goes in
// `operations` below: the throttle and SECURE_LOCAL_NET on sign-in, errors that
// never sign anyone out, and the AI switches over keys.
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

/** What a link that cannot be spent is told, whichever way it is wrong. */
const BAD_LINK = 'Invalid or expired sign-in link.';

/** What a one-time token that cannot be spent is told: the sign-in has to be started again. */
const BAD_SSO_TOKEN = 'Invalid or expired sign-in. Sign in again.';

const emailInput = z.email('Enter a valid email address.');

const NULLABLE_STRING: JsonSchema = { type: ['string', 'null'] };

/**
 * Runs a token-spending call, and answers any refusal from better-auth with one message.
 *
 * BAD_USER_INPUT, never the UNAUTHENTICATED better-auth's 401 maps to: that one
 * is what the client drops its session on, and a bad link must not sign anyone
 * out. What is not a refusal (the database failing) is rethrown as it is.
 *
 * @param next - The call.
 * @param message - What the caller is told when the token is refused.
 * @returns What the call returned.
 */
async function refusedAs(next: () => Promise<unknown>, message: string): Promise<unknown> {
  try {
    return await next();
  } catch (error) {
    throw error instanceof GraphQLError ? badInput(message) : error;
  }
}

/**
 * Sign-in. Takes only an address: the link always goes to the app's verify
 * screen, and the account's first name is the address's local part. Under
 * SECURE_LOCAL_NET no link is sent and a live session comes back in
 * `token`/`userId`.
 */
const signInMagicLink: OperationOptions<Context> = {
  omitArgs: ['name', 'metadata', 'callbackURL', 'newUserCallbackURL', 'errorCallbackURL'],
  result: (documented) => ({
    ...documented,
    type: 'object',
    properties: {
      ...documented?.properties,
      token: { ...NULLABLE_STRING, description: 'A live session, under SECURE_LOCAL_NET.' },
      userId: { type: ['string', 'null'], format: 'uuid', description: "The session's user, under SECURE_LOCAL_NET." },
    },
  }),
  around: async (call, next) => {
    const normalized = String(call.body.email).toLowerCase().trim();
    // Unauthenticated, so without the limiter anyone who can reach the port can
    // bury an inbox in links, or walk through addresses.
    throttle(call.context, AuthFlow.SignInMagicLink, normalized);
    const email = parseEmail(normalized);

    // The network is the credential, so the address alone opens the account.
    if (secureLocalNet()) {
      return { status: true, ...(await signInOnLocalNet(call.context.auth, email)) };
    }
    if (!sendsMagicLinks(call.context.auth)) {
      throw badInput(
        'This instance cannot email sign-in links. Whoever runs it needs to set SMTP_URL, pair an OIDC provider, or set SECURE_LOCAL_NET on a private network.',
      );
    }
    call.body.email = email;
    call.body.name = nameFor(email);
    return { ...((await next()) as object), token: null, userId: null };
  },
};

/** Spends a sign-in link's token for a session. Expired, used and unknown tokens answer the same. */
const magicLinkVerify: OperationOptions<Context> = {
  around: (call, next) => {
    // By IP alone: until the token verifies there is no address to count against.
    throttle(call.context, AuthFlow.MagicLinkVerify);
    if (!sendsMagicLinks(call.context.auth)) throw badInput(BAD_LINK);
    return refusedAs(next, BAD_LINK);
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
  around: async (call, next) => {
    throttle(call.context, AuthFlow.VerifyOneTimeToken);
    const result = (await refusedAs(next, BAD_SSO_TOKEN)) as { session: { token: string }; user: { id: string } };
    return { token: result.session.token, userId: result.user.id };
  },
};

/** Ends the caller's session. Signing out with none is `success: false`, not an error. */
const signOut: OperationOptions<Context> = {
  // For a provider's logout page, which Telos does not send anyone to.
  omitArgs: ['callbackURL', 'disableRedirect', 'state'],
  around: async (call, next) => {
    const session = await call.context.auth.api.getSession({ headers: call.context.headers }).catch(() => null);
    if (session === null) return { success: false };
    return next();
  },
};

/**
 * Checks an address is one.
 *
 * @param email - The address, already normalized.
 * @returns The address.
 * @throws BAD_USER_INPUT when it is not an address.
 */
function parseEmail(email: string): string {
  const parsed = emailInput.safeParse(email);
  if (!parsed.success) throw badInput(parsed.error.issues[0]?.message ?? 'Enter a valid email address.');
  return parsed.data;
}

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
  // Described from an instance that always has the magic-link plugin, so the
  // fields do not depend on SMTP_URL, and no OIDC provider, whose discovery
  // document describing would fetch. A request's own instance is what is called.
  const describing = createAuth(db, { oidc: null, sendMagicLink: async () => {} });
  const built = betterAuthGraphQL<Context>(describing, {
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
    operations: { signInMagicLink, magicLinkVerify, verifyOneTimeToken, signOut, createApiKey, deleteApiKey },
  });
  return applyBetterAuthGraphQL(schema, built);
}
