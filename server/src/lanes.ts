import * as dbSchema from '@telos/db/schema';
import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { assertNotBlocked, resultRows } from './blocking.ts';

// The lane rules, in one place. A lane is a board column; at most one lane per
// project may be flagged `isDone`, and that flag is what ties the board to the
// list view:
//
//   in a project that has a done lane,
//   a todo with a lane is completed  <=>  that lane is the done lane
//
// Both views render the same data, so they must never be able to disagree.
// `completeTodo`, `reopenTodo`, `moveTodo` and `setDoneLane` each maintain the
// biconditional, and `assertCompletionMatchesLane` re-asserts it after any
// generated write. A project with no done lane is exempt: its board simply has
// no column that means done, and completion lives only in the list.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyDb = any;

/** The board a new project starts with. Users rename, reorder and add to it. */
export const DEFAULT_LANES = [
  { name: 'To do', position: 0, isDone: false },
  { name: 'In progress', position: 1, isDone: false },
  { name: 'Done', position: 2, isDone: true },
] as const;

/**
 * Gives every one of the caller's projects that has no board the default one.
 *
 * Phrased as "the projects missing lanes" rather than "the project just created"
 * because a mutation returns only the columns the client selected, so the new
 * row's id is not reliably there to name. Together with the guard that refuses
 * to delete a project's last lane, it makes "every project has a board" hold
 * rather than merely usually hold.
 */
export async function seedMissingLanes(tx: AnyDb, userId: string): Promise<void> {
  const seed = sql.join(
    // Cast explicitly: a bare parameter inside VALUES has no type for Postgres
    // to infer from, and the insert fails on the column it does not match.
    DEFAULT_LANES.map((lane) => sql`(${lane.name}::text, ${lane.position}::int, ${lane.isDone}::boolean)`),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO lanes (user_id, project_id, name, position, is_done)
    SELECT p.user_id, p.id, seed.name, seed.position, seed.is_done
    FROM projects p
    CROSS JOIN (VALUES ${seed}) AS seed(name, position, is_done)
    WHERE p.user_id = ${userId}
      AND NOT EXISTS (SELECT 1 FROM lanes l WHERE l.project_id = p.id)
  `);
}

/**
 * Moves the caller's todos into the column their completion implies: the
 * project's done lane for finished work, its first open lane for the rest.
 *
 * Completion is the fact and the lane is how it is drawn, so when a write says
 * something about `completedAt` the lane follows rather than argues — including
 * on create, where generated CRUD names no lane at all and a todo with none is
 * invisible on the board. A project missing the lane a todo would need is left
 * alone: there is nowhere better to put it than where it already is.
 *
 * Phrased over the caller's rows for the same reason `seedMissingLanes` is —
 * a mutation returns only the columns the client selected, so the rows it
 * touched are not reliably identifiable from what came back.
 */
export async function realignLanes(tx: AnyDb, userId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE todos t
    SET lane_id = (
      SELECT l.id FROM lanes l
      WHERE l.project_id = t.project_id AND l.is_done = (t.completed_at IS NOT NULL)
      ORDER BY l.position, l.created_at
      LIMIT 1
    )
    WHERE t.user_id = ${userId}
      AND EXISTS (
        SELECT 1 FROM lanes target
        WHERE target.project_id = t.project_id AND target.is_done = (t.completed_at IS NOT NULL)
      )
      AND (
        t.lane_id IS NULL
        OR EXISTS (
          SELECT 1 FROM lanes current
          WHERE current.id = t.lane_id AND current.is_done <> (t.completed_at IS NOT NULL)
        )
      )
  `);
}

/** Throws if any of the caller's projects has been left with no lanes at all. */
export async function assertEveryProjectHasLanes(tx: AnyDb, userId: string): Promise<void> {
  const result = await tx.execute(sql`
    SELECT 1 AS hit FROM projects p
    WHERE p.user_id = ${userId}
      AND NOT EXISTS (SELECT 1 FROM lanes l WHERE l.project_id = p.id)
    LIMIT 1
  `);
  if (resultRows(result).length === 0) return;
  throw new GraphQLError('A project needs at least one lane. Add another before removing this one.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/** The project's done lane, or null when it has none. */
export async function findDoneLaneId(db: AnyDb, projectId: string): Promise<string | null> {
  const rows: Array<{ id: string }> = await db
    .select({ id: dbSchema.lanes.id })
    .from(dbSchema.lanes)
    .where(and(eq(dbSchema.lanes.projectId, projectId), eq(dbSchema.lanes.isDone, true)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Where a reopened todo goes: the project's first lane that does not mean done.
 * Null when the project has no such lane, which leaves the todo off the board
 * rather than parked in a column that would immediately re-complete it.
 */
export async function findFirstOpenLaneId(db: AnyDb, projectId: string): Promise<string | null> {
  const rows: Array<{ id: string }> = await db
    .select({ id: dbSchema.lanes.id })
    .from(dbSchema.lanes)
    .where(and(eq(dbSchema.lanes.projectId, projectId), eq(dbSchema.lanes.isDone, false)))
    .orderBy(asc(dbSchema.lanes.position), asc(dbSchema.lanes.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Throws if any of `userId`'s todos sits in a lane that contradicts its own
 * completion — done in an open lane, or open in the done lane.
 *
 * Like `assertNoBlockedCompletions`, this is re-asserted over the caller's rows
 * rather than read out of a mutation's return value: a generated update returns
 * only the columns the client selected, so neither `completedAt` nor `laneId` is
 * reliably there to inspect. It runs inside the transaction, so a violation
 * rolls the write back.
 */
export async function assertCompletionMatchesLane(db: AnyDb, userId: string): Promise<void> {
  const rows: Array<{ title: string }> = await db
    .select({ title: dbSchema.todos.title })
    .from(dbSchema.todos)
    .innerJoin(dbSchema.lanes, eq(dbSchema.lanes.id, dbSchema.todos.laneId))
    .where(
      and(
        eq(dbSchema.todos.userId, userId),
        sql`(${dbSchema.todos.completedAt} is not null) <> ${dbSchema.lanes.isDone}`,
        // Exempt: a project with no done lane cannot express completion on the
        // board at all, so its columns say nothing about whether a todo is done.
        sql`exists (select 1 from lanes d where d.project_id = ${dbSchema.todos.projectId} and d.is_done)`,
      ),
    )
    .limit(3);
  if (rows.length === 0) return;
  throw new GraphQLError(
    `Lane and completion disagree for ${rows.map((row) => row.title).join(', ')}. Use moveTodo to change a todo's lane.`,
    { extensions: { code: 'BAD_USER_INPUT' } },
  );
}

/**
 * Makes the project's todos agree with which lane now means done: everything in
 * that lane becomes complete, everything outside it becomes open. Called when
 * the flag moves, since the same rows mean something different afterwards.
 *
 * Clearing the flag entirely syncs nothing — the project simply stops having a
 * column that means done, and reopening finished work over a board edit would
 * destroy more than the edit asked for.
 */
export async function syncLaneCompletion(tx: AnyDb, projectId: string, doneLaneId: string): Promise<void> {
  const entering: Array<{ id: string }> = await tx
    .select({ id: dbSchema.todos.id })
    .from(dbSchema.todos)
    .where(and(eq(dbSchema.todos.laneId, doneLaneId), isNull(dbSchema.todos.completedAt)));
  // The same rule a drag into the done lane obeys: blocked work cannot be
  // declared finished, so flagging a lane full of it fails rather than lying.
  await assertNotBlocked(
    tx,
    entering.map((row) => row.id),
  );
  const now = new Date();
  await tx
    .update(dbSchema.todos)
    .set({ completedAt: now, updatedAt: now })
    .where(and(eq(dbSchema.todos.laneId, doneLaneId), isNull(dbSchema.todos.completedAt)));
  await tx
    .update(dbSchema.todos)
    .set({ completedAt: null, updatedAt: now })
    .where(
      and(
        eq(dbSchema.todos.projectId, projectId),
        isNotNull(dbSchema.todos.laneId),
        isNotNull(dbSchema.todos.completedAt),
        ne(dbSchema.todos.laneId, doneLaneId),
      ),
    );
}
