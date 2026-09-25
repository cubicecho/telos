import { type SQL, sql } from 'drizzle-orm';
import { resultRows } from './blocking.ts';

// The station rules, in one place: which todos an agent may start on, and how
// to stop what is running. A lane with an agent is a station; the runner asks
// `runnerQueue` what to start, and `claimRun` asks the same question again for
// one todo inside the claiming transaction, so what is claimable is decided by
// one piece of SQL rather than two that could drift.
//
// A todo is ready at a station when all of these hold:
//
//   - every AI switch over it is on: its user's, its project's, and it is not
//     ignored — the same three checks a run token makes on every request
//   - the project is not archived, and the todo is open and not blocked
//   - nothing is working it now (a running run inside its lease)
//   - the station has not already finished with it: no `ok` run in this lane
//     since the todo last arrived here
//   - it has failed no more than `maxAttempts` times since a person last
//     touched it, which is what stops a Doing↔Review loop spending forever
//   - an `expand` station has somewhere to put what it produces
//   - the station has room under its WIP limit

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite)
type AnyDb = any;

/** How long a claim holds a todo without a heartbeat before it counts as abandoned. */
export const LEASE_SECONDS = 120;

export interface ReadyTodo {
  todoId: string;
  laneId: string;
  projectId: string;
  userId: string;
}

/**
 * The todos stations could start on now, first station and first todo first.
 *
 * @param db The database or transaction.
 * @param filter Narrows the question to one todo in one lane, which is how a claim asks it.
 * @param limit The most to return.
 * @returns The ready todos, each with the lane that would work it.
 */
export async function readyTodos(
  db: AnyDb,
  filter: { todoId?: string; laneId?: string } = {},
  limit = 50,
): Promise<ReadyTodo[]> {
  const narrow: SQL[] = [];
  if (filter.todoId) narrow.push(sql`AND t.id = ${filter.todoId}`);
  if (filter.laneId) narrow.push(sql`AND l.id = ${filter.laneId}`);
  const result = await db.execute(sql`
    WITH live AS (
      SELECT lane_id, count(*)::int AS n FROM runs
      WHERE status = 'running' AND lease_expires_at > now()
      GROUP BY lane_id
    ),
    candidates AS (
      SELECT
        t.id AS todo_id, l.id AS lane_id, t.project_id, t.user_id,
        l.wip_limit, l.position AS lane_position, t.position, t.created_at,
        row_number() OVER (PARTITION BY l.id ORDER BY t.position, t.created_at) AS place
      FROM todos t
      JOIN lanes l ON l.id = t.lane_id
      JOIN agents a ON a.id = l.agent_id
      JOIN projects p ON p.id = t.project_id
      JOIN users u ON u.id = t.user_id
      WHERE u.ai_enabled AND p.ai_enabled AND NOT t.ai_ignored
        AND p.archived_at IS NULL
        AND t.completed_at IS NULL AND NOT l.is_done
        AND (l.contract <> 'expand' OR l.on_success_lane_id IS NOT NULL)
        ${sql.join(narrow, sql` `)}
        AND NOT EXISTS (
          SELECT 1 FROM todo_dependencies d JOIN todos b ON b.id = d.depends_on_todo_id
          WHERE d.todo_id = t.id AND b.completed_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM runs r
          WHERE r.todo_id = t.id AND r.status = 'running' AND r.lease_expires_at > now()
        )
        AND NOT EXISTS (
          SELECT 1 FROM runs r
          WHERE r.todo_id = t.id AND r.lane_id = l.id AND r.status = 'ok'
            AND r.started_at >= coalesce(
              (SELECT max(e.at) FROM todo_events e WHERE e.todo_id = t.id AND e.to_lane_id = l.id),
              t.created_at
            )
        )
        AND (
          SELECT count(*) FROM runs r
          WHERE r.todo_id = t.id AND (r.status = 'error' OR r.verdict = 'fail')
            AND r.started_at > coalesce(
              (SELECT max(e.at) FROM todo_events e WHERE e.todo_id = t.id AND e.actor_kind = 'user'),
              '-infinity'::timestamptz
            )
        ) <= l.max_attempts
    )
    SELECT c.todo_id, c.lane_id, c.project_id, c.user_id
    FROM candidates c LEFT JOIN live ON live.lane_id = c.lane_id
    WHERE c.place <= c.wip_limit - coalesce(live.n, 0)
    ORDER BY c.lane_position, c.position, c.created_at
    LIMIT ${limit}
  `);
  return resultRows<{ todo_id: string; lane_id: string; project_id: string; user_id: string }>(result).map((row) => ({
    todoId: row.todo_id,
    laneId: row.lane_id,
    projectId: row.project_id,
    userId: row.user_id,
  }));
}

/**
 * Marks running runs whose lease has lapsed as failed: their runner died, and
 * the todo should be free to be claimed again.
 *
 * @param db The database or transaction.
 * @param where Which runs to look at: one todo's, or one lane's.
 * @returns Nothing.
 */
export async function expireLapsedRuns(db: AnyDb, where: { todoId: string; laneId: string }): Promise<void> {
  await db.execute(sql`
    UPDATE runs
    SET status = 'error', error = 'The runner stopped renewing its lease.', finished_at = now()
    WHERE status = 'running' AND lease_expires_at <= now()
      AND (todo_id = ${where.todoId} OR lane_id = ${where.laneId})
  `);
}

/**
 * Asks every running run under a switch to stop. The runner hears it on its
 * next heartbeat, and the run's token stops resolving at once.
 *
 * @param db The database or transaction.
 * @param where Whose runs: a user's, a project's, or those of todos AI now ignores.
 * @returns Nothing.
 */
export async function cancelRunsUnder(
  db: AnyDb,
  where: { userId: string; projectId?: string; ignoredTodos?: boolean },
): Promise<void> {
  const narrow: SQL[] = [];
  if (where.projectId) narrow.push(sql`AND project_id = ${where.projectId}`);
  if (where.ignoredTodos) narrow.push(sql`AND todo_id IN (SELECT id FROM todos WHERE ai_ignored)`);
  await db.execute(sql`
    UPDATE runs SET cancel_requested_at = now()
    WHERE user_id = ${where.userId} AND status = 'running' AND cancel_requested_at IS NULL
      ${sql.join(narrow, sql` `)}
  `);
}
