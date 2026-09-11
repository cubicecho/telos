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
    // What the todo is actually for, when a title cannot hold it. Nullable
    // rather than defaulted to '': "no notes" and "an empty note" are the same
    // thing, and only one of them should be storable.
    notes: text('notes'),
    // Which board column the todo sits in. Nullable because a project may have
    // no lanes yet, and `set null` because deleting a lane must not delete work.
    laneId: uuid('lane_id').references(() => lanes.id, { onDelete: 'set null' }),
    // A todo is done when this is set. Never write it directly — completeTodo
    // and reopenTodo own the transition, and the write guard enforces that a
    // blocked todo cannot be completed however the write arrives.
    completedAt: timestamp('completed_at', { withTimezone: true }),
    // When the work is wanted by, if it is wanted by any particular time —
    // most todos are not. Unlike completedAt this carries no invariant: no
    // lane, guard or count reads it, so it is safe for a plain update to set.
    dueAt: timestamp('due_at', { withTimezone: true }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // `$onUpdate` rather than a stamp at each call site. The hand-written
    // resolvers set this themselves, but generated writes — which is how the
    // edit dialog saves — never did, so the column was stale for exactly the
    // path a reader would check it on. Application-level, so no migration.
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_todos_user_id').on(t.userId),
    index('idx_todos_project_id').on(t.projectId),
    index('idx_todos_completed_at').on(t.completedAt),
    index('idx_todos_lane_id').on(t.laneId),
    // Not yet load-bearing: the due-date sort runs in the client over the
    // project's already-fetched rows. It is here because the column is the
    // obvious thing to order or filter on server-side the moment a project
    // outgrows one query, and because an index added later is a migration on
    // a table that by then has rows.
    index('idx_todos_due_at').on(t.dueAt),
  ],
);

export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
