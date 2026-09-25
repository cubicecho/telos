import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// The instance's own settings: one row, owned by no user, written only by an
// admin through the server (resolvers/instance.ts). A missing row reads as the
// defaults, so a fresh database needs no seeding.
export const instanceSettings = pgTable(
  'instance_settings',
  {
    id: text('id').primaryKey().default('instance'),
    // The instance's AI switch. Off, which is the default, no account can use
    // AI, whatever its own switch says. AI_ENABLED=false removes AI entirely,
    // and then this switch is not offered at all.
    aiEnabled: boolean('ai_enabled').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('instance_settings_singleton', sql`${t.id} = 'instance'`)],
);

/** The drizzle-graphql keys of tables only the server touches, which the schema excludes. */
export const SERVER_TABLES = ['instanceSettings'] as const;

export type InstanceSettings = typeof instanceSettings.$inferSelect;
