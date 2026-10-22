import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  // better-auth's. A magic link that signs someone in verifies the address.
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // The account's AI switch. Off, which is the default, nothing AI touches
  // this user: their API keys are refused and no agent runs on their todos.
  // It only matters while the instance's own switch is on.
  aiEnabled: boolean('ai_enabled').notNull().default(false),
  // How many days a finished run and its log are kept; null keeps them for
  // good. Pruning (server/src/runs/retention.ts) never takes a run readiness
  // still count, so it changes what is kept, never what runs next.
  runRetentionDays: integer('run_retention_days'),
  // What every agent of this account should know, whichever project it works
  // in: the base layer of a run's system prompt, under the project's own
  // context and prompt. A person edits it in Settings, and AI may keep it up
  // to date as it does a project's context (`setGlobalContext`). Read by
  // agents only, and harmless when AI is off.
  globalContext: text('global_context'),
  // An admin runs the instance: only an admin flips its switches. The first
  // account is made one (auth.ts); no client can write this.
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
