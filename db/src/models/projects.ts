import { type AnyPgColumn, boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { lanes } from './lanes.ts';
import { users } from './users.ts';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // What an agent working here should know that no single todo says: the
    // repo, the conventions, who the work is for. Read by agents only, and
    // harmless when AI is off.
    context: text('context'),
    // The project's AI switch, under the account's (users.aiEnabled) and the
    // instance's (AI_ENABLED). Off by default: an agent only ever works on a
    // project somebody deliberately opened to it. Set through
    // setProjectAiEnabled, never a generated write — see write-guards.ts.
    aiEnabled: boolean('ai_enabled').notNull().default(false),
    // Whether lanes' agents start on todos by themselves. Off, an open project's
    // todos are worked only when a person asks (runTodo). Means nothing while
    // aiEnabled is off. Set through setProjectAutoRun, as aiEnabled is.
    autoRun: boolean('auto_run').notNull().default(false),
    // Where new todos land: a submitted request, a finished draft, or the todos
    // a run proposes. Unset, or a done lane, and they land in the first open
    // lane (findNewTodoLaneId).
    newTodoLaneId: uuid('new_todo_lane_id').references((): AnyPgColumn => lanes.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_projects_user_id').on(t.userId)],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
