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

// A todo's running commentary. What a run wrote stays as written, so what an
// agent said is what it said. A plain note can be rewritten or taken away by
// whoever wrote it (server resolvers/notes.ts), and says when it was.
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
    // When its author last rewrote it. Null for a note that reads as written.
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (t) => [index('idx_todo_notes_user_id').on(t.userId), index('idx_todo_notes_todo_id').on(t.todoId)],
);

export type TodoNote = typeof todoNotes.$inferSelect;
export type NewTodoNote = typeof todoNotes.$inferInsert;
