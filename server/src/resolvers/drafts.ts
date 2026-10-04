import * as dbSchema from '@telos/db/schema';
import { and, asc, desc, eq, isNotNull, isNull, not, sql } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi, requireSystem } from '../ai-gate.ts';
import type { Context } from '../context.ts';
import { DRAFT_LEASE_SECONDS, draftBeingAnswered, expireLapsedDraftRuns, stopDraftReply } from '../draft-runs.ts';
import { instanceAiOn } from '../instance.ts';
import { findNewTodoLaneId } from '../lanes.ts';
import { runnerAgent } from '../mcp-servers.ts';
import { stampActor } from '../provenance.ts';
import { markRunnerSeen } from '../runner-seen.ts';
import { loadAiProject, nextPosition } from './requests.ts';
import { isUniqueViolation, type RunEventInput, type RunPrompt, type RunUsage, reported, withEvents } from './runs.ts';

// Drafts: talking a rough request over with an agent until its brief reads
// right, then making a todo of it. The person's side is here — start one, say
// something, stop the answer, make the todo — and so is the runner's: the
// server never calls a model, so the runner asks which drafts are waiting,
// claims one, has its agent answer, and reports the answer back.
//
// A draft waits (`waitingSince`) from the moment the person says something to
// the moment an answer lands. While it waits the person cannot say more: the
// agent answers the conversation as it stood, and a message arriving half way
// through would be answered by nobody. Stopping gives the turn back.
//
// Each answer is a run (kind `draft`, see draft-runs.ts): claiming a draft
// starts one, which holds the lease, and finishing it records what the agent
// was told, what it said or why it failed, and what it cost. So a draft's
// replies are read, counted and pruned as a station's work is.
//
// Every person-side field needs AI on for the account and the project, and the
// runner only sees drafts where both still are. Applied only when the instance
// has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const DRAFTS_SDL = parse(`
  "One turn of a draft's conversation, for the runner."
  type DraftTurn {
    "user or assistant."
    role: String!
    content: String!
  }

  "A draft the runner has taken to answer: who answers, and everything said so far."
  type DraftClaim {
    draftId: ID!
    "The run this answer is recorded as. Hand it back to finishDraft."
    runId: ID!
    agent: RunnerAgent!
    projectName: String!
    projectDescription: String
    projectContext: String
    title: String!
    brief: String!
    messages: [DraftTurn!]!
  }

  extend type Query {
    "Drafts waiting on an answer, oldest first. The runner's."
    runnerDrafts(limit: Int): [ID!]!
  }

  extend type Mutation {
    "Starts talking a request over with one of your agents, in a project with AI on."
    startDraft(projectId: ID!, agentId: ID!, message: String!): Draft!
    "Says something more in a draft. Refused while the agent is still answering."
    sayToDraft(id: ID!, message: String!): Draft!
    "Stops waiting for the agent's answer. An answer that arrives later is dropped."
    stopDraft(id: ID!): Draft!
    """
    Makes a todo of the draft, in its project's first open lane. \`title\` and
    \`brief\`, when given, are used in place of the agent's.
    """
    makeTodoFromDraft(id: ID!, title: String, brief: String): Todo!
    "Deletes a draft and its conversation. The todo it became, if any, stays."
    discardDraft(id: ID!): Boolean!
    "Takes a waiting draft to answer. Null when it is no longer waiting, or someone else took it."
    claimDraft(id: ID!): DraftClaim
    """
    Reports the agent's answer: its reply, and the title and brief as they now
    stand (blank leaves them as they were). \`error\` instead, when it could not
    answer. \`runId\` is the run claimDraft started; without it the draft's
    running run is finished. What the agent was told, what it spent and what
    happened are recorded on that run. False when nobody is waiting for the
    answer any more; what it spent is recorded all the same.
    """
    finishDraft(
      id: ID!
      runId: ID
      reply: String
      title: String
      brief: String
      error: String
      prompt: RunPromptInput
      usage: RunUsageInput
      events: [RunEventInput!]
    ): Boolean!
  }
`);

const MAX_MESSAGE = 20_000;
const MAX_TITLE = 200;
/** The most of a failed reply's error kept, on the draft and on its run. */
const MAX_ERROR = 2000;
const MS_PER_SECOND = 1000;

const badInput = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
const notFound = (what: string) => new GraphQLError(`${what} not found`, { extensions: { code: 'NOT_FOUND' } });
const conflict = (message: string) => new GraphQLError(message, { extensions: { code: 'CONFLICT' } });

function message(value: string): string {
  const text = value.trim();
  if (!text) throw badInput('Say something first.');
  if (text.length > MAX_MESSAGE) throw badInput(`Keep it under ${MAX_MESSAGE} characters.`);
  return text;
}

/** Why a draft cannot wait on an agent that is switched off. */
const AGENT_OFF = (name: string) => `${name} is switched off. Switch it on in Settings, or talk to another agent.`;

/** The caller's agent, or NOT_FOUND; CONFLICT where it is switched off, since nothing would answer. */
async function ownedAgent(db: AnyRow, userId: string, agentId: string) {
  const [agent] = await db
    .select({ id: dbSchema.agents.id, name: dbSchema.agents.name, enabled: dbSchema.agents.enabled })
    .from(dbSchema.agents)
    .where(and(eq(dbSchema.agents.id, agentId), eq(dbSchema.agents.userId, userId)));
  if (!agent) throw notFound('Agent');
  if (!agent.enabled) throw conflict(AGENT_OFF(agent.name));
  return agent;
}

/**
 * The caller's draft, in a project that still has AI on, or NOT_FOUND.
 *
 * @param context The request.
 * @param userId The caller.
 * @param id The draft.
 * @param db The database or transaction.
 * @param lock Whether to lock the row, inside a transaction.
 * @returns The draft.
 */
async function ownedDraft(context: Context, userId: string, id: string, db: AnyRow = context.db, lock = false) {
  const query = db
    .select({ draft: dbSchema.drafts })
    .from(dbSchema.drafts)
    .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.drafts.projectId))
    .where(and(eq(dbSchema.drafts.id, id), eq(dbSchema.drafts.userId, userId), eq(dbSchema.projects.aiEnabled, true)));
  const [row] = await (lock ? query.for('update', { of: dbSchema.drafts }) : query);
  if (!row) throw notFound('Draft');
  return row.draft as dbSchema.Draft;
}

function unmade(draft: dbSchema.Draft): void {
  if (draft.todoId) throw conflict('This draft is already a todo. Start a new one.');
}

/** Whether a draft is waiting and no run is answering it, as SQL. */
const takeable = () =>
  and(
    isNotNull(dbSchema.drafts.waitingSince),
    isNull(dbSchema.drafts.todoId),
    isNotNull(dbSchema.drafts.agentId),
    // A switched-off agent answers nothing; its drafts wait until it is back.
    sql`EXISTS (SELECT 1 FROM agents a WHERE a.id = ${dbSchema.drafts.agentId} AND a.enabled)`,
    not(draftBeingAnswered()),
  );

/** Drafts whose account and project both have AI on, as SQL joins. */
function withAiOn(query: AnyRow) {
  return query
    .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.drafts.projectId))
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.drafts.userId));
}
const aiOn = () => and(eq(dbSchema.projects.aiEnabled, true), eq(dbSchema.users.aiEnabled, true));

interface FinishDraftArgs {
  id: string;
  runId?: string | null;
  reply?: string | null;
  title?: string | null;
  brief?: string | null;
  error?: string | null;
  prompt?: RunPrompt | null;
  usage?: RunUsage | null;
  events?: RunEventInput[] | null;
}

/**
 * The run an answer is reported against: the one the runner names, when it is
 * this draft's, or the draft's running run. Locked, so two reports of one
 * answer cannot both land.
 *
 * @param tx - The transaction.
 * @param draftId - The draft.
 * @param runId - The run the runner named, if it named one.
 * @returns The run, or nothing when the draft has no such run.
 */
async function replyRun(tx: AnyRow, draftId: string, runId: string | null | undefined) {
  const mine = eq(dbSchema.runs.draftId, draftId);
  const [run] = await tx
    .select()
    .from(dbSchema.runs)
    .where(runId ? and(mine, eq(dbSchema.runs.id, runId)) : and(mine, eq(dbSchema.runs.status, 'running')))
    .orderBy(desc(dbSchema.runs.startedAt))
    .limit(1)
    .for('update');
  return run as dbSchema.Run | undefined;
}

/**
 * Whether AI is still on everywhere a draft needs it: the instance, its
 * owner's account and its project.
 *
 * @param tx - The transaction.
 * @param draft - The draft.
 * @returns Whether an answer may still land.
 */
async function draftAiOn(tx: AnyRow, draft: dbSchema.Draft): Promise<boolean> {
  if ((await instanceAiOn(tx)) === false) {
    return false;
  }
  const [row] = await withAiOn(tx.select({ id: dbSchema.drafts.id }).from(dbSchema.drafts)).where(
    and(eq(dbSchema.drafts.id, draft.id), aiOn()),
  );
  return row !== undefined;
}

export function applyDraftsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, DRAFTS_SDL);
  const queries = (extendedSchema.getType('Query') as GraphQLObjectType).getFields();
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  mutations.startDraft.resolve = async (
    _parent: unknown,
    args: { projectId: string; agentId: string; message: string },
    context: Context,
  ) => {
    const userId = await requireAi(context);
    const text = message(args.message);
    const project = await loadAiProject(context, userId, args.projectId);
    await ownedAgent(context.db, userId, args.agentId);
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const [draft] = await tx
        .insert(dbSchema.drafts)
        .values({ userId, projectId: project.id, agentId: args.agentId, waitingSince: new Date() })
        .returning();
      await tx.insert(dbSchema.draftMessages).values({ userId, draftId: draft.id, role: 'user', content: text });
      return draft;
    });
  };

  mutations.sayToDraft.resolve = async (_parent: unknown, args: { id: string; message: string }, context: Context) => {
    const userId = await requireAi(context);
    const text = message(args.message);
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const draft = await ownedDraft(context, userId, args.id, tx, true);
      unmade(draft);
      if (draft.waitingSince) throw conflict('Wait for the answer, or stop it, before saying more.');
      if (!draft.agentId) throw conflict('The agent this draft was talking to is gone. Start a new one.');
      await ownedAgent(tx, userId, draft.agentId);
      await tx.insert(dbSchema.draftMessages).values({ userId, draftId: draft.id, role: 'user', content: text });
      const [updated] = await tx
        .update(dbSchema.drafts)
        .set({ waitingSince: new Date(), error: null })
        .where(eq(dbSchema.drafts.id, draft.id))
        .returning();
      return updated;
    });
  };

  mutations.stopDraft.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    const userId = await requireAi(context);
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const draft = await ownedDraft(context, userId, args.id, tx, true);
      return stopDraftReply(tx, draft.id);
    });
  };

  mutations.makeTodoFromDraft.resolve = async (
    _parent: unknown,
    args: { id: string; title?: string | null; brief?: string | null },
    context: Context,
  ) => {
    const userId = await requireAi(context);
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const draft = await ownedDraft(context, userId, args.id, tx, true);
      unmade(draft);
      const brief = (args.brief ?? draft.brief).trim();
      if (!brief) throw badInput('There is no brief yet to make a todo of.');
      const title = ((args.title ?? draft.title).trim() || brief.split('\n')[0]).slice(0, MAX_TITLE);

      await stampActor(tx, context.actor);
      const laneId = await findNewTodoLaneId(tx, draft.projectId);
      const [todo] = await tx
        .insert(dbSchema.todos)
        .values({
          userId,
          projectId: draft.projectId,
          title,
          notes: brief,
          laneId,
          position: await nextPosition(tx, draft.projectId, laneId),
        })
        .returning();
      await tx.update(dbSchema.drafts).set({ todoId: todo.id, title, brief }).where(eq(dbSchema.drafts.id, draft.id));
      // An answer still on its way has nothing left to answer.
      await stopDraftReply(tx, draft.id);
      return todo;
    });
  };

  mutations.discardDraft.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    const userId = await requireAi(context);
    const draft = await ownedDraft(context, userId, args.id);
    await (context.db as AnyRow).delete(dbSchema.drafts).where(eq(dbSchema.drafts.id, draft.id));
    return true;
  };

  queries.runnerDrafts.resolve = async (_parent: unknown, args: { limit?: number | null }, context: Context) => {
    requireSystem(context);
    markRunnerSeen();
    if (!(await instanceAiOn(context.db))) return [];
    const limit = Math.max(1, Math.min(args.limit ?? 20, 200));
    const rows = await withAiOn((context.db as AnyRow).select({ id: dbSchema.drafts.id }).from(dbSchema.drafts))
      .where(and(takeable(), aiOn()))
      .orderBy(asc(dbSchema.drafts.waitingSince))
      .limit(limit);
    return rows.map((row: { id: string }) => row.id);
  };

  mutations.claimDraft.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    requireSystem(context);
    if (!(await instanceAiOn(context.db))) return null;
    try {
      return await (context.db as AnyRow).transaction(async (tx: AnyRow) => {
        const [row] = await withAiOn(
          tx.select({ draft: dbSchema.drafts, project: dbSchema.projects }).from(dbSchema.drafts),
        )
          .where(and(eq(dbSchema.drafts.id, args.id), takeable(), aiOn()))
          .for('update', { of: dbSchema.drafts });
        if (!row) return null;
        const { draft, project } = row;
        const [agent] = await tx.select().from(dbSchema.agents).where(eq(dbSchema.agents.id, draft.agentId));
        if (!agent) return null;
        const handed = await runnerAgent(tx, agent);
        // A reply whose runner died is closed, so this one can start.
        await expireLapsedDraftRuns(tx, draft.id);
        const [run] = await tx
          .insert(dbSchema.runs)
          .values({
            userId: draft.userId,
            projectId: draft.projectId,
            kind: 'draft',
            draftId: draft.id,
            agentId: agent.id,
            model: handed.resolvedModel,
            leaseExpiresAt: new Date(Date.now() + DRAFT_LEASE_SECONDS * MS_PER_SECOND),
          })
          .returning({ id: dbSchema.runs.id });
        const messages = await tx
          .select({ role: dbSchema.draftMessages.role, content: dbSchema.draftMessages.content })
          .from(dbSchema.draftMessages)
          .where(eq(dbSchema.draftMessages.draftId, draft.id))
          .orderBy(asc(dbSchema.draftMessages.createdAt), asc(dbSchema.draftMessages.id));
        return {
          draftId: draft.id,
          runId: run.id,
          agent: handed,
          projectName: project.name,
          projectDescription: project.description ?? null,
          projectContext: project.context ?? null,
          title: draft.title,
          brief: draft.brief,
          messages,
        };
      });
    } catch (error) {
      // The one-live-reply-per-draft index: somebody else's claim won.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  };

  mutations.finishDraft.resolve = async (_parent: unknown, args: FinishDraftArgs, context: Context) => {
    requireSystem(context);
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const [draft]: dbSchema.Draft[] = await tx
        .select()
        .from(dbSchema.drafts)
        .where(eq(dbSchema.drafts.id, args.id))
        .for('update');
      // Discarded meanwhile: its runs went with it.
      if (!draft) return false;
      const run = await replyRun(tx, draft.id, args.runId);
      if (!run) return false;

      const aiOff = (await draftAiOn(tx, draft)) === false;
      // A reply stopped by a switch keeps nothing it said after the switch,
      // but what it spent was spent.
      const spent = reported(run, aiOff ? null : args.prompt, args.usage);
      if (run.status !== 'running') {
        // Stopped by the person, or its lease lapsed and the draft moved on.
        if (Object.keys(spent).length > 0) {
          await tx.update(dbSchema.runs).set(spent).where(eq(dbSchema.runs.id, run.id));
        }
        return false;
      }
      const finishedAt = new Date();
      if (aiOff || run.cancelRequestedAt || !draft.waitingSince || draft.todoId) {
        await tx
          .update(dbSchema.runs)
          .set({
            status: 'stopped',
            finishedAt,
            events: aiOff ? run.events : withEvents(run.events, args.events),
            ...spent,
          })
          .where(eq(dbSchema.runs.id, run.id));
        return false;
      }

      const events = withEvents(run.events, args.events);
      const error = args.error?.trim().slice(0, MAX_ERROR);
      if (error) {
        await tx
          .update(dbSchema.runs)
          .set({ status: 'error', error, finishedAt, events, ...spent })
          .where(eq(dbSchema.runs.id, run.id));
        await tx.update(dbSchema.drafts).set({ waitingSince: null, error }).where(eq(dbSchema.drafts.id, draft.id));
        return true;
      }
      const reply = args.reply?.trim().slice(0, MAX_MESSAGE);
      if (reply) {
        await tx
          .insert(dbSchema.draftMessages)
          .values({ userId: draft.userId, draftId: draft.id, role: 'assistant', content: reply });
      }
      await tx
        .update(dbSchema.runs)
        .set({ status: 'ok', output: reply || null, finishedAt, events, ...spent })
        .where(eq(dbSchema.runs.id, run.id));
      const title = args.title?.trim();
      const brief = args.brief?.trim();
      await tx
        .update(dbSchema.drafts)
        .set({
          waitingSince: null,
          error: null,
          ...(title ? { title: title.slice(0, MAX_TITLE) } : {}),
          ...(brief ? { brief } : {}),
        })
        .where(eq(dbSchema.drafts.id, draft.id));
      return true;
    });
  };

  return extendedSchema;
}
