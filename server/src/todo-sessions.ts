import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

/**
 * Records that an agent is working a todo, which is the session its MCP hooks
 * file things under. The record is what a deleted todo's `sessionDelete` is
 * owed from (resolvers/session-deletes.ts).
 *
 * @param tx - The transaction the run is claimed in.
 * @param todo - The todo being claimed.
 * @param agentId - The agent claiming it.
 * @returns Whether no agent had worked the todo before: the session opens now.
 */
export async function openSession(
  tx: AnyRow,
  todo: Pick<dbSchema.Todo, 'id' | 'userId'>,
  agentId: string,
): Promise<boolean> {
  const before: number = await tx.$count(dbSchema.todoSessions, eq(dbSchema.todoSessions.todoId, todo.id));
  await tx
    .insert(dbSchema.todoSessions)
    .values({ userId: todo.userId, todoId: todo.id, agentId })
    .onConflictDoNothing({ target: [dbSchema.todoSessions.todoId, dbSchema.todoSessions.agentId] });
  return before === 0;
}
