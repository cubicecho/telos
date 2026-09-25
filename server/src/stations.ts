import { type SQL, sql } from 'drizzle-orm';
import { resultRows } from './blocking.ts';
import { INSTANCE_AI_ON } from './instance.ts';

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
      WHERE ${INSTANCE_AI_ON} AND u.ai_enabled AND p.ai_enabled AND NOT t.ai_ignored
        AND p.archived_at IS NULL
        AND t.completed_at IS NULL AND t.archived_at IS NULL AND NOT l.is_done
        AND (l.contract <> 'expand' OR l.on_success_lane_id IS NOT NULL)
        ${sql.join(narrow, sql` `)}
        AND NOT EXISTS (
          SELECT 1 FROM todo_dependencies d JOIN todos b ON b.id = d.depends_on_todo_id
          WHERE d.todo_id = t.id AND b.completed_at IS NULL AND b.archived_at IS NULL
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
 * @param where Whose runs: everyone's (no user, for the instance switch), a user's, a
 *   project's, or those of todos AI now ignores or someone archived.
 * @returns Nothing.
 */
export async function cancelRunsUnder(
  db: AnyDb,
  where: { userId?: string; projectId?: string; ignoredTodos?: boolean; archivedTodos?: boolean },
): Promise<void> {
  const narrow: SQL[] = [];
  if (where.userId) narrow.push(sql`AND user_id = ${where.userId}`);
  if (where.projectId) narrow.push(sql`AND project_id = ${where.projectId}`);
  if (where.ignoredTodos) narrow.push(sql`AND todo_id IN (SELECT id FROM todos WHERE ai_ignored)`);
  if (where.archivedTodos) narrow.push(sql`AND todo_id IN (SELECT id FROM todos WHERE archived_at IS NOT NULL)`);
  await db.execute(sql`
    UPDATE runs SET cancel_requested_at = now()
    WHERE status = 'running' AND cancel_requested_at IS NULL
      ${sql.join(narrow, sql` `)}
  `);
}

/** Where a todo stands with the stations, for a person reading the board. */
export type StationState = 'attention' | 'running' | 'blocked' | 'queued' | 'parked' | 'done';

export interface StationTodo {
  todoId: string;
  title: string;
  projectId: string;
  laneId: string | null;
  state: StationState;
  /** Why it is where it is, when that needs saying. */
  reason: string | null;
  /** Failed runs since a person last touched it. */
  failures: number;
  /** The run working it now, if one is. */
  liveRunId: string | null;
}

export interface LaneTally {
  projectId: string;
  laneId: string;
  done: number;
}

/**
 * Every open todo in the user's AI projects, and where it stands: the same
 * rules `readyTodos` applies, read back as a reason instead of a filter.
 *
 *   - running: a run holds it now
 *   - parked: no station will ever pick it up where it is (no lane, no agent,
 *     AI told to ignore it, an expand lane with nowhere to put what it makes)
 *   - attention: a station gave up on it (more failures than the lane allows)
 *     or finished with it and has nowhere to send it
 *   - blocked: it waits on something unfinished
 *   - queued: a station will start on it when there is room
 *
 * Done todos are only counted, per lane: there can be many, and none of them
 * needs anything.
 *
 * @param db The database.
 * @param userId Whose todos.
 * @param projectId Narrows it to one project.
 * @returns The open todos, in board order, and the done counts.
 */
export async function stationStates(
  db: AnyDb,
  userId: string,
  projectId?: string | null,
): Promise<{ todos: StationTodo[]; done: LaneTally[] }> {
  const project = projectId ? sql`AND p.id = ${projectId}` : sql``;
  const open = resultRows<{
    todo_id: string;
    title: string;
    project_id: string;
    lane_id: string | null;
    lane_name: string | null;
    has_agent: boolean;
    ai_ignored: boolean;
    barren_expand: boolean;
    max_attempts: number | null;
    failures: number;
    finished_here: boolean;
    last_failure: string | null;
    blockers: string | null;
    live_run_id: string | null;
  }>(
    await db.execute(sql`
      WITH base AS (
        SELECT
          t.id, t.title, t.project_id, t.lane_id, t.ai_ignored, t.position, t.created_at,
          l.name AS lane_name, l.position AS lane_position, l.agent_id IS NOT NULL AS has_agent,
          (l.contract = 'expand' AND l.on_success_lane_id IS NULL) AS barren_expand,
          l.max_attempts,
          (SELECT max(e.at) FROM todo_events e WHERE e.todo_id = t.id AND e.actor_kind = 'user') AS touched,
          coalesce(
            (SELECT max(e.at) FROM todo_events e WHERE e.todo_id = t.id AND e.to_lane_id = l.id),
            t.created_at
          ) AS arrived
        FROM todos t
        JOIN projects p ON p.id = t.project_id
        LEFT JOIN lanes l ON l.id = t.lane_id
        WHERE t.user_id = ${userId} AND p.ai_enabled AND p.archived_at IS NULL
          AND t.completed_at IS NULL AND t.archived_at IS NULL AND NOT coalesce(l.is_done, false)
          ${project}
      )
      SELECT
        b.id AS todo_id, b.title, b.project_id, b.lane_id, b.lane_name,
        coalesce(b.has_agent, false) AS has_agent, b.ai_ignored,
        coalesce(b.barren_expand, false) AS barren_expand, b.max_attempts,
        (
          SELECT count(*)::int FROM runs r
          WHERE r.todo_id = b.id AND (r.status = 'error' OR r.verdict = 'fail')
            AND r.started_at > coalesce(b.touched, '-infinity'::timestamptz)
        ) AS failures,
        EXISTS (
          SELECT 1 FROM runs r
          WHERE r.todo_id = b.id AND r.lane_id = b.lane_id AND r.status = 'ok' AND r.started_at >= b.arrived
        ) AS finished_here,
        (
          SELECT coalesce(r.error, r.output) FROM runs r
          WHERE r.todo_id = b.id AND (r.status = 'error' OR r.verdict = 'fail')
          ORDER BY r.started_at DESC LIMIT 1
        ) AS last_failure,
        (
          SELECT string_agg(d2.title, ', ' ORDER BY d2.title) FROM todo_dependencies d
          JOIN todos d2 ON d2.id = d.depends_on_todo_id
          WHERE d.todo_id = b.id AND d2.completed_at IS NULL AND d2.archived_at IS NULL
        ) AS blockers,
        (
          SELECT r.id FROM runs r
          WHERE r.todo_id = b.id AND r.status = 'running' AND r.lease_expires_at > now()
          ORDER BY r.started_at DESC LIMIT 1
        ) AS live_run_id
      FROM base b
      ORDER BY b.project_id, b.lane_position NULLS LAST, b.position, b.created_at
    `),
  );

  const todos = open.map((row): StationTodo => {
    const [state, reason] = judge(row);
    return {
      todoId: row.todo_id,
      title: row.title,
      projectId: row.project_id,
      laneId: row.lane_id,
      state,
      reason,
      failures: Number(row.failures),
      liveRunId: row.live_run_id,
    };
  });

  const done = resultRows<{ project_id: string; lane_id: string; done: number }>(
    await db.execute(sql`
      SELECT t.project_id, t.lane_id, count(*)::int AS done
      FROM todos t
      JOIN projects p ON p.id = t.project_id
      JOIN lanes l ON l.id = t.lane_id
      WHERE t.user_id = ${userId} AND p.ai_enabled AND p.archived_at IS NULL
        AND t.archived_at IS NULL AND (t.completed_at IS NOT NULL OR l.is_done)
        ${project}
      GROUP BY t.project_id, t.lane_id
    `),
  ).map((row) => ({ projectId: row.project_id, laneId: row.lane_id, done: Number(row.done) }));

  return { todos, done };
}

function judge(row: {
  lane_id: string | null;
  lane_name: string | null;
  has_agent: boolean;
  ai_ignored: boolean;
  barren_expand: boolean;
  max_attempts: number | null;
  failures: number;
  finished_here: boolean;
  last_failure: string | null;
  blockers: string | null;
  live_run_id: string | null;
}): [StationState, string | null] {
  if (row.live_run_id) return ['running', null];
  if (!row.lane_id) return ['parked', 'It is in no lane.'];
  if (row.ai_ignored) return ['parked', 'AI is told to ignore it.'];
  if (!row.has_agent) return ['parked', `${row.lane_name} has no agent.`];
  if (row.barren_expand) return ['parked', `${row.lane_name} splits todos but has nowhere to put the pieces.`];
  if (Number(row.failures) > (row.max_attempts ?? 0)) {
    return ['attention', row.last_failure?.trim() || `It failed ${row.failures} times.`];
  }
  if (row.finished_here) return ['attention', `${row.lane_name} finished with it and has nowhere to send it.`];
  if (row.blockers) return ['blocked', `Waiting on ${row.blockers}.`];
  return ['queued', null];
}
