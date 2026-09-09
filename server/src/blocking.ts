import * as dbSchema from '@telos/db/schema';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { GraphQLError } from 'graphql';

// The dependency rules, in one place. A todo is *blocked* while any todo it
// depends on is still open; a blocked todo cannot be completed. Every path that
// could complete a todo goes through `assertNotBlocked` — the ergonomic
// `completeTodo` mutation and the generated `updateTodo` alike (see
// resolvers/write-guards.ts), so there is no way to route around the rule.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyDb = any;
export type TodoRow = Record<string, unknown> & { id: string };

/** Rows a raw `execute` returned, across the postgres-js and PGlite drivers. */
function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * Of `todoIds`, the ones with at least one incomplete dependency — in one query,
 * so `Todo.isBlocked` over a list costs the same as over a single todo.
 */
export async function findBlocked(db: AnyDb, todoIds: readonly string[]): Promise<Set<string>> {
  if (todoIds.length === 0) return new Set();
  const rows: Array<{ todoId: string }> = await db
    .selectDistinct({ todoId: dbSchema.todoDependencies.todoId })
    .from(dbSchema.todoDependencies)
    .innerJoin(dbSchema.todos, eq(dbSchema.todos.id, dbSchema.todoDependencies.dependsOnTodoId))
    .where(and(inArray(dbSchema.todoDependencies.todoId, [...todoIds]), isNull(dbSchema.todos.completedAt)));
  return new Set(rows.map((row) => row.todoId));
}

/** The open todos standing in the way of each of `todoIds`, keyed by blocked id. */
export async function findBlockers(db: AnyDb, todoIds: readonly string[]): Promise<Map<string, TodoRow[]>> {
  const byTodo = new Map<string, TodoRow[]>();
  if (todoIds.length === 0) return byTodo;
  const rows: Array<{ todoId: string; blocker: TodoRow }> = await db
    .select({ todoId: dbSchema.todoDependencies.todoId, blocker: dbSchema.todos })
    .from(dbSchema.todoDependencies)
    .innerJoin(dbSchema.todos, eq(dbSchema.todos.id, dbSchema.todoDependencies.dependsOnTodoId))
    .where(and(inArray(dbSchema.todoDependencies.todoId, [...todoIds]), isNull(dbSchema.todos.completedAt)));
  for (const row of rows) {
    const existing = byTodo.get(row.todoId);
    if (existing) existing.push(row.blocker);
    else byTodo.set(row.todoId, [row.blocker]);
  }
  return byTodo;
}

/** Throws unless every id in `todoIds` is free to be completed. */
export async function assertNotBlocked(db: AnyDb, todoIds: readonly string[]): Promise<void> {
  const blocked = await findBlocked(db, todoIds);
  if (blocked.size === 0) return;
  const blockers = await findBlockers(db, [...blocked]);
  const names = [...blockers.values()]
    .flat()
    .map((row) => String(row.title))
    .slice(0, 3);
  throw new GraphQLError(
    `This todo is blocked by ${names.length > 0 ? names.join(', ') : 'an incomplete dependency'}. Complete it first.`,
    { extensions: { code: 'BAD_USER_INPUT' } },
  );
}

/**
 * Throws if any todo of `userId`'s is completed while something it depends on is
 * still open.
 *
 * The write guard cannot ask the returned rows which todos a generated update
 * completed — a mutation returns only the columns the client selected, so
 * `completedAt` is often simply absent. Re-asserting the invariant over the
 * caller's rows is independent of the selection set, and it runs inside the
 * mutation's transaction, so a violation rolls the whole write back.
 */
export async function assertNoBlockedCompletions(db: AnyDb, userId: string): Promise<void> {
  const blockers = alias(dbSchema.todos, 'blocker_todos');
  const rows: Array<{ blocker: string }> = await db
    .select({ blocker: blockers.title })
    .from(dbSchema.todos)
    .innerJoin(dbSchema.todoDependencies, eq(dbSchema.todoDependencies.todoId, dbSchema.todos.id))
    .innerJoin(blockers, eq(blockers.id, dbSchema.todoDependencies.dependsOnTodoId))
    .where(and(eq(dbSchema.todos.userId, userId), isNotNull(dbSchema.todos.completedAt), isNull(blockers.completedAt)))
    .limit(3);
  if (rows.length === 0) return;
  throw new GraphQLError(`This todo is blocked by ${rows.map((row) => row.blocker).join(', ')}. Complete it first.`, {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/**
 * Rejects a `todoId → dependsOnTodoId` edge that would close a cycle.
 *
 * A cycle is a deadlock: every todo in it waits on another, and none can ever be
 * completed. The recursive CTE walks the dependencies of the proposed blocker; if
 * the todo being blocked is reachable from it, the new edge closes a loop.
 */
export async function assertNoCycle(db: AnyDb, todoId: string, dependsOnTodoId: string): Promise<void> {
  if (todoId === dependsOnTodoId) {
    throw new GraphQLError('A todo cannot depend on itself.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  // Written against the table's SQL name rather than the drizzle table object:
  // the recursive term joins the table to the CTE under an alias, which the
  // query builder has no way to spell.
  const result = await db.execute(sql`
    WITH RECURSIVE reachable(id) AS (
      SELECT depends_on_todo_id FROM todo_dependencies WHERE todo_id = ${dependsOnTodoId}
      UNION
      SELECT d.depends_on_todo_id FROM todo_dependencies d JOIN reachable r ON d.todo_id = r.id
    )
    SELECT 1 AS hit FROM reachable WHERE id = ${todoId} LIMIT 1
  `);
  if (resultRows(result).length > 0) {
    throw new GraphQLError('That dependency would create a cycle.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
}
