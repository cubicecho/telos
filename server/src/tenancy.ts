import type { BuildSchemaConfig, RowScope } from '@vantreeseba/drizzle-graphql';
import { eq } from 'drizzle-orm';
import type { Context } from './context.ts';
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
] as const;

/** Every table drizzle-graphql will generate fields for. */
export const ALL_TABLES = ['users', ...USER_OWNED_TABLES] as const;

const scopeByUserId: RowScope<Context> = (context, table) => eq((table as AnyTable).userId, requireAuth(context));

export const scope: NonNullable<BuildSchemaConfig['scope']> = {
  // A user row is only ever visible to its owner. There is no directory here.
  users: (context, table) => eq((table as AnyTable).id, requireAuth(context as Context)),
  ...Object.fromEntries(USER_OWNED_TABLES.map((name) => [name, scopeByUserId])),
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
 */
const WRITES_RESERVED = new Set<string>(['users', 'todoDependencies', 'todoEvents']);

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
