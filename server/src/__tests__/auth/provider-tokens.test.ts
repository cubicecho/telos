import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import express from 'express';
import { type Client, createClient as createSseClient } from 'graphql-sse';
import { type CryptoKey, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedAuthHost } from '../../auth/auth-host.ts';
import { ACCESS_TOKEN_TYP } from '../../auth/provider-tokens.ts';
import { OIDC_PROVIDER_ID, type OidcConfig, oidcApiAudience, serverUrl } from '../../core/config.ts';
import { createApp } from '../../http/app.ts';
import { PROTECTED_RESOURCE_PATH } from '../../http/protected-resource.ts';
import { authFor, createTestDb, createUser, hostFor, schemaFor, type TestDb } from '../helpers.ts';

// Access tokens the OIDC provider issued for this API (RFC 9068), as a device
// app (Home Assistant) sends them after the device flow: against the real app
// over HTTP, with a stand-in provider serving discovery and a JWKS on a
// loopback port, and tokens signed with its key here.

const PROJECTS = `{ projects { id name } }`;
const CREATE_PROJECT = `mutation { createProject(values: { name: "From the hub" }) { id } }`;
const CREATE_TODO = `mutation ($projectId: UUID!) { createTodo(values: { title: "Water the plants", projectId: $projectId }) { id } }`;
const WATCH = `subscription ($projectId: ID!) { boardChanged(projectId: $projectId) { projectId table } }`;
const SUB = 'heautou-user-1';
const DEVICE_CLIENT = 'home-assistant';

interface FakeProvider {
  issuer: string;
  /** Signs a token as the provider would, with whatever the test changes. */
  mint(options?: MintOptions): Promise<string>;
  close(): Promise<void>;
}

interface MintOptions {
  claims?: JWTPayload;
  typ?: string;
  issuer?: string;
  audience?: string | string[];
  /** Seconds from now. */
  expiresIn?: number;
  /** A key the provider's JWKS does not have. */
  key?: CryptoKey;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startProvider(): Promise<FakeProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const app = express();
  const server = createServer(app);
  const issuer = `${await listen(server)}/oidc`;
  app.get('/oidc/.well-known/openid-configuration', (_req, res) => {
    res.json({
      issuer,
      jwks_uri: `${issuer}/jwks`,
      // HS256 is advertised and must still never be accepted.
      id_token_signing_alg_values_supported: ['RS256', 'HS256'],
    });
  });
  app.get('/oidc/jwks', (_req, res) => {
    res.json({ keys: [jwk] });
  });
  return {
    issuer,
    async mint(options = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ client_id: DEVICE_CLIENT, scope: 'openid', ...options.claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: options.typ ?? ACCESS_TOKEN_TYP })
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.audience ?? oidcApiAudience())
        .setSubject(typeof options.claims?.sub === 'string' ? options.claims.sub : SUB)
        .setIssuedAt(now)
        .setExpirationTime(now + (options.expiresIn ?? 600))
        .sign(options.key ?? privateKey);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A JWT with no signature at all. */
function unsigned(payload: JWTPayload): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: ACCESS_TOKEN_TYP })}.${part(payload)}.`;
}

let db: TestDb;
let provider: FakeProvider;
let telos: Server | null = null;
let base: string;
let userId: string;
const clients: Client[] = [];
const originalEnv = { ...process.env };

async function serve(oidc: OidcConfig | null): Promise<void> {
  const authHost = oidc ? fixedAuthHost(authFor(db), oidc) : hostFor(db);
  const { app } = createApp({ db, authHost, schema: schemaFor(db, false).schema, ai: false, version: '0' });
  telos = createServer(app);
  base = await listen(telos);
}

function providerConfig(): OidcConfig {
  return {
    issuer: provider.issuer,
    clientId: 'telos',
    clientSecret: undefined,
    clientAuth: 'client_secret_basic',
    name: 'heautou',
  };
}

async function post(query: string, token: string, variables?: Record<string, unknown>) {
  const response = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: each test reads the fields its own query asked for
  return { response, body: (await response.json()) as any };
}

async function codeFor(token: string): Promise<unknown> {
  const { body } = await post(PROJECTS, token);
  return body.errors?.[0]?.extensions?.code;
}

beforeEach(async () => {
  db = await createTestDb();
  provider = await startProvider();
  userId = await createUser(db, 'ada@example.com');
  // What a browser sign-in through the provider leaves behind (http/sso.test.ts checks it does).
  await db.insert(dbSchema.accounts).values({ userId, providerId: OIDC_PROVIDER_ID, accountId: SUB });
});

afterEach(async () => {
  process.env = { ...originalEnv };
  for (const client of clients.splice(0)) client.dispose();
  telos?.closeAllConnections();
  await new Promise<void>((resolve) => (telos ? telos.close(() => resolve()) : resolve()));
  telos = null;
  await provider.close();
});

describe('a provider access token as a bearer', () => {
  beforeEach(() => serve(providerConfig()));

  it('signs the linked person in, for reads and writes alike', async () => {
    const token = await provider.mint();
    const created = await post(CREATE_PROJECT, token);
    expect(created.body.errors).toBeUndefined();
    const projectId = created.body.data.createProject.id;
    const todo = await post(CREATE_TODO, token, { projectId });
    expect(todo.body.errors).toBeUndefined();

    const { body } = await post(PROJECTS, token);
    expect(body.data.projects).toEqual([{ id: projectId, name: 'From the hub' }]);
    const [project] = await db.select().from(dbSchema.projects).where(eq(dbSchema.projects.id, projectId));
    expect(project.userId).toBe(userId);
  });

  it('accepts a token with no scope and no client_id, as heautou issues for an API without scopes', async () => {
    expect(await codeFor(await provider.mint({ claims: { client_id: undefined, scope: undefined } }))).toBeUndefined();
  });

  it('accepts an audience among several', async () => {
    expect(await codeFor(await provider.mint({ audience: ['someone-else', oidcApiAudience()] }))).toBeUndefined();
  });

  it.each([
    ['another audience', { audience: 'https://other.example.com/graphql' }],
    ['another issuer', { issuer: 'https://evil.example.com/oidc' }],
    ['an id token typ', { typ: 'JWT' }],
    ['an expired token', { expiresIn: -120 }],
  ])('refuses %s as UNAUTHENTICATED', async (_name, options: MintOptions) => {
    expect(await codeFor(await provider.mint(options))).toBe('UNAUTHENTICATED');
  });

  it('refuses a token signed with a key the provider does not publish', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    expect(await codeFor(await provider.mint({ key: privateKey }))).toBe('UNAUTHENTICATED');
  });

  it('refuses an unsigned token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = unsigned({
      iss: provider.issuer,
      aud: oidcApiAudience(),
      sub: SUB,
      client_id: DEVICE_CLIENT,
      iat: now,
      exp: now + 600,
    });
    expect(await codeFor(token)).toBe('UNAUTHENTICATED');
  });

  it('refuses an HS256 token, whatever the provider advertises', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ client_id: DEVICE_CLIENT })
      .setProtectedHeader({ alg: 'HS256', typ: ACCESS_TOKEN_TYP })
      .setIssuer(provider.issuer)
      .setAudience(oidcApiAudience())
      .setSubject(SUB)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode('a-secret-the-attacker-chose-0123456789'));
    expect(await codeFor(token)).toBe('UNAUTHENTICATED');
  });

  it('refuses a sub no Telos account signed in with, even with a matching address', async () => {
    await createUser(db, 'grace@example.com');
    const token = await provider.mint({ claims: { sub: 'heautou-user-2', email: 'grace@example.com' } });
    expect(await codeFor(token)).toBe('UNAUTHENTICATED');
  });

  it('refuses the token of a person whose account was deleted', async () => {
    await db.delete(dbSchema.users).where(eq(dbSchema.users.id, userId));
    expect(await codeFor(await provider.mint())).toBe('UNAUTHENTICATED');
  });

  it('challenges a refused bearer with where to get a good one', async () => {
    const { response } = await post(PROJECTS, await provider.mint({ expiresIn: -120 }));
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="${serverUrl()}${PROTECTED_RESOURCE_PATH}"`,
    );
  });

  it('sends no challenge to a good token', async () => {
    const { response } = await post(PROJECTS, await provider.mint());
    expect(response.headers.get('www-authenticate')).toBeNull();
  });
});

describe('a live board on a provider access token', () => {
  beforeEach(() => serve(providerConfig()));

  function connect(token: string): Client {
    const client = createSseClient({
      url: `${base}/graphql`,
      headers: { authorization: `Bearer ${token}` },
      retryAttempts: 0,
    });
    clients.push(client);
    return client;
  }

  async function project(token: string): Promise<string> {
    return (await post(CREATE_PROJECT, token)).body.data.createProject.id;
  }

  it('delivers changes', async () => {
    const token = await provider.mint();
    const projectId = await project(token);
    const heard = new Promise<unknown>((resolve, reject) => {
      const stop = connect(token).subscribe(
        { query: WATCH, variables: { projectId } },
        {
          next: (result) => {
            stop();
            resolve(result);
          },
          error: reject,
          complete: () => {},
        },
      );
    });
    let done = false;
    void heard.then(() => {
      done = true;
    });
    for (let i = 0; !done && i < 20; i++) {
      await post(CREATE_TODO, token, { projectId });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await heard).toEqual({ data: { boardChanged: { projectId, table: 'todos' } } });
  });

  it('ends the stream with UNAUTHENTICATED when the token expires', async () => {
    const projectId = await project(await provider.mint());
    const token = await provider.mint({ expiresIn: 2 });
    const opened = Date.now();
    const results: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      connect(token).subscribe(
        { query: WATCH, variables: { projectId } },
        { next: (result) => results.push(result), error: reject, complete: resolve },
      );
    });
    expect(Date.now() - opened).toBeGreaterThan(1000);
    expect(results).toHaveLength(1);
    expect((results[0] as { errors: Array<{ extensions: { code: string } }> }).errors[0].extensions.code).toBe(
      'UNAUTHENTICATED',
    );
  });
});

describe('with no provider', () => {
  beforeEach(() => serve(null));

  it('refuses every JWT', async () => {
    expect(await codeFor(await provider.mint())).toBe('UNAUTHENTICATED');
  });

  it('sends no challenge', async () => {
    const { response } = await post(PROJECTS, await provider.mint());
    expect(response.headers.get('www-authenticate')).toBeNull();
  });
});

describe('protected-resource metadata', () => {
  it('names the provider and the audience', async () => {
    await serve(providerConfig());
    const response = await fetch(`${base}${PROTECTED_RESOURCE_PATH}`);
    expect(await response.json()).toEqual({
      resource: oidcApiAudience(),
      authorization_servers: [provider.issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'Telos',
    });
  });

  it('is served under the resource path too', async () => {
    await serve(providerConfig());
    const response = await fetch(`${base}${PROTECTED_RESOURCE_PATH}/graphql`);
    expect((await response.json()).resource).toBe(oidcApiAudience());
  });

  it('names no authorization server without a provider', async () => {
    await serve(null);
    const response = await fetch(`${base}${PROTECTED_RESOURCE_PATH}`);
    expect((await response.json()).authorization_servers).toEqual([]);
  });

  it('takes the audience from OIDC_API_AUDIENCE', async () => {
    process.env.OIDC_API_AUDIENCE = 'https://telos.example.com/api';
    await serve(providerConfig());
    const response = await fetch(`${base}${PROTECTED_RESOURCE_PATH}`);
    expect((await response.json()).resource).toBe('https://telos.example.com/api');
    // And a token for it is the one accepted.
    expect(await codeFor(await provider.mint({ audience: 'https://telos.example.com/api' }))).toBeUndefined();
  });
});
