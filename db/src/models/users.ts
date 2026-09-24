import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  // better-auth's. A magic link that signs someone in verifies the address.
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // The account's AI switch. Off, which is the default, nothing AI touches
  // this user: their API keys are refused and no agent runs on their todos.
  // It only matters when the instance has AI_ENABLED on at all.
  aiEnabled: boolean('ai_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
