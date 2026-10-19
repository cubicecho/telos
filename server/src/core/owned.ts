import type { DB } from '@telos/db';
import * as dbSchema from '@telos/db/schema';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { reachable } from '../graphql/tenancy.ts';
import type { Context } from './context.ts';
import { notFound } from './errors.ts';

// A row the caller may reach, by id, or NOT_FOUND: the one fetch every
// resolver that is handed an id starts with. Someone else's row and no row at
// all are the same answer, so an id says nothing about other accounts.
//
// What the caller may reach is tenancy's `reachable()`, the scope generated
// CRUD runs under, so a hand-written mutation and a generated one agree on it:
// a person reaches their own rows, and AI only what AI may see of them. The AI
// forms add what a draft or an artifact needs whoever asks, a project with AI
// on, which is not a permission but a rule of the feature.

type OwnedName = 'todos' | 'lanes' | 'projects';
type OwnedTable = (typeof dbSchema)[OwnedName];

/**
 * A row of `table` the caller may reach, or NOT_FOUND.
 *
 * @param context - The request.
 * @param db - The database or transaction to read it in.
 * @param name - The table's drizzle-graphql key.
 * @param table - Which rows.
 * @param what - What one is called, for the error ("Todo").
 * @param id - The row.
 * @param also - Anything else the row must be.
 * @returns The row.
 */
async function loadOwned<T extends OwnedTable>(
  context: Context,
  db: DB,
  name: OwnedName,
  table: OwnedTable & T,
  what: string,
  id: string,
  ...also: SQL[]
): Promise<T['$inferSelect']> {
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), reachable(context, name, table), ...also))
    .limit(1);
  if (!row) throw notFound(what);
  // drizzle loses the row type through a generic table; it is T's row.
  return row as T['$inferSelect'];
}

/**
 * A project the caller may reach, archived or not.
 *
 * @param context - The request.
 * @param id - The project.
 * @param [db] - A transaction to read it in. The default is `context.db`.
 * @returns The project.
 */
export function loadOwnedProject(context: Context, id: string, db: DB = context.db): Promise<dbSchema.Project> {
  return loadOwned(context, db, 'projects', dbSchema.projects, 'Project', id);
}

/**
 * A lane the caller may reach.
 *
 * @param context - The request.
 * @param id - The lane.
 * @param [db] - A transaction to read it in. The default is `context.db`.
 * @returns The lane.
 */
export function loadOwnedLane(context: Context, id: string, db: DB = context.db): Promise<dbSchema.Lane> {
  return loadOwned(context, db, 'lanes', dbSchema.lanes, 'Lane', id);
}

/**
 * A todo the caller may reach that is not archived.
 *
 * @param context - The request.
 * @param id - The todo.
 * @param [db] - A transaction to read it in. The default is `context.db`.
 * @returns The todo.
 */
export function loadOwnedTodo(context: Context, id: string, db: DB = context.db): Promise<dbSchema.Todo> {
  return loadOwned(context, db, 'todos', dbSchema.todos, 'Todo', id, isNull(dbSchema.todos.archivedAt));
}

/**
 * A project the caller may reach with AI on, whoever is asking.
 *
 * @param context - The request.
 * @param id - The project.
 * @returns The project.
 */
export function loadAiProject(context: Context, id: string): Promise<dbSchema.Project> {
  return loadOwned(
    context,
    context.db,
    'projects',
    dbSchema.projects,
    'Project',
    id,
    eq(dbSchema.projects.aiEnabled, true),
  );
}

/**
 * A todo the caller may reach that AI may see, whoever is asking: not
 * archived, not ignored, in a project with AI on.
 *
 * @param context - The request.
 * @param id - The todo.
 * @returns The todo.
 */
export async function loadAiTodo(context: Context, id: string): Promise<dbSchema.Todo> {
  const [row] = await context.db
    .select({ todo: dbSchema.todos })
    .from(dbSchema.todos)
    .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.todos.projectId))
    .where(
      and(
        eq(dbSchema.todos.id, id),
        reachable(context, 'todos', dbSchema.todos),
        eq(dbSchema.todos.aiIgnored, false),
        isNull(dbSchema.todos.archivedAt),
        eq(dbSchema.projects.aiEnabled, true),
      ),
    );
  if (!row) throw notFound('Todo');
  return row.todo;
}
