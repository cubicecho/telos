import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { Context } from './context.ts';
import { instanceAiOn } from './instance.ts';
import { requireAuth } from './resolvers/auth.ts';

// The one question every AI resolver asks: is AI on for this caller? Whether
// the server offers AI at all (AI_ENABLED) is answered earlier, when the schema
// is built: with it off none of these resolvers exist. What is left is the
// instance's switch and the account's.

/** Whether the instance and the caller's account both have AI switched on. */
export async function aiAllowed(ctx: Context): Promise<boolean> {
  const userId = requireAuth(ctx);
  if (!(await instanceAiOn(ctx.db))) return false;
  const [user] = await ctx.db
    .select({ aiEnabled: dbSchema.users.aiEnabled })
    .from(dbSchema.users)
    .where(eq(dbSchema.users.id, userId));
  return user?.aiEnabled === true;
}

/**
 * Throws unless AI is on for the caller. NOT_FOUND rather than FORBIDDEN: for
 * someone who turned AI off, the AI surface is not there, not refused.
 */
export async function requireAi(ctx: Context): Promise<string> {
  if (!(await aiAllowed(ctx))) {
    throw new GraphQLError('AI is switched off', { extensions: { code: 'NOT_FOUND' } });
  }
  return requireAuth(ctx);
}

/**
 * Throws unless the caller is the runner. FORBIDDEN rather than NOT_FOUND: the
 * runner's fields are in the schema whenever AI is on, and saying so costs
 * nothing, where a person's AI surface is theirs to hide.
 */
export function requireSystem(ctx: Context): void {
  if (ctx.actor.kind === 'system') return;
  throw new GraphQLError('Only the runner may do this.', { extensions: { code: 'FORBIDDEN' } });
}
