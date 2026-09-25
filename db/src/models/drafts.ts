import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { agents } from './agents.ts';
import { projects } from './projects.ts';
import { todos } from './todos.ts';
import { users } from './users.ts';

// A draft: a rough request talked over with an agent until it is a brief worth
// putting on the board. The person says something, the runner has the agent
// answer (it rewrites the title and brief each turn), and when the brief reads
// right the person makes a todo of it. The conversation stays with the draft;
// the todo gets only the brief, which has to stand on its own.
//
// Written only by resolvers/drafts.ts: a person talks, the runner answers.
export const drafts = pgTable(
  'drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // The agent that answers. Gone, the draft waits for another to be chosen.
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    title: text('title').notNull().default(''),
    brief: text('brief').notNull().default(''),
    // Set when the person has said something the agent has not answered yet;
    // cleared by the answer. This is what the runner looks for.
    waitingSince: timestamp('waiting_since', { withTimezone: true }),
    // Held while the runner has the agent answering. One that passes is a
    // runner that died, and the draft is taken again.
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    // Why the last answer did not come, when it did not.
    error: text('error'),
    // The todo it became.
    todoId: uuid('todo_id').references(() => todos.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_drafts_user_id').on(t.userId),
    index('idx_drafts_project_id').on(t.projectId, t.updatedAt),
    index('idx_drafts_agent_id').on(t.agentId),
    index('idx_drafts_todo_id').on(t.todoId),
    index('idx_drafts_waiting').on(t.waitingSince).where(sql`waiting_since is not null`),
  ],
);

export const DRAFT_ROLES = ['user', 'assistant'] as const;
export type DraftRole = (typeof DRAFT_ROLES)[number];

// One turn of a draft's conversation.
export const draftMessages = pgTable(
  'draft_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    role: text('role').$type<DraftRole>().notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_draft_messages_user_id').on(t.userId),
    index('idx_draft_messages_draft_id').on(t.draftId, t.createdAt),
    check('ck_draft_messages_role', sql`${t.role} in ('user', 'assistant')`),
  ],
);

export type Draft = typeof drafts.$inferSelect;
export type DraftMessage = typeof draftMessages.$inferSelect;
