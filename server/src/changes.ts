import * as dbSchema from '@telos/db/schema';
import { and, inArray, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { resultRows } from './blocking.ts';
import { type Context, isAiActor } from './context.ts';
import { requireAuth } from './resolvers/auth.ts';
import { reachable } from './tenancy.ts';

// The change feed: what changed in an account's projects, todos and dependency
// edges since a cursor, for a consumer that keeps a copy (auto-cal, a webhook
// sender, a sync client). The `change_log` table holds one row per entity,
// written by triggers on every path (change_feed migration); this reads it.
//
// Each page names entities, and what it hands back is how they stand *now*,
// read through the same scope a generated query uses (tenancy.ts `reachable`):
// an entity the caller can reach is an upsert, one it cannot is a tombstone.
// So a page is never staler than the moment it was read, an entity may come
// round again on a later page, and applying entries is idempotent by id.
//
// For AI (an API key or a run) "cannot reach" includes leaving AI's view: an
// ignored todo, a project whose AI switch went off. Those come as tombstones
// too, but only for entities AI could see at some point (`ai_seen`), so the
// feed never names something AI was never shown, and a tombstone never says
// whether a thing was deleted or hidden.
//
// The cursor is a position in (transaction id, sequence), served only up to
// the oldest transaction still running: everything behind a cursor has
// committed, so nothing can land behind it later. A long transaction holds
// the feed back until it ends, rather than letting the feed skip it.

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite)
type AnyDb = any;
// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

/** Entries per page when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 200;

/** The most entries one page may hold. */
export const MAX_PAGE_SIZE = 1000;

/** How long a tombstone is kept: the furthest back a cursor can reach. */
export const TOMBSTONE_RETENTION_DAYS = 30;

/**
 * How long a cursor is good for. A day short of the tombstones' keep, so a
 * tombstone written by a transaction that was still running when the cursor
 * was handed out is still there when the cursor comes back.
 */
export const CURSOR_MAX_AGE_DAYS = TOMBSTONE_RETENTION_DAYS - 1;

const DAY_MS = 24 * 60 * 60_000;
const CURSOR_VERSION = 'c1';

export type ChangeEntity = 'project' | 'todo' | 'dependency';

/** Where a consumer has read up to. */
export interface FeedPosition {
  /** The transaction id of the last entry read, as a decimal string. */
  xid: string;
  /** Its sequence number within the log, as a decimal string. */
  seq: string;
}

const START: FeedPosition = { xid: '0', seq: '0' };
const DIGITS = /^\d{1,19}$/;

/**
 * A position as the opaque string a consumer hands back.
 *
 * @param position Where the page ended.
 * @param issuedAt When it was handed out, which bounds how long it is good for.
 * @returns The cursor.
 */
export function encodeCursor(position: FeedPosition, issuedAt: Date): string {
  return Buffer.from(`${CURSOR_VERSION}.${position.xid}.${position.seq}.${issuedAt.getTime()}`).toString('base64url');
}

function badCursor(): GraphQLError {
  return new GraphQLError('That is not a cursor this feed handed out. Start again without one.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/**
 * Reads a cursor back.
 *
 * @param cursor What `encodeCursor` made.
 * @param now What time it is.
 * @returns The position. Throws BAD_USER_INPUT for anything else, and
 *   CURSOR_EXPIRED for one older than the tombstones behind it.
 */
export function decodeCursor(cursor: string, now: Date): FeedPosition {
  const [version, xid, seq, issued, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('.');
  if (version !== CURSOR_VERSION || rest.length > 0 || !DIGITS.test(xid ?? '') || !DIGITS.test(seq ?? '')) {
    throw badCursor();
  }
  const issuedAt = Number(issued);
  if (!Number.isSafeInteger(issuedAt)) {
    throw badCursor();
  }
  if (now.getTime() - issuedAt > CURSOR_MAX_AGE_DAYS * DAY_MS) {
    throw new GraphQLError(
      `That cursor is older than ${CURSOR_MAX_AGE_DAYS} days, and deletions before then are forgotten. Start again without one.`,
      { extensions: { code: 'CURSOR_EXPIRED' } },
    );
  }
  return { xid, seq };
}

/** Something that is gone, or gone from the caller's view. */
export interface Tombstone {
  entity: ChangeEntity;
  id: string;
  projectId: string | null;
  todoId: string | null;
  dependsOnTodoId: string | null;
  removedAt: Date;
}

/** One page of the feed. */
export interface ChangePage {
  projects: AnyRow[];
  todos: AnyRow[];
  dependencies: AnyRow[];
  tombstones: Tombstone[];
  /** Where to ask from next time, whether or not there is more now. */
  cursor: string;
  /** Whether the log had more than this page held. */
  hasMore: boolean;
}

interface LogRow {
  entity: ChangeEntity;
  entityId: string;
  projectId: string | null;
  todoId: string | null;
  dependsOnTodoId: string | null;
  deletedAt: string | Date | null;
  changedAt: string | Date;
  xid: string;
  seq: string;
}

const TABLES = {
  project: { name: 'projects', table: dbSchema.projects },
  todo: { name: 'todos', table: dbSchema.todos },
  dependency: { name: 'todoDependencies', table: dbSchema.todoDependencies },
} as const;

/**
 * Of `ids`, the rows of one kind the caller can reach now, by id.
 *
 * @param context The request.
 * @param entity Which kind.
 * @param ids The ids the page names.
 * @returns The rows found.
 */
async function liveRows(context: Context, entity: ChangeEntity, ids: string[]): Promise<Map<string, AnyRow>> {
  if (ids.length === 0) {
    return new Map();
  }
  const { name, table } = TABLES[entity];
  const rows: AnyRow[] = await (context.db as AnyDb)
    .select()
    .from(table)
    .where(and(inArray((table as AnyRow).id, ids), reachable(context, name, table)));
  return new Map(rows.map((row) => [String(row.id), row]));
}

/**
 * One page of what changed since `since`, as the caller may see it.
 *
 * @param context The request: whose feed, and whether AI is reading it.
 * @param args The cursor from the last page (none to start from the
 *   beginning) and how many entries at most.
 * @param now What time it is.
 * @returns The page.
 */
export async function readChanges(
  context: Context,
  args: { since?: string | null; limit?: number | null },
  now: Date = new Date(),
): Promise<ChangePage> {
  const userId = requireAuth(context);
  const limit = args.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new GraphQLError(`limit must be between 1 and ${MAX_PAGE_SIZE}.`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  const from = args.since ? decodeCursor(args.since, now) : START;

  const rows = resultRows<LogRow>(
    await (context.db as AnyDb).execute(sql`
      SELECT entity, entity_id AS "entityId", project_id AS "projectId", todo_id AS "todoId",
        depends_on_todo_id AS "dependsOnTodoId", deleted_at AS "deletedAt", changed_at AS "changedAt",
        xid::text AS xid, seq::text AS seq
      FROM change_log
      WHERE user_id = ${userId}
        AND (user_id, xid, seq) > (${userId}::uuid, ${from.xid}::bigint, ${from.seq}::bigint)
        -- Only what every running transaction started after: nothing can
        -- commit behind the cursor this page hands out.
        AND xid < pg_snapshot_xmin(pg_current_snapshot())::text::bigint
        ${isAiActor(context) ? sql`AND ai_seen` : sql``}
      ORDER BY xid, seq
      LIMIT ${limit + 1}
    `),
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const idsOf = (entity: ChangeEntity) => page.filter((row) => row.entity === entity).map((row) => row.entityId);
  const [projects, todos, dependencies] = await Promise.all([
    liveRows(context, 'project', idsOf('project')),
    liveRows(context, 'todo', idsOf('todo')),
    liveRows(context, 'dependency', idsOf('dependency')),
  ]);
  const live = { project: projects, todo: todos, dependency: dependencies };

  const tombstones: Tombstone[] = page
    .filter((row) => !live[row.entity].has(row.entityId))
    .map((row) => ({
      entity: row.entity,
      id: row.entityId,
      projectId: row.projectId,
      todoId: row.todoId,
      dependsOnTodoId: row.dependsOnTodoId,
      removedAt: new Date(row.deletedAt ?? row.changedAt),
    }));
  const last = page.at(-1);
  return {
    projects: [...projects.values()],
    todos: [...todos.values()],
    dependencies: [...dependencies.values()],
    tombstones,
    cursor: encodeCursor(last ? { xid: last.xid, seq: last.seq } : from, now),
    hasMore,
  };
}

/**
 * Drops the tombstones older than the feed remembers.
 *
 * @param db The database.
 * @param now What time it is.
 * @returns How many went.
 */
export async function pruneTombstones(db: AnyDb, now: Date = new Date()): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM change_log
    WHERE deleted_at IS NOT NULL
      AND deleted_at < ${now.toISOString()}::timestamptz - make_interval(days => ${TOMBSTONE_RETENTION_DAYS})
    RETURNING entity
  `);
  return resultRows(result).length;
}
