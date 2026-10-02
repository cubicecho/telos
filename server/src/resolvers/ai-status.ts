import * as dbSchema from '@telos/db/schema';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi } from '../ai-gate.ts';
import { resultRows } from '../blocking.ts';
import type { Context } from '../context.ts';
import { runnerSeenAt } from '../runner-seen.ts';
import { type StationState, stationStates } from '../stations.ts';
import { requireSession } from './auth.ts';

// The stations, as a person reads them: what needs them, what is running,
// what waits, per lane; and whether the runner is there at all. Plus the two
// things a person can do about a todo at a station: send one it gave up on
// round again, and ask for one to be worked now.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const AI_STATUS_SDL = parse(`
  "An open todo and where it stands with the stations."
  type StationTodo {
    todoId: ID!
    title: String!
    projectId: ID!
    laneId: ID
    "attention, running, blocked, queued or parked."
    state: String!
    "Why it is where it is, when that needs saying."
    reason: String
    "Failed runs since a person last touched it."
    failures: Int!
    "The run working it now."
    liveRunId: ID
    "A station would take it, were it asked to (runTodo): its project does not run by itself."
    awaitsRun: Boolean!
    "A person asked for it to be run, and no run has taken it yet."
    runRequested: Boolean!
  }

  "How many of a lane's todos are in each state."
  type LaneTally {
    laneId: ID!
    name: String!
    "Whether an agent works this lane."
    station: Boolean!
    isDone: Boolean!
    attention: Int!
    running: Int!
    blocked: Int!
    queued: Int!
    parked: Int!
    done: Int!
  }

  type ProjectTally {
    projectId: ID!
    name: String!
    lanes: [LaneTally!]!
  }

  type AiStatus {
    "Every open todo in a project with AI on, in board order."
    todos: [StationTodo!]!
    "Each such project's lanes, counted."
    projects: [ProjectTally!]!
    "When the runner last asked for work. Null when it has not since the server started."
    runnerSeenAt: DateTime
  }

  extend type Query {
    "Where every todo stands with the stations, across your AI projects or in one."
    aiStatus(projectId: ID): AiStatus!
  }

  extend type Mutation {
    "Sends a todo round its station again: its failures are forgotten, and a station that finished with it starts over."
    retryTodo(id: ID!, reason: String): Boolean!
    "Asks for a todo to be worked once where it stands, whether or not its project runs by itself. Also a retry."
    runTodo(id: ID!): Todo!
  }
`);

/** The history kinds a person's nudge to a station is recorded as. */
const RETRY_EVENT = 'retry' as const;
const RUN_EVENT = 'run' as const;

/**
 * Finds a todo a station could be nudged about: the caller's, not archived,
 * in a lane, and not being worked now.
 *
 * @param db - The database or transaction.
 * @param userId - The caller.
 * @param id - The todo.
 * @returns The todo's row.
 */
async function restingTodo(db: AnyRow, userId: string, id: string): Promise<AnyRow> {
  const [todo] = await db
    .select()
    .from(dbSchema.todos)
    .where(and(eq(dbSchema.todos.id, id), eq(dbSchema.todos.userId, userId), isNull(dbSchema.todos.archivedAt)));
  if (todo === undefined) {
    throw new GraphQLError('Todo not found', { extensions: { code: 'NOT_FOUND' } });
  }
  if (todo.laneId === null) {
    throw new GraphQLError('It is in no lane, so no station can take it.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  const [live] = await db
    .select({ id: dbSchema.runs.id })
    .from(dbSchema.runs)
    .where(
      and(
        eq(dbSchema.runs.todoId, todo.id),
        eq(dbSchema.runs.status, 'running'),
        sql`${dbSchema.runs.leaseExpiresAt} > now()`,
      ),
    );
  if (live !== undefined) {
    throw new GraphQLError('An agent is working it now.', { extensions: { code: 'CONFLICT' } });
  }
  return todo;
}

/**
 * Records a person's nudge in the todo's lane. Their event arriving there is
 * what forgets its failures and restarts a station that finished with it.
 *
 * @param db - The database or transaction.
 * @param todo - The todo's row.
 * @param kind - Which nudge it was.
 * @param [reason] - Why, in the person's words.
 * @returns Nothing.
 */
async function recordNudge(
  db: AnyRow,
  todo: AnyRow,
  kind: typeof RETRY_EVENT | typeof RUN_EVENT,
  reason?: string | null,
): Promise<void> {
  await db.insert(dbSchema.todoEvents).values({
    userId: todo.userId,
    todoId: todo.id,
    kind,
    fromLaneId: todo.laneId,
    toLaneId: todo.laneId,
    actorKind: 'user',
    reason: reason?.trim() || null,
  });
}

/**
 * Why no station would work a todo even when asked, or null when one would.
 * The same rules `readyTodos` filters on, apart from auto-run and room.
 *
 * @param db - The database or transaction.
 * @param todo - The todo's row.
 * @returns The reason, as a sentence for the person who asked.
 */
async function whyNotRunnable(db: AnyRow, todo: AnyRow): Promise<string | null> {
  const [row] = resultRows<{
    ai_enabled: boolean;
    project_archived: boolean;
    lane_name: string;
    is_done: boolean;
    has_agent: boolean;
    barren_expand: boolean;
    blockers: string | null;
  }>(
    await db.execute(sql`
      SELECT
        p.ai_enabled, p.archived_at IS NOT NULL AS project_archived, l.name AS lane_name, l.is_done, l.agent_id IS NOT NULL AS has_agent,
        (l.contract = 'expand' AND l.on_success_lane_id IS NULL) AS barren_expand,
        (
          SELECT string_agg(b.title, ', ' ORDER BY b.title) FROM todo_dependencies d
          JOIN todos b ON b.id = d.depends_on_todo_id
          WHERE d.todo_id = t.id AND b.completed_at IS NULL AND b.archived_at IS NULL
        ) AS blockers
      FROM todos t
      JOIN projects p ON p.id = t.project_id
      JOIN lanes l ON l.id = t.lane_id
      WHERE t.id = ${todo.id}
    `),
  );
  if (row.ai_enabled === false) {
    return 'AI is off for its project.';
  }
  if (row.project_archived) {
    return 'Its project is archived.';
  }
  if (todo.aiIgnored) {
    return 'AI is told to ignore it.';
  }
  if (todo.completedAt !== null || row.is_done) {
    return 'It is already done.';
  }
  if (row.has_agent === false) {
    return `${row.lane_name} has no agent.`;
  }
  if (row.barren_expand) {
    return `${row.lane_name} splits todos but has nowhere to put the pieces.`;
  }
  if (row.blockers !== null) {
    return `It is waiting on ${row.blockers}.`;
  }
  return null;
}

const STATES: StationState[] = ['attention', 'running', 'blocked', 'queued', 'parked', 'done'];

export function applyAiStatusExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AI_STATUS_SDL);
  const queries = (extendedSchema.getType('Query') as GraphQLObjectType).getFields();
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  queries.aiStatus.resolve = async (_parent: unknown, args: { projectId?: string | null }, context: Context) => {
    const userId = await requireAi(context);
    const db = context.db as AnyRow;
    const { todos, done } = await stationStates(db, userId, args.projectId);

    const projects: AnyRow[] = await db
      .select({ id: dbSchema.projects.id, name: dbSchema.projects.name })
      .from(dbSchema.projects)
      .where(
        and(
          eq(dbSchema.projects.userId, userId),
          eq(dbSchema.projects.aiEnabled, true),
          sql`${dbSchema.projects.archivedAt} IS NULL`,
          args.projectId ? eq(dbSchema.projects.id, args.projectId) : undefined,
        ),
      )
      .orderBy(asc(dbSchema.projects.name));
    const lanes: AnyRow[] =
      projects.length === 0
        ? []
        : await db
            .select()
            .from(dbSchema.lanes)
            .where(
              inArray(
                dbSchema.lanes.projectId,
                projects.map((project) => project.id),
              ),
            )
            .orderBy(asc(dbSchema.lanes.position));

    const tallies = new Map<string, Record<StationState, number>>(
      lanes.map((lane) => [
        lane.id,
        Object.fromEntries(STATES.map((state) => [state, 0])) as Record<StationState, number>,
      ]),
    );
    for (const todo of todos) {
      const tally = todo.laneId ? tallies.get(todo.laneId) : undefined;
      if (tally) tally[todo.state] += 1;
    }
    for (const row of done) {
      const tally = tallies.get(row.laneId);
      if (tally) tally.done += row.done;
    }

    return {
      todos,
      projects: projects.map((project) => ({
        projectId: project.id,
        name: project.name,
        lanes: lanes
          .filter((lane) => lane.projectId === project.id)
          .map((lane) => ({
            laneId: lane.id,
            name: lane.name,
            station: lane.agentId != null,
            isDone: lane.isDone,
            ...tallies.get(lane.id),
          })),
      })),
      runnerSeenAt: runnerSeenAt(),
    };
  };

  mutations.retryTodo.resolve = async (
    _parent: unknown,
    args: { id: string; reason?: string | null },
    context: Context,
  ) => {
    const userId = await requireAi(context);
    const db = context.db as AnyRow;
    const todo = await restingTodo(db, userId, args.id);
    await recordNudge(db, todo, RETRY_EVENT, args.reason);
    return true;
  };

  mutations.runTodo.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    // A person's, never a key's or an agent's: working the board from the MCP
    // door is its own decision.
    requireSession(context);
    const userId = await requireAi(context);
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const todo = await restingTodo(tx, userId, args.id);
      const refusal = await whyNotRunnable(tx, todo);
      if (refusal !== null) {
        throw new GraphQLError(refusal, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      await recordNudge(tx, todo, RUN_EVENT);
      // The history trigger reads none of this column, so asking writes the
      // one event above and no second one.
      const [requested] = await tx
        .update(dbSchema.todos)
        .set({ runRequestedAt: new Date() })
        .where(eq(dbSchema.todos.id, todo.id))
        .returning();
      return requested;
    });
  };

  return extendedSchema;
}
