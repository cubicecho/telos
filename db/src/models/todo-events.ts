import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { type ActorKindValue, todoNotes } from './todo-notes.ts';
import { todos } from './todos.ts';
import { users } from './users.ts';

export const TODO_EVENT_KINDS = ['create', 'move', 'complete', 'reopen', 'edit', 'retry'] as const;
export type TodoEventKind = (typeof TODO_EVENT_KINDS)[number];

// A todo's history. Nothing in the server inserts here: the `todos_history`
// trigger (see the richer_todos migration) writes one row per insert or
// meaningful update, whichever path made it, and reads who did it from the
// transaction's `telos.*` settings (server/src/provenance.ts). Read-only
// through the API.
export const todoEvents = pgTable(
  'todo_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    todoId: uuid('todo_id')
      .notNull()
      .references(() => todos.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<TodoEventKind>().notNull(),
    // Plain ids rather than foreign keys: history outlives the lanes it names,
    // and a lane's delete moves its todos in the same statement that removes it.
    fromLaneId: uuid('from_lane_id'),
    toLaneId: uuid('to_lane_id'),
    // The columns an update changed, by their API names.
    fields: text('fields').array().notNull().default(sql`'{}'::text[]`),
    actorKind: text('actor_kind').$type<ActorKindValue>().notNull(),
    actorKeyId: uuid('actor_key_id'),
    runId: uuid('run_id'),
    noteId: uuid('note_id').references(() => todoNotes.id, { onDelete: 'set null' }),
    reason: text('reason'),
    // clock_timestamp, not now(): one transaction can write several events,
    // and they should still sort in the order they happened.
    at: timestamp('at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index('idx_todo_events_user_id').on(t.userId), index('idx_todo_events_todo_id').on(t.todoId, t.at)],
);

export type TodoEvent = typeof todoEvents.$inferSelect;
