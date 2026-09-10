import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { lanes } from './lanes.ts';
import { projects } from './projects.ts';
import { users } from './users.ts';

export const todos = pgTable(
  'todos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // Which board column the todo sits in. Nullable because a project may have
    // no lanes yet, and `set null` because deleting a lane must not delete work.
    laneId: uuid('lane_id').references(() => lanes.id, { onDelete: 'set null' }),
    // A todo is done when this is set. Never write it directly — completeTodo
    // and reopenTodo own the transition, and the write guard enforces that a
    // blocked todo cannot be completed however the write arrives.
    completedAt: timestamp('completed_at', { withTimezone: true }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_todos_user_id').on(t.userId),
    index('idx_todos_project_id').on(t.projectId),
    index('idx_todos_completed_at').on(t.completedAt),
    index('idx_todos_lane_id').on(t.laneId),
  ],
);

export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
