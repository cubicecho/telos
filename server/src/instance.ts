import * as dbSchema from '@telos/db/schema';
import { and, eq, sql } from 'drizzle-orm';

// The instance's settings row, and its admins. There is one row or none; none
// reads as the defaults, which keep AI off.

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite)
type AnyDb = any;

/**
 * Whether the instance's AI switch is on. Asked afresh every time, because an
 * admin can flip it while the server runs.
 *
 * @param db The database, or a transaction.
 * @returns The switch.
 */
export async function instanceAiOn(db: AnyDb): Promise<boolean> {
  const [row] = await db
    .select({ aiEnabled: dbSchema.instanceSettings.aiEnabled })
    .from(dbSchema.instanceSettings)
    .limit(1);
  return row?.aiEnabled === true;
}

/**
 * Sets the instance's AI switch.
 *
 * @param db The database, or a transaction.
 * @param enabled The new value.
 */
export async function setInstanceAi(db: AnyDb, enabled: boolean): Promise<void> {
  await db
    .insert(dbSchema.instanceSettings)
    .values({ aiEnabled: enabled })
    .onConflictDoUpdate({ target: dbSchema.instanceSettings.id, set: { aiEnabled: enabled, updatedAt: new Date() } });
}

/** SQL that is true while the instance's AI switch is on, for queries that check every switch at once. */
export const INSTANCE_AI_ON = sql`EXISTS (SELECT 1 FROM instance_settings WHERE ai_enabled)`;

/**
 * Whether a user is an admin.
 *
 * @param db The database.
 * @param userId The user.
 * @returns Their flag.
 */
export async function isAdmin(db: AnyDb, userId: string): Promise<boolean> {
  const [user] = await db
    .select({ isAdmin: dbSchema.users.isAdmin })
    .from(dbSchema.users)
    .where(eq(dbSchema.users.id, userId));
  return user?.isAdmin === true;
}

/**
 * Makes a new account the admin if the instance has none, so whoever sets an
 * instance up runs it.
 *
 * @param db The database.
 * @param userId The account just created.
 */
export async function claimFirstAdmin(db: AnyDb, userId: string): Promise<void> {
  await db
    .update(dbSchema.users)
    .set({ isAdmin: true })
    .where(and(eq(dbSchema.users.id, userId), sql`NOT EXISTS (SELECT 1 FROM users WHERE is_admin)`));
}
