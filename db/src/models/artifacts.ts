import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { projects } from './projects.ts';
import { runs } from './runs.ts';
import { todos } from './todos.ts';
import { users } from './users.ts';

/**
 * How the board learned of an artifact. `declared` is an agent calling
 * `record_artifact` and saying what it made; `detected` is the runner reading a
 * write out of a tool call's name and arguments, which is a guess and kept as
 * one.
 */
export const ARTIFACT_SOURCES = ['declared', 'detected'] as const;
export type ArtifactSource = (typeof ARTIFACT_SOURCES)[number];

export const ARTIFACT_ACTIONS = ['created', 'updated', 'moved', 'deleted'] as const;
export type ArtifactAction = (typeof ARTIFACT_ACTIONS)[number];

// Something a run left behind: a file it wrote, a page it published. A record
// of where the thing is, never a copy of it. Written only by `finishRun`, so it
// is read-only through the API, and it goes when its todo goes.
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
    todoId: uuid('todo_id')
      .notNull()
      .references(() => todos.id, { onDelete: 'cascade' }),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_artifacts_user_id').on(t.userId),
    index('idx_artifacts_project_id').on(t.projectId),
    index('idx_artifacts_todo_id').on(t.todoId, t.createdAt),
    index('idx_artifacts_run_id').on(t.runId),
    check('ck_artifacts_source', sql`${t.source} in ('declared', 'detected')`),
    check('ck_artifacts_action', sql`${t.action} in ('created', 'updated', 'moved', 'deleted')`),
  ],
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
