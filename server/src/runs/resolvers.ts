import * as dbSchema from '@telos/db/schema';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type {
  ArtifactInput,
  CheckResultInput,
  MutationResolvers,
  ProposedTodoInput,
  QueryResolvers,
  RefinedTodoInput,
  RunEventInput,
  RunPromptInput,
  RunResultInput,
  RunUsageInput,
} from '../../__generated__/resolvers.ts';
import { runnerAgent } from '../agents/mcp-servers.ts';
import { requireAuth } from '../auth/resolvers.ts';
import { findDoneLaneId, findNewTodoLaneId } from '../board/lanes.ts';
import type { Actor, Context } from '../core/context.ts';
import { LANE_CHECK_DEFAULTS } from '../core/defaults.ts';
import { RunEventKindEnum, RunOutcomeEnum, withEnums } from '../core/enums.ts';
import { conflict, forbidden, notFound } from '../core/errors.ts';
import { attachResolvers } from '../graphql/attach-resolvers.ts';
import { instanceAiOn } from '../instance/settings.ts';
import { assertNoCycle, findBlocked } from '../todos/blocking.ts';
import { stampActor } from '../todos/provenance.ts';
import { dropRunRequests, expireLapsedRuns, LEASE_SECONDS, readyTodos } from './ready.ts';
import { markRunnerSeen } from './runner-seen.ts';
import { openSession } from './todo-sessions.ts';
import { mintRunToken } from './tokens.ts';

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
  "A todo a lane's agent could start on now, and the lane."
  type ReadyTodo {
    todoId: ID!
    laneId: ID!
    projectId: ID!
  }

  "The agent a lane names, secret included. Only ever handed to the runner. Null inherits from \`defaults\`."
  type RunnerAgent {
    id: ID!
    name: String!
    baseUrl: String
    model: String
    apiKey: String
    systemPrompt: String
    temperature: Float
    maxTokens: Int
    contextLength: Int
    maxToolIterations: Int
    toolDiscovery: Boolean
    toolSelectModel: String
    reasoningEffort: String
    requestTimeoutSeconds: Int
    maxRetries: Int
    "The account's MCP servers the agent reaches, in slug order, as JSON, secrets included."
    mcpServers: String!
    "What to say on the run about its servers: one line for each the agent names that is gone."
    mcpNotices: [String!]!
    "The account's defaults the agent inherits, key included. Null where the account has set none."
    defaults: RunnerAgentDefaults
  }

  "An account's agent defaults, secret included. Only ever handed to the runner."
  type RunnerAgentDefaults {
    baseUrl: String
    model: String
    apiKey: String
    temperature: Float
    maxTokens: Int
    contextLength: Int
    maxToolIterations: Int
    toolDiscovery: Boolean
    toolSelectModel: String
    reasoningEffort: String
    requestTimeoutSeconds: Int
    maxRetries: Int
  }

  "A check lane's command, which the runner runs in place of an agent. Only ever handed to the runner."
  type RunnerCheck {
    "A line of shell. Its exit code is the verdict: 0 passes, anything else fails."
    command: String!
    "How long it may run before it is killed and fails. Null is the runner's default."
    timeoutSeconds: Int
  }

  "Everything an agent is told about the todo it is working, and where."
  type RunAssignment {
    projectName: String!
    projectDescription: String
    projectContext: String
    laneName: String!
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
    "How many runs the todo had before this one: zero for its first."
    turn: Int!
    "Whether no agent has worked the todo before: its hooks' session opens with this run."
    opensSession: Boolean!
    "The lane's agent. Null for a check lane, which has \`check\` instead."
    agent: RunnerAgent
    "The lane's check. Null for an agent's lane."
    check: RunnerCheck
    assignment: RunAssignment!
  }

  "A todo a run proposes."
  input ProposedTodoInput {
    title: String!
    brief: String
    acceptance: String
    "Titles of other todos in the same proposal that this one waits on."
    dependsOn: [String!]
  }

  "The todo rewritten by its run: what a field leaves out stays as it was."
  input RefinedTodoInput {
    title: String
    brief: String
    acceptance: String
  }

  "Something that happened in a run, for the live view."
  input RunEventInput {
    kind: RunEventKind!
    "The tool or hook it concerns."
    name: String
    ok: Boolean
    text: String
  }

  "What a run's agent was told, exactly."
  input RunPromptInput {
    system: String!
    user: String!
  }

  "What a run has spent so far, counted from its start."
  input RunUsageInput {
    toolCalls: Int
    promptTokens: Int!
    completionTokens: Int!
    totalTokens: Int!
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

  "What a check's command did. The server reads the verdict off it: exit 0 passes, anything else fails."
  input CheckResultInput {
    "Null when the command did not exit by itself: it was killed, or never started."
    exitCode: Int
    timedOut: Boolean!
    "The end of what it printed, stdout and stderr together."
    output: String!
  }

  "What a run came to."
  input RunResultInput {
    status: RunOutcome!
    output: String
    error: String
    toolCalls: Int
    promptTokens: Int
    completionTokens: Int
    totalTokens: Int
    "The todos the agent split this one into, if any: two or more. This one is done when they all are. One is read as a refine."
    todos: [ProposedTodoInput!]
    "The todo as the agent rewrote it, if it did. It then passes, as a report would. Never with todos."
    refine: RefinedTodoInput
    "What happened since the last heartbeat."
    events: [RunEventInput!]
    "What the agent was told, when no heartbeat reported it."
    prompt: RunPromptInput
    "What the run left behind."
    artifacts: [ArtifactInput!]
    "What a check lane's command did. Only a check run reports it, and it is the verdict."
    check: CheckResultInput
  }

  extend type Query {
    "What lanes' agents could start on now. The runner's only."
    runnerQueue(limit: Int = 20): [ReadyTodo!]!
  }

  extend type Mutation {
    "Starts a run of a ready todo by its lane's agent. Null when it is no longer ready. The runner's only."
    claimRun(todoId: ID!, laneId: ID!): RunClaim
    "Keeps a run's lease. True means stop: somebody asked, or AI was switched off. The runner's only."
    heartbeatRun(id: ID!, events: [RunEventInput!], prompt: RunPromptInput, usage: RunUsageInput): Boolean!
    "Records what a run came to and moves its todo on. The runner's only."
    finishRun(id: ID!, result: RunResultInput!): Run!
    "Asks a running run to stop, and tells AI to ignore its todo so no run starts on it again until that is switched off. The agent hears it on its next heartbeat."
    cancelRun(id: ID!): Run!
    "Deletes a finished run and its log. What it did to the todo, its notes and history, stays."
    deleteRun(id: ID!): Boolean!
    "Takes an artifact off the board: the link, not what it points at, which stays wherever it was stored. A person's only."
    deleteArtifact(id: ID!): Boolean!
  }
`);

/** The most events a run keeps: the newest, since a live view reads the end. */
export const MAX_RUN_EVENTS = 500;
/** The most of one event's text kept: enough to read, not a transcript. */
const EVENT_TEXT_CHARS = 4000;
/**
 * The most of one streamed block kept — a turn's thinking, or its reply — which
 * grows across heartbeats. The end is kept, since that is where a live view is.
 */
const STREAM_TEXT_CHARS = 16_000;
/** The kinds that arrive a piece at a time and are joined into one block. */
const STREAMED = new Set(['thinking', 'output']);
/** The most of a prompt kept. */
const PROMPT_CHARS = 64_000;
/** The most artifacts one run may report. */
const MAX_ARTIFACTS = 100;

/** A reply that opens with FAIL is a failing verdict: the todo takes the failure route. */
const FAILS = /^\s*FAIL\b/i;
/** A reply that opens with PASS is a passing verdict. Any other reply is a report, and passes too. */
const PASSES = /^\s*PASS\b/i;

/**
 * What a reply rules, read off its first word.
 *
 * @param output - What the agent replied.
 * @returns `fail` or `pass` for a verdict, `none` for a report.
 */
function verdictOf(output: string | null): 'pass' | 'fail' | 'none' {
  if (output === null) {
    return 'none';
  }
  if (FAILS.test(output)) {
    return 'fail';
  }
  return PASSES.test(output) ? 'pass' : 'none';
}

/**
 * What a check run rules, and the verdict note that says why: the first word
 * is PASS or FAIL, as a reviewer's is, then the command and the end of what it
 * printed, which is what the next run is shown when the todo comes back.
 *
 * @param command - What the lane ran.
 * @param check - What the runner says it did; absent, it did not say, which fails.
 * @returns The verdict and the note's body.
 */
export function checkVerdict(
  command: string,
  check: CheckResultInput | null | undefined,
): { verdict: 'pass' | 'fail'; body: string } {
  const passed = check?.exitCode === 0 && !check.timedOut;
  const what = !check
    ? 'reported no result'
    : check.timedOut
      ? 'ran out of time and was stopped'
      : check.exitCode === null || check.exitCode === undefined
        ? 'did not exit by itself'
        : `exited with code ${check.exitCode}`;
  const output = keepEnd(check?.output?.trimEnd() ?? '', LANE_CHECK_DEFAULTS.outputChars);
  const block = fenceFor(output, 3);
  const shown = output ? `\n\n${block}text\n${output}\n${block}` : '\n\nIt printed nothing.';
  const inline = fenceFor(command, 1);
  const pad = inline.length > 1 ? ' ' : '';
  return {
    verdict: passed ? 'pass' : 'fail',
    body: `${passed ? 'PASS' : 'FAIL'}: the check ${inline}${pad}${command}${pad}${inline} ${what}.${shown}`,
  };
}

/**
 * A Markdown fence for `text`: longer than any run of backticks in it, so what
 * a command printed cannot close its own block.
 *
 * @param text - What the fence holds.
 * @param least - The shortest fence.
 * @returns The backticks.
 */
function fenceFor(text: string, least: number): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  return '`'.repeat(Math.max(least, longest + 1));
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
  const aiOff = !(await instanceAiOn(tx)) || !user?.aiEnabled || !project?.aiEnabled || todo?.aiIgnored !== false;
  return { run, todo, project, lane: lane ?? null, aiOff };
}

/**
 * What the agent is told: the project, the lane, the todo, and what has been
 * said about it. What to do with it is in the agent's own instructions.
 *
 * @param tx The transaction.
 * @param todo The todo being worked.
 * @param lane The lane it is in.
 * @param project The todo's project.
 * @returns The assignment.
 */
async function assignmentFor(tx: AnyRow, todo: AnyRow, lane: AnyRow, project: AnyRow) {
  const thread: AnyRow[] = await tx
    .select()
    .from(dbSchema.todoNotes)
    .where(eq(dbSchema.todoNotes.todoId, todo.id))
    .orderBy(asc(dbSchema.todoNotes.createdAt));
  const report = thread.filter((note) => note.kind === 'report').at(-1)?.body ?? null;

  // Why it is back: the note (or else the reason) on the move that brought it
  // here, when that move was not its first arrival. The note comes first: a
  // FAIL's move carries the fixed reason "The review failed." beside the
  // verdict itself, and the verdict is what the next agent has to act on. An
  // edit is not an arrival (`arrivedIn` in ready.ts).
  const [arrival] = await tx
    .select({ reason: dbSchema.todoEvents.reason, noteId: dbSchema.todoEvents.noteId })
    .from(dbSchema.todoEvents)
    .where(
      and(
        eq(dbSchema.todoEvents.todoId, todo.id),
        eq(dbSchema.todoEvents.toLaneId, lane.id),
        ne(dbSchema.todoEvents.kind, 'edit'),
      ),
    )
    .orderBy(desc(dbSchema.todoEvents.at))
    .limit(1);
  const arrivalNote = arrival?.noteId ? thread.find((note) => note.id === arrival.noteId) : undefined;
  const why = arrivalNote?.body ?? arrival?.reason ?? null;

  return {
    projectName: project.name,
    projectDescription: project.description,
    projectContext: project.context,
    laneName: lane.name,
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
 * project-wide (see board/lanes-resolvers.ts), so this is the end of every lane.
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
 * Writes a run's proposed todos into `laneId`, links what they wait on by
 * title, and makes the parent an umbrella: it is no longer run, and the
 * `todos_settle_umbrella` trigger closes it when its last piece is done. A
 * dependency naming nothing in the batch, or one that would close a cycle, is
 * dropped — a lost ordering hint, not a lost todo.
 *
 * @param tx The transaction, already stamped with the agent.
 * @param parent The todo that was broken up.
 * @param laneId Where the pieces land.
 * @param proposed What the agent proposed.
 * @returns The new todos.
 */
async function writeChildren(
  tx: AnyRow,
  parent: AnyRow,
  laneId: string | null,
  proposed: ProposedTodoInput[],
): Promise<AnyRow[]> {
  await tx.update(dbSchema.todos).set({ splitAt: new Date() }).where(eq(dbSchema.todos.id, parent.id));
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
  const edges = proposed.flatMap((todo, at) =>
    (todo.dependsOn ?? [])
      .map((title) => byTitle.get(title.trim()))
      .filter((id): id is string => !!id && id !== written[at].id)
      .map((id): [string, string] => [written[at].id, id]),
  );
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

/** Why a run that both refined and split its todo fails: the two say different things about it. */
const REFINED_AND_SPLIT = 'The reply both rewrote the todo and split it. A todo is either refined or split.';

/**
 * The columns a refine rewrites: each field it gave, trimmed. What it leaves
 * out or leaves empty stays as it was.
 *
 * @param refine - What the agent rewrote, or a lone proposed todo read as one.
 * @returns The columns to set; null when it changes nothing.
 */
function refinementOf(
  refine: RefinedTodoInput | null | undefined,
): { title?: string; notes?: string; acceptance?: string } | null {
  const title = refine?.title?.trim();
  const notes = refine?.brief?.trim();
  const acceptance = refine?.acceptance?.trim();
  const set = {
    ...(title ? { title } : {}),
    ...(notes ? { notes } : {}),
    ...(acceptance ? { acceptance } : {}),
  };
  return Object.keys(set).length > 0 ? set : null;
}

/**
 * Where a split's pieces land: where the project's new todos do, unless that is
 * the lane that split them. New todos land there to be planned, and these
 * already were, so they go on down its success route instead, when it has one
 * that is not the done lane. Otherwise a planning lane would plan its own
 * pieces again.
 *
 * @param tx - The transaction.
 * @param todo - The todo that was split.
 * @param lane - The lane whose run split it, if it still exists.
 * @returns The lane, or null when the project has no open lane.
 */
async function piecesLaneId(tx: AnyRow, todo: AnyRow, lane: AnyRow | null): Promise<string | null> {
  const intake = await findNewTodoLaneId(tx, todo.projectId);
  if (!lane || intake !== lane.id || !lane.onSuccessLaneId) {
    return intake;
  }
  const [next] = await tx
    .select({ id: dbSchema.lanes.id, isDone: dbSchema.lanes.isDone })
    .from(dbSchema.lanes)
    .where(eq(dbSchema.lanes.id, lane.onSuccessLaneId));
  return next && !next.isDone ? next.id : intake;
}

/**
 * A run's events with `incoming` added, stamped now, cut to size.
 *
 * @param existing What the run already has.
 * @param incoming What the runner just reported.
 * @returns The events to store.
 */
export function withEvents(existing: dbSchema.RunEvent[] | null, incoming: RunEventInput[] | null | undefined) {
  const at = new Date().toISOString();
  const events = [...(existing ?? [])];
  for (const event of incoming ?? []) {
    const kind = event.kind.slice(0, 40);
    const last = events.at(-1);
    // A block the model is still streaming carries on where the last
    // heartbeat left it, rather than starting a new entry every few seconds.
    if (STREAMED.has(kind) && last?.kind === kind) {
      events[events.length - 1] = {
        ...last,
        text: keepEnd(`${last.text ?? ''}${event.text ?? ''}`, STREAM_TEXT_CHARS),
      };
      continue;
    }
    events.push({
      at,
      kind,
      name: event.name?.slice(0, 200) ?? null,
      ok: event.ok ?? null,
      text: STREAMED.has(kind)
        ? keepEnd(event.text ?? '', STREAM_TEXT_CHARS)
        : (event.text?.slice(0, EVENT_TEXT_CHARS) ?? null),
    });
  }
  return events.slice(-MAX_RUN_EVENTS);
}

/**
 * The end of `text`, marked as cut when it was.
 *
 * @param text The whole.
 * @param limit The most kept.
 * @returns What fits.
 */
function keepEnd(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(-(limit - 1))}`;
}

/**
 * The columns a heartbeat's prompt and usage set. The prompt is written once:
 * it is what the run was told at its start, and no later report changes that.
 *
 * @param run The run as stored.
 * @param prompt What the runner says the agent was told.
 * @param usage What the runner says the run has spent.
 * @returns Columns to set.
 */
export function reported(
  run: AnyRow,
  prompt: RunPromptInput | null | undefined,
  usage: RunUsageInput | null | undefined,
) {
  return {
    ...(prompt && run.systemPrompt == null && run.userPrompt == null
      ? { systemPrompt: prompt.system.slice(0, PROMPT_CHARS), userPrompt: prompt.user.slice(0, PROMPT_CHARS) }
      : {}),
    ...(usage
      ? {
          promptTokens: Math.max(0, usage.promptTokens),
          completionTokens: Math.max(0, usage.completionTokens),
          totalTokens: Math.max(0, usage.totalTokens),
          ...(usage.toolCalls == null ? {} : { toolCalls: Math.max(0, usage.toolCalls) }),
        }
      : {}),
  };
}

/**
 * The artifacts a result reports, as rows. Anything without a location, or
 * with a source or action a run cannot report, is dropped rather than failing
 * the finish: a run's work is not undone by a malformed receipt. `client` is
 * not a run's to claim (runs/artifacts.ts).
 *
 * @param run The run.
 * @param reported What the runner reported.
 * @returns Rows to insert.
 */
function artifactRows(run: AnyRow, reported: ArtifactInput[] | null | undefined) {
  const sources: readonly string[] = dbSchema.RUN_ARTIFACT_SOURCES;
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

/**
 * The counters a result reports, as columns. One it leaves out keeps what the
 * heartbeats reported, so a run stopped mid-turn still says what it spent.
 */
function spend(run: AnyRow, result: RunResultInput) {
  return {
    toolCalls: result.toolCalls ?? run.toolCalls ?? 0,
    promptTokens: result.promptTokens ?? run.promptTokens ?? 0,
    completionTokens: result.completionTokens ?? run.completionTokens ?? 0,
    totalTokens: result.totalTokens ?? run.totalTokens ?? 0,
  };
}

/**
 * Records what a run came to and carries out what its lane says follows.
 *
 * A run that was asked to stop, or whose user, project or todo was closed to
 * AI while it worked, is recorded as stopped and nothing else happens: no
 * note, no move, no new todos. For a user who switched AI off, that is the
 * promise — nothing of theirs changes after the switch.
 *
 * Otherwise every run is read the same way. A failed run, or a reply that
 * opens with FAIL, sends the todo down the failure route; anything else
 * passes, down the success route, or into the archive when that is what the
 * lane does with a pass. A pass that refined the todo rewrites it first. A pass
 * that split it leaves it where it is, waiting on its pieces. A todo a person moved while the agent worked stays
 * where the person put it: the run's opinion is recorded, but the person's
 * move wins.
 *
 * @param context The runner's context.
 * @param runId The run.
 * @param result What the runner reports.
 * @returns The finished run.
 */
async function finish(context: Context, runId: string, result: RunResultInput): Promise<AnyRow> {
  return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
    const { run, todo, lane, aiOff } = await loadRunForUpdate(tx, runId);
    if (run.status !== 'running') {
      throw conflict('That run has already finished.');
    }
    let output = result.output?.trim() || null;

    if (result.status === 'stopped' || run.cancelRequestedAt || aiOff || !todo) {
      // A run stopped by a switch keeps nothing it said after the switch.
      const events = aiOff ? run.events : withEvents(run.events, result.events);
      const [stopped] = await tx
        .update(dbSchema.runs)
        .set({
          status: 'stopped',
          output,
          events,
          finishedAt: new Date(),
          ...spend(run, result),
          ...(aiOff ? {} : reported(run, result.prompt, null)),
        })
        .where(eq(dbSchema.runs.id, run.id))
        .returning();
      return stopped;
    }

    // A reply is one outcome: a verdict, a report, a refine (the todo
    // rewritten, then passed) or a split (two or more pieces). A lone proposed
    // todo is the todo said again, so it is read as a refine; a reply that
    // both refines and splits fails, as there is no telling which it meant.
    const ok = result.status === 'ok';
    // A check run is ruled by its command's exit code, never by what was
    // said, and it neither refines nor splits: it has no agent to do either.
    const checked = run.checkCommand != null && ok ? checkVerdict(run.checkCommand, result.check) : null;
    if (checked) output = checked.body;
    const verdict = checked ? checked.verdict : ok ? verdictOf(output) : 'none';
    const proposed = checked ? [] : (result.todos ?? []).filter((todo) => todo.title?.trim());
    const refined = checked ? null : refinementOf(result.refine);
    const mixed = ok && verdict !== 'fail' && refined !== null && proposed.length > 0;
    const passed = ok && verdict !== 'fail' && !mixed;
    const pieces = passed && proposed.length > 1 ? proposed : [];
    const rewrite = passed ? (refined ?? (proposed.length === 1 ? refinementOf(proposed[0]) : null)) : null;
    const error = mixed ? REFINED_AND_SPLIT : ok ? null : result.error?.trim() || 'The run failed.';

    const actor: Actor = { kind: 'agent', userId: run.userId, runId: run.id };
    await stampActor(tx, actor);

    // What the agent said goes on the thread. A verdict is a different kind of
    // note from a report, so a reviewer's PASS never buries the account of the
    // work the next agent round the loop needs.
    const [note] =
      ok && output
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

    // An edit, not an arrival (`arrivedIn` in ready.ts): rewriting the todo
    // does not hand it back to this lane's agent.
    if (rewrite) {
      await tx.update(dbSchema.todos).set(rewrite).where(eq(dbSchema.todos.id, todo.id));
    }

    if (pieces.length > 0) {
      await writeChildren(tx, todo, await piecesLaneId(tx, todo, lane), pieces);
      await tx.insert(dbSchema.todoNotes).values({
        userId: run.userId,
        todoId: todo.id,
        kind: 'report',
        body: `Split into ${pieces.length} todos: ${pieces.map((todo) => todo.title.trim()).join('; ')}`,
        actorKind: 'agent',
        runId: run.id,
      });
    } else if (passed && stillHere && lane.archiveOnSuccess) {
      await archiveOn(tx, actor, todo, { noteId: note?.id ?? null, reason: null });
    } else if (targetId && targetId !== todo.laneId) {
      await moveOn(tx, actor, todo, targetId, {
        noteId: note?.id ?? null,
        // A failed check's note is the reason: the next run is shown the
        // command and what it printed, not a line saying a review failed.
        reason: passed ? null : checked ? null : verdict === 'fail' ? 'The review failed.' : error,
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
        ...spend(run, result),
        ...reported(run, result.prompt, null),
      })
      .where(eq(dbSchema.runs.id, run.id))
      .returning();
    return finished;
  });
}

/**
 * Moves a todo to the lane a route points at, keeping the lane rules:
 * into the done lane completes it, out of it reopens it. A todo that became
 * blocked while it was worked is not completed; it stays where it is, since
 * finished work waiting on something unfinished is not finished.
 *
 * @param tx The transaction.
 * @param actor The run's agent.
 * @param todo The todo.
 * @param laneId Where the route points.
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

/**
 * Completes a todo and archives it, which is what a pass does at a lane set to
 * archive. It lands in the done lane when the board has one, so lane and
 * completion agree and a restore puts it back among the finished. Like a move
 * into the done lane, a todo that became blocked while it was worked is left
 * where it is: finished work waiting on something unfinished is not finished.
 *
 * @param tx The transaction.
 * @param actor The run's agent.
 * @param todo The todo.
 * @param provenance The note and reason for its history.
 * @returns Nothing.
 */
async function archiveOn(
  tx: AnyRow,
  actor: Actor,
  todo: AnyRow,
  provenance: { noteId: string | null; reason: string | null },
): Promise<void> {
  if ((await findBlocked(tx, [todo.id])).size > 0) return;
  const doneLaneId = await findDoneLaneId(tx, todo.projectId);
  const now = new Date();
  await stampActor(tx, actor, provenance);
  await tx
    .update(dbSchema.todos)
    .set({
      ...(doneLaneId ? { laneId: doneLaneId, position: await nextPosition(tx, todo.projectId) } : {}),
      completedAt: todo.completedAt ?? now,
      archivedAt: now,
    })
    .where(eq(dbSchema.todos.id, todo.id));
}

export function applyRunsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(withEnums(schema, [RunOutcomeEnum, RunEventKindEnum]), RUNS_SDL);
  const queries: QueryResolvers = {};
  const mutations: MutationResolvers = {};

  queries.runnerQueue = async (_parent, args, context) => {
    markRunnerSeen();
    const limit = Math.max(1, Math.min(args.limit ?? 20, 200));
    return readyTodos(context.db, {}, limit);
  };

  mutations.claimRun = async (_parent, args, context) => {
    try {
      return await (context.db as AnyRow).transaction(async (tx: AnyRow) => {
        // Claims in one lane take turns, so two runners cannot both see
        // room under its WIP limit and both take it.
        const [lane] = await tx.select().from(dbSchema.lanes).where(eq(dbSchema.lanes.id, args.laneId)).for('update');
        if (!lane) return null;
        await expireLapsedRuns(tx, args);
        const [ready] = await readyTodos(tx, args, 1);
        if (!ready) return null;

        const [todo] = await tx.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, args.todoId));
        const [project] = await tx.select().from(dbSchema.projects).where(eq(dbSchema.projects.id, todo.projectId));
        // Counted before this run is written. The todo is the session its
        // agents' hooks file things under.
        const turn = await tx.$count(dbSchema.runs, eq(dbSchema.runs.todoId, todo.id));
        // A check lane's run has no agent: the runner runs its command, and
        // the run keeps the command as it was, whatever the lane says later.
        const check: string | null = lane.checkCommand;
        const [agent] = check
          ? []
          : await tx.select().from(dbSchema.agents).where(eq(dbSchema.agents.id, lane.agentId));
        const handed = agent ? await runnerAgent(tx, agent) : null;
        // Asked of the sessions and not of `turn`: retention prunes runs, and a
        // todo whose runs are gone has still had its session opened.
        const opensSession = agent ? await openSession(tx, todo, agent.id) : false;
        const [run] = await tx
          .insert(dbSchema.runs)
          .values({
            userId: todo.userId,
            projectId: todo.projectId,
            todoId: todo.id,
            laneId: lane.id,
            agentId: agent?.id ?? null,
            model: handed?.resolvedModel ?? null,
            checkCommand: check,
            leaseExpiresAt: leaseFromNow(),
          })
          .returning();
        // A person's request is for one run, and this is it.
        await dropRunRequests(tx, { todoId: todo.id });

        return {
          runId: run.id,
          todoId: todo.id,
          token: mintRunToken(run.id),
          leaseExpiresAt: run.leaseExpiresAt,
          turn,
          opensSession,
          agent: handed,
          check: check ? { command: check, timeoutSeconds: lane.checkTimeoutSeconds } : null,
          assignment: await assignmentFor(tx, todo, lane, project),
        };
      });
    } catch (error) {
      // The one-live-run-per-todo index: somebody else's claim won.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  };

  mutations.heartbeatRun = async (_parent, args, context) => {
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const { run, aiOff } = await loadRunForUpdate(tx, args.id);
      if (run.status !== 'running') return true;
      if (aiOff && !run.cancelRequestedAt) {
        await tx.update(dbSchema.runs).set({ cancelRequestedAt: new Date() }).where(eq(dbSchema.runs.id, run.id));
        return true;
      }
      if (aiOff) return true;
      const events = withEvents(run.events, args.events);
      const also = reported(run, args.prompt, args.usage);
      if (run.cancelRequestedAt) {
        await tx
          .update(dbSchema.runs)
          .set({ events, ...also })
          .where(eq(dbSchema.runs.id, run.id));
        return true;
      }
      await tx
        .update(dbSchema.runs)
        .set({ leaseExpiresAt: leaseFromNow(), events, ...also })
        .where(eq(dbSchema.runs.id, run.id));
      return false;
    });
  };

  mutations.finishRun = async (_parent, args, context) => {
    return finish(context, args.id, args.result);
  };

  mutations.cancelRun = async (_parent, args, context) => {
    const userId = requireAuth(context);
    const db = context.db as AnyRow;
    const [run] = await db
      .select()
      .from(dbSchema.runs)
      .where(and(eq(dbSchema.runs.id, args.id), eq(dbSchema.runs.userId, userId)));
    if (!run) throw notFound('Run');
    if (run.status !== 'running' || run.cancelRequestedAt) return run;
    return db.transaction(async (tx: AnyRow) => {
      const [cancelled] = await tx
        .update(dbSchema.runs)
        .set({ cancelRequestedAt: new Date() })
        .where(eq(dbSchema.runs.id, run.id))
        .returning();
      // Stopping a run means "not now", and the queue would otherwise hand the
      // todo straight back to the same agent. So AI is told to leave it alone,
      // as the MCP door's cancelRequest does; switching that off again is the
      // way back in, and the history says why it went on.
      await stampActor(tx, context.actor, { reason: 'Its run was stopped.' });
      await tx
        .update(dbSchema.todos)
        .set({ aiIgnored: true, updatedAt: new Date() })
        .where(
          and(
            eq(dbSchema.todos.id, run.todoId),
            eq(dbSchema.todos.userId, userId),
            eq(dbSchema.todos.aiIgnored, false),
          ),
        );
      return cancelled;
    });
  };

  mutations.deleteRun = async (_parent, args, context) => {
    const userId = requireAuth(context);
    const db = context.db as AnyRow;
    const [run] = await db
      .select({ id: dbSchema.runs.id, status: dbSchema.runs.status })
      .from(dbSchema.runs)
      .where(and(eq(dbSchema.runs.id, args.id), eq(dbSchema.runs.userId, userId)));
    if (!run) throw notFound('Run');
    // A live run is the runner's until it ends; cancel it first.
    if (run.status === 'running') {
      throw conflict('Stop the run before deleting it.');
    }
    await db.delete(dbSchema.runs).where(eq(dbSchema.runs.id, run.id));
    return true;
  };

  // A person's, like watching a board: what was made is theirs to tidy, and
  // an agent that could remove it could hide what it did. An artifact whose
  // todo is gone is removed the same way.
  mutations.deleteArtifact = async (_parent, args, context) => {
    const userId = requireAuth(context);
    if (context.actor.kind !== 'user') {
      throw forbidden('Only a person can remove an artifact.');
    }
    const removed = await (context.db as AnyRow)
      .delete(dbSchema.artifacts)
      .where(and(eq(dbSchema.artifacts.id, args.id), eq(dbSchema.artifacts.userId, userId)))
      .returning({ id: dbSchema.artifacts.id });
    if (removed.length === 0) throw notFound('Artifact');
    return true;
  };

  return attachResolvers(extendedSchema, { Query: queries, Mutation: mutations });
}

/**
 * Whether a database error is a unique-constraint violation, across drivers.
 *
 * @param error What was thrown.
 * @returns Whether it was SQLSTATE 23505.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
