import type { DB } from '@telos/db';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Records that an agent is working a todo, which is the session its MCP hooks
 * file things under. The record is what a deleted todo's `sessionDelete` is
 * owed from (runs/session-deletes.ts).
 *
 * @param tx - The transaction the run is claimed in.
 * @param todo - The todo being claimed.
 * @param agentId - The agent claiming it.
 * @returns Whether no agent had worked the todo before: the session opens now.
 */
export async function openSession(
  tx: DB,
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
