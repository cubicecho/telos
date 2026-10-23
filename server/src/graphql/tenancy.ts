import type { BuildSchemaConfig, RowScope } from '@vantreeseba/drizzle-graphql';
import type { SQL } from 'drizzle-orm';
import { requireAuth } from '../auth/resolvers.ts';
import { ALL_TABLES, type RowSubject, USER_OWNED_TABLES } from '../auth/rows.ts';
import { rowsReached } from '../auth/sql-filter.ts';
import type { Context } from '../core/context.ts';

// Multi-tenancy, expressed as drizzle-graphql configuration rather than as
// resolver wrappers. `scope` is ANDed into the SQL of every read, update and
// delete the library generates — list and single queries, aggregates, groupBy,
// relation fields, cursor pages — after the client's own `where`, so a client
// filter can only ever narrow it. `contextValues` is the write-side half: it
// takes `userId` out of every create and update input and stamps it from the
// request, so ownership is never something a caller states.
//
// A `scope` cannot reach a plain insert, and it says nothing about the rows a
// foreign key *points at* — graphql/write-guards.ts closes that half.
//
// Who reaches which rows is the caller's ability's (auth/abilities.ts, with the
// conditions in auth/rows.ts): `scope` asks it for every table. The rule for
// anyone adding a table: name it in auth/rows.ts, or nobody reaches its rows.
// __tests__/tenancy.test.ts fails when one is missing.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyTable = any;

export { ALL_TABLES, USER_OWNED_TABLES } from '../auth/rows.ts';

/**
 * The rows of a table the caller may reach, as SQL: what the caller's ability
 * says (auth/abilities.ts), folded into SQL by auth/sql-filter.ts. A person
 * reaches their own rows; AI only what AI may see of them. What the generated
 * resolvers are confined to, for the hand-written checks that must agree with
 * them. A caller with no account is answered UNAUTHENTICATED.
 *
 * @param context The request.
 * @param name The table's drizzle-graphql key.
 * @param table The table, or the alias of it the statement runs against.
 * @returns The predicate.
 */
export function reachable(context: Context, name: RowSubject, table: AnyTable): SQL {
  requireAuth(context);
  return rowsReached(context.ability, context.db, name, table);
}

// A table with no rule reaches no row, so one added later is closed until
// auth/rows.ts says who reaches it.
export const scope: NonNullable<BuildSchemaConfig['scope']> = Object.fromEntries(
  ALL_TABLES.map((name): [string, RowScope<Context>] => [name, (context, table) => reachable(context, name, table)]),
);

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
  // What a test of the server found is the runner's to say (`finishProbe`),
  // so no client states it: a new server has never been tested.
  mcpServers: {
    userId: (context: Context) => requireAuth(context),
    checkedAt: () => null,
    checkOk: () => null,
    checkError: () => null,
    tools: () => [],
  },
};

/**
 * Tables whose writes belong to a hand-written mutation instead of generated CRUD.
 *
 * `users` is the auth flow's (auth/resolvers.ts): an account exists because a
 * sign-in created it. `todoDependencies` is `addTodoDependency`'s — a generated
 * insert would let a client write an edge without the cycle check, and a cycle
 * is a set of todos none of which can ever be completed. `todoEvents` is the
 * `todos_history` trigger's, and history nobody can edit is the point of it.
 * `runs` belong to the runner's mutations (runs/resolvers.ts): a run is
 * claimed, renewed and finished, and a person may only ask one to stop.
 * `artifacts` are what a finished run reports (`finishRun`) or a client says it
 * made (`recordArtifact`), each stamped with where it came from; a person may
 * take one off the board (`deleteArtifact`), and nothing else.
 */
const WRITES_RESERVED = new Set<string>(['users', 'todoDependencies', 'todoEvents', 'runs', 'artifacts']);

/**
 * Tables generated CRUD may add to and nothing more. Rewriting a note or taking
 * one away depends on who wrote it and what kind it is, which a `where` cannot
 * say: `editTodoNote` and `deleteTodoNote` (todos/notes.ts) decide. A report
 * an agent wrote, or a verdict it returned, should read later as it read then.
 */
const INSERT_ONLY = new Set<string>(['todoNotes']);

const generatedWritesAllowed = (table: string) => !WRITES_RESERVED.has(table);
const generatedChangesAllowed = (table: string) => generatedWritesAllowed(table) && !INSERT_ONLY.has(table);

export const features: NonNullable<BuildSchemaConfig['features']> = {
  insert: generatedWritesAllowed,
  update: generatedChangesAllowed,
  updateMany: generatedChangesAllowed,
  delete: generatedChangesAllowed,
};
