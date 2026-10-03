import type { DB } from '@telos/db';
import type { Auth } from './auth.ts';
import type { Loaders } from './loaders.ts';

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
  auth: Auth;
  userId: string | null;
  actor: Actor;
  loaders: Loaders;
}

/**
 * Whether the caller is AI: an MCP client on a key, or an agent on a run token.
 * What such a caller may see is narrower than what its user may (tenancy.ts),
 * and what it may write is a stated list (resolvers/actor-lock.ts), less
 * whatever its key has switched off.
 */
export function isAiActor(ctx: Pick<Context, 'actor'>): boolean {
  return ctx.actor.kind === 'apiKey' || ctx.actor.kind === 'agent';
}
