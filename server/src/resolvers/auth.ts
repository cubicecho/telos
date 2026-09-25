import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { magicLinkUrl, requestMagicToken, signInDirectly, verifyMagicToken } from '../auth.ts';
import { magicLinkExposed, magicLinkRequired } from '../config.ts';
import type { Context } from '../context.ts';
import { instanceAiOn } from '../instance.ts';
import { createRateLimiter } from '../rate-limit.ts';

// Five sign-in attempts per address per quarter hour. requestMagicLink is
// unauthenticated, so without this anyone who can reach the port can mint magic
// tokens at will. Per-IP limiting belongs in the reverse proxy, which is the
// only thing that reliably knows the client's address.
const signInLimiter = createRateLimiter(5, 15 * 60 * 1000);

const AUTH_SDL = parse(`
  """
  The outcome of a sign-in request. When the instance runs with
  AUTH_MAGIC_LINK=false there is no link to follow, so a live session comes back
  immediately in \`token\`/\`userId\`. When magic links are on, \`magicLink\` is
  filled in only where exposing it is enabled.
  """
  type RequestMagicLinkResult {
    ok: Boolean!
    magicLink: String
    token: String
    userId: ID
  }

  type AuthPayload {
    token: String!
    userId: ID!
  }

  "What this instance offers, readable before signing in."
  type AuthConfig {
    "Whether AI is on for the instance: offered, and switched on by an admin. Off, the app shows no AI surface."
    ai: Boolean!
    "Whether the server offers AI at all (AI_ENABLED is not false), so an admin has a switch to flip."
    aiAvailable: Boolean!
  }

  extend type Query {
    authConfig: AuthConfig!
  }

  extend type Mutation {
    requestMagicLink(email: String!): RequestMagicLinkResult!
    verifyMagicLink(token: String!): AuthPayload!
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

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Only a person signed in with a session. An API key acts for its owner but
 * may not manage the account itself: a leaked key that could mint its own
 * successor would outlive being revoked.
 */
export function requireSession(ctx: Context): string {
  const userId = requireAuth(ctx);
  if (ctx.actor.kind !== 'user') {
    throw new GraphQLError('Only a signed-in person can do this', { extensions: { code: 'FORBIDDEN' } });
  }
  return userId;
}

export function applyAuthExtension(schema: GraphQLSchema, options: { ai: boolean }): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AUTH_SDL);
  const queryType = extendedSchema.getType('Query') as GraphQLObjectType;
  queryType.getFields().authConfig.resolve = async (_parent: unknown, _args: unknown, context: Context) => ({
    ai: options.ai && (await instanceAiOn(context.db)),
    aiAvailable: options.ai,
  });

  const mutationType = extendedSchema.getType('Mutation') as GraphQLObjectType;
  const fields = mutationType.getFields();

  fields.requestMagicLink.resolve = async (_parent: unknown, args: { email: string }, context: Context) => {
    const email = normalizeEmail(args.email);
    if (!signInLimiter.allow(email)) {
      throw new GraphQLError('Too many sign-in attempts. Try again in a few minutes.', {
        extensions: { code: 'TOO_MANY_REQUESTS' },
      });
    }

    // No-link mode: the address alone is the credential. Only ever appropriate
    // on a private instance — see config.ts and the README's "Before you expose
    // it".
    if (!magicLinkRequired()) {
      const session = await signInDirectly(context.auth, email);
      console.log(`[auth] Magic links are off; signed ${email} in directly.`);
      return { ok: true, magicLink: null, ...session };
    }

    // The link itself is logged by auth.ts, which is the delivery channel.
    const token = await requestMagicToken(context.auth, email);
    const magicLink = token && magicLinkExposed() ? magicLinkUrl(token) : null;
    return { ok: true, magicLink, token: null, userId: null };
  };

  fields.verifyMagicLink.resolve = async (_parent: unknown, args: { token: string }, context: Context) => {
    // Registration is open: the first verified link for an address creates its
    // account. Self-hosting is the deployment model, so whoever can reach the
    // instance is meant to have one.
    const session = await verifyMagicToken(context.auth, args.token);
    if (!session) {
      throw new GraphQLError('Invalid or expired magic link', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    return session;
  };

  return extendedSchema;
}
