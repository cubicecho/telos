import { randomUUID } from 'node:crypto';
import { apiKey } from '@better-auth/api-key';
import * as dbSchema from '@telos/db/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, magicLink } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { appUrl, authSecret } from './config.ts';
import type { Actor } from './context.ts';

// Sessions, magic links and API keys, all through better-auth. The server
// mounts none of better-auth's REST routes: the GraphQL mutations in
// resolvers/auth.ts call `auth.api` directly, and the bearer plugin is what
// lets a request carry its session as `Authorization: Bearer <token>`.

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite)
type AnyDb = any;

/** Sessions last as long as the hand-rolled tokens they replaced did. */
const SESSION_SECONDS = 30 * 24 * 60 * 60;

/** What the API keys this server mints start with, so a leaked one is recognisable. */
export const API_KEY_PREFIX = 'telos_';

// One-slot mailboxes for handing a magic token back in the API response.
// `signInMagicLink` awaits `sendMagicLink` inline, so `requestMagicLink`
// registers a capture id, the callback deposits the token in it, and the
// mutation reads it back out.
const tokenCaptures = new Map<string, string>();

export function createAuth(db: AnyDb) {
  return betterAuth({
    // The rc drizzle instance is keyed by relations rather than tables, so the
    // adapter cannot discover models itself: map better-auth's names onto ours.
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: dbSchema.users,
        session: dbSchema.sessions,
        account: dbSchema.accounts,
        verification: dbSchema.verifications,
        apikey: dbSchema.apikeys,
      },
    }),
    secret: authSecret(),
    baseURL: appUrl(),
    // Every id column is a uuid, and existing users keep theirs.
    advanced: { database: { generateId: 'uuid' } },
    session: { expiresIn: SESSION_SECONDS },
    plugins: [
      apiKey({ enableMetadata: true, defaultPrefix: API_KEY_PREFIX }),
      bearer(),
      magicLink({
        expiresIn: 15 * 60,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, token, metadata }) => {
          const captureId = metadata?.captureId;
          if (typeof captureId === 'string' && tokenCaptures.has(captureId)) {
            tokenCaptures.set(captureId, token);
          }
          // Telos ships no mail provider, so the console is the delivery channel.
          console.log(`\n[auth] Magic link for ${email}:\n${magicLinkUrl(token)}\n`);
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** The app's verify screen, which hands the token to `verifyMagicLink`. */
export function magicLinkUrl(token: string): string {
  return `${appUrl()}/auth/verify?token=${encodeURIComponent(token)}`;
}

/**
 * Sends a magic link and returns its token. The token is only ever handed to
 * a caller that is allowed to see it (magicLinkExposed), so it is captured
 * every time and dropped by the resolver otherwise.
 */
export async function requestMagicToken(auth: Auth, email: string): Promise<string | null> {
  const captureId = randomUUID();
  tokenCaptures.set(captureId, '');
  try {
    await auth.api.signInMagicLink({ body: { email, metadata: { captureId } }, headers: new Headers() });
    return tokenCaptures.get(captureId) || null;
  } finally {
    tokenCaptures.delete(captureId);
  }
}

/** Consumes a magic token and opens a session. Null for a bad or expired token. */
export async function verifyMagicToken(auth: Auth, token: string): Promise<{ token: string; userId: string } | null> {
  try {
    const result = await auth.api.magicLinkVerify({ query: { token }, headers: new Headers() });
    return { token: result.token, userId: result.user.id };
  } catch {
    // A bad token is answered with a redirect to an error URL, which arrives
    // here as a thrown response. Every failure means the same thing.
    return null;
  }
}

/**
 * Opens a session for an address with no link to follow, creating the account
 * on first use. Only for AUTH_MAGIC_LINK=false; see config.ts.
 */
export async function signInDirectly(auth: Auth, email: string): Promise<{ token: string; userId: string }> {
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  const user =
    found?.user ??
    (await ctx.internalAdapter.createUser({ email, name: '', emailVerified: false }, { method: 'magic-link' }));
  const session = await ctx.internalAdapter.createSession(user.id);
  return { token: session.token, userId: user.id };
}

/**
 * Mints an API key for a user. Server-side, which is what allows setting the
 * owner and turning off the plugin's per-key rate limit (10 requests a day by
 * default, which would starve any real client). Returns the plaintext key,
 * which is never stored and so exists only in this return value.
 */
export async function mintApiKey(
  auth: Auth,
  input: { userId: string; name: string; expiresInDays?: number | null | undefined },
): Promise<{ id: string; key: string }> {
  const created = await auth.api.createApiKey({
    body: {
      userId: input.userId,
      name: input.name,
      rateLimitEnabled: false,
      ...(input.expiresInDays ? { expiresIn: input.expiresInDays * 24 * 60 * 60 } : {}),
    },
  });
  return { id: created.id, key: created.key };
}

export const ANONYMOUS: Actor = { kind: 'anonymous', userId: null };

/**
 * Who a request is. An `x-api-key` wins over a session, and resolves only while
 * AI is on for both the instance (`ai`) and the key's owner: a key is the AI
 * door, and a user who turned AI off has closed it. A key that fails any check
 * is anonymous rather than an error, so the caller gets UNAUTHENTICATED from
 * the first field that needs a user.
 */
export async function resolveActor(auth: Auth, db: AnyDb, headers: Headers, options: { ai: boolean }): Promise<Actor> {
  const key = headers.get('x-api-key');
  if (key) {
    if (!options.ai) return ANONYMOUS;
    const result = await auth.api.verifyApiKey({ body: { key } }).catch(() => null);
    if (!result?.valid || !result.key) return ANONYMOUS;
    const userId = result.key.referenceId;
    const [owner] = await db
      .select({ aiEnabled: dbSchema.users.aiEnabled })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, userId));
    if (!owner?.aiEnabled) return ANONYMOUS;
    return { kind: 'apiKey', userId, keyId: result.key.id };
  }

  // Case-sensitive on purpose: it is what the client sends, and the bearer
  // plugin would otherwise be the only thing deciding what counts.
  if (headers.get('authorization')?.startsWith('Bearer ')) {
    const session = await auth.api.getSession({ headers }).catch(() => null);
    if (session) return { kind: 'user', userId: session.user.id };
  }

  return ANONYMOUS;
}

/** Express's header bag as a fetch `Headers`, which is what better-auth reads. */
export function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  return headers;
}
