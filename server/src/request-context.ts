import { type ActorOptions, type Auth, resolveActor } from './auth.ts';
import type { Context } from './context.ts';
import { createLoaders } from './loaders.ts';

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite)
type AnyDb = any;

/**
 * Builds a request's context from its headers. Both doors — /graphql and /mcp —
 * use this one, so a caller is the same actor whichever it came through.
 * Loaders are built per request: their batching is only ever valid within one
 * request, and their cache must not outlive it.
 */
export function createContextFactory(db: AnyDb, auth: Auth, options: ActorOptions) {
  return async (headers: Headers): Promise<Context> => {
    const actor = await resolveActor(auth, db, headers, options);
    return { db, auth, userId: actor.userId, actor, loaders: createLoaders(db) };
  };
}

export type ContextFactory = ReturnType<typeof createContextFactory>;
