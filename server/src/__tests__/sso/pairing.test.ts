import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AuthHost, createAuthHost } from '../../auth/auth-host.ts';
import { mountSso, SSO_START_PATH } from '../../http/sso.ts';
import { DEVICE_CODE_GRANT, forgetDeviceClientCheck } from '../../sso/device-client.ts';
import { parseSetupUrl } from '../../sso/pairing.ts';
import { readPairedOidc } from '../../sso/settings.ts';
import { createClient, createTestDb, createUser, type TestDb } from '../helpers.ts';

// Pairing with a provider by pasting a setup URL, against a stand-in for
// heautou's Dynamic Client Registration: discovery naming a registration
// endpoint, registration on an initial access token (RFC 7591), and deleting
// the client on its registration access token (RFC 7592).

const SETUP = `query { ssoSetup { source issuer name canPair redirectUri } }`;
const PAIR = `mutation ($url: String!) { pairSso(setupUrl: $url) { source name canPair } }`;
const UNPAIR = `mutation { unpairSso { source name } }`;
const CONFIG = `{ authConfig { sso { name signInPath } } }`;

const TOKEN = 'iat-good';
const CLIENT_ID = 'telos-client';
const CLIENT_SECRET = 'telos-secret';
const RAT = 'rat-1';
const DEVICE_ID = 'telos-devices';
const DEVICE_RAT = 'rat-device';
const DEVICE_CONFIG = `{ authConfig { sso { deviceClientId } } }`;

interface FakeDcr {
  issuer: string;
  /** What discovery says the issuer is. Set to something else to forge it. */
  claimedIssuer: string;
  /** Whether discovery names a registration endpoint. */
  canRegister: boolean;
  /** What the next registration answers, when the token is good. */
  answer: 'created' | 'badRedirect' | 'rateLimited';
  /** Bodies and auth headers registration was called with. */
  registrations: { body: Record<string, unknown>; authorization: string | undefined }[];
  /** Auth headers the client was deleted with. */
  deletions: (string | undefined)[];
  /** What deleting answers. */
  deleteStatus: number;
  /** Whether discovery offers the device flow. */
  hasDeviceFlow: boolean;
  /** Whether a second registration with the same token is allowed, as heautou allows one device client. */
  allowsDeviceClient: boolean;
  /** Whether the provider's admin has turned the device client's device flow on. */
  deviceFlowOn: boolean;
  /** Whether the device client still exists. */
  deviceClientExists: boolean;
  /** How many times the device client's registration was read. */
  deviceReads: number;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startDcr(): Promise<FakeDcr> {
  const app = express();
  const server = createServer(app);
  const issuer = `${await listen(server)}/oidc`;
  const fake: FakeDcr = {
    issuer,
    claimedIssuer: issuer,
    canRegister: true,
    answer: 'created',
    registrations: [],
    deletions: [],
    deleteStatus: 204,
    hasDeviceFlow: false,
    allowsDeviceClient: true,
    deviceFlowOn: false,
    deviceClientExists: false,
    deviceReads: 0,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  app.get('/oidc/.well-known/openid-configuration', (_req, res) => {
    res.json({
      issuer: fake.claimedIssuer,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      ...(fake.canRegister ? { registration_endpoint: `${issuer}/reg` } : {}),
      ...(fake.hasDeviceFlow ? { device_authorization_endpoint: `${issuer}/device/auth` } : {}),
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    });
  });
  app.post('/oidc/reg', express.json(), (req, res) => {
    fake.registrations.push({ body: req.body, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.status(401).json({ error: 'invalid_token', error_description: 'invalid token provided' });
      return;
    }
    if (fake.answer === 'rateLimited') {
      res.status(429).json({ error: 'too_many_requests' });
      return;
    }
    if (fake.answer === 'badRedirect') {
      res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must use https' });
      return;
    }
    if (req.body.token_endpoint_auth_method === 'none') {
      if (!fake.allowsDeviceClient) {
        res.status(401).json({ error: 'invalid_token', error_description: 'the setup URL has been used' });
        return;
      }
      fake.deviceClientExists = true;
      // Held back until the admin turns it on, so the answer lists no grant types.
      res.status(201).json({
        ...req.body,
        grant_types: [],
        client_id: DEVICE_ID,
        registration_access_token: DEVICE_RAT,
        registration_client_uri: `${issuer}/reg/${DEVICE_ID}`,
      });
      return;
    }
    res.status(201).json({
      ...req.body,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      registration_access_token: RAT,
      registration_client_uri: `${issuer}/reg/${CLIENT_ID}`,
    });
  });
  app.delete(`/oidc/reg/${CLIENT_ID}`, (req, res) => {
    fake.deletions.push(req.headers.authorization);
    res.status(fake.deleteStatus).end();
  });
  app.get(`/oidc/reg/${DEVICE_ID}`, (req, res) => {
    fake.deviceReads += 1;
    if (req.headers.authorization !== `Bearer ${DEVICE_RAT}` || !fake.deviceClientExists) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    res.json({ client_id: DEVICE_ID, grant_types: fake.deviceFlowOn ? [DEVICE_CODE_GRANT, 'refresh_token'] : [] });
  });
  app.delete(`/oidc/reg/${DEVICE_ID}`, (req, res) => {
    fake.deletions.push(req.headers.authorization);
    fake.deviceClientExists = false;
    res.status(204).end();
  });
  return fake;
}

let db: TestDb;
let dcr: FakeDcr;
let host: AuthHost;
let telos: Server;
let appUrl: string;
const originalEnv = { ...process.env };

beforeEach(async () => {
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_DEVICE_CLIENT_ID;
  forgetDeviceClientCheck();
  db = await createTestDb();
  dcr = await startDcr();
  const app = express();
  telos = createServer(app);
  appUrl = await listen(telos);
  process.env.APP_URL = appUrl;
  // The redirect URI pairing registers is on SERVER_URL.
  process.env.SERVER_URL = appUrl;
  host = await createAuthHost(db);
  mountSso(app, host);
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await new Promise<void>((resolve) => {
    telos.closeAllConnections();
    telos.close(() => resolve());
  });
  await dcr.close();
});

/** A client on the real host, so pairing rebuilds what sign-in uses. */
function client(userId: string | null = null) {
  return createClient(db, userId, { authHost: host });
}

function setupUrl(token = TOKEN, name = 'heautou'): string {
  return `${dcr.issuer}#setup=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`;
}

async function pairError(url: string, userId: string | null = null) {
  const result = await client(userId).run(PAIR, { url });
  expect(result.errors).toHaveLength(1);
  const [error] = result.errors ?? [];
  return { message: error?.message, ...error?.extensions };
}

async function makeAdmin(email: string): Promise<string> {
  const id = await createUser(db, email);
  await db.update(dbSchema.users).set({ isAdmin: true }).where(eq(dbSchema.users.id, id));
  return id;
}

describe('setup URLs', () => {
  it('takes the issuer, token and name apart', () => {
    expect(parseSetupUrl('https://id.example.com/oidc#setup=abc&name=heautou')).toEqual({
      issuer: 'https://id.example.com/oidc',
      token: 'abc',
      name: 'heautou',
    });
  });

  it('calls a provider with no name SSO', () => {
    expect(parseSetupUrl('https://id.example.com/oidc/#setup=abc').name).toBe('SSO');
  });

  it('refuses anything that is not a setup URL', () => {
    expect(() => parseSetupUrl('not a url')).toThrow(/not a URL/);
    expect(() => parseSetupUrl('https://id.example.com/oidc')).toThrow(/no setup token/);
    expect(() => parseSetupUrl('ftp://id.example.com/oidc#setup=abc')).toThrow(/https/);
  });
});

describe('pairSso', () => {
  it('registers Telos and puts the button on the login page without a restart', async () => {
    expect((await client().expectOk(CONFIG)).authConfig.sso).toBeNull();
    expect((await client().expectOk(SETUP)).ssoSetup).toMatchObject({ source: 'NONE', canPair: true });

    const data = await client().expectOk(PAIR, { url: setupUrl() });
    expect(data.pairSso).toEqual({ source: 'PAIRED', name: 'heautou', canPair: true });

    expect(dcr.registrations).toHaveLength(1);
    const [registration] = dcr.registrations;
    expect(registration?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(registration?.body).toEqual({
      client_name: 'Telos',
      client_uri: appUrl,
      redirect_uris: [`${appUrl}/api/auth/callback/oidc`],
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });

    expect(await readPairedOidc(db)).toMatchObject({
      issuer: dcr.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      name: 'heautou',
      registrationAccessToken: RAT,
      registrationClientUri: `${dcr.issuer}/reg/${CLIENT_ID}`,
      deviceClientId: null,
    });
    expect((await client().expectOk(CONFIG)).authConfig.sso).toEqual({ name: 'heautou', signInPath: SSO_START_PATH });

    // The running server's sign-in now goes to the provider, as the new client.
    const start = await fetch(`${appUrl}${SSO_START_PATH}`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get('location') ?? '');
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${dcr.issuer}/auth`);
    expect(authorize.searchParams.get('client_id')).toBe(CLIENT_ID);
  });

  it('says a used or expired setup URL is spent, and keeps nothing', async () => {
    const error = await pairError(setupUrl('iat-used'));
    expect(error).toMatchObject({ code: 'BAD_USER_INPUT', reason: 'EXPIRED' });
    expect(error.message).toMatch(/new one/);
    expect(await readPairedOidc(db)).toBeNull();
    expect(host.oidc()).toBeNull();
  });

  it('passes on why the provider refused the registration', async () => {
    dcr.answer = 'badRedirect';
    const error = await pairError(setupUrl());
    expect(error).toMatchObject({ code: 'BAD_USER_INPUT', reason: 'REFUSED' });
    expect(error.message).toMatch(/redirect_uris must use https/);
    expect(await readPairedOidc(db)).toBeNull();
  });

  it('says when the provider is rate limiting', async () => {
    dcr.answer = 'rateLimited';
    expect(await pairError(setupUrl())).toMatchObject({ code: 'TOO_MANY_REQUESTS', reason: 'RATE_LIMITED' });
  });

  it('refuses a discovery document that names another issuer, before sending the token', async () => {
    dcr.claimedIssuer = 'https://evil.example.com/oidc';
    expect(await pairError(setupUrl())).toMatchObject({ code: 'BAD_USER_INPUT', reason: 'NOT_A_PROVIDER' });
    expect(dcr.registrations).toHaveLength(0);
  });

  it('says when nothing answers at the URL', async () => {
    const error = await pairError('http://127.0.0.1:1/oidc#setup=abc');
    expect(error).toMatchObject({ reason: 'NOT_A_PROVIDER' });
  });

  it('says when the provider cannot pair', async () => {
    dcr.canRegister = false;
    expect(await pairError(setupUrl())).toMatchObject({ reason: 'NO_REGISTRATION' });
  });

  it('will not pair over an existing pairing', async () => {
    await client().expectOk(PAIR, { url: setupUrl() });
    expect(await pairError(setupUrl())).toMatchObject({ code: 'CONFLICT' });
  });
});

describe('the device client', () => {
  it('is registered with the same token when the provider offers the device flow', async () => {
    dcr.hasDeviceFlow = true;
    await client().expectOk(PAIR, { url: setupUrl() });
    expect(dcr.registrations).toHaveLength(2);
    expect(dcr.registrations[1]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(dcr.registrations[1]?.body).toEqual({
      client_name: 'Telos devices',
      client_uri: appUrl,
      redirect_uris: [],
      token_endpoint_auth_method: 'none',
      grant_types: [DEVICE_CODE_GRANT, 'refresh_token'],
      response_types: [],
    });
    expect(await readPairedOidc(db)).toMatchObject({
      deviceClientId: DEVICE_ID,
      deviceRegistrationAccessToken: DEVICE_RAT,
      deviceRegistrationClientUri: `${dcr.issuer}/reg/${DEVICE_ID}`,
    });
  });

  it('is told to device apps only once the provider has turned its device flow on', async () => {
    dcr.hasDeviceFlow = true;
    await client().expectOk(PAIR, { url: setupUrl() });
    expect((await client().expectOk(DEVICE_CONFIG)).authConfig.sso.deviceClientId).toBeNull();

    dcr.deviceFlowOn = true;
    // The answer is remembered for a while, so reading again does not ask.
    expect((await client().expectOk(DEVICE_CONFIG)).authConfig.sso.deviceClientId).toBeNull();
    expect(dcr.deviceReads).toBe(1);
    forgetDeviceClientCheck();
    expect((await client().expectOk(DEVICE_CONFIG)).authConfig.sso.deviceClientId).toBe(DEVICE_ID);

    // The provider's admin turned it off, which removed it.
    dcr.deviceClientExists = false;
    forgetDeviceClientCheck();
    expect((await client().expectOk(DEVICE_CONFIG)).authConfig.sso.deviceClientId).toBeNull();
  });

  it('gives way to OIDC_DEVICE_CLIENT_ID', async () => {
    dcr.hasDeviceFlow = true;
    dcr.deviceFlowOn = true;
    await client().expectOk(PAIR, { url: setupUrl() });
    process.env.OIDC_DEVICE_CLIENT_ID = 'home-assistant';
    expect((await client().expectOk(DEVICE_CONFIG)).authConfig.sso.deviceClientId).toBe('home-assistant');
  });

  it('is not asked for when the provider has no device flow', async () => {
    await client().expectOk(PAIR, { url: setupUrl() });
    expect(dcr.registrations).toHaveLength(1);
    expect((await client().expectOk(DEVICE_CONFIG)).authConfig.sso.deviceClientId).toBeNull();
  });

  it('does not stop pairing when the provider allows the token once', async () => {
    dcr.hasDeviceFlow = true;
    dcr.allowsDeviceClient = false;
    const data = await client().expectOk(PAIR, { url: setupUrl() });
    expect(data.pairSso.source).toBe('PAIRED');
    expect(await readPairedOidc(db)).toMatchObject({ clientId: CLIENT_ID, deviceClientId: null });
  });

  it('is deleted at the provider on unpairing', async () => {
    dcr.hasDeviceFlow = true;
    await client().expectOk(PAIR, { url: setupUrl() });
    await client().expectOk(UNPAIR);
    expect(dcr.deletions).toEqual([`Bearer ${RAT}`, `Bearer ${DEVICE_RAT}`]);
    expect(dcr.deviceClientExists).toBe(false);
  });
});

describe('who may pair', () => {
  it('is anyone while there are no accounts', async () => {
    expect((await client().expectOk(SETUP)).ssoSetup.canPair).toBe(true);
  });

  it('is only an admin once anyone has an account', async () => {
    const admin = await makeAdmin('admin@example.com');
    const member = await createUser(db, 'member@example.com');

    const anonymous = (await client().expectOk(SETUP)).ssoSetup;
    expect(anonymous).toMatchObject({ canPair: false, issuer: null });
    expect((await client(member).expectOk(SETUP)).ssoSetup.canPair).toBe(false);
    expect((await client(admin).expectOk(SETUP)).ssoSetup.canPair).toBe(true);

    expect(await pairError(setupUrl())).toMatchObject({ code: 'FORBIDDEN' });
    expect(await pairError(setupUrl(), member)).toMatchObject({ code: 'FORBIDDEN' });
    expect(dcr.registrations).toHaveLength(0);

    await client(admin).expectOk(PAIR, { url: setupUrl() });
    expect((await client(admin).expectOk(SETUP)).ssoSetup).toMatchObject({ source: 'PAIRED', issuer: dcr.issuer });
  });

  it('is nobody when the environment names the provider, which wins', async () => {
    process.env.OIDC_ISSUER = 'https://env.example.com/oidc';
    process.env.OIDC_CLIENT_ID = 'env-client';
    process.env.OIDC_NAME = 'Corp SSO';
    const admin = await makeAdmin('admin@example.com');

    expect((await client(admin).expectOk(SETUP)).ssoSetup).toMatchObject({
      source: 'ENV',
      name: 'Corp SSO',
      canPair: false,
    });
    expect((await client(admin).expectOk(CONFIG)).authConfig.sso.name).toBe('Corp SSO');
    expect(await pairError(setupUrl(), admin)).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('unpairSso', () => {
  it('deletes the client at the provider and takes the button away', async () => {
    const admin = await makeAdmin('admin@example.com');
    await client(admin).expectOk(PAIR, { url: setupUrl() });
    expect(host.oidc()).not.toBeNull();

    const data = await client(admin).expectOk(UNPAIR);
    expect(data.unpairSso).toEqual({ source: 'NONE', name: null });
    expect(dcr.deletions).toEqual([`Bearer ${RAT}`]);
    expect(await readPairedOidc(db)).toBeNull();
    expect(host.oidc()).toBeNull();
    expect((await client(admin).expectOk(CONFIG)).authConfig.sso).toBeNull();

    // With nothing paired, the sign-in route sends the browser back to log in.
    const start = await fetch(`${appUrl}${SSO_START_PATH}`, { redirect: 'manual' });
    expect(new URL(start.headers.get('location') ?? '').searchParams.get('error')).toBe('sso_off');
  });

  it('counts a client the provider already removed as gone', async () => {
    const admin = await makeAdmin('admin@example.com');
    await client(admin).expectOk(PAIR, { url: setupUrl() });
    dcr.deleteStatus = 401;
    await client(admin).expectOk(UNPAIR);
    expect(await readPairedOidc(db)).toBeNull();
  });

  it('is an admin’s once anyone has an account', async () => {
    await client().expectOk(PAIR, { url: setupUrl() });
    const member = await createUser(db, 'member@example.com');
    const result = await client(member).run(UNPAIR);
    expect(result.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(await readPairedOidc(db)).not.toBeNull();
  });
});
