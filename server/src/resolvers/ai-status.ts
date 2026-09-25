import * as dbSchema from '@telos/db/schema';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi } from '../ai-gate.ts';
import type { Context } from '../context.ts';
import { runnerSeenAt } from '../runner-seen.ts';
import { type StationState, stationStates } from '../stations.ts';

// The stations, as a person reads them: what needs them, what is running,
// what waits, per lane; and whether the runner is there at all. Plus the one
// thing a person can do about a todo a station gave up on: send it round
// again.
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
  }
`);

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
    const [todo] = await db
      .select()
      .from(dbSchema.todos)
      .where(and(eq(dbSchema.todos.id, args.id), eq(dbSchema.todos.userId, userId)));
    if (!todo) throw new GraphQLError('Todo not found', { extensions: { code: 'NOT_FOUND' } });
    if (!todo.laneId) {
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
    if (live) {
      throw new GraphQLError('An agent is working it now.', { extensions: { code: 'CONFLICT' } });
    }
    // A person's event arriving in the same lane is all it takes: failures
    // count from a person's last touch, and a station's "done with it" from
    // the last arrival. The queue sees both at once.
    await db.insert(dbSchema.todoEvents).values({
      userId,
      todoId: todo.id,
      kind: 'retry',
      fromLaneId: todo.laneId,
      toLaneId: todo.laneId,
      actorKind: 'user',
      reason: args.reason?.trim() || null,
    });
    return true;
  };

  return extendedSchema;
}
