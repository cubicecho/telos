import type { DB } from '@telos/db';
import * as dbSchema from '@telos/db/schema';
import { and, eq, sql } from 'drizzle-orm';

// The instance's settings row, and its admins. There is one row or none; none
// reads as the defaults, which keep AI off.

/**
 * Whether the instance's AI switch is on. Asked afresh every time, because an
 * admin can flip it while the server runs.
 *
 * @param db The database, or a transaction.
 * @returns The switch.
 */
export async function instanceAiOn(db: DB): Promise<boolean> {
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
export async function setInstanceAi(db: DB, enabled: boolean): Promise<void> {
  await db
    .insert(dbSchema.instanceSettings)
    .values({ aiEnabled: enabled })
    .onConflictDoUpdate({ target: dbSchema.instanceSettings.id, set: { aiEnabled: enabled, updatedAt: new Date() } });
}

/** The most runs the instance works at once, before an admin says otherwise. */
export const DEFAULT_RUN_LIMIT = 2;

/** The highest run limit an admin may set. */
export const MAX_RUN_LIMIT = 32;

/**
 * The most runs the instance works at once, across every runner and account.
 *
 * @param db The database, or a transaction.
 * @returns The limit.
 */
export async function instanceRunLimit(db: DB): Promise<number> {
  const [row] = await db
    .select({ runLimit: dbSchema.instanceSettings.runLimit })
    .from(dbSchema.instanceSettings)
    .limit(1);
  return row?.runLimit ?? DEFAULT_RUN_LIMIT;
}

/**
 * Sets the most runs the instance works at once. Lowering it stops nothing:
 * runs going now finish, and no new one starts until there is room.
 *
 * @param db The database, or a transaction.
 * @param limit The new limit, 1 to MAX_RUN_LIMIT.
 */
export async function setInstanceRunLimit(db: DB, limit: number): Promise<void> {
  await db
    .insert(dbSchema.instanceSettings)
    .values({ runLimit: limit })
    .onConflictDoUpdate({ target: dbSchema.instanceSettings.id, set: { runLimit: limit, updatedAt: new Date() } });
}

/**
 * SQL for how many more runs the instance may start now: its run limit less the
 * runs working inside their lease. Never below zero.
 */
export const INSTANCE_RUN_ROOM = sql`greatest(0,
  coalesce((SELECT run_limit FROM instance_settings LIMIT 1), ${DEFAULT_RUN_LIMIT})
  - (SELECT count(*)::int FROM runs WHERE status = 'running' AND lease_expires_at > now())
)`;

/** SQL that is true while the instance's AI switch is on, for queries that check every switch at once. */
export const INSTANCE_AI_ON = sql`EXISTS (SELECT 1 FROM instance_settings WHERE ai_enabled)`;

/**
 * Whether a user is an admin.
 *
 * @param db The database.
 * @param userId The user.
 * @returns Their flag.
 */
export async function isAdmin(db: DB, userId: string): Promise<boolean> {
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
export async function claimFirstAdmin(db: DB, userId: string): Promise<void> {
  await db
    .update(dbSchema.users)
    .set({ isAdmin: true })
    .where(and(eq(dbSchema.users.id, userId), sql`NOT EXISTS (SELECT 1 FROM users WHERE is_admin)`));
}
