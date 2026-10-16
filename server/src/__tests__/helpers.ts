import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { relations } from '@telos/db/relations';
import * as dbSchema from '@telos/db/schema';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { type ExecutionResult, graphql } from 'graphql';
import { expect } from 'vitest';
import { type Auth, createAuth } from '../auth.ts';
import { createSchema } from '../build-schema.ts';
import type { Actor, Context } from '../context.ts';
import { setInstanceAi } from '../instance.ts';
import { createLoaders } from '../loaders.ts';

// A throwaway in-memory Postgres per suite. `@telos/db` is deliberately never
// imported here — it opens a real connection at import time — so the schema is
// pulled from `@telos/db/schema`, which is inert. The committed migrations
// build it, not a push of the models, because they carry what the models
// cannot say: the trigger that writes todo history.

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/drizzle');

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver
export type TestDb = any;

export async function createTestDb(options: { instanceAi?: boolean } = {}): Promise<TestDb> {
  const db = await takeDb();
  // On unless a test says otherwise: most tests are about what happens once
  // AI is on, and the instance switch has tests of its own (instance-ai.test.ts).
  await setInstanceAi(db, options.instanceAi ?? true);
  return db;
}

// Booting PGlite and replaying the migrations cost about a second, and nearly
// every test asks for a database. So a test file keeps the ones it has built
// and hands each back out emptied. A database stays the test's until that test
// ends, so a test that asks for a second one — a "fresh" database beside its
// own — still gets a different one. Module state, so the pool is the file's
// alone: Vitest gives each file its own module graph.
const free: TestDb[] = [];
let held: TestDb[] = [];
let holder: string | undefined;

/** The test asking, as far as Vitest says: its file and its full name. */
function currentTest(): string {
  const { testPath, currentTestName } = expect.getState();
  return `${testPath}\u0000${currentTestName}`;
}

async function takeDb(): Promise<TestDb> {
  const test = currentTest();
  if (test !== holder) {
    // A new test: everything the last one held is free again.
    free.push(...held);
    held = [];
    holder = test;
  }
  let db = free.pop();
  if (db) {
    await empty(db);
  } else {
    db = drizzle({ client: new PGlite('memory://'), relations });
    await migrate(db as never, { migrationsFolder });
  }
  held.push(db);
  return db;
}

/**
 * Every row gone and every sequence restarted, as a fresh migration leaves
 * them. Drizzle's own record of the migrations stays, which is all the
 * migrations seed; `instance_settings` is written again by the caller.
 */
async function empty(db: TestDb): Promise<void> {
  const { rows } = await db.$client.query(
    `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'drizzle')`,
  );
  const names = (rows as { name: string }[]).map((row) => row.name);
  if (names.length > 0) await db.$client.exec(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`);
}

/** A user row created straight through Drizzle — signup is not what is under test. */
export async function createUser(db: TestDb, email: string): Promise<string> {
  const [user] = await db.insert(dbSchema.users).values({ email }).returning();
  return user.id as string;
}

export interface TestClient {
  /** Runs an operation as `userId`, or unauthenticated when it is null. */
  run: (query: string, variables?: Record<string, unknown>) => Promise<ExecutionResult>;
  /** Runs an operation and throws unless it succeeded, returning `data`. */
  // biome-ignore lint/suspicious/noExplicitAny: caller shapes the response
  expectOk: (query: string, variables?: Record<string, unknown>) => Promise<any>;
  /** Runs an operation, expects exactly one error, and returns it. */
  expectError: (query: string, variables?: Record<string, unknown>) => Promise<{ message: string; code: unknown }>;
}

export interface ClientOptions {
  /** Who the caller is, when it is not simply `userId` signed in with a session. */
  actor?: Actor | undefined;
  /** The instance's AI switch. Off by default, as it is in production. */
  ai?: boolean | undefined;
  /** Shared across clients of one database, so a session one opens another can see. */
  auth?: Auth | undefined;
  /** The request's headers, for calls that hand them to better-auth (`Authorization: Bearer ...`). */
  headers?: Headers | undefined;
}

// One better-auth instance per database: it holds no state of its own, but
// building one is not free and every client of a suite shares its database.
const auths = new WeakMap<object, Auth>();

export function authFor(db: TestDb): Auth {
  let auth = auths.get(db);
  if (!auth) {
    auth = createAuth(db);
    auths.set(db, auth);
  }
  return auth;
}

// One schema per database and AI flag, as the server builds one for every
// request. Building it with AI on takes over half a second, and a test makes a
// client for each person in it.
const schemas = new WeakMap<object, Map<boolean, ReturnType<typeof createSchema>>>();

/** The schema over `db`, built once per AI flag. */
export function schemaFor(db: TestDb, ai: boolean): ReturnType<typeof createSchema> {
  let byAi = schemas.get(db);
  if (!byAi) {
    byAi = new Map();
    schemas.set(db, byAi);
  }
  let built = byAi.get(ai);
  if (!built) {
    built = createSchema(db, { ai });
    byAi.set(ai, built);
  }
  return built;
}

/**
 * A client for a person signed in with a real session, which better-auth's
 * own fields (resolvers/better-auth.ts) read from the request's headers.
 */
export async function sessionClient(
  db: TestDb,
  userId: string,
  options: Omit<ClientOptions, 'headers'> = {},
): Promise<TestClient> {
  const auth = options.auth ?? authFor(db);
  const session = await (await auth.$context).internalAdapter.createSession(userId);
  return createClient(db, userId, {
    ...options,
    auth,
    headers: new Headers({ authorization: `Bearer ${session.token}` }),
  });
}

export function createClient(db: TestDb, userId: string | null, options: ClientOptions = {}): TestClient {
  const { schema } = schemaFor(db, options.ai ?? false);
  const auth = options.auth ?? authFor(db);
  const actor: Actor = options.actor ?? (userId ? { kind: 'user', userId } : { kind: 'anonymous', userId: null });

  const run = async (query: string, variables?: Record<string, unknown>) => {
    const headers = options.headers ?? new Headers();
    const contextValue: Context = { db, auth, userId: actor.userId, actor, loaders: createLoaders(db), headers };
    return graphql({ schema, source: query, contextValue, variableValues: variables });
  };

  return {
    run,
    expectOk: async (query, variables) => {
      const result = await run(query, variables);
      // graphql masks a thrown non-GraphQLError as "Internal server error";
      // surface the original so a broken test reads as the bug it is.
      if (result.errors?.length) {
        const [first] = result.errors;
        throw first.originalError ?? new Error(result.errors.map((error) => error.message).join('; '));
      }
      return result.data;
    },
    expectError: async (query, variables) => {
      const result = await run(query, variables);
      const error = result.errors?.[0];
      if (!error) throw new Error('expected an error, got a successful result');
      return { message: error.message, code: error.extensions?.code };
    },
  };
}
