import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { users } from './users.ts';

// What an agent is told its job is: a prompt the account keeps, and an agent
// names (agents.promptId). Every account starts with the seeded ones
// (prompt-seeds.ts), which are its own to change or delete like any other.
// It comes last in a run's system prompt, after the account's agent
// instructions and the project's description and prompt.
//
// A person's only: AI reaches no prompt (auth/rows.ts), as it reaches no agent.
export const prompts = pgTable(
  'prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    body: text('body').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique('uq_prompts_user_name').on(t.userId, t.name)],
);

export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
