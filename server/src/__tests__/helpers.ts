import { PGlite } from '@electric-sql/pglite';
import { relations } from '@telos/db/relations';
import * as dbSchema from '@telos/db/schema';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { drizzle } from 'drizzle-orm/pglite';
import { type ExecutionResult, graphql } from 'graphql';
import { type Auth, createAuth } from '../auth.ts';
import { createSchema } from '../build-schema.ts';
import type { Actor, Context } from '../context.ts';
import { createLoaders } from '../loaders.ts';

// A throwaway in-memory Postgres per suite. `@telos/db` is deliberately never
// imported here — it opens a real connection at import time — so the schema is
// pulled from `@telos/db/schema`, which is inert.

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver
export type TestDb = any;

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite('memory://');
  const db = drizzle({ client, relations });
  const { apply } = await pushSchema(dbSchema as never, db as never);
  await apply();
  return db;
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

export function createClient(db: TestDb, userId: string | null, options: ClientOptions = {}): TestClient {
  const { schema } = createSchema(db, { ai: options.ai ?? false });
  const auth = options.auth ?? authFor(db);
  const actor: Actor = options.actor ?? (userId ? { kind: 'user', userId } : { kind: 'anonymous', userId: null });

  const run = async (query: string, variables?: Record<string, unknown>) => {
    const contextValue: Context = { db, auth, userId: actor.userId, actor, loaders: createLoaders(db) };
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
