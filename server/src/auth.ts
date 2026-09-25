import { randomUUID } from 'node:crypto';
import { apiKey } from '@better-auth/api-key';
import * as dbSchema from '@telos/db/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, magicLink } from 'better-auth/plugins';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { appUrl, authSecret } from './config.ts';
import type { Actor } from './context.ts';
import { readRunToken, runnerKeyMatches } from './run-tokens.ts';

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

export interface ActorOptions {
  /** The instance's AI switch. Off, only a session resolves. */
  ai: boolean;
  /** The runner's key (config.ts `runnerKey`). Unset, nobody is the system principal. */
  runnerKey?: string | null | undefined;
}

/**
 * Who a request is. The AI credentials resolve only while the instance has AI
 * on, and each is checked against the switches below it every time:
 *
 * - `x-runner-key`: the runner, as the system principal. It owns no rows and
 *   may call only the runner's own mutations (resolvers/actor-lock.ts).
 * - `x-run-token`: an agent at work, for exactly as long as its run is live
 *   and its user, project and todo are all still open to AI.
 * - `x-api-key`: an MCP client, while its owner has AI on.
 *
 * A credential that fails any check is anonymous rather than an error, so the
 * caller gets UNAUTHENTICATED from the first field that needs a user.
 */
export async function resolveActor(auth: Auth, db: AnyDb, headers: Headers, options: ActorOptions): Promise<Actor> {
  const runner = headers.get('x-runner-key');
  if (runner) {
    return options.ai && runnerKeyMatches(runner, options.runnerKey) ? { kind: 'system', userId: null } : ANONYMOUS;
  }

  const runToken = headers.get('x-run-token');
  if (runToken) {
    const runId = options.ai ? readRunToken(runToken) : null;
    return runId ? await resolveRun(db, runId) : ANONYMOUS;
  }

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

/**
 * The agent working a run, while the run may still act: running, inside its
 * lease, not asked to stop, and every AI switch over it still on.
 *
 * @param db The database.
 * @param runId The run a token named.
 * @returns The agent actor, or anonymous.
 */
async function resolveRun(db: AnyDb, runId: string): Promise<Actor> {
  const [row] = await db
    .select({ userId: dbSchema.runs.userId })
    .from(dbSchema.runs)
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.runs.userId))
    .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.runs.projectId))
    .innerJoin(dbSchema.todos, eq(dbSchema.todos.id, dbSchema.runs.todoId))
    .where(
      and(
        eq(dbSchema.runs.id, runId),
        eq(dbSchema.runs.status, 'running'),
        gt(dbSchema.runs.leaseExpiresAt, new Date()),
        isNull(dbSchema.runs.cancelRequestedAt),
        eq(dbSchema.users.aiEnabled, true),
        eq(dbSchema.projects.aiEnabled, true),
        eq(dbSchema.todos.aiIgnored, false),
      ),
    );
  return row ? { kind: 'agent', userId: row.userId, runId } : ANONYMOUS;
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
