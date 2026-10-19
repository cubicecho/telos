import type { DB } from '@telos/db';
import * as dbSchema from '@telos/db/schema';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Actor } from '../core/context.ts';
import { instanceAiOn } from '../instance/settings.ts';
import { runToolsOff } from '../mcp/door.ts';
import { readRunToken, runnerKeyMatches } from '../runs/tokens.ts';
import type { Auth } from './better-auth.ts';

// Who a request is: a person on a session, an MCP client on a key, an agent on
// a run token, the runner, or nobody. Every door asks this, through the context
// factory (graphql/context-factory.ts).

export const ANONYMOUS: Actor = { kind: 'anonymous', userId: null };

export interface ActorOptions {
  /** Whether the server offers AI (config.ts `aiAvailable`). Off, only a session resolves. */
  ai: boolean;
  /** The runner's key (config.ts `runnerKey`). Unset, nobody is the system principal. */
  runnerKey?: string | null | undefined;
}

/**
 * Who a request is. The AI credentials resolve only while the server offers AI,
 * and each is checked against the switches over it every time, the instance's
 * own included:
 *
 * - `x-runner-key`: the runner, as the system principal. It owns no rows and
 *   may call only the runner's own mutations (graphql/permissions.ts). It
 *   resolves with the instance switch off too, so it can hear that its runs
 *   were stopped; the queue is empty then, and nothing can be claimed.
 * - `x-run-token`: an agent at work, for exactly as long as its run is live
 *   and its user, project and todo are all still open to AI. It carries the
 *   tools its agent has off for runs, or the default for a run.
 * - `x-api-key`: an MCP client, while its owner has AI on. It carries the
 *   tools its owner switched off for it.
 *
 * A credential that fails any check is anonymous rather than an error, so the
 * caller gets UNAUTHENTICATED from the first field that needs a user.
 */
export async function resolveActor(auth: Auth, db: DB, headers: Headers, options: ActorOptions): Promise<Actor> {
  const runner = headers.get('x-runner-key');
  if (runner) {
    return options.ai && runnerKeyMatches(runner, options.runnerKey) ? { kind: 'system', userId: null } : ANONYMOUS;
  }

  const runToken = headers.get('x-run-token');
  if (runToken) {
    const runId = options.ai ? readRunToken(runToken) : null;
    return runId && (await instanceAiOn(db)) ? await resolveRun(db, runId) : ANONYMOUS;
  }

  const key = headers.get('x-api-key');
  if (key) {
    if (!options.ai || !(await instanceAiOn(db))) return ANONYMOUS;
    const result = await auth.api.verifyApiKey({ body: { key } }).catch(() => null);
    if (!result?.valid || !result.key) return ANONYMOUS;
    const userId = result.key.referenceId;
    const [owner] = await db
      .select({ aiEnabled: dbSchema.users.aiEnabled })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, userId));
    if (!owner?.aiEnabled) return ANONYMOUS;
    return { kind: 'apiKey', userId, keyId: result.key.id, toolsOff: await keyToolsOff(db, result.key.id) };
  }

  // Case-sensitive on purpose: it is what the client sends, and the bearer
  // plugin would otherwise be the only thing deciding what counts.
  if (headers.get('authorization')?.startsWith('Bearer ')) {
    const session = await auth.api.getSession({ headers }).catch(() => null);
    if (session) return { kind: 'user', userId: session.user.id };
  }

  return ANONYMOUS;
}

/**
 * The door's tools a key has switched off. A key nobody has changed a switch
 * for has no row, and every tool on.
 *
 * @param db The database.
 * @param keyId The key.
 * @returns The names of the tools that are off for it.
 */
async function keyToolsOff(db: DB, keyId: string): Promise<ReadonlySet<string>> {
  const [row] = await db
    .select({ off: dbSchema.apiKeyTools.off })
    .from(dbSchema.apiKeyTools)
    .where(eq(dbSchema.apiKeyTools.keyId, keyId));
  return new Set<string>(row?.off ?? []);
}

/**
 * The agent working a run, while the run may still act: running, inside its
 * lease, not asked to stop, and every AI switch over it still on. Read with its
 * agent's tool switches, once per request as a key's are.
 *
 * @param db The database.
 * @param runId The run a token named.
 * @returns The agent actor, or anonymous.
 */
async function resolveRun(db: DB, runId: string): Promise<Actor> {
  const [row] = await db
    .select({ userId: dbSchema.runs.userId, toolsOff: dbSchema.agents.toolsOff })
    .from(dbSchema.runs)
    .leftJoin(dbSchema.agents, eq(dbSchema.agents.id, dbSchema.runs.agentId))
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.runs.userId))
    .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.runs.projectId))
    .innerJoin(dbSchema.todos, eq(dbSchema.todos.id, dbSchema.runs.todoId))
    .where(
      and(
        eq(dbSchema.runs.id, runId),
        eq(dbSchema.runs.status, 'running'),
        gt(dbSchema.runs.leaseExpiresAt, new Date()),
        isNull(dbSchema.runs.cancelRequestedAt),
        eq(dbSchema.users.aiEnabled, true),
        eq(dbSchema.projects.aiEnabled, true),
        eq(dbSchema.todos.aiIgnored, false),
      ),
    );
  return row ? { kind: 'agent', userId: row.userId, runId, toolsOff: runToolsOff(row.toolsOff) } : ANONYMOUS;
}
