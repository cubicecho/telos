import type { DB } from '@telos/db';
import type { CallerAbility } from '../auth/abilities.ts';
import type { AuthHost } from '../auth/auth-host.ts';
import type { Auth } from '../auth/better-auth.ts';
import type { RateLimiter } from '../auth/rate-limit.ts';
import type { Loaders } from '../graphql/loaders.ts';

/** What `Context.ip` holds when Express reports no address. One shared budget, not none. */
export const UNKNOWN_IP = 'unknown';

/**
 * Who is asking.
 *
 * - `user`: a person, signed in with a session.
 * - `apiKey`: an external client (an MCP host) holding one of a user's keys.
 *   It acts for that user, but only through the AI door, and only with the
 *   tools its owner left switched on for it.
 * - `agent`: an agent working a run, on the run's token. Acts for the run's
 *   user, through the AI door, for as long as the run is live.
 * - `system`: the runner itself. Owns nothing (`userId` is null) and may call
 *   only the runner's mutations.
 * - `anonymous`: nobody. `userId` is null.
 */
export type ActorKind = 'anonymous' | 'user' | 'apiKey' | 'agent' | 'system';

export interface Actor {
  kind: ActorKind;
  /** The user whose rows this request may touch. */
  userId: string | null;
  /** The `apikeys` row, for an `apiKey` actor. */
  keyId?: string | undefined;
  /**
   * The door's tools that are off (door.ts): an `apiKey` actor's key's, or an
   * `agent` actor's agent's.
   */
  toolsOff?: ReadonlySet<string> | undefined;
  /** The run, for an `agent` actor. */
  runId?: string | undefined;
}

/**
 * What every resolver, generated or hand-written, is handed. `userId` is the
 * only thing that says whose rows are in play and is always `actor.userId`: it
 * comes from the request's session or key, and nothing downstream may take it
 * from an argument.
 */
export interface Context {
  db: DB;
  /** The auth instance this request uses: `authHost.current()` when it began. */
  auth: Auth;
  /** Where `auth` came from, for the writes that change the OIDC provider and must rebuild it. */
  authHost: AuthHost;
  userId: string | null;
  actor: Actor;
  /** What `actor` may do: `defineAbilitiesFor(actor)`, built once with the context. */
  ability: CallerAbility;
  loaders: Loaders;
  /** The request's headers, for calls to `auth.api` that read the session from them. */
  headers: Headers;
  /** The client's address as Express resolved it under `TRUST_PROXY`, for the sign-in throttle. Never an identity. */
  ip: string;
  /** Sign-in throttle; the sign-in operations call it first (throttle.ts). */
  limiter: RateLimiter;
}

/**
 * Whether the caller is AI: an MCP client on a key, or an agent on a run token.
 * What such a caller may see is narrower than what its user may (tenancy.ts),
 * and what it may write is a stated list (graphql/permissions.ts), less
 * whatever its key has switched off.
 */
export function isAiActor(ctx: Pick<Context, 'actor'>): boolean {
  return ctx.actor.kind === 'apiKey' || ctx.actor.kind === 'agent';
}
