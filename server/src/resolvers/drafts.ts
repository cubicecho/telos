import * as dbSchema from '@telos/db/schema';
import { and, asc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi, requireSystem } from '../ai-gate.ts';
import type { Context } from '../context.ts';
import { instanceAiOn } from '../instance.ts';
import { findFirstOpenLaneId } from '../lanes.ts';
import { stampActor } from '../provenance.ts';
import { markRunnerSeen } from '../runner-seen.ts';
import { loadAiProject, nextPosition } from './requests.ts';

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
    answer. False when nobody is waiting for it any more.
    """
    finishDraft(id: ID!, reply: String, title: String, brief: String, error: String): Boolean!
  }
`);

/**
 * How long the runner holds a draft it is answering. There is no heartbeat:
 * one answer is one model call, so this is set well past a slow model's
 * timeout. A draft held past it is taken again.
 */
export const DRAFT_LEASE_SECONDS = 600;

const MAX_MESSAGE = 20_000;
const MAX_TITLE = 200;

const badInput = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
const notFound = (what: string) => new GraphQLError(`${what} not found`, { extensions: { code: 'NOT_FOUND' } });
const conflict = (message: string) => new GraphQLError(message, { extensions: { code: 'CONFLICT' } });

function message(value: string): string {
  const text = value.trim();
  if (!text) throw badInput('Say something first.');
  if (text.length > MAX_MESSAGE) throw badInput(`Keep it under ${MAX_MESSAGE} characters.`);
  return text;
}

/** The caller's agent, or NOT_FOUND. */
async function ownedAgent(db: AnyRow, userId: string, agentId: string) {
  const [agent] = await db
    .select({ id: dbSchema.agents.id })
    .from(dbSchema.agents)
    .where(and(eq(dbSchema.agents.id, agentId), eq(dbSchema.agents.userId, userId)));
  if (!agent) throw notFound('Agent');
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

/** Whether a draft is waiting and nobody holds it, as SQL. */
const takeable = () =>
  and(
    isNotNull(dbSchema.drafts.waitingSince),
    isNull(dbSchema.drafts.todoId),
    isNotNull(dbSchema.drafts.agentId),
    or(isNull(dbSchema.drafts.leaseExpiresAt), lt(dbSchema.drafts.leaseExpiresAt, new Date())),
  );

/** Drafts whose account and project both have AI on, as SQL joins. */
function withAiOn(query: AnyRow) {
  return query
    .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.drafts.projectId))
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.drafts.userId));
}
const aiOn = () => and(eq(dbSchema.projects.aiEnabled, true), eq(dbSchema.users.aiEnabled, true));

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
    const draft = await ownedDraft(context, userId, args.id);
    const [updated] = await (context.db as AnyRow)
      .update(dbSchema.drafts)
      .set({ waitingSince: null, leaseExpiresAt: null })
      .where(eq(dbSchema.drafts.id, draft.id))
      .returning();
    return updated;
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
      const laneId = await findFirstOpenLaneId(tx, draft.projectId);
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
      await tx
        .update(dbSchema.drafts)
        .set({ todoId: todo.id, title, brief, waitingSince: null, leaseExpiresAt: null })
        .where(eq(dbSchema.drafts.id, draft.id));
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
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const [row] = await withAiOn(
        tx.select({ draft: dbSchema.drafts, project: dbSchema.projects }).from(dbSchema.drafts),
      )
        .where(and(eq(dbSchema.drafts.id, args.id), takeable(), aiOn()))
        .for('update', { of: dbSchema.drafts });
      if (!row) return null;
      const { draft, project } = row;
      const [agent] = await tx.select().from(dbSchema.agents).where(eq(dbSchema.agents.id, draft.agentId));
      if (!agent) return null;
      await tx
        .update(dbSchema.drafts)
        .set({ leaseExpiresAt: new Date(Date.now() + DRAFT_LEASE_SECONDS * 1000) })
        .where(eq(dbSchema.drafts.id, draft.id));
      const messages = await tx
        .select({ role: dbSchema.draftMessages.role, content: dbSchema.draftMessages.content })
        .from(dbSchema.draftMessages)
        .where(eq(dbSchema.draftMessages.draftId, draft.id))
        .orderBy(asc(dbSchema.draftMessages.createdAt), asc(dbSchema.draftMessages.id));
      return {
        draftId: draft.id,
        agent: { ...agent, mcpServers: JSON.stringify(agent.mcpServers ?? []) },
        projectName: project.name,
        projectDescription: project.description ?? null,
        projectContext: project.context ?? null,
        title: draft.title,
        brief: draft.brief,
        messages,
      };
    });
  };

  mutations.finishDraft.resolve = async (
    _parent: unknown,
    args: { id: string; reply?: string | null; title?: string | null; brief?: string | null; error?: string | null },
    context: Context,
  ) => {
    requireSystem(context);
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const [row] = await withAiOn(tx.select({ draft: dbSchema.drafts }).from(dbSchema.drafts))
        .where(and(eq(dbSchema.drafts.id, args.id), aiOn()))
        .for('update', { of: dbSchema.drafts });
      // Stopped, made into a todo, deleted, or AI switched off meanwhile:
      // nobody is waiting for this answer.
      const draft = row?.draft as dbSchema.Draft | undefined;
      if (!draft || !draft.waitingSince || !draft.leaseExpiresAt || draft.todoId) return false;

      const done = { waitingSince: null, leaseExpiresAt: null };
      const error = args.error?.trim();
      if (error) {
        await tx
          .update(dbSchema.drafts)
          .set({ ...done, error: error.slice(0, 2000) })
          .where(eq(dbSchema.drafts.id, draft.id));
        return true;
      }
      const reply = args.reply?.trim();
      if (reply) {
        await tx
          .insert(dbSchema.draftMessages)
          .values({ userId: draft.userId, draftId: draft.id, role: 'assistant', content: reply.slice(0, MAX_MESSAGE) });
      }
      const title = args.title?.trim();
      const brief = args.brief?.trim();
      await tx
        .update(dbSchema.drafts)
        .set({
          ...done,
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
