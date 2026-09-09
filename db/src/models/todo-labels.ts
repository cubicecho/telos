import { index, pgTable, unique, uuid } from 'drizzle-orm/pg-core';

import { labels } from './labels.ts';
import { todos } from './todos.ts';
import { users } from './users.ts';

export const todoLabels = pgTable(
  'todo_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    todoId: uuid('todo_id')
      .notNull()
      .references(() => todos.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [
    unique('uq_todo_labels_pair').on(t.todoId, t.labelId),
    index('idx_todo_labels_user_id').on(t.userId),
    index('idx_todo_labels_todo_id').on(t.todoId),
    index('idx_todo_labels_label_id').on(t.labelId),
  ],
);

export type TodoLabel = typeof todoLabels.$inferSelect;
export type NewTodoLabel = typeof todoLabels.$inferInsert;
