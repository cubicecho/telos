import { apiKey } from '@better-auth/api-key';
import type { DB } from '@telos/db';
import * as dbSchema from '@telos/db/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, genericOAuth, magicLink, oneTimeToken } from 'better-auth/plugins';
import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  appLink,
  appUrl,
  authSecret,
  OIDC_PROVIDER_ID,
  type OidcConfig,
  oidcConfig,
  serverUrl,
  smtpConfigured,
} from './config.ts';
import type { Actor } from './context.ts';
import { AUTH_DEFAULTS } from './defaults.ts';
import { runToolsOff } from './door.ts';
import { sendMagicLinkEmail } from './email.ts';
import { claimFirstAdmin, instanceAiOn } from './instance.ts';
import { readRunToken, runnerKeyMatches } from './run-tokens.ts';

// Sessions, magic links, OIDC sign-in and API keys, all through better-auth.
// resolvers/better-auth.ts serves its endpoints as GraphQL fields that call
// `auth.api` directly, and the bearer plugin is what lets a request carry its
// session as `Authorization: Bearer <token>`. The one exception is OIDC, whose
// two browser redirects routes/sso.ts serves over HTTP.

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_DAY = 24 * 60 * 60;

/** better-auth's id for the magic-link plugin. */
const MAGIC_LINK_PLUGIN_ID = 'magic-link';

/** What the API keys this server mints start with, so a leaked one is recognisable. */
export const API_KEY_PREFIX = 'telos_';

/** What delivering one sign-in link is given. */
export interface MagicLink {
  email: string;
  /** The link to the app's verify screen, with the token in its query. */
  url: string;
  token: string;
}

/** Overrides for tests. Production uses the defaults. */
export interface AuthOptions {
  /** What better-auth signs with. The default is `authSecret()`. */
  secret?: string | undefined;
  /**
   * Delivers a sign-in link; tests pass a fake that captures it. The default is
   * `sendMagicLinkEmail` when SMTP_URL is set, and no links at all otherwise.
   */
  sendMagicLink?: ((link: MagicLink) => Promise<void>) | undefined;
  /** The OIDC provider to sign in with. Defaults to the one the environment names (config.ts). */
  oidc?: OidcConfig | null | undefined;
}

/**
 * Builds the better-auth instance. Server code calls `auth.api.*`, and none of
 * its REST routes are mounted.
 *
 * @param db - The database users, sessions and pending links are kept in.
 * @param [options] - Test overrides.
 * @returns The auth instance.
 */
export function createAuth(db: DB, options: AuthOptions = {}) {
  const oidc = options.oidc === undefined ? oidcConfig() : options.oidc;
  const deliver = options.sendMagicLink ?? (smtpConfigured() ? sendMagicLinkEmail : undefined);
  const magicLinkPlugins =
    deliver === undefined
      ? []
      : [
          magicLink({
            // better-auth takes seconds.
            expiresIn: AUTH_DEFAULTS.magicLinkTtlMinutes * SECONDS_PER_MINUTE,
            storeToken: 'hashed',
            // Links go to the app, which calls magicLinkVerify over GraphQL.
            sendMagicLink: ({ email, token }) => deliver({ email, token, url: magicLinkUrl(token) }),
          }),
        ];
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
    secret: options.secret ?? authSecret(),
    // The OIDC callback is served here (routes/sso.ts), which in development is not the app's origin.
    baseURL: serverUrl(),
    // So a sign-in may finish on the app's pages when they are another origin.
    trustedOrigins: [new URL(appUrl()).origin],
    // Every id column is a uuid, and existing users keep theirs.
    advanced: { database: { generateId: 'uuid' } },
    session: { expiresIn: AUTH_DEFAULTS.sessionTtlDays * SECONDS_PER_DAY },
    // An address the OIDC provider vouches for (email_verified) signs in to the
    // account that has it, even one whose address telos never checked itself:
    // made under SECURE_LOCAL_NET, or before sessions moved to better-auth.
    // The provider is the operator's own, so its word on an address is good.
    ...(oidc ? { account: { accountLinking: { requireLocalEmailVerified: false } } } : {}),
    // Where an OIDC callback goes when it cannot tell where the sign-in came
    // from (no state, or state that cannot be read): the login page, which
    // shows the error, rather than better-auth's own error page.
    onAPIError: { errorURL: appLink('/login') },
    // Every way an account is made (a link, SECURE_LOCAL_NET, OIDC) goes through
    // better-auth's adapter, so this is the one place the first one becomes the admin.
    databaseHooks: { user: { create: { after: async (user) => claimFirstAdmin(db, user.id) } } },
    plugins: [
      apiKey({
        enableMetadata: true,
        defaultPrefix: API_KEY_PREFIX,
        requireName: true,
        // The plugin's per-key limit (10 requests a day) would starve any real
        // MCP client.
        rateLimit: { enabled: false },
      }),
      bearer(),
      // How an OIDC sign-in reaches the app: the callback mints one of these
      // for the session it opened, and the app's /auth/sso screen spends it
      // over GraphQL, as /auth/verify spends a magic token. Only the server
      // mints them, and the session itself never rides in a URL or a cookie.
      oneTimeToken({
        expiresIn: AUTH_DEFAULTS.oneTimeTokenTtlMinutes,
        storeToken: 'hashed',
        disableClientRequest: true,
        disableSetSessionCookie: true,
      }),
      ...(oidc ? [oidcPlugin(oidc)] : []),
      ...magicLinkPlugins,
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The OIDC provider, through better-auth's generic OAuth plugin: endpoints,
 * keys and issuer come from its discovery document, the id token is checked
 * against them, and better-auth's own sign-in and callback endpoints run the
 * flow (state, PKCE, nonce).
 */
function oidcPlugin(oidc: OidcConfig) {
  return genericOAuth({
    config: [
      {
        providerId: OIDC_PROVIDER_ID,
        name: oidc.name,
        discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`,
        requireIdTokenVerification: true,
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
        tokenEndpointAuth: { method: oidc.clientSecret ? oidc.clientAuth : 'none' },
        pkce: true,
        scopes: ['openid', 'profile', 'email'],
        // Accounts have a name column that is never null; a provider may
        // release only a username, or nothing.
        mapProfileToUser: (profile) => ({
          name:
            stringClaim(profile.name) ??
            stringClaim(profile.preferred_username) ??
            stringClaim(profile.email)?.split('@')[0] ??
            '',
        }),
      },
    ],
  });
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The app's verify screen, which hands the token to `magicLinkVerify`. */
export function magicLinkUrl(token: string): string {
  return appLink(`/auth/verify?token=${encodeURIComponent(token)}`);
}

/**
 * Whether this instance emails sign-in links.
 *
 * @param auth - The auth instance.
 * @returns true when it was built with a way to deliver them.
 */
export function sendsMagicLinks(auth: Auth): boolean {
  return auth.options.plugins.some((plugin) => plugin.id === MAGIC_LINK_PLUGIN_ID);
}

/** How an account made by a SECURE_LOCAL_NET sign-in is labelled in better-auth's hooks. */
const LOCAL_NET_METHOD = 'secure-local-net';

/**
 * What a new account is called until its owner says otherwise.
 *
 * @param email - The account's address, already normalized.
 * @returns The part of the address before the `@`.
 */
export function nameFor(email: string): string {
  return email.split('@')[0] ?? email;
}

/**
 * Signs an address in on the strength of the network alone, creating the
 * account on first use. Only for SECURE_LOCAL_NET; see config.ts.
 *
 * @param auth - The auth instance.
 * @param email - The address, already normalized.
 * @returns The session's bearer token and user.
 */
export async function signInOnLocalNet(auth: Auth, email: string): Promise<{ token: string; userId: string }> {
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  const user =
    found?.user ??
    (await ctx.internalAdapter.createUser(
      { email, name: nameFor(email), emailVerified: false },
      { method: LOCAL_NET_METHOD },
    ));
  const session = await ctx.internalAdapter.createSession(user.id);
  return { token: session.token, userId: user.id };
}

/**
 * Mints an API key for a user, server-side: for tests and seeding, which have
 * no session to mint one with. Returns the plaintext key, which is never
 * stored and so exists only in this return value.
 */
export async function mintApiKey(
  auth: Auth,
  input: { userId: string; name: string; expiresInDays?: number | null | undefined },
): Promise<{ id: string; key: string }> {
  const created = await auth.api.createApiKey({
    body: {
      userId: input.userId,
      name: input.name,
      ...(input.expiresInDays ? { expiresIn: input.expiresInDays * SECONDS_PER_DAY } : {}),
    },
  });
  return { id: created.id, key: created.key };
}

export const ANONYMOUS: Actor = { kind: 'anonymous', userId: null };

export interface ActorOptions {
  /** Whether the server offers AI (config.ts `aiAvailable`). Off, only a session resolves. */
  ai: boolean;
  /** The runner's key (config.ts `runnerKey`). Unset, nobody is the system principal. */
  runnerKey?: string | null | undefined;
}

/**
 * Who a request is. The AI credentials resolve only while the server offers AI,
 * and each is checked against the switches over it every time, the instance's
 * own included:
 *
 * - `x-runner-key`: the runner, as the system principal. It owns no rows and
 *   may call only the runner's own mutations (resolvers/actor-lock.ts). It
 *   resolves with the instance switch off too, so it can hear that its runs
 *   were stopped; the queue is empty then, and nothing can be claimed.
 * - `x-run-token`: an agent at work, for exactly as long as its run is live
 *   and its user, project and todo are all still open to AI. It carries the
 *   tools its agent has off for runs, or the default for a run.
 * - `x-api-key`: an MCP client, while its owner has AI on. It carries the
 *   tools its owner switched off for it.
 *
 * A credential that fails any check is anonymous rather than an error, so the
 * caller gets UNAUTHENTICATED from the first field that needs a user.
 */
export async function resolveActor(auth: Auth, db: DB, headers: Headers, options: ActorOptions): Promise<Actor> {
  const runner = headers.get('x-runner-key');
  if (runner) {
    return options.ai && runnerKeyMatches(runner, options.runnerKey) ? { kind: 'system', userId: null } : ANONYMOUS;
  }

  const runToken = headers.get('x-run-token');
  if (runToken) {
    const runId = options.ai ? readRunToken(runToken) : null;
    return runId && (await instanceAiOn(db)) ? await resolveRun(db, runId) : ANONYMOUS;
  }

  const key = headers.get('x-api-key');
  if (key) {
    if (!options.ai || !(await instanceAiOn(db))) return ANONYMOUS;
    const result = await auth.api.verifyApiKey({ body: { key } }).catch(() => null);
    if (!result?.valid || !result.key) return ANONYMOUS;
    const userId = result.key.referenceId;
    const [owner] = await db
      .select({ aiEnabled: dbSchema.users.aiEnabled })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, userId));
    if (!owner?.aiEnabled) return ANONYMOUS;
    return { kind: 'apiKey', userId, keyId: result.key.id, toolsOff: await keyToolsOff(db, result.key.id) };
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
 * The door's tools a key has switched off. A key nobody has changed a switch
 * for has no row, and every tool on.
 *
 * @param db The database.
 * @param keyId The key.
 * @returns The names of the tools that are off for it.
 */
async function keyToolsOff(db: DB, keyId: string): Promise<ReadonlySet<string>> {
  const [row] = await db
    .select({ off: dbSchema.apiKeyTools.off })
    .from(dbSchema.apiKeyTools)
    .where(eq(dbSchema.apiKeyTools.keyId, keyId));
  return new Set<string>(row?.off ?? []);
}

/**
 * The agent working a run, while the run may still act: running, inside its
 * lease, not asked to stop, and every AI switch over it still on. Read with its
 * agent's tool switches, once per request as a key's are.
 *
 * @param db The database.
 * @param runId The run a token named.
 * @returns The agent actor, or anonymous.
 */
async function resolveRun(db: DB, runId: string): Promise<Actor> {
  const [row] = await db
    .select({ userId: dbSchema.runs.userId, toolsOff: dbSchema.agents.toolsOff })
    .from(dbSchema.runs)
    .leftJoin(dbSchema.agents, eq(dbSchema.agents.id, dbSchema.runs.agentId))
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
  return row ? { kind: 'agent', userId: row.userId, runId, toolsOff: runToolsOff(row.toolsOff) } : ANONYMOUS;
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
