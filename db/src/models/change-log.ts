import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './users.ts';

// The change feed (`changes(since:)`, server/src/changes.ts): one row per
// project, todo and dependency edge that exists or was deleted lately, saying
// when it last changed. Written only by triggers (change_feed migration), so
// every write path stamps it, raw SQL and cascades included; read only by the
// server, so it generates nothing.
//
// A row is the entity's latest change, not its history: a write replaces it.
// `deleted_at` set makes it a tombstone, which `pruneTombstones` drops once it
// is older than the feed promises to remember (TOMBSTONE_RETENTION_DAYS).
//
// The feed's order is (`xid`, `seq`): the writing transaction's id, then a
// sequence within it. The reader serves only rows whose transaction ended
// before every transaction still running began, so a row can never commit
// behind a cursor that was already handed out — which a timestamp cannot
// promise, since transactions commit out of the order they stamp in.
//
// `project_id`, `todo_id` and `depends_on_todo_id` have no foreign keys on
// purpose: a tombstone outlives what it names.
export const changeLog = pgTable(
  'change_log',
  {
    // 'project', 'todo' or 'dependency'.
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The project it is in: the project itself, a todo's, a dependency's waiting todo's.
    projectId: uuid('project_id'),
    // A dependency's two ends, so its tombstone says which edge went.
    todoId: uuid('todo_id'),
    dependsOnTodoId: uuid('depends_on_todo_id'),
    // Set when it was deleted: the row is then a tombstone.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    // pg_current_xact_id() of the transaction that wrote it last.
    xid: bigint('xid', { mode: 'number' }).notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    // Whether AI (an API key, a run) could see it at any write: what lets the
    // feed tell AI something left its view without naming what it never saw.
    aiSeen: boolean('ai_seen').notNull().default(false),
  },
  (t) => [
    primaryKey({ name: 'change_log_pkey', columns: [t.entity, t.entityId] }),
    index('idx_change_log_user_position').on(t.userId, t.xid, t.seq),
    index('idx_change_log_deleted_at').on(t.deletedAt).where(sql`deleted_at IS NOT NULL`),
    check('ck_change_log_entity', sql`${t.entity} IN ('project', 'todo', 'dependency')`),
  ],
);

export type ChangeLogRow = typeof changeLog.$inferSelect;
