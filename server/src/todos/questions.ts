import * as dbSchema from '@telos/db/schema';
import { inArray, type SQL, sql } from 'drizzle-orm';

// When a todo waits on a person. A run that is missing something calls the
// runner's `ask_person` tool, and `finishRun` writes its question as a note of
// kind `question` and ends the run as `asked`, which costs no attempt and
// moves the todo nowhere.
//
// Waiting is derived, not stored: a todo waits while it has a question with no
// person's note after it. So there is no status to keep in step, a person
// answers by replying in the thread, and one rule serves the queue
// (`readyTodos` skips it), the status panel (`workStates` says ASKED), the
// card (`cardMarks`) and `Todo.question`.
//
// An answer is a plain note signed by a person or by a person's own MCP client
// (an API key). Never by a run, or an agent could unblock itself, and never by
// the server.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyDb = any;

/** Who may answer a question: a person, at the app or through their own MCP client. */
export const ANSWERS_FROM = sql`('user', 'apiKey')`;

/**
 * The question a todo is waiting on, in a query that names the todo's id by
 * `todoId`: the newest `question` note with no person's note after it, or
 * null. An older question is answered by whatever answered a newer one, so
 * the newest is the only one that can be open.
 *
 * @param todoId - The todo's id column, as the surrounding query names it.
 * @returns A scalar subquery: the question's text, or null.
 */
export function openQuestion(todoId: SQL): SQL {
  return sql`(
    SELECT q.body FROM todo_notes q
    WHERE q.todo_id = ${todoId} AND q.kind = 'question'
      AND NOT EXISTS (
        SELECT 1 FROM todo_notes a
        WHERE a.todo_id = q.todo_id AND a.kind = 'note' AND a.actor_kind IN ${ANSWERS_FROM}
          AND a.created_at > q.created_at
      )
    ORDER BY q.created_at DESC LIMIT 1
  )`;
}

/**
 * The open question of each todo asked about.
 *
 * @param db - The database or transaction.
 * @param todoIds - The todos.
 * @returns The questions, keyed by todo id; a todo waiting on nobody is absent.
 */
export async function findQuestions(db: AnyDb, todoIds: readonly string[]): Promise<Map<string, string>> {
  const byTodo = new Map<string, string>();
  if (todoIds.length === 0) return byTodo;
  const rows: Array<{ id: string; question: string | null }> = await db
    .select({ id: dbSchema.todos.id, question: sql<string | null>`${openQuestion(sql`${dbSchema.todos.id}`)}` })
    .from(dbSchema.todos)
    .where(inArray(dbSchema.todos.id, [...todoIds]));
  for (const row of rows) {
    if (row.question !== null) byTodo.set(String(row.id), row.question);
  }
  return byTodo;
}
