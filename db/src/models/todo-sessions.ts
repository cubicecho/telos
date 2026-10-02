import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { agents } from './agents.ts';
import { users } from './users.ts';

// A todo as a hook session, per agent that worked it. The todo is the session
// an agent's MCP hooks file things under (runner/src/execute.ts); this is the
// record that one was opened, kept apart from `runs` so retention pruning a
// todo's runs does not make its next run look like its first, and so it
// outlives the todo.
//
// `todo_id` has no foreign key on purpose: when the todo is hard-deleted the
// `todos_end_sessions` trigger (todo_sessions migration) stamps `deleted_at`,
// and the row waits for the runner to tell the agent's servers
// (`sessionDelete`) before it goes. Written only by the server
// (resolvers/runs.ts, resolvers/session-deletes.ts), so it generates nothing.
export const todoSessions = pgTable(
  'todo_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    todoId: uuid('todo_id').notNull(),
    // The agent's servers are who gets told. An agent that is deleted has none.
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    // Set when the todo was deleted: `sessionDelete` is owed.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // How many times the runner has taken it to tell the servers.
    attempts: integer('attempts').notNull().default(0),
    // Not to be taken again before this: a runner holds it, or it failed and waits.
    retryAt: timestamp('retry_at', { withTimezone: true }),
    // Why the last attempt did not get through.
    error: text('error'),
  },
  (t) => [
    index('idx_todo_sessions_user_id').on(t.userId),
    index('idx_todo_sessions_agent_id').on(t.agentId),
    uniqueIndex('uq_todo_sessions_todo_agent').on(t.todoId, t.agentId),
    index('idx_todo_sessions_deleted_at').on(t.deletedAt).where(sql`deleted_at IS NOT NULL`),
    check('ck_todo_sessions_attempts', sql`${t.attempts} >= 0`),
  ],
);

export type TodoSession = typeof todoSessions.$inferSelect;
export type NewTodoSession = typeof todoSessions.$inferInsert;
