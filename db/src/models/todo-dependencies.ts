import { index, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { todos } from './todos.ts';
import { users } from './users.ts';

/**
 * `todoId` is blocked by `dependsOnTodoId`. The graph is kept acyclic by
 * assertNoCycle in the server, which is why generated writes are switched off
 * for this table — addTodoDependency is the only way in.
 */
export const todoDependencies = pgTable(
  'todo_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    todoId: uuid('todo_id')
      .notNull()
      .references(() => todos.id, { onDelete: 'cascade' }),
    dependsOnTodoId: uuid('depends_on_todo_id')
      .notNull()
      .references(() => todos.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_todo_dependencies_pair').on(t.todoId, t.dependsOnTodoId),
    index('idx_todo_dependencies_user_id').on(t.userId),
    index('idx_todo_dependencies_todo_id').on(t.todoId),
    index('idx_todo_dependencies_depends_on').on(t.dependsOnTodoId),
  ],
);

export type TodoDependency = typeof todoDependencies.$inferSelect;
export type NewTodoDependency = typeof todoDependencies.$inferInsert;
