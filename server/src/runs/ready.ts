import type { DB } from '@telos/db';
import type { RunMode } from '@telos/db/schema';
import { type SQL, sql } from 'drizzle-orm';
import type { StationTodo } from '../../__generated__/resolvers.ts';
import type { HandBack, WorkState } from '../core/enums.ts';
import { INSTANCE_AI_ON, INSTANCE_RUN_ROOM } from '../instance/settings.ts';
import { resultRows } from '../todos/blocking.ts';
import { openQuestion } from '../todos/questions.ts';

// The readiness rules, in one place: which todos a lane's agent may start on,
// and how to stop what is running. The runner asks
// `runnerQueue` what to start, and `claimRun` asks the same question again for
// one todo inside the claiming transaction, so what is claimable is decided by
// one piece of SQL rather than two that could drift.
//
// A todo is ready for its lane's agent when all of these hold:
//
//   - every AI switch over it is on: its user's, its project's, and it is not
//     ignored — the same three checks a run token makes on every request
//   - its project runs by itself (run mode `auto`), or a person asked for this
//     todo to be run (runTodo), which holds until a run claims it, or its
//     project follows what it is asked for (`follow`) and this todo was
//   - the project is not archived, and the todo is open and not blocked
//   - it is not an umbrella: a todo split into pieces is done when they are,
//     not by being worked
//   - nothing is working it now (a running run inside its lease)
//   - no agent is waiting on a person: a question a run asked with no
//     person's note after it (todos/questions.ts)
//   - the lane's agent has not already finished with it: no `ok` run in this lane
//     since the todo last arrived here (`arrivedIn`: an edit is not an arrival)
//   - it has failed no more than `maxAttempts` times since a person last
//     touched it, which is what stops a Doing↔Review loop spending forever
//   - the lane has room under its WIP limit
//   - the instance has room under its run limit, which counts every lane's
//     runs at once (instance_settings.run_limit)

/** How long a claim holds a todo without a heartbeat before it counts as abandoned. */
export const LEASE_SECONDS = 120;

export interface ReadyTodo {
  todoId: string;
  laneId: string;
  projectId: string;
  userId: string;
}

/**
 * What a failed run is, in a query that names the run `r`: it errored, or a
 * reviewer ruled against it. One definition, for the queue, the status panel
 * and the board's cards.
 */
export const RUN_FAILED = sql`(r.status = 'error' OR r.verdict = 'fail')`;

/**
 * What forgets a todo's failures, in a query that names the event `e`: a
 * person touching it, or anyone at all sending it round again (`retryTodo`,
 * `runTodo`), which a key or an agent may do from the MCP door.
 */
export const TOUCHED = sql`(e.actor_kind = 'user' OR e.kind IN ('retry', 'run'))`;

/**
 * When a todo last arrived in a lane: the newest event that put it there, or
 * its creation. Every event names the lane the todo is in, but an edit is not
 * an arrival: rewriting a todo whose lane is done with it, as a person or as a
 * run's refine, must not hand it back to the lane's agent.
 *
 * @param todoId - The todo's id column, as the surrounding query names it.
 * @param laneId - The lane's id column.
 * @param createdAt - The todo's creation column, the arrival when no event says.
 * @returns A scalar subquery.
 */
export function arrivedIn(todoId: SQL, laneId: SQL, createdAt: SQL): SQL {
  return sql`coalesce(
    (SELECT max(e.at) FROM todo_events e WHERE e.todo_id = ${todoId} AND e.to_lane_id = ${laneId} AND e.kind <> 'edit'),
    ${createdAt}
  )`;
}

/**
 * How many of a todo's runs failed since it was last touched: the count a
 * lane's `maxAttempts` is held against.
 *
 * @param todoId - The todo's id column, as the surrounding query names it.
 * @returns A scalar subquery.
 */
export function failuresSinceTouched(todoId: SQL): SQL {
  return sql`(
    SELECT count(*)::int FROM runs r
    WHERE r.todo_id = ${todoId} AND ${RUN_FAILED}
      AND r.started_at > coalesce(
        (SELECT max(e.at) FROM todo_events e WHERE e.todo_id = ${todoId} AND ${TOUCHED}),
        '-infinity'::timestamptz
      )
  )`;
}

/**
 * The todos lanes' agents could start on now, first lane and first todo first.
 *
 * @param db The database or transaction.
 * @param filter Narrows the question to one todo in one lane, which is how a claim asks it.
 * @param limit The most to return.
 * @returns The ready todos, each with the lane that would work it.
 */
export async function readyTodos(
  db: DB,
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
      WHERE ${INSTANCE_AI_ON} AND u.ai_enabled AND p.ai_enabled AND NOT t.ai_ignored AND a.enabled
        AND (p.run_mode = 'auto' OR t.run_requested_at IS NOT NULL OR (p.run_mode = 'follow' AND t.followed_at IS NOT NULL))
        AND p.archived_at IS NULL
        AND t.completed_at IS NULL AND t.archived_at IS NULL AND t.split_at IS NULL AND NOT l.is_done
        ${sql.join(narrow, sql` `)}
        AND NOT EXISTS (
          SELECT 1 FROM todo_dependencies d JOIN todos b ON b.id = d.depends_on_todo_id
          WHERE d.todo_id = t.id AND b.completed_at IS NULL AND b.archived_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM runs r
          WHERE r.todo_id = t.id AND r.status = 'running' AND r.lease_expires_at > now()
        )
        AND ${openQuestion(sql`t.id`)} IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM runs r
          WHERE r.todo_id = t.id AND r.lane_id = l.id AND r.status = 'ok'
            AND r.started_at >= ${arrivedIn(sql`t.id`, sql`l.id`, sql`t.created_at`)}
        )
        AND ${failuresSinceTouched(sql`t.id`)} <= l.max_attempts
    )
    SELECT c.todo_id, c.lane_id, c.project_id, c.user_id
    FROM candidates c LEFT JOIN live ON live.lane_id = c.lane_id
    WHERE c.place <= c.wip_limit - coalesce(live.n, 0)
    ORDER BY c.lane_position, c.position, c.created_at
    LIMIT least(${limit}, ${INSTANCE_RUN_ROOM})
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
export async function expireLapsedRuns(db: DB, where: { todoId: string; laneId: string }): Promise<void> {
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
  db: DB,
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

/**
 * Forgets the run a person asked for. For one todo, a run has taken it, and
 * whether it is followed stands. For a project, AI can no longer work it, so
 * which of its todos were followed is forgotten too.
 *
 * @param db - The database or transaction.
 * @param where - Which requests: one todo's, or every one in a project.
 * @returns Nothing.
 */
export async function dropRunRequests(db: DB, where: { todoId: string } | { projectId: string }): Promise<void> {
  if ('todoId' in where) {
    await db.execute(
      sql`UPDATE todos SET run_requested_at = NULL WHERE run_requested_at IS NOT NULL AND id = ${where.todoId}`,
    );
    return;
  }
  await db.execute(sql`
    UPDATE todos SET run_requested_at = NULL, followed_at = NULL
    WHERE (run_requested_at IS NOT NULL OR followed_at IS NOT NULL) AND project_id = ${where.projectId}
  `);
}

/**
 * Forgets which of a project's todos were followed: it left follow mode, and
 * a todo asked for under it should not start following again if it returns.
 *
 * @param db - The database or transaction.
 * @param projectId - The project.
 * @returns Nothing.
 */
export async function dropFollows(db: DB, projectId: string): Promise<void> {
  await db.execute(
    sql`UPDATE todos SET followed_at = NULL WHERE followed_at IS NOT NULL AND project_id = ${projectId}`,
  );
}

/**
 * A todo and where it stands: the API's `StationTodo`, with what the pages
 * that list them across projects also show.
 */
export interface WorkTodo extends Omit<StationTodo, '__typename'> {
  projectName: string;
  laneName: string | null;
  /** How many failures its lane allows. Null where no agent works the lane. */
  maxAttempts: number | null;
  /** Its last finished run. */
  lastRunId: string | null;
  lastRunAt: Date | null;
}

/** How many of a lane's todos are done: aiStatus adds them to its `LaneTally`. */
export interface LaneDoneCount {
  projectId: string;
  laneId: string;
  done: number;
}

/**
 * Every open todo in the user's AI projects, and where it stands: the same
 * rules `readyTodos` applies, read back as a reason instead of a filter.
 *
 *   - running: a run holds it now
 *   - asked: its agent asked a person something, and waits for the answer
 *   - waiting: it is an umbrella, done when its pieces are
 *   - parked: no agent will ever pick it up where it is (no lane, no agent
 *     or one switched off, AI told to ignore it)
 *   - handedBack: its lane's agent gave up on it (more failures than the lane
 *     allows) or finished with it and has nowhere to send it
 *   - blocked: it waits on something unfinished
 *   - queued: its lane's agent will start on it when there is room
 *
 * A todo that would be queued is parked instead while its project does not
 * run by itself (run mode `lane`, or `follow` and the todo not yet followed),
 * until a person asks for it to be run.
 *
 * Done todos are only counted, per lane: there can be many, and none of them
 * needs anything.
 *
 * @param db The database.
 * @param userId Whose todos.
 * @param projectId Narrows it to one project.
 * @returns The open todos, in board order, and the done counts.
 */
export async function workStates(
  db: DB,
  userId: string,
  projectId?: string | null,
): Promise<{ todos: WorkTodo[]; done: LaneDoneCount[] }> {
  const project = projectId ? sql`AND p.id = ${projectId}` : sql``;
  const open = resultRows<{
    todo_id: string;
    title: string;
    project_id: string;
    project_name: string;
    lane_id: string | null;
    lane_name: string | null;
    has_agent: boolean;
    agent_name: string | null;
    agent_enabled: boolean;
    ai_ignored: boolean;
    run_mode: RunMode;
    run_requested: boolean;
    followed: boolean;
    split: boolean;
    pieces: number;
    pieces_done: number;
    max_attempts: number | null;
    failures: number;
    finished_here: boolean;
    last_failure: string | null;
    blockers: string | null;
    live_run_id: string | null;
    question: string | null;
    last_run_id: string | null;
    last_run_at: Date | string | null;
  }>(
    await db.execute(sql`
      WITH base AS (
        SELECT
          t.id, t.title, t.project_id, p.name AS project_name, t.lane_id, t.ai_ignored, t.position, t.created_at, p.run_mode,
          t.run_requested_at IS NOT NULL AS run_requested, t.followed_at IS NOT NULL AS followed, t.split_at IS NOT NULL AS split,
          l.name AS lane_name, l.position AS lane_position, l.agent_id IS NOT NULL AS has_agent,
          a.name AS agent_name, coalesce(a.enabled, true) AS agent_enabled,
          l.max_attempts,
          ${arrivedIn(sql`t.id`, sql`l.id`, sql`t.created_at`)} AS arrived
        FROM todos t
        JOIN projects p ON p.id = t.project_id
        LEFT JOIN lanes l ON l.id = t.lane_id
        LEFT JOIN agents a ON a.id = l.agent_id
        WHERE t.user_id = ${userId} AND p.ai_enabled AND p.archived_at IS NULL
          AND t.completed_at IS NULL AND t.archived_at IS NULL AND NOT coalesce(l.is_done, false)
          ${project}
      )
      SELECT
        b.id AS todo_id, b.title, b.project_id, b.project_name, b.lane_id, b.lane_name,
        coalesce(b.has_agent, false) AS has_agent, b.agent_name, b.agent_enabled, b.ai_ignored, b.run_mode, b.run_requested, b.followed,
        b.split, pieces.total AS pieces, pieces.done AS pieces_done,
        b.max_attempts,
        ${failuresSinceTouched(sql`b.id`)} AS failures,
        EXISTS (
          SELECT 1 FROM runs r
          WHERE r.todo_id = b.id AND r.lane_id = b.lane_id AND r.status = 'ok' AND r.started_at >= b.arrived
        ) AS finished_here,
        (
          SELECT coalesce(r.error, r.output) FROM runs r
          WHERE r.todo_id = b.id AND ${RUN_FAILED}
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
        ) AS live_run_id,
        ${openQuestion(sql`b.id`)} AS question,
        last.id AS last_run_id, last.started_at AS last_run_at
      FROM base b
      LEFT JOIN LATERAL (
        SELECT r.id, r.started_at FROM runs r
        WHERE r.todo_id = b.id AND r.status IN ('ok', 'error', 'asked')
        ORDER BY r.started_at DESC LIMIT 1
      ) last ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS total, count(*) FILTER (WHERE c.completed_at IS NOT NULL)::int AS done
        FROM todos c WHERE b.split AND c.parent_id = b.id AND (c.archived_at IS NULL OR c.completed_at IS NOT NULL)
      ) pieces ON true
      ORDER BY b.project_id, b.lane_position NULLS LAST, b.position, b.created_at
    `),
  );

  const todos = open.map((row): WorkTodo => {
    const [state, reason, handedBack = null] = judge(row);
    return {
      todoId: row.todo_id,
      title: row.title,
      projectId: row.project_id,
      laneId: row.lane_id,
      state,
      reason,
      handedBack,
      failures: Number(row.failures),
      liveRunId: row.live_run_id,
      awaitsRun: state === 'parked' && reason === AWAITS_RUN,
      runRequested: row.run_requested,
      following: row.run_mode === 'follow' && row.followed,
      projectName: row.project_name,
      laneName: row.lane_name,
      maxAttempts: row.has_agent ? row.max_attempts : null,
      lastRunId: row.last_run_id,
      lastRunAt: row.last_run_at === null ? null : new Date(row.last_run_at),
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

/** Why a todo a lane's agent could take is not queued, in a project that waits to be asked. */
const AWAITS_RUN = 'It waits to be run.';

function judge(row: {
  lane_id: string | null;
  lane_name: string | null;
  has_agent: boolean;
  agent_name: string | null;
  agent_enabled: boolean;
  ai_ignored: boolean;
  run_mode: RunMode;
  run_requested: boolean;
  followed: boolean;
  split: boolean;
  pieces: number;
  pieces_done: number;
  max_attempts: number | null;
  failures: number;
  finished_here: boolean;
  last_failure: string | null;
  blockers: string | null;
  live_run_id: string | null;
  question: string | null;
}): [WorkState, string | null, HandBack?] {
  if (row.live_run_id) return ['running', null];
  if (row.question) return ['asked', `Waiting on a person: ${row.question}`];
  if (row.split) return ['waiting', `${row.pieces_done} of ${row.pieces} pieces done.`];
  if (!row.lane_id) return ['parked', 'It is in no lane.'];
  if (row.ai_ignored) return ['parked', 'AI is told to ignore it.'];
  if (!row.has_agent) return ['parked', `${row.lane_name} has no agent.`];
  if (!row.agent_enabled) return ['parked', `${row.agent_name}, who works ${row.lane_name}, is switched off.`];
  if (Number(row.failures) > (row.max_attempts ?? 0)) {
    return ['handedBack', row.last_failure?.trim() || `It failed ${row.failures} times.`, 'gaveUp'];
  }
  if (row.finished_here) {
    return ['handedBack', `${row.lane_name} finished with it and has nowhere to send it.`, 'finished'];
  }
  if (row.blockers) return ['blocked', `Waiting on ${row.blockers}.`];
  const runsByItself = row.run_mode === 'auto' || (row.run_mode === 'follow' && row.followed);
  if (runsByItself === false && row.run_requested === false) {
    return ['parked', AWAITS_RUN];
  }
  return ['queued', null];
}
