import type { DB } from '@telos/db';
import { type ActorOptions, resolveActor } from './auth.ts';
import type { AuthHost } from './auth-host.ts';
import type { Context } from './context.ts';
import { createLoaders } from './loaders.ts';

/**
 * Builds a request's context from its headers. Both doors — /graphql and /mcp —
 * use this one, so a caller is the same actor whichever it came through.
 * Loaders are built per request: their batching is only ever valid within one
 * request, and their cache must not outlive it. The auth instance is asked for
 * per request too, since pairing an OIDC provider replaces it (auth-host.ts).
 */
export function createContextFactory(db: DB, authHost: AuthHost, options: ActorOptions) {
  return async (headers: Headers): Promise<Context> => {
    const auth = authHost.current();
    const actor = await resolveActor(auth, db, headers, options);
    return { db, auth, authHost, userId: actor.userId, actor, loaders: createLoaders(db), headers };
  };
}

export type ContextFactory = ReturnType<typeof createContextFactory>;
