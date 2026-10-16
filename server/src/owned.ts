import * as dbSchema from '@telos/db/schema';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { notFound } from './errors.ts';

// A row of the caller's, by id, or NOT_FOUND: the one fetch every resolver
// that is handed an id starts with. Someone else's row and no row at all are
// the same answer, so an id says nothing about other accounts. The AI forms
// narrow it to what AI may see, as tenancy.ts does for lists.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyDb = any;

type OwnedTable = typeof dbSchema.todos | typeof dbSchema.lanes | typeof dbSchema.projects;

/**
 * A row of `table` the caller owns, or NOT_FOUND.
 *
 * @param db - The database or transaction.
 * @param table - Which rows.
 * @param what - What one is called, for the error ("Todo").
 * @param userId - The caller.
 * @param id - The row.
 * @param also - Anything else the row must be.
 * @returns The row.
 */
async function loadOwned<T extends OwnedTable>(
  db: AnyDb,
  table: T,
  what: string,
  userId: string,
  id: string,
  ...also: SQL[]
): Promise<T['$inferSelect']> {
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), eq(table.userId, userId), ...also))
    .limit(1);
  if (!row) throw notFound(what);
  return row;
}

/** A project of the caller's, archived or not. */
export function loadOwnedProject(db: AnyDb, userId: string, id: string): Promise<dbSchema.Project> {
  return loadOwned(db, dbSchema.projects, 'Project', userId, id);
}

/** A lane of the caller's. */
export function loadOwnedLane(db: AnyDb, userId: string, id: string): Promise<dbSchema.Lane> {
  return loadOwned(db, dbSchema.lanes, 'Lane', userId, id);
}

/** A todo of the caller's that is not archived. */
export function loadOwnedTodo(db: AnyDb, userId: string, id: string): Promise<dbSchema.Todo> {
  return loadOwned(db, dbSchema.todos, 'Todo', userId, id, isNull(dbSchema.todos.archivedAt));
}

/** A project of the caller's with AI on. */
export function loadAiProject(db: AnyDb, userId: string, id: string): Promise<dbSchema.Project> {
  return loadOwned(db, dbSchema.projects, 'Project', userId, id, eq(dbSchema.projects.aiEnabled, true));
}

/** A todo of the caller's that AI may see: not archived, not ignored, in a project with AI on. */
export async function loadAiTodo(db: AnyDb, userId: string, id: string): Promise<dbSchema.Todo> {
  const [row] = await db
    .select({ todo: dbSchema.todos })
    .from(dbSchema.todos)
    .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.todos.projectId))
    .where(
      and(
        eq(dbSchema.todos.id, id),
        eq(dbSchema.todos.userId, userId),
        eq(dbSchema.todos.aiIgnored, false),
        isNull(dbSchema.todos.archivedAt),
        eq(dbSchema.projects.aiEnabled, true),
      ),
    );
  if (!row) throw notFound('Todo');
  return row.todo;
}
