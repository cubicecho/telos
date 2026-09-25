import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { todos } from './todos.ts';
import { users } from './users.ts';

/** Who can be behind a request. Mirrors the server's `ActorKind`, less `anonymous`. */
export const ACTOR_KINDS = ['user', 'apiKey', 'agent', 'system'] as const;
export type ActorKindValue = (typeof ACTOR_KINDS)[number];

/**
 * What a note is. People write `note`s. `report` (what a run did) and
 * `verdict` (whether a review passed) are written by the server on an agent's
 * behalf, never through generated CRUD.
 */
export const NOTE_KINDS = ['note', 'report', 'verdict'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

// A todo's running commentary. Append-only: a note can be deleted but not
// rewritten, so what an agent was told is what it was told.
export const todoNotes = pgTable(
  'todo_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    todoId: uuid('todo_id')
      .notNull()
      .references(() => todos.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NoteKind>().notNull().default('note'),
    body: text('body').notNull(),
    // Stamped from the request (tenancy.ts), never stated by the caller.
    actorKind: text('actor_kind').$type<ActorKindValue>().notNull().default('user'),
    actorKeyId: uuid('actor_key_id'),
    // The run that wrote it. A plain id, as on todo_events: what a run said
    // outlives the run's own row.
    runId: uuid('run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_todo_notes_user_id').on(t.userId), index('idx_todo_notes_todo_id').on(t.todoId)],
);

export type TodoNote = typeof todoNotes.$inferSelect;
export type NewTodoNote = typeof todoNotes.$inferInsert;
