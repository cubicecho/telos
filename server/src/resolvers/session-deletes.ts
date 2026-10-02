import * as dbSchema from '@telos/db/schema';
import { and, asc, eq, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { extendSchema, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireSystem } from '../ai-gate.ts';
import type { Context } from '../context.ts';
import { instanceAiOn } from '../instance.ts';
import { markRunnerSeen } from '../runner-seen.ts';

// Telling an agent's MCP servers that a todo is gone. The todo is the session
// their hooks file things under, so a memory server that is never told keeps
// what it filed for good. A delete happens here and the servers are reached
// only from the runner, so the delete leaves a mark (`todo_sessions.deleted_at`,
// set by a trigger) and the runner comes for it, as it comes for MCP tests and
// drafts: it takes what is owed, fires `sessionDelete`, and reports back.
//
// The delete itself never waits on any of this, and nothing here can undo it.
// A server that cannot be told is tried a few times and then given up on.
//
// These wait while AI is off for the instance or the account: off means the
// runner reaches nothing of that account's. A project's switch is not asked,
// since the project may be gone with the todo.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const SESSION_DELETES_SDL = parse(`
  "A deleted todo's session, which an agent's MCP servers have yet to be told is gone."
  type SessionDelete {
    id: ID!
    "The todo that was deleted: the session's id."
    todoId: ID!
    agentName: String!
    "Which try this is, from one."
    attempt: Int!
    "The agent's servers that have a sessionDelete hook, as JSON, secrets included."
    mcpServers: String!
  }

  extend type Mutation {
    "Takes the session deletes owed, each held for a while so no other runner takes it too. The runner's only."
    takeSessionDeletes(limit: Int): [SessionDelete!]!
    "Reports that a session's servers were told, or with \`error\` that they could not be. The runner's only. False when it was no longer owed."
    finishSessionDelete(id: ID!, error: String): Boolean!
  }
`);

/** The hook event a deleted todo's session is owed. */
export const SESSION_DELETE = 'sessionDelete';
/** How many times the servers are tried before a session delete is given up on. */
export const SESSION_DELETE_ATTEMPTS = 3;
/** How long a runner holds one it took. One that passes is a runner that died. */
export const SESSION_DELETE_HOLD_SECONDS = 300;
/** How long a failed one waits, times the tries so far. */
export const SESSION_DELETE_RETRY_SECONDS = 300;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const MAX_ERROR = 2000;
const MS_PER_SECOND = 1000;

/**
 * An agent's servers that ask to hear of a deleted session.
 *
 * @param servers - `agents.mcp_servers`, which a client wrote and may be anything.
 * @returns The servers with an enabled `sessionDelete` hook.
 */
export function serversToTell(servers: unknown): unknown[] {
  if (Array.isArray(servers) === false) {
    return [];
  }
  return (servers as unknown[]).filter((server) => {
    const hooks = (server as { hooks?: unknown } | null)?.hooks;
    return (
      Array.isArray(hooks) &&
      hooks.some((hook: { on?: unknown; enabled?: unknown } | null) => {
        return hook?.on === SESSION_DELETE && hook.enabled !== false;
      })
    );
  });
}

/**
 * Says on the server's log that a session delete was dropped. There is no todo
 * left to hang a notice on.
 *
 * @param session - The session given up on.
 * @param reason - Why the last try failed.
 * @returns Nothing.
 */
function warnDropped(session: dbSchema.TodoSession, reason: string | null): void {
  console.warn(
    `[sessions] gave up telling agent ${session.agentId} that todo ${session.todoId} was deleted, ` +
      `after ${session.attempts} tries: ${reason || 'the runner never reported back'}`,
  );
}

/**
 * Adds the runner's session-delete mutations to the schema.
 *
 * @param schema - The schema so far.
 * @returns The schema with them.
 */
export function applySessionDeletesExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, SESSION_DELETES_SDL);
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  mutations.takeSessionDeletes.resolve = async (
    _parent: unknown,
    args: { limit?: number | null },
    context: Context,
  ) => {
    requireSystem(context);
    markRunnerSeen();
    if ((await instanceAiOn(context.db)) === false) {
      return [];
    }
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const now = new Date();
      const owed: Array<{ session: dbSchema.TodoSession; agent: dbSchema.Agent }> = await tx
        .select({ session: dbSchema.todoSessions, agent: dbSchema.agents })
        .from(dbSchema.todoSessions)
        .innerJoin(dbSchema.agents, eq(dbSchema.agents.id, dbSchema.todoSessions.agentId))
        .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.todoSessions.userId))
        .where(
          and(
            isNotNull(dbSchema.todoSessions.deletedAt),
            or(isNull(dbSchema.todoSessions.retryAt), lte(dbSchema.todoSessions.retryAt, now)),
            eq(dbSchema.users.aiEnabled, true),
          ),
        )
        .orderBy(asc(dbSchema.todoSessions.deletedAt), asc(dbSchema.todoSessions.id))
        .limit(limit)
        .for('update', { of: dbSchema.todoSessions, skipLocked: true });

      const taken = [];
      for (const { session, agent } of owed) {
        const servers = serversToTell(agent.mcpServers);
        const spent = session.attempts >= SESSION_DELETE_ATTEMPTS;
        if (servers.length === 0 || spent) {
          // Nobody asked to hear, or a runner took the last try and never came back.
          if (servers.length > 0) {
            warnDropped(session, session.error);
          }
          await tx.delete(dbSchema.todoSessions).where(eq(dbSchema.todoSessions.id, session.id));
          continue;
        }
        const attempt = session.attempts + 1;
        await tx
          .update(dbSchema.todoSessions)
          .set({ attempts: attempt, retryAt: new Date(now.getTime() + SESSION_DELETE_HOLD_SECONDS * MS_PER_SECOND) })
          .where(eq(dbSchema.todoSessions.id, session.id));
        taken.push({
          id: session.id,
          todoId: session.todoId,
          agentName: agent.name,
          attempt,
          mcpServers: JSON.stringify(servers),
        });
      }
      return taken;
    });
  };

  mutations.finishSessionDelete.resolve = async (
    _parent: unknown,
    args: { id: string; error?: string | null },
    context: Context,
  ) => {
    requireSystem(context);
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const [session]: dbSchema.TodoSession[] = await tx
        .select()
        .from(dbSchema.todoSessions)
        .where(and(eq(dbSchema.todoSessions.id, args.id), isNotNull(dbSchema.todoSessions.deletedAt)))
        .for('update');
      if (session === undefined) {
        return false;
      }
      const error = args.error?.trim().slice(0, MAX_ERROR) || null;
      if (error !== null && session.attempts < SESSION_DELETE_ATTEMPTS) {
        const wait = SESSION_DELETE_RETRY_SECONDS * session.attempts * MS_PER_SECOND;
        await tx
          .update(dbSchema.todoSessions)
          .set({ error, retryAt: new Date(Date.now() + wait) })
          .where(eq(dbSchema.todoSessions.id, session.id));
        return true;
      }
      if (error !== null) {
        warnDropped(session, error);
      }
      await tx.delete(dbSchema.todoSessions).where(eq(dbSchema.todoSessions.id, session.id));
      return true;
    });
  };

  return extendedSchema;
}
