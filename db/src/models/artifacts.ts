import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { projects } from './projects.ts';
import { runs } from './runs.ts';
import type { ActorKindValue } from './todo-notes.ts';
import { todos } from './todos.ts';
import { users } from './users.ts';

/**
 * How the board learned of an artifact. `declared` is a run's agent calling
 * `record_artifact` and saying what it made; `detected` is the runner reading a
 * write out of a tool call's name and arguments, which is a guess and kept as
 * one. Both are held against what the run's tools were seen to do. `client` is
 * an MCP client saying so from outside any run, which nothing can check.
 */
export const RUN_ARTIFACT_SOURCES = ['declared', 'detected'] as const;
export const CLIENT_ARTIFACT_SOURCE = 'client';
export const ARTIFACT_SOURCES = [...RUN_ARTIFACT_SOURCES, CLIENT_ARTIFACT_SOURCE] as const;
export type ArtifactSource = (typeof ARTIFACT_SOURCES)[number];

export const ARTIFACT_ACTIONS = ['created', 'updated', 'moved', 'deleted'] as const;
export type ArtifactAction = (typeof ARTIFACT_ACTIONS)[number];

// Something made for a todo: a file a run wrote, a page it published, or
// something an MCP client says it made. A record of where the thing is, never a
// copy of it. Written by `finishRun` and `recordArtifact`, so it is read-only
// through generated CRUD.
//
// It outlives its todo. Deleting the todo detaches it: `todo_id` goes null and
// `todo_title` keeps what the todo was called (the `todos_detach_artifacts`
// trigger), and it stays on the project until the project goes.
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Null once the todo it was made for has been deleted.
    todoId: uuid('todo_id').references(() => todos.id, { onDelete: 'set null' }),
    // The todo's title as it was when it was deleted. Null while it is attached.
    todoTitle: text('todo_title'),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    location: text('location').notNull(),
    source: text('source').$type<ArtifactSource>().notNull(),
    action: text('action').$type<ArtifactAction>().notNull().default('created'),
    // The MCP server it went through, and the tool, when anything said.
    serverSlug: text('server_slug'),
    tool: text('tool'),
    title: text('title'),
    description: text('description'),
    mediaType: text('media_type'),
    sizeBytes: integer('size_bytes'),
    // Who recorded it, stamped from the request as a note's signer is: `agent`
    // for what a run reported, and the API key for what a client did.
    actorKind: text('actor_kind').$type<ActorKindValue>().notNull().default('agent'),
    actorKeyId: uuid('actor_key_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_artifacts_user_id').on(t.userId),
    index('idx_artifacts_project_id').on(t.projectId),
    index('idx_artifacts_todo_id').on(t.todoId, t.createdAt),
    index('idx_artifacts_run_id').on(t.runId),
    check('ck_artifacts_source', sql`${t.source} in ('declared', 'detected', 'client')`),
    check('ck_artifacts_action', sql`${t.action} in ('created', 'updated', 'moved', 'deleted')`),
  ],
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
