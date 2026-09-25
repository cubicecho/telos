import * as dbSchema from '@telos/db/schema';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireSystem } from '../ai-gate.ts';
import { assertNoCycle, findBlocked } from '../blocking.ts';
import type { Actor, Context } from '../context.ts';
import { findFirstOpenLaneId } from '../lanes.ts';
import { stampActor } from '../provenance.ts';
import { mintRunToken } from '../run-tokens.ts';
import { expireLapsedRuns, LEASE_SECONDS, readyTodos } from '../stations.ts';
import { requireAuth } from './auth.ts';

// The runner's side of the board. The runner is a separate process that talks
// to telos only through these fields, as the system principal: it asks what is
// ready, claims a todo, keeps its lease alive, and reports what the agent said.
// Everything that decides something — what is ready, what a verdict means,
// where a todo goes next, what an expansion becomes — is decided here, so the
// runner is an executor and nothing more.
//
// The system principal owns no rows. Each of these acts as the owner of the
// run it names, and writes as the run's agent, so the history says an agent
// did it and which run.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const RUNS_SDL = parse(`
  "A todo a station could start on now, and the station."
  type ReadyTodo {
    todoId: ID!
    laneId: ID!
    projectId: ID!
  }

  "The agent a station names, secret included. Only ever handed to the runner."
  type RunnerAgent {
    id: ID!
    name: String!
    baseUrl: String!
    model: String!
    apiKey: String
    systemPrompt: String
    temperature: Float
    maxTokens: Int
    contextLength: Int
    maxToolIterations: Int!
    toolDiscovery: Boolean!
    toolSelectModel: String
    requestTimeoutSeconds: Int
    maxRetries: Int
    "The agent's MCP servers, as JSON."
    mcpServers: String!
  }

  "Everything an agent is told about the todo it is working, and where."
  type RunBrief {
    projectName: String!
    projectDescription: String
    projectContext: String
    laneName: String!
    "What the station asks for: work, verdict or expand."
    contract: String!
    lanePrompt: String
    title: String!
    brief: String
    acceptance: String
    "What the last agent to work it reported."
    report: String
    "Why it came back here, when it did."
    why: String
    "What people have said about it, oldest first."
    notes: [String!]!
  }

  type RunClaim {
    runId: ID!
    todoId: ID!
    "Sent as x-run-token, it lets the agent reach telos as itself while the run is live."
    token: String!
    "Heartbeat before this passes, or the run counts as abandoned."
    leaseExpiresAt: DateTime!
    agent: RunnerAgent!
    brief: RunBrief!
  }

  "A todo an expansion proposes."
  input ProposedTodoInput {
    title: String!
    brief: String
    acceptance: String
    "Titles of other todos in the same proposal that this one waits on."
    dependsOn: [String!]
  }

  "Something that happened in a run, for the live view."
  input RunEventInput {
    "tool_call, tool_result, hook or notice."
    kind: String!
    "The tool or hook it concerns."
    name: String
    ok: Boolean
    text: String
  }

  "Something a run left behind: where it is, not what is in it."
  input ArtifactInput {
    location: String!
    "declared (the agent said so) or detected (read off a tool call)."
    source: String!
    "created, updated, moved or deleted."
    action: String
    serverSlug: String
    tool: String
    title: String
    description: String
    mediaType: String
    sizeBytes: Int
  }

  "What a run came to."
  input RunResultInput {
    "ok, error or stopped."
    status: String!
    output: String
    error: String
    toolCalls: Int
    promptTokens: Int
    completionTokens: Int
    totalTokens: Int
    "For an expand station: the todos the agent broke this one into."
    todos: [ProposedTodoInput!]
    "What happened since the last heartbeat."
    events: [RunEventInput!]
    "What the run left behind."
    artifacts: [ArtifactInput!]
  }

  extend type Query {
    "What the stations could start on now. The runner's only."
    runnerQueue(limit: Int = 20): [ReadyTodo!]!
  }

  extend type Mutation {
    "Starts a run of a ready todo at its station. Null when it is no longer ready. The runner's only."
    claimRun(todoId: ID!, laneId: ID!): RunClaim
    "Keeps a run's lease. True means stop: somebody asked, or AI was switched off. The runner's only."
    heartbeatRun(id: ID!, events: [RunEventInput!]): Boolean!
    "Records what a run came to and moves its todo on. The runner's only."
    finishRun(id: ID!, result: RunResultInput!): Run!
    "Asks a running run to stop. The agent hears it on its next heartbeat."
    cancelRun(id: ID!): Run!
  }
`);

const OUTCOMES = new Set(['ok', 'error', 'stopped']);

/** The most events a run keeps: the newest, since a live view reads the end. */
export const MAX_RUN_EVENTS = 500;
/** The most of one event's text kept: enough to read, not a transcript. */
const EVENT_TEXT_CHARS = 4000;
/** The most artifacts one run may report. */
const MAX_ARTIFACTS = 100;

/** A verdict station's answer fails the todo when it opens with FAIL. Anything else passes. */
const FAILS = /^\s*FAIL\b/i;

function notFound(what: string): GraphQLError {
  return new GraphQLError(`${what} not found`, { extensions: { code: 'NOT_FOUND' } });
}

/**
 * When a lease taken or renewed now runs out.
 *
 * @returns The expiry.
 */
function leaseFromNow(): Date {
  return new Date(Date.now() + LEASE_SECONDS * 1000);
}

/**
 * A run with everything its outcome depends on: its todo, lane, project and
 * the owner's switch. Locks the run row, so a finish and a heartbeat cannot
 * interleave.
 *
 * @param tx The transaction.
 * @param runId The run.
 * @returns The run and its surroundings. The lane is null if it was deleted.
 */
async function loadRunForUpdate(tx: AnyRow, runId: string) {
  const [run] = await tx.select().from(dbSchema.runs).where(eq(dbSchema.runs.id, runId)).for('update');
  if (!run) throw notFound('Run');
  const [todo] = await tx.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, run.todoId));
  const [project] = await tx.select().from(dbSchema.projects).where(eq(dbSchema.projects.id, run.projectId));
  const [user] = await tx
    .select({ aiEnabled: dbSchema.users.aiEnabled })
    .from(dbSchema.users)
    .where(eq(dbSchema.users.id, run.userId));
  const [lane] = run.laneId ? await tx.select().from(dbSchema.lanes).where(eq(dbSchema.lanes.id, run.laneId)) : [];
  const aiOff = !user?.aiEnabled || !project?.aiEnabled || todo?.aiIgnored !== false;
  return { run, todo, project, lane: lane ?? null, aiOff };
}

/**
 * What the agent is told: the project, the station, the todo, and what has
 * been said about it.
 *
 * @param tx The transaction.
 * @param todo The todo being worked.
 * @param lane The station.
 * @param project The todo's project.
 * @returns The brief.
 */
async function briefFor(tx: AnyRow, todo: AnyRow, lane: AnyRow, project: AnyRow) {
  const thread: AnyRow[] = await tx
    .select()
    .from(dbSchema.todoNotes)
    .where(eq(dbSchema.todoNotes.todoId, todo.id))
    .orderBy(asc(dbSchema.todoNotes.createdAt));
  const report = thread.filter((note) => note.kind === 'report').at(-1)?.body ?? null;

  // Why it is back: the reason (or the note) on the move that brought it here,
  // when that move was not its first arrival.
  const [arrival] = await tx
    .select({ reason: dbSchema.todoEvents.reason, noteId: dbSchema.todoEvents.noteId })
    .from(dbSchema.todoEvents)
    .where(and(eq(dbSchema.todoEvents.todoId, todo.id), eq(dbSchema.todoEvents.toLaneId, lane.id)))
    .orderBy(desc(dbSchema.todoEvents.at))
    .limit(1);
  const why =
    arrival?.reason ?? (arrival?.noteId ? (thread.find((note) => note.id === arrival.noteId)?.body ?? null) : null);

  return {
    projectName: project.name,
    projectDescription: project.description,
    projectContext: project.context,
    laneName: lane.name,
    contract: lane.contract,
    lanePrompt: lane.prompt,
    title: todo.title,
    brief: todo.notes,
    acceptance: todo.acceptance,
    report,
    why,
    notes: thread.filter((note) => note.kind === 'note').map((note) => note.body as string),
  };
}

/**
 * The next position in a project: after everything in it. Position is
 * project-wide (see resolvers/lanes.ts), so this is the end of every lane.
 *
 * @param tx The transaction.
 * @param projectId The project.
 * @returns The position.
 */
async function nextPosition(tx: AnyRow, projectId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${dbSchema.todos.position})` })
    .from(dbSchema.todos)
    .where(eq(dbSchema.todos.projectId, projectId));
  return row?.max == null ? 0 : Number(row.max) + 1;
}

/**
 * Writes an expansion's todos into `laneId`, links what they wait on by title,
 * and makes the parent wait on all of them: the request is done when its
 * pieces are. A dependency naming nothing in the batch, or one that would close
 * a cycle, is dropped — a lost ordering hint, not a lost todo.
 *
 * @param tx The transaction, already stamped with the agent.
 * @param parent The todo that was broken up.
 * @param laneId Where the pieces land.
 * @param proposed What the agent proposed.
 * @returns The new todos.
 */
async function writeChildren(tx: AnyRow, parent: AnyRow, laneId: string, proposed: ProposedTodo[]): Promise<AnyRow[]> {
  const start = await nextPosition(tx, parent.projectId);
  const written: AnyRow[] = await tx
    .insert(dbSchema.todos)
    .values(
      proposed.map((todo, at) => ({
        userId: parent.userId,
        projectId: parent.projectId,
        parentId: parent.id,
        laneId,
        title: todo.title.trim(),
        notes: todo.brief?.trim() || null,
        acceptance: todo.acceptance?.trim() || null,
        position: start + at,
      })),
    )
    .returning();

  const byTitle = new Map(written.map((todo) => [todo.title as string, todo.id as string]));
  const edges: Array<[string, string]> = [
    ...proposed.flatMap((todo, at) =>
      (todo.dependsOn ?? [])
        .map((title) => byTitle.get(title.trim()))
        .filter((id): id is string => !!id && id !== written[at].id)
        .map((id): [string, string] => [written[at].id, id]),
    ),
    ...written.map((child): [string, string] => [parent.id, child.id]),
  ];
  for (const [todoId, dependsOnTodoId] of edges) {
    try {
      await assertNoCycle(tx, todoId, dependsOnTodoId);
    } catch {
      continue;
    }
    await tx
      .insert(dbSchema.todoDependencies)
      .values({ userId: parent.userId, todoId, dependsOnTodoId })
      .onConflictDoNothing();
  }
  return written;
}

interface ProposedTodo {
  title: string;
  brief?: string | null;
  acceptance?: string | null;
  dependsOn?: string[] | null;
}

interface RunEventInput {
  kind: string;
  name?: string | null;
  ok?: boolean | null;
  text?: string | null;
}

interface ArtifactInput {
  location: string;
  source: string;
  action?: string | null;
  serverSlug?: string | null;
  tool?: string | null;
  title?: string | null;
  description?: string | null;
  mediaType?: string | null;
  sizeBytes?: number | null;
}

/**
 * A run's events with `incoming` added, stamped now, cut to size.
 *
 * @param existing What the run already has.
 * @param incoming What the runner just reported.
 * @returns The events to store.
 */
function withEvents(existing: dbSchema.RunEvent[] | null, incoming: RunEventInput[] | null | undefined) {
  const at = new Date().toISOString();
  const added = (incoming ?? []).map((event) => ({
    at,
    kind: event.kind.slice(0, 40),
    name: event.name?.slice(0, 200) ?? null,
    ok: event.ok ?? null,
    text: event.text?.slice(0, EVENT_TEXT_CHARS) ?? null,
  }));
  return [...(existing ?? []), ...added].slice(-MAX_RUN_EVENTS);
}

/**
 * The artifacts a result reports, as rows. Anything without a location, or
 * with a source or action the board does not know, is dropped rather than
 * failing the finish: a run's work is not undone by a malformed receipt.
 *
 * @param run The run.
 * @param reported What the runner reported.
 * @returns Rows to insert.
 */
function artifactRows(run: AnyRow, reported: ArtifactInput[] | null | undefined) {
  const sources: readonly string[] = dbSchema.ARTIFACT_SOURCES;
  const actions: readonly string[] = dbSchema.ARTIFACT_ACTIONS;
  return (reported ?? [])
    .filter(
      (artifact) =>
        artifact.location?.trim() &&
        sources.includes(artifact.source) &&
        (!artifact.action || actions.includes(artifact.action)),
    )
    .slice(0, MAX_ARTIFACTS)
    .map((artifact) => ({
      userId: run.userId,
      projectId: run.projectId,
      todoId: run.todoId,
      runId: run.id,
      location: artifact.location.trim(),
      source: artifact.source as dbSchema.ArtifactSource,
      action: (artifact.action ?? 'created') as dbSchema.ArtifactAction,
      serverSlug: artifact.serverSlug || null,
      tool: artifact.tool || null,
      title: artifact.title?.trim() || null,
      description: artifact.description?.trim() || null,
      mediaType: artifact.mediaType || null,
      sizeBytes: artifact.sizeBytes ?? null,
    }));
}

interface RunResult {
  status: string;
  output?: string | null;
  error?: string | null;
  toolCalls?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  todos?: ProposedTodo[] | null;
  events?: RunEventInput[] | null;
  artifacts?: ArtifactInput[] | null;
}

/** The counters a result reports, as columns. */
function spend(result: RunResult) {
  return {
    toolCalls: result.toolCalls ?? 0,
    promptTokens: result.promptTokens ?? 0,
    completionTokens: result.completionTokens ?? 0,
    totalTokens: result.totalTokens ?? 0,
  };
}

/**
 * Records what a run came to and carries out what the station says follows.
 *
 * A run that was asked to stop, or whose user, project or todo was closed to
 * AI while it worked, is recorded as stopped and nothing else happens: no
 * note, no move, no new todos. For a user who switched AI off, that is the
 * promise — nothing of theirs changes after the switch.
 *
 * Otherwise the outcome is read against the lane's contract. A `verdict`
 * station ruled FAIL, a failed run, or an expansion that proposed nothing
 * sends the todo down the failure arm; anything else passes, down the success
 * arm. A todo a person moved while the agent worked stays where the person
 * put it: the run's opinion is recorded, but the person's move wins.
 *
 * @param context The runner's context.
 * @param runId The run.
 * @param result What the runner reports.
 * @returns The finished run.
 */
async function finish(context: Context, runId: string, result: RunResult): Promise<AnyRow> {
  if (!OUTCOMES.has(result.status)) {
    throw new GraphQLError('status must be ok, error or stopped', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
    const { run, todo, lane, aiOff } = await loadRunForUpdate(tx, runId);
    if (run.status !== 'running') {
      throw new GraphQLError('That run has already finished.', { extensions: { code: 'CONFLICT' } });
    }
    const output = result.output?.trim() || null;

    if (result.status === 'stopped' || run.cancelRequestedAt || aiOff || !todo) {
      // A run stopped by a switch keeps nothing it said after the switch.
      const events = aiOff ? run.events : withEvents(run.events, result.events);
      const [stopped] = await tx
        .update(dbSchema.runs)
        .set({ status: 'stopped', output, events, finishedAt: new Date(), ...spend(result) })
        .where(eq(dbSchema.runs.id, run.id))
        .returning();
      return stopped;
    }

    const ok = result.status === 'ok';
    const verdict = run.contract === 'verdict' && ok ? (FAILS.test(output ?? '') ? 'fail' : 'pass') : 'none';
    const proposed = run.contract === 'expand' && ok ? (result.todos ?? []).filter((todo) => todo.title?.trim()) : [];
    const barren = run.contract === 'expand' && ok && proposed.length === 0;
    const passed = ok && verdict !== 'fail' && !barren;
    const error = barren ? 'The agent proposed no todos.' : ok ? null : result.error?.trim() || 'The run failed.';

    const actor: Actor = { kind: 'agent', userId: run.userId, runId: run.id };
    await stampActor(tx, actor);

    // What the agent said goes on the thread. A verdict is a different kind of
    // note from a report, so a reviewer's PASS never buries the account of the
    // work the next agent round the loop needs. An expansion's answer is the
    // todos it became, not something anyone would read back.
    const [note] =
      ok && output && run.contract !== 'expand'
        ? await tx
            .insert(dbSchema.todoNotes)
            .values({
              userId: run.userId,
              todoId: todo.id,
              kind: verdict === 'none' ? 'report' : 'verdict',
              body: output,
              actorKind: 'agent',
              runId: run.id,
            })
            .returning()
        : [];

    const stillHere = lane && todo.laneId === lane.id;
    const targetId = stillHere ? (passed ? lane.onSuccessLaneId : lane.onFailureLaneId) : null;

    if (passed && proposed.length > 0 && lane?.onSuccessLaneId) {
      // Pieces of work are open work, so a success arm into the done lane
      // puts them in the first open lane instead.
      const [landing] = await tx.select().from(dbSchema.lanes).where(eq(dbSchema.lanes.id, lane.onSuccessLaneId));
      const laneId = landing?.isDone ? await findFirstOpenLaneId(tx, todo.projectId) : lane.onSuccessLaneId;
      await writeChildren(tx, todo, laneId ?? lane.id, proposed);
      await tx.insert(dbSchema.todoNotes).values({
        userId: run.userId,
        todoId: todo.id,
        kind: 'report',
        body: `Split into ${proposed.length} todo${proposed.length === 1 ? '' : 's'}: ${proposed.map((todo) => todo.title.trim()).join('; ')}`,
        actorKind: 'agent',
        runId: run.id,
      });
    } else if (targetId && targetId !== todo.laneId) {
      await moveOn(tx, actor, todo, targetId, {
        noteId: note?.id ?? null,
        reason: passed ? null : verdict === 'fail' ? 'The review failed.' : error,
      });
    }

    // What it made exists whatever became of the run, so a failed run's files
    // are listed too.
    const artifacts = artifactRows(run, result.artifacts);
    if (artifacts.length > 0) await tx.insert(dbSchema.artifacts).values(artifacts);

    const [finished] = await tx
      .update(dbSchema.runs)
      .set({
        events: withEvents(run.events, result.events),
        status: passed || verdict === 'fail' ? 'ok' : 'error',
        verdict,
        output,
        error,
        finishedAt: new Date(),
        ...spend(result),
      })
      .where(eq(dbSchema.runs.id, run.id))
      .returning();
    return finished;
  });
}

/**
 * Moves a todo to the lane a station's arrow points at, keeping the lane rules:
 * into the done lane completes it, out of it reopens it. A todo that became
 * blocked while it was worked is not completed; it stays where it is, since
 * finished work waiting on something unfinished is not finished.
 *
 * @param tx The transaction.
 * @param actor The run's agent.
 * @param todo The todo.
 * @param laneId Where the arrow points.
 * @param provenance The note and reason for its history.
 * @returns Nothing.
 */
async function moveOn(
  tx: AnyRow,
  actor: Actor,
  todo: AnyRow,
  laneId: string,
  provenance: { noteId: string | null; reason: string | null },
): Promise<void> {
  const [target] = await tx
    .select()
    .from(dbSchema.lanes)
    .where(and(eq(dbSchema.lanes.id, laneId), eq(dbSchema.lanes.projectId, todo.projectId)));
  if (!target) return;
  if (target.isDone && (await findBlocked(tx, [todo.id])).size > 0) return;
  const completedAt = target.isDone ? (todo.completedAt ?? new Date()) : null;
  await stampActor(tx, actor, provenance);
  await tx
    .update(dbSchema.todos)
    .set({ laneId: target.id, completedAt, position: await nextPosition(tx, todo.projectId) })
    .where(eq(dbSchema.todos.id, todo.id));
}

export function applyRunsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, RUNS_SDL);
  const queries = (extendedSchema.getType('Query') as GraphQLObjectType).getFields();
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  queries.runnerQueue.resolve = async (_parent: unknown, args: { limit?: number | null }, context: Context) => {
    requireSystem(context);
    const limit = Math.max(1, Math.min(args.limit ?? 20, 200));
    return readyTodos(context.db, {}, limit);
  };

  mutations.claimRun.resolve = async (_parent: unknown, args: { todoId: string; laneId: string }, context: Context) => {
    requireSystem(context);
    try {
      return await (context.db as AnyRow).transaction(async (tx: AnyRow) => {
        // Claims at one station take turns, so two runners cannot both see
        // room under its WIP limit and both take it.
        const [lane] = await tx.select().from(dbSchema.lanes).where(eq(dbSchema.lanes.id, args.laneId)).for('update');
        if (!lane) return null;
        await expireLapsedRuns(tx, args);
        const [ready] = await readyTodos(tx, args, 1);
        if (!ready) return null;

        const [todo] = await tx.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, args.todoId));
        const [project] = await tx.select().from(dbSchema.projects).where(eq(dbSchema.projects.id, todo.projectId));
        const [agent] = await tx.select().from(dbSchema.agents).where(eq(dbSchema.agents.id, lane.agentId));
        const [run] = await tx
          .insert(dbSchema.runs)
          .values({
            userId: todo.userId,
            projectId: todo.projectId,
            todoId: todo.id,
            laneId: lane.id,
            agentId: agent.id,
            contract: lane.contract,
            leaseExpiresAt: leaseFromNow(),
          })
          .returning();

        return {
          runId: run.id,
          todoId: todo.id,
          token: mintRunToken(run.id),
          leaseExpiresAt: run.leaseExpiresAt,
          agent: { ...agent, mcpServers: JSON.stringify(agent.mcpServers ?? []) },
          brief: await briefFor(tx, todo, lane, project),
        };
      });
    } catch (error) {
      // The one-live-run-per-todo index: somebody else's claim won.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  };

  mutations.heartbeatRun.resolve = async (
    _parent: unknown,
    args: { id: string; events?: RunEventInput[] | null },
    context: Context,
  ) => {
    requireSystem(context);
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const { run, aiOff } = await loadRunForUpdate(tx, args.id);
      if (run.status !== 'running') return true;
      if (aiOff && !run.cancelRequestedAt) {
        await tx.update(dbSchema.runs).set({ cancelRequestedAt: new Date() }).where(eq(dbSchema.runs.id, run.id));
        return true;
      }
      const events = aiOff ? run.events : withEvents(run.events, args.events);
      if (run.cancelRequestedAt) {
        await tx.update(dbSchema.runs).set({ events }).where(eq(dbSchema.runs.id, run.id));
        return true;
      }
      await tx
        .update(dbSchema.runs)
        .set({ leaseExpiresAt: leaseFromNow(), events })
        .where(eq(dbSchema.runs.id, run.id));
      return false;
    });
  };

  mutations.finishRun.resolve = async (_parent: unknown, args: { id: string; result: RunResult }, context: Context) => {
    requireSystem(context);
    return finish(context, args.id, args.result);
  };

  mutations.cancelRun.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    const userId = requireAuth(context);
    const db = context.db as AnyRow;
    const [run] = await db
      .select()
      .from(dbSchema.runs)
      .where(and(eq(dbSchema.runs.id, args.id), eq(dbSchema.runs.userId, userId)));
    if (!run) throw notFound('Run');
    if (run.status !== 'running' || run.cancelRequestedAt) return run;
    const [cancelled] = await db
      .update(dbSchema.runs)
      .set({ cancelRequestedAt: new Date() })
      .where(eq(dbSchema.runs.id, run.id))
      .returning();
    return cancelled;
  };

  return extendedSchema;
}

/**
 * Whether a database error is a unique-constraint violation, across drivers.
 *
 * @param error What was thrown.
 * @returns Whether it was SQLSTATE 23505.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
