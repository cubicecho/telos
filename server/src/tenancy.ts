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
export const contextValues: NonNullable<BuildSchemaConfig['contextValues']> = Object.fromEntries(
  USER_OWNED_TABLES.map((name) => [name, { userId: (context: Context) => requireAuth(context) }]),
);

/**
 * Tables whose writes belong to a hand-written mutation instead of generated CRUD.
 *
 * `users` is the auth flow's (resolvers/auth.ts): an account exists because a
 * sign-in created it. `todoDependencies` is `addTodoDependency`'s — a generated
 * insert would let a client write an edge without the cycle check, and a cycle
 * is a set of todos none of which can ever be completed.
 */
const WRITES_RESERVED = new Set<string>(['users', 'todoDependencies']);

const generatedWritesAllowed = (table: string) => !WRITES_RESERVED.has(table);

export const features: NonNullable<BuildSchemaConfig['features']> = {
  insert: generatedWritesAllowed,
  update: generatedWritesAllowed,
  updateMany: generatedWritesAllowed,
  delete: generatedWritesAllowed,
};
