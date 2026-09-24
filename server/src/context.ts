import type { DB } from '@telos/db';
import type { Auth } from './auth.ts';
import type { Loaders } from './loaders.ts';

/**
 * Who is asking.
 *
 * - `user`: a person, signed in with a session.
 * - `apiKey`: an external client (an MCP host) holding one of a user's keys.
 *   It acts for that user, but only through the AI door.
 * - `agent` and `system`: the runner, which arrives in a later phase.
 * - `anonymous`: nobody. `userId` is null.
 */
export type ActorKind = 'anonymous' | 'user' | 'apiKey' | 'agent' | 'system';

export interface Actor {
  kind: ActorKind;
  /** The user whose rows this request may touch. */
  userId: string | null;
  /** The `apikeys` row, for an `apiKey` actor. */
  keyId?: string | undefined;
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
