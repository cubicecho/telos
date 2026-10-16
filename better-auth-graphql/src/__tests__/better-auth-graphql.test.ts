import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { bearer, magicLink } from 'better-auth/plugins';
import { buildSchema, type ExecutionResult, type GraphQLSchema, graphql } from 'graphql';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBetterAuthGraphQL, type BetterAuthGraphQLOptions, betterAuthGraphQL } from '../index.ts';

interface Ctx {
  headers: Headers;
}

/** The last magic token each address was sent. */
const magicTokens = new Map<string, string>();

function createAuth() {
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], apikey: [] }),
    secret: 'a-test-secret-that-is-long-enough-for-better-auth',
    baseURL: 'http://localhost:3000',
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: { theme: { type: 'string', required: false }, isAdmin: { type: 'boolean', input: false } },
    },
    plugins: [
      bearer(),
      apiKey({ defaultPrefix: 'test_' }),
      magicLink({
        sendMagicLink: async ({ email, token }) => {
          magicTokens.set(email, token);
        },
      }),
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;

let auth: Auth;

function schemaFor(options: Partial<BetterAuthGraphQLOptions<Ctx>> = {}): GraphQLSchema {
  const built = betterAuthGraphQL<Ctx>(auth, { headers: (ctx) => ctx.headers, ...options });
  return applyBetterAuthGraphQL(buildSchema('type Query { ping: Boolean }'), built);
}

function client(schema: GraphQLSchema = schemaFor()) {
  return async (source: string, variables?: Record<string, unknown>, token?: string): Promise<ExecutionResult> => {
    const headers = new Headers(token ? { authorization: `Bearer ${token}` } : {});
    return graphql({ schema, source, variableValues: variables, contextValue: { headers } satisfies Ctx });
  };
}

function data<T>(result: ExecutionResult): T {
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.data as T;
}

const SIGN_UP = `mutation ($email: String!) {
  signUpEmail(email: $email, password: "correct horse battery", name: "Ada", theme: "dark") {
    token
    user { id email name emailVerified createdAt theme isAdmin }
  }
}`;

beforeEach(() => {
  auth = createAuth();
  magicTokens.clear();
});

describe('the schema', () => {
  it('serves every client endpoint, and none of the HTTP-only or server-only ones', () => {
    const built = betterAuthGraphQL<Ctx>(auth, { headers: (ctx) => ctx.headers });
    const kinds = Object.fromEntries(built.operations.map((operation) => [operation.name, operation.kind]));

    expect(kinds).toMatchObject({
      getSession: 'query',
      listSessions: 'query',
      listApiKeys: 'query',
      signUpEmail: 'mutation',
      signInEmail: 'mutation',
      signOut: 'mutation',
      createApiKey: 'mutation',
      signInMagicLink: 'mutation',
      // GETs that spend a one-time token are writes.
      magicLinkVerify: 'mutation',
      verifyEmail: 'mutation',
    });
    for (const name of [
      'callbackOAuth',
      'requestPasswordResetCallback',
      'setPassword',
      'verifyApiKey',
      'ok',
      'error',
    ]) {
      expect(kinds).not.toHaveProperty(name);
    }
  });

  it('types the models from the auth config, user fields included, and leaves out what is never returned', () => {
    const { typeDefs } = betterAuthGraphQL<Ctx>(auth, { headers: (ctx) => ctx.headers });
    const user = typeDefs.match(/type AuthUser \{[^}]*\}/)?.[0] ?? '';
    expect(user).toContain('email: String!');
    expect(user).toContain('createdAt: DateTime!');
    expect(user).toContain('theme: String');
    expect(user).toContain('isAdmin: Boolean');
    // A GET spending a token loses the arguments that would make it redirect.
    expect(typeDefs).not.toMatch(/magicLinkVerify\([^)]*callbackURL/);
    // An account's password is `returned: false`.
    expect(typeDefs.match(/type AuthAccount \{[^}]*\}/)?.[0] ?? '').not.toContain('password');
  });

  it('takes an include list, a prefix and field names', () => {
    const built = betterAuthGraphQL<Ctx>(auth, {
      headers: (ctx) => ctx.headers,
      include: ['getSession', 'signOut'],
      typePrefix: 'Ba',
      fieldName: (operation) => `auth${operation.name.charAt(0).toUpperCase()}${operation.name.slice(1)}`,
    });
    expect(built.operations.map((operation) => operation.name)).toEqual(['getSession', 'signOut']);
    expect(Object.keys(built.resolvers.Query)).toEqual(['authGetSession']);
    expect(built.typeDefs).toContain('type BaUser');
  });

  it('refuses a field the schema already has', () => {
    const built = betterAuthGraphQL<Ctx>(auth, { headers: (ctx) => ctx.headers, include: ['getSession'] });
    expect(() => applyBetterAuthGraphQL(buildSchema('type Query { getSession: Boolean }'), built)).toThrow(
      /getSession/,
    );
  });
});

describe('the operations', () => {
  it('signs up, finds the session by its bearer token, and signs out', async () => {
    const run = client();
    const { signUpEmail } = data<{ signUpEmail: { token: string; user: Record<string, unknown> } }>(
      await run(SIGN_UP, { email: 'ada@example.com' }),
    );
    expect(signUpEmail.user).toMatchObject({
      email: 'ada@example.com',
      name: 'Ada',
      emailVerified: false,
      theme: 'dark',
    });
    expect(typeof signUpEmail.user.createdAt).toBe('string');

    const session = `{ getSession { user { email } session { token expiresAt } } }`;
    expect(data(await run(session, {}, signUpEmail.token))).toMatchObject({
      getSession: { user: { email: 'ada@example.com' }, session: { token: signUpEmail.token } },
    });
    expect(
      data<{ listSessions: unknown[] }>(await run(`{ listSessions { id } }`, {}, signUpEmail.token)).listSessions,
    ).toHaveLength(1);

    expect(data(await run(`mutation { signOut { success } }`, {}, signUpEmail.token))).toEqual({
      signOut: { success: true },
    });
    expect(data(await run(session, {}, signUpEmail.token))).toEqual({ getSession: null });
  });

  it("reports better-auth's failures with a GraphQL code and better-auth's own", async () => {
    const run = client();
    await run(SIGN_UP, { email: 'ada@example.com' });
    const result = await run(
      `mutation { signInEmail(email: "ada@example.com", password: "wrong password!") { token } }`,
    );
    expect(result.errors?.[0]?.extensions).toMatchObject({
      code: 'UNAUTHENTICATED',
      authCode: 'INVALID_EMAIL_OR_PASSWORD',
    });

    const anonymous = await run(`{ listSessions { id } }`);
    expect(anonymous.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('sends a magic link and spends it once', async () => {
    const run = client();
    expect(data(await run(`mutation { signInMagicLink(email: "bo@example.com") { status } }`))).toEqual({
      signInMagicLink: { status: true },
    });
    const token = magicTokens.get('bo@example.com');
    const verify = `mutation ($token: String!) { magicLinkVerify(token: $token) { token user { email } } }`;
    expect(data(await run(verify, { token }))).toMatchObject({
      magicLinkVerify: { user: { email: 'bo@example.com' } },
    });

    // Spent: better-auth answers with a redirect to `?error=...`.
    const again = await run(verify, { token });
    expect(again.errors?.[0]?.extensions).toMatchObject({ code: 'BAD_USER_INPUT', authCode: 'INVALID_TOKEN' });
  });

  it('updates the user, clearing a nullable field with null and skipping a null for one that is not', async () => {
    const run = client();
    const { signUpEmail } = data<{ signUpEmail: { token: string } }>(await run(SIGN_UP, { email: 'ada@example.com' }));
    await run(`mutation { updateUser(image: "https://example.com/a.png") { status } }`, {}, signUpEmail.token);
    const update = await run(
      `mutation { updateUser(name: null, image: null, theme: "light") { status } }`,
      {},
      signUpEmail.token,
    );
    expect(data(update)).toEqual({ updateUser: { status: true } });
    expect(data(await run(`{ getSession { user { name image theme } } }`, {}, signUpEmail.token))).toEqual({
      getSession: { user: { name: 'Ada', image: null, theme: 'light' } },
    });
  });

  it("mints and lists a plugin's rows (API keys)", async () => {
    const run = client();
    const { signUpEmail } = data<{ signUpEmail: { token: string } }>(await run(SIGN_UP, { email: 'ada@example.com' }));
    const created = data<{ createApiKey: { key: string; name: string } }>(
      await run(`mutation { createApiKey(name: "laptop") { key name } }`, {}, signUpEmail.token),
    );
    expect(created.createApiKey).toMatchObject({ name: 'laptop' });
    expect(created.createApiKey.key.startsWith('test_')).toBe(true);
    const listed = await run(`{ listApiKeys { apiKeys { name start } total } }`, {}, signUpEmail.token);
    expect(data(listed)).toMatchObject({ listApiKeys: { apiKeys: [{ name: 'laptop' }], total: 1 } });
  });

  it('lets one operation lose arguments, gain result fields, and be wrapped', async () => {
    const schema = schemaFor({
      operations: {
        signInMagicLink: {
          omitArgs: ['metadata', 'callbackURL'],
          result: (documented) => ({
            ...documented,
            properties: { ...documented?.properties, sentTo: { type: 'string' } },
          }),
          around: async (call, next) => {
            call.body.email = String(call.body.email).toLowerCase();
            return { ...((await next()) as object), sentTo: call.body.email };
          },
        },
        // Answered without calling better-auth at all.
        listSessions: { around: async () => [] },
      },
    });
    const run = client(schema);
    expect(data(await run(`mutation { signInMagicLink(email: "Bo@Example.com") { status sentTo } }`))).toEqual({
      signInMagicLink: { status: true, sentTo: 'bo@example.com' },
    });
    expect(magicTokens.has('bo@example.com')).toBe(true);
    expect(data(await run(`{ listSessions { id } }`))).toEqual({ listSessions: [] });

    const omitted = await run(`mutation { signInMagicLink(email: "a@b.c", metadata: {}) { status } }`);
    expect(omitted.errors?.[0]?.message).toMatch(/Unknown argument "metadata"/);
  });

  it('asks `before` first, and hands the response headers to `onResponseHeaders`', async () => {
    const seen: string[] = [];
    const run = client(
      schemaFor({
        before: ({ operation }) => {
          if (operation.name === 'signInMagicLink') throw new Error('Not today');
        },
        onResponseHeaders: (headers, { operation }) => {
          const token = headers.get('set-auth-token');
          if (token) seen.push(`${operation.name}:${token}`);
        },
      }),
    );
    const { signUpEmail } = data<{ signUpEmail: { token: string } }>(await run(SIGN_UP, { email: 'ada@example.com' }));
    // The bearer plugin hands out the token signed: `<token>.<signature>`.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.startsWith(`signUpEmail:${signUpEmail.token}.`)).toBe(true);

    const refused = await run(`mutation { signInMagicLink(email: "bo@example.com") { status } }`);
    expect(refused.errors?.[0]?.message).toBe('Not today');
    expect(magicTokens.size).toBe(0);
  });
});
