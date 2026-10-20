import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveActor } from '../../auth/actor.ts';
import { fixedAuthHost } from '../../auth/auth-host.ts';
import { type Auth, createAuth } from '../../auth/better-auth.ts';
import { OIDC_PROVIDER_ID, type OidcConfig } from '../../core/config.ts';
import { mountSso, SSO_START_PATH } from '../../http/sso.ts';
import { createClient, createTestDb, createUser, type TestDb } from '../helpers.ts';

// The whole OIDC sign-in, against a stand-in provider that does what heautou
// (oidc-provider) does: discovery, a JWKS, a code flow with a client secret
// in a Basic header, PKCE, and a signed id token carrying the nonce.

const VERIFY = `mutation ($token: String!) { verifyOneTimeToken(token: $token) { token userId } }`;
const CONFIG = `{ authConfig { sso { name signInPath deviceClientId } } }`;
const CLIENT_ID = 'telos';
const CLIENT_SECRET = 'telos-secret';

interface Profile {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

interface FakeProvider {
  issuer: string;
  /** Who the next sign-in is. */
  profile: Profile;
  /** Plays the browser at the authorize endpoint: the code and state it would be sent back with. */
  authorize(url: string): { code: string; state: string };
  close(): Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startProvider(): Promise<FakeProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; profile: Profile }>();
  const app = express();
  const server = createServer(app);
  const issuer = `${await listen(server)}/oidc`;
  const provider: FakeProvider = {
    issuer,
    profile: { sub: 'u1', email: 'ada@example.com', name: 'Ada' },
    authorize(url) {
      const params = new URL(url).searchParams;
      expect(params.get('client_id')).toBe(CLIENT_ID);
      expect(params.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['openid', 'email', 'profile']));
      expect(params.get('code_challenge_method')).toBe('S256');
      const code = randomUUID();
      codes.set(code, {
        nonce: params.get('nonce') ?? '',
        challenge: params.get('code_challenge') ?? '',
        redirectUri: params.get('redirect_uri') ?? '',
        profile: provider.profile,
      });
      return { code, state: params.get('state') ?? '' };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  app.get('/oidc/.well-known/openid-configuration', (_req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/me`,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    });
  });
  app.get('/oidc/jwks', (_req, res) => {
    res.json({ keys: [jwk] });
  });
  app.post('/oidc/token', express.urlencoded({ extended: false }), async (req, res) => {
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    if (req.headers.authorization !== `Basic ${basic}`) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }
    const grant = codes.get(req.body.code);
    codes.delete(req.body.code);
    const challenge = createHash('sha256').update(String(req.body.code_verifier)).digest('base64url');
    if (!grant || grant.challenge !== challenge || grant.redirectUri !== req.body.redirect_uri) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    const { profile } = grant;
    const idToken = await new SignJWT({
      ...profile,
      email_verified: profile.email ? true : undefined,
      nonce: grant.nonce,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(CLIENT_ID)
      .setSubject(profile.sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    res.json({ access_token: `at-${profile.sub}`, token_type: 'Bearer', expires_in: 300, id_token: idToken });
  });
  app.get('/oidc/me', (req, res) => {
    const sub = String(req.headers.authorization).replace('Bearer at-', '');
    const profile = sub === provider.profile.sub ? provider.profile : null;
    res.json(profile ? { ...profile, email_verified: Boolean(profile.email) } : {});
  });
  return provider;
}

let db: TestDb;
let provider: FakeProvider;
let auth: Auth;
let telos: Server;
let appUrl: string;
const originalEnv = { ...process.env };

beforeEach(async () => {
  db = await createTestDb();
  provider = await startProvider();
  const app = express();
  telos = createServer(app);
  appUrl = await listen(telos);
  // One server is both the app and the API here, as in production: better-auth
  // builds its callback URL from SERVER_URL, and http/sso.ts the app's from APP_URL.
  process.env.APP_URL = appUrl;
  process.env.SERVER_URL = appUrl;
  const oidc: OidcConfig = {
    issuer: provider.issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    clientAuth: 'client_secret_basic',
    name: 'heautou',
  };
  auth = createAuth(db, { oidc });
  mountSso(app, fixedAuthHost(auth, oidc));
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await new Promise<void>((resolve) => telos.close(() => resolve()));
  await provider.close();
});

/** The cookies a response set, as a request's Cookie header. */
function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

/** Walks the browser through a sign-in: the start route, the provider, the callback. */
async function signIn(tamper?: (callback: URL) => void): Promise<{ location: URL; callback: Response }> {
  const start = await fetch(`${appUrl}${SSO_START_PATH}`, { redirect: 'manual' });
  expect(start.status).toBe(302);
  const authorizeUrl = start.headers.get('location') ?? '';
  expect(authorizeUrl.startsWith(`${provider.issuer}/auth?`)).toBe(true);
  expect(new URL(authorizeUrl).searchParams.get('redirect_uri')).toBe(`${appUrl}/api/auth/callback/oidc`);

  const { code, state } = provider.authorize(authorizeUrl);
  const back = new URL(`${appUrl}/api/auth/callback/oidc`);
  back.searchParams.set('code', code);
  back.searchParams.set('state', state);
  back.searchParams.set('iss', provider.issuer);
  tamper?.(back);
  const callback = await fetch(back, { redirect: 'manual', headers: { cookie: cookiesFrom(start) } });
  expect(callback.status).toBe(302);
  return { location: new URL(callback.headers.get('location') ?? ''), callback };
}

async function verify(token: string) {
  return createClient(db, null, { auth }).run(VERIFY, { token });
}

async function whoIs(token: string): Promise<string | null> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  return (await resolveActor(auth, db, headers, { ai: false })).userId;
}

describe('OIDC sign-in', () => {
  it('lands on /auth/sso with a one-time token the app swaps for a session', async () => {
    const { location, callback } = await signIn();
    expect(location.origin + location.pathname).toBe(`${appUrl}/auth/sso`);
    // The session goes to the app as a bearer token, never as a cookie.
    expect(callback.headers.getSetCookie().some((cookie) => cookie.includes('session_token'))).toBe(false);

    const token = location.searchParams.get('token') ?? '';
    const result = await verify(token);
    expect(result.errors).toBeUndefined();
    const session = (result.data as { verifyOneTimeToken: { token: string; userId: string } }).verifyOneTimeToken;
    expect(await whoIs(session.token)).toBe(session.userId);
    // The provider's `sub` is what an access token from it is mapped back
    // through (auth/provider-tokens.ts `userForSubject`).
    const [account] = await db.select().from(dbSchema.accounts).where(eq(dbSchema.accounts.userId, session.userId));
    expect(account).toMatchObject({ providerId: OIDC_PROVIDER_ID, accountId: provider.profile.sub });

    // Spent.
    expect((await verify(token)).errors).toBeDefined();
  });

  it('signs an existing account in by the address the provider vouches for', async () => {
    const existing = await createUser(db, 'ada@example.com');
    const { location } = await signIn();
    const result = await verify(location.searchParams.get('token') ?? '');
    expect((result.data as { verifyOneTimeToken: { userId: string } }).verifyOneTimeToken.userId).toBe(existing);
  });

  it('names a new account from the username when there is no name', async () => {
    provider.profile = { sub: 'u2', email: 'bob@example.com', preferred_username: 'bob' };
    const { location } = await signIn();
    const result = await verify(location.searchParams.get('token') ?? '');
    const { userId } = (result.data as { verifyOneTimeToken: { userId: string } }).verifyOneTimeToken;
    const ctx = await auth.$context;
    expect((await ctx.internalAdapter.findUserById(userId))?.name).toBe('bob');
  });

  it('sends a user with no address back to the login page', async () => {
    provider.profile = { sub: 'u3', name: 'No Mail' };
    const { location } = await signIn();
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBeTruthy();
  });

  it('refuses a callback whose state does not match', async () => {
    const { location } = await signIn((back) => back.searchParams.set('state', 'forged'));
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBeTruthy();
    expect(location.searchParams.get('token')).toBeNull();
  });
});

describe('authConfig.sso', () => {
  it('is null without a provider', async () => {
    delete process.env.OIDC_ISSUER;
    const data = await createClient(db, null, { auth }).expectOk(CONFIG);
    expect(data.authConfig.sso).toBeNull();
  });

  it('names the provider and where to start', async () => {
    process.env.OIDC_ISSUER = provider.issuer;
    process.env.OIDC_CLIENT_ID = CLIENT_ID;
    process.env.OIDC_NAME = 'heautou';
    const data = await createClient(db, null, { auth }).expectOk(CONFIG);
    expect(data.authConfig.sso).toEqual({ name: 'heautou', signInPath: SSO_START_PATH, deviceClientId: null });
  });

  it('names the client device apps use, when one is set', async () => {
    process.env.OIDC_ISSUER = provider.issuer;
    process.env.OIDC_CLIENT_ID = CLIENT_ID;
    process.env.OIDC_DEVICE_CLIENT_ID = 'telos-devices';
    const data = await createClient(db, null, { auth }).expectOk(CONFIG);
    expect(data.authConfig.sso.deviceClientId).toBe('telos-devices');
  });
});
