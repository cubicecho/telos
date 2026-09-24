import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { Context } from './context.ts';
import { requireAuth } from './resolvers/auth.ts';

// The one question every AI resolver asks: is AI on for this caller? The
// instance switch (AI_ENABLED) is answered earlier, when the schema is built:
// with it off none of these resolvers exist. What is left is the account's.

/** Whether the caller's account has AI switched on. */
export async function aiAllowed(ctx: Context): Promise<boolean> {
  const userId = requireAuth(ctx);
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
    throw new GraphQLError('AI is switched off for this account', { extensions: { code: 'NOT_FOUND' } });
  }
  return requireAuth(ctx);
}
