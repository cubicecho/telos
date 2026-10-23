import type { DB } from '@telos/db';
import * as dbSchema from '@telos/db/schema';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { MutationResolvers, QueryResolvers } from '../../__generated__/resolvers.ts';
import type { Actor, Context } from '../core/context.ts';
import { HandBackEnum, WORK_STATES, type WorkState, WorkStateEnum, withEnums } from '../core/enums.ts';
import { badInput, conflict } from '../core/errors.ts';
import { loadOwnedTodo } from '../core/owned.ts';
import { attachResolvers } from '../graphql/attach-resolvers.ts';
import { workStates } from '../runs/ready.ts';
import { runnerSeenAt } from '../runs/runner-seen.ts';
import { resultRows } from '../todos/blocking.ts';
import { requireAi } from './gate.ts';

// Lanes' agents, as a person reads them: what they handed back, what is running,
// what waits, per lane; and whether the runner is there at all. Plus the two
// things anyone can do about a todo in a lane with an agent, a key or an agent at the MCP
// door included: send one it gave up on round again, and ask for one to be
// worked now.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const AI_STATUS_SDL = parse(`
  "An open todo and where it stands with its lane's agent."
  type StationTodo {
    todoId: ID!
    title: String!
    projectId: ID!
    laneId: ID
    state: WorkState!
    "Why it is where it is, when that needs saying."
    reason: String
    "Why its lane's agent handed it back. Null unless its state is HANDED_BACK."
    handedBack: HandBack
    "Failed runs since a person last touched it, or anyone sent it round again."
    failures: Int!
    "The run working it now."
    liveRunId: ID
    "Its lane's agent would take it, were it asked to (runTodo): its project does not run by itself."
    awaitsRun: Boolean!
    "It was asked to be run, and no run has taken it yet."
    runRequested: Boolean!
  }

  "How many of a lane's todos are in each state."
  type LaneTally {
    laneId: ID!
    name: String!
    "Whether an agent works this lane."
    station: Boolean!
    isDone: Boolean!
    handedBack: Int!
    running: Int!
    waiting: Int!
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
    "Where every todo stands with its lane's agent, across your AI projects or in one."
    aiStatus(projectId: ID): AiStatus!
  }

  extend type Mutation {
    "Sends a todo round its lane's agent again: its failures are forgotten, and an agent that finished with it starts over."
    retryTodo(id: ID!, reason: String): Boolean!
    "Asks for a todo to be worked once where it stands, whether or not its project runs by itself. Also a retry. Who asked is on its history."
    runTodo(id: ID!): Todo!
  }
`);

/** The history kinds a nudge to a lane's agent is recorded as. */
const RETRY_EVENT = 'retry' as const;
const RUN_EVENT = 'run' as const;

/**
 * Finds a todo a lane's agent could be nudged about: the caller's, not archived,
 * in a lane, and not being worked now.
 *
 * @param context - The request.
 * @param id - The todo.
 * @param db - The database or transaction.
 * @returns The todo's row.
 */
async function restingTodo(context: Context, id: string, db: DB): Promise<AnyRow> {
  const todo = await loadOwnedTodo(context, id, db);
  if (todo.laneId === null) {
    throw badInput('It is in no lane, so no agent can take it. Move it to a lane with an agent.');
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
    throw conflict('An agent is working it now.');
  }
  return todo;
}

/**
 * Records a nudge in the todo's lane, signed as whoever gave it. The event
 * arriving there is what forgets its failures (ready.ts `TOUCHED`) and
 * restarts an agent that finished with it.
 *
 * @param db - The database or transaction.
 * @param actor - Who nudged it.
 * @param todo - The todo's row.
 * @param kind - Which nudge it was.
 * @param [reason] - Why, in the caller's words.
 * @returns Nothing.
 */
async function recordNudge(
  db: DB,
  actor: Actor,
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
    actorKind: actor.kind === 'anonymous' ? 'system' : actor.kind,
    actorKeyId: actor.keyId ?? null,
    runId: actor.runId ?? null,
    reason: reason?.trim() || null,
  });
}

/**
 * Why no agent would work a todo even when asked, or null when one would.
 * The same rules `readyTodos` filters on, apart from auto-run and room.
 *
 * @param db - The database or transaction.
 * @param todo - The todo's row.
 * @returns The reason, as a sentence for the person who asked.
 */
async function whyNotRunnable(db: DB, todo: AnyRow): Promise<string | null> {
  const [row] = resultRows<{
    ai_enabled: boolean;
    project_archived: boolean;
    lane_name: string;
    is_done: boolean;
    has_agent: boolean;
    split: boolean;
    blockers: string | null;
  }>(
    await db.execute(sql`
      SELECT
        p.ai_enabled, p.archived_at IS NOT NULL AS project_archived, l.name AS lane_name, l.is_done, l.agent_id IS NOT NULL AS has_agent,
        t.split_at IS NOT NULL AS split,
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
  if (row.split) {
    return 'It is split into pieces, and is done when they are.';
  }
  if (row.has_agent === false) {
    return `${row.lane_name} has no agent.`;
  }
  if (row.blockers !== null) {
    return `It is waiting on ${row.blockers}.`;
  }
  return null;
}

export function applyAiStatusExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(withEnums(schema, [WorkStateEnum, HandBackEnum]), AI_STATUS_SDL);
  const queries: QueryResolvers = {};
  const mutations: MutationResolvers = {};

  queries.aiStatus = async (_parent, args, context) => {
    const userId = await requireAi(context);
    const db = context.db;
    const { todos, done } = await workStates(db, userId, args.projectId);

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

    const noTally = () => Object.fromEntries(WORK_STATES.map((state) => [state, 0])) as Record<WorkState, number>;
    const tallies = new Map<string, Record<WorkState, number>>(lanes.map((lane) => [lane.id, noTally()]));
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
            ...(tallies.get(lane.id) ?? noTally()),
          })),
      })),
      runnerSeenAt: runnerSeenAt(),
    };
  };

  mutations.retryTodo = async (_parent, args, context) => {
    await requireAi(context);
    const db = context.db;
    const todo = await restingTodo(context, args.id, db);
    await recordNudge(db, context.actor, todo, RETRY_EVENT, args.reason);
    return true;
  };

  mutations.runTodo = async (_parent, args, context) => {
    await requireAi(context);
    return context.db.transaction(async (tx) => {
      const todo = await restingTodo(context, args.id, tx);
      const refusal = await whyNotRunnable(tx, todo);
      if (refusal !== null) {
        throw badInput(refusal);
      }
      await recordNudge(tx, context.actor, todo, RUN_EVENT);
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

  return attachResolvers(extendedSchema, { Query: queries, Mutation: mutations });
}
