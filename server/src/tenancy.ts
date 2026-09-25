import * as dbSchema from '@telos/db/schema';
import type { BuildSchemaConfig, RowScope } from '@vantreeseba/drizzle-graphql';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { type Context, isAiActor } from './context.ts';
import { requireAuth } from './resolvers/auth.ts';

// Multi-tenancy, expressed as drizzle-graphql configuration rather than as
// resolver wrappers. `scope` is ANDed into the SQL of every read, update and
// delete the library generates — list and single queries, aggregates, groupBy,
// relation fields, cursor pages — after the client's own `where`, so a client
// filter can only ever narrow it. `contextValues` is the write-side half: it
// takes `userId` out of every create and update input and stamps it from the
// request, so ownership is never something a caller states.
//
// A `scope` cannot reach a plain insert, and it says nothing about the rows a
// foreign key *points at* — resolvers/write-guards.ts closes that half.
//
// The rule for anyone adding a table: it needs an entry here, or its rows are
// visible across tenants. __tests__/tenancy.test.ts fails when one is missing.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyTable = any;

/**
 * Every table but `users` carries its own `user_id` — junctions included.
 * Philotes routes junction ownership through a subquery against the parent row;
 * carrying the column directly costs one uuid per join row and lets every table
 * share the same one-line scope.
 */
export const USER_OWNED_TABLES = [
  'projects',
  'lanes',
  'todos',
  'todoDependencies',
  'labels',
  'projectLabels',
  'todoLabels',
  'todoNotes',
  'todoEvents',
  'agents',
  'runs',
] as const;

/** Every table drizzle-graphql will generate fields for. */
export const ALL_TABLES = ['users', ...USER_OWNED_TABLES] as const;

const scopeByUserId: RowScope<Context> = (context, table) => eq((table as AnyTable).userId, requireAuth(context));

// What AI sees is narrower than what its user sees: only projects with AI
// switched on, and in them only the todos nobody told AI to ignore. Everything
// hanging off a hidden project or todo — lanes, notes, history, labels on it,
// dependency edges touching it — is hidden with it. A person's session is
// untouched by any of this.

/** The caller's projects with AI on, as a subquery. */
function aiProjectIds(context: Context, userId: string) {
  return (context.db as AnyTable)
    .select({ id: dbSchema.projects.id })
    .from(dbSchema.projects)
    .where(and(eq(dbSchema.projects.userId, userId), eq(dbSchema.projects.aiEnabled, true)));
}

/** The caller's todos AI may see, as a subquery. */
function aiTodoIds(context: Context, userId: string) {
  return (context.db as AnyTable)
    .select({ id: dbSchema.todos.id })
    .from(dbSchema.todos)
    .where(
      and(
        eq(dbSchema.todos.userId, userId),
        eq(dbSchema.todos.aiIgnored, false),
        inArray(dbSchema.todos.projectId, aiProjectIds(context, userId)),
      ),
    );
}

/** The user scope, and for an AI caller whatever `narrow` adds to it. */
function aiNarrowed(narrow: (context: Context, table: AnyTable, userId: string) => SQL | undefined): RowScope<Context> {
  return (context, table) => {
    const userId = requireAuth(context);
    const own = eq((table as AnyTable).userId, userId);
    return isAiActor(context) ? and(own, narrow(context, table as AnyTable, userId)) : own;
  };
}

const AI_SCOPES: Partial<Record<(typeof USER_OWNED_TABLES)[number], RowScope<Context>>> = {
  // Agents are the board's own machinery, configured by a person. Nothing
  // on the AI side has a reason to read them.
  agents: aiNarrowed(() => sql`false`),
  runs: aiNarrowed((context, table, userId) => inArray(table.todoId, aiTodoIds(context, userId))),
  projects: aiNarrowed((_context, table) => eq(table.aiEnabled, true)),
  lanes: aiNarrowed((context, table, userId) => inArray(table.projectId, aiProjectIds(context, userId))),
  projectLabels: aiNarrowed((context, table, userId) => inArray(table.projectId, aiProjectIds(context, userId))),
  todos: aiNarrowed((context, table, userId) =>
    and(eq(table.aiIgnored, false), inArray(table.projectId, aiProjectIds(context, userId))),
  ),
  todoNotes: aiNarrowed((context, table, userId) => inArray(table.todoId, aiTodoIds(context, userId))),
  todoEvents: aiNarrowed((context, table, userId) => inArray(table.todoId, aiTodoIds(context, userId))),
  todoLabels: aiNarrowed((context, table, userId) => inArray(table.todoId, aiTodoIds(context, userId))),
  todoDependencies: aiNarrowed((context, table, userId) =>
    and(inArray(table.todoId, aiTodoIds(context, userId)), inArray(table.dependsOnTodoId, aiTodoIds(context, userId))),
  ),
};

export const scope: NonNullable<BuildSchemaConfig['scope']> = {
  // A user row is only ever visible to its owner. There is no directory here.
  users: (context, table) => eq((table as AnyTable).id, requireAuth(context as Context)),
  ...Object.fromEntries(USER_OWNED_TABLES.map((name) => [name, AI_SCOPES[name] ?? scopeByUserId])),
};

/**
 * Columns the server owns: removed from every create and update input, stamped
 * from the request on insert. This is what makes `userId` unstatable rather than
 * merely overwritten.
 */
export const contextValues: NonNullable<BuildSchemaConfig['contextValues']> = {
  ...Object.fromEntries(
    USER_OWNED_TABLES.map((name) => [name, { userId: (context: Context) => requireAuth(context) }]),
  ),
  // Who wrote a note is a fact about the request, like whose it is. An MCP
  // client cannot sign a note as the user it acts for.
  todoNotes: {
    userId: (context: Context) => requireAuth(context),
    actorKind: (context: Context) => context.actor.kind,
    actorKeyId: (context: Context) => context.actor.keyId ?? null,
    runId: (context: Context) => context.actor.runId ?? null,
  },
};

/**
 * Tables whose writes belong to a hand-written mutation instead of generated CRUD.
 *
 * `users` is the auth flow's (resolvers/auth.ts): an account exists because a
 * sign-in created it. `todoDependencies` is `addTodoDependency`'s — a generated
 * insert would let a client write an edge without the cycle check, and a cycle
 * is a set of todos none of which can ever be completed. `todoEvents` is the
 * `todos_history` trigger's, and history nobody can edit is the point of it.
 * `runs` belong to the runner's mutations (resolvers/runs.ts): a run is
 * claimed, renewed and finished, and a person may only ask one to stop.
 */
const WRITES_RESERVED = new Set<string>(['users', 'todoDependencies', 'todoEvents', 'runs']);

/**
 * Tables that can be added to and deleted from, but not rewritten. A note an
 * agent was given, or a verdict it returned, should read later as it read then.
 */
const APPEND_ONLY = new Set<string>(['todoNotes']);

const generatedWritesAllowed = (table: string) => !WRITES_RESERVED.has(table);
const generatedUpdatesAllowed = (table: string) => generatedWritesAllowed(table) && !APPEND_ONLY.has(table);

export const features: NonNullable<BuildSchemaConfig['features']> = {
  insert: generatedWritesAllowed,
  update: generatedUpdatesAllowed,
  updateMany: generatedUpdatesAllowed,
  delete: generatedWritesAllowed,
};
