import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveActor } from '../../auth/actor.ts';
import { createAuth } from '../../auth/better-auth.ts';
import { createRateLimiter } from '../../auth/rate-limit.ts';
import {
  authFor,
  createClient,
  createTestDb,
  createUser,
  linksFor,
  TEST_SECRET,
  type TestClient,
  type TestDb,
} from '../helpers.ts';

const REQUEST = `mutation ($email: String!) { signInMagicLink(email: $email) { status token userId } }`;
const VERIFY = `mutation ($token: String!) { magicLinkVerify(token: $token) { token user { id } } }`;
const ONE_TIME = `mutation ($token: String!) { verifyOneTimeToken(token: $token) { token userId } }`;
const SIGN_OUT = `mutation { signOut { success } }`;

let db: TestDb;
let anonymous: TestClient;

const originalEnv = { ...process.env };

beforeEach(async () => {
  db = await createTestDb();
  anonymous = createClient(db, null);
  delete process.env.SECURE_LOCAL_NET;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/** Requests a link and takes the token out of the one that was sent, as the app's verify screen does. */
async function magicToken(email: string): Promise<string> {
  await anonymous.expectOk(REQUEST, { email });
  const link = linksFor(db).at(-1);
  if (!link) throw new Error('no link was sent');
  return link.token;
}

/** Who a session token signs in as, through the same path a request takes. */
async function whoIs(token: string): Promise<string | null> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  return (await resolveActor(authFor(db), db, headers, { ai: false })).userId;
}

describe('signInMagicLink', () => {
  it('sends a link to the verify screen and returns no session', async () => {
    const data = await anonymous.expectOk(REQUEST, { email: 'link@example.com' });
    expect(data.signInMagicLink).toEqual({ status: true, token: null, userId: null });
    const link = linksFor(db).at(-1);
    expect(link?.email).toBe('link@example.com');
    expect(link?.url).toContain('/auth/verify?token=');
  });

  it('normalizes the address before sending', async () => {
    await anonymous.expectOk(REQUEST, { email: '  Mixed@Example.COM ' });
    expect(linksFor(db).at(-1)?.email).toBe('mixed@example.com');
  });

  it('refuses something that is not an address', async () => {
    const error = await anonymous.expectError(REQUEST, { email: 'not-an-address' });
    expect(error.code).toBe('BAD_USER_INPUT');
  });

  it('refuses when the instance has no way to send links', async () => {
    // No SMTP_URL and no capturing fake: the instance was built without the magic-link plugin.
    const noMail = createClient(db, null, { auth: createAuth(db, { secret: TEST_SECRET, oidc: null }) });
    const error = await noMail.expectError(REQUEST, { email: 'nomail@example.com' });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('SMTP_URL');
  });

  it('signs straight in under SECURE_LOCAL_NET, sending nothing', async () => {
    process.env.SECURE_LOCAL_NET = 'true';
    // The links are kept per database, and databases are reused between tests.
    const sentBefore = linksFor(db).length;
    const data = await anonymous.expectOk(REQUEST, { email: 'local@example.com' });
    expect(linksFor(db)).toHaveLength(sentBefore);
    expect(data.signInMagicLink.userId).toBeTruthy();
    expect(await whoIs(data.signInMagicLink.token)).toBe(data.signInMagicLink.userId);
  });

  it("names a SECURE_LOCAL_NET account after its address's local part", async () => {
    process.env.SECURE_LOCAL_NET = 'true';
    const data = await anonymous.expectOk(REQUEST, { email: 'ada@example.com' });
    const [user] = await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, data.signInMagicLink.userId));
    expect(user.name).toBe('ada');
    expect(user.emailVerified).toBe(false);
  });
});

describe('sign-in throttle', () => {
  it('refuses the attempt past the budget, with when to try again', async () => {
    const limiter = createRateLimiter({ maxAttempts: 2 });
    const client = createClient(db, null, { limiter });
    await client.expectOk(REQUEST, { email: 'budget@example.com' });
    await client.expectOk(REQUEST, { email: 'budget@example.com' });
    const result = await client.run(REQUEST, { email: 'budget@example.com' });
    expect(result.errors?.[0]?.extensions).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(result.errors?.[0]?.extensions?.retryAfter).toBeGreaterThan(0);
  });

  it('counts one address across client addresses, whatever its casing', async () => {
    const limiter = createRateLimiter({ maxAttempts: 2 });
    const from = (ip: string) => createClient(db, null, { limiter, ip });
    await from('198.51.100.1').expectOk(REQUEST, { email: 'alice@example.com' });
    await from('198.51.100.2').expectOk(REQUEST, { email: ' Alice@Example.com' });
    const { code } = await from('198.51.100.3').expectError(REQUEST, { email: 'ALICE@example.com' });
    expect(code).toBe('TOO_MANY_REQUESTS');
  });

  it('counts one client address across many addresses', async () => {
    const limiter = createRateLimiter({ maxAttempts: 2 });
    const client = createClient(db, null, { limiter, ip: '198.51.100.9' });
    await client.expectOk(REQUEST, { email: 'one@example.com' });
    await client.expectOk(REQUEST, { email: 'two@example.com' });
    const { code } = await client.expectError(REQUEST, { email: 'three@example.com' });
    expect(code).toBe('TOO_MANY_REQUESTS');
  });

  it('throttles spending a link by client address', async () => {
    const limiter = createRateLimiter({ maxAttempts: 1 });
    const client = createClient(db, null, { limiter });
    await client.expectError(VERIFY, { token: 'not-a-token' });
    const { code } = await client.expectError(VERIFY, { token: 'not-a-token' });
    expect(code).toBe('TOO_MANY_REQUESTS');
  });
});

describe('magicLinkVerify', () => {
  it('opens a session the next request is signed in with', async () => {
    const data = await anonymous.expectOk(VERIFY, { token: await magicToken('open@example.com') });
    expect(await whoIs(data.magicLinkVerify.token)).toBe(data.magicLinkVerify.user.id);
  });

  it('creates the account on first use and reuses it on the second', async () => {
    const first = await anonymous.expectOk(VERIFY, { token: await magicToken('twice@example.com') });
    const second = await anonymous.expectOk(VERIFY, { token: await magicToken('twice@example.com') });
    expect(first.magicLinkVerify.user.id).toBe(second.magicLinkVerify.user.id);
  });

  it('signs an existing account in as itself, keeping its id', async () => {
    // Accounts from before better-auth have no `accounts` row and a uuid
    // better-auth never minted. Both have to keep working.
    const existing = await createUser(db, 'existing@example.com');
    const data = await anonymous.expectOk(VERIFY, { token: await magicToken('existing@example.com') });
    expect(data.magicLinkVerify.user.id).toBe(existing);
  });

  it('treats addresses case-insensitively', async () => {
    const lower = await anonymous.expectOk(VERIFY, { token: await magicToken('case@example.com') });
    const upper = await anonymous.expectOk(VERIFY, { token: await magicToken('CASE@example.com') });
    expect(upper.magicLinkVerify.user.id).toBe(lower.magicLinkVerify.user.id);
  });

  it('works once', async () => {
    const token = await magicToken('once@example.com');
    await anonymous.expectOk(VERIFY, { token });
    const error = await anonymous.expectError(VERIFY, { token });
    expect(error.code).toBe('BAD_USER_INPUT');
  });

  it('rejects a garbage token as bad input, not as an expired session', async () => {
    // UNAUTHENTICATED is what the client drops its token on; a bad magic link is
    // a bad argument and must not sign anyone out.
    const error = await anonymous.expectError(VERIFY, { token: 'not-a-token' });
    expect(error.code).toBe('BAD_USER_INPUT');
  });

  it('marks the address verified', async () => {
    const data = await anonymous.expectOk(VERIFY, { token: await magicToken('verified@example.com') });
    const [user] = await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, data.magicLinkVerify.user.id));
    expect(user.emailVerified).toBe(true);
  });
});

describe('verifyOneTimeToken', () => {
  it('rejects a garbage token as bad input, not as an expired session', async () => {
    const error = await anonymous.expectError(ONE_TIME, { token: 'not-a-token' });
    expect(error.code).toBe('BAD_USER_INPUT');
  });
});

describe('signOut', () => {
  it('says so, rather than failing, when there is no session', async () => {
    const data = await anonymous.expectOk(SIGN_OUT);
    expect(data.signOut.success).toBe(false);
  });
});

describe('authConfig', () => {
  it('says which ways of signing in the instance offers', async () => {
    const data = await anonymous.expectOk(`{ authConfig { secureLocalNet magicLink sso { name } } }`);
    expect(data.authConfig).toEqual({ secureLocalNet: false, magicLink: true, sso: null });
    process.env.SECURE_LOCAL_NET = 'true';
    const local = await anonymous.expectOk(`{ authConfig { secureLocalNet } }`);
    expect(local.authConfig.secureLocalNet).toBe(true);
  });

  it('says whether the instance has AI, before anyone signs in', async () => {
    expect((await anonymous.expectOk(`{ authConfig { ai } }`)).authConfig.ai).toBe(false);
    const withAi = createClient(db, null, { ai: true });
    expect((await withAi.expectOk(`{ authConfig { ai } }`)).authConfig.ai).toBe(true);
  });
});

describe('authentication', () => {
  it('refuses to read anything without a session', async () => {
    const error = await anonymous.expectError(`query { projects { id } }`);
    expect(error.code).toBe('UNAUTHENTICATED');
  });

  it('shows a signed-in user only their own user row', async () => {
    const mine = await createUser(db, 'mine@example.com');
    await createUser(db, 'theirs@example.com');
    const data = await createClient(db, mine).expectOk(`query { users { id email } }`);
    expect(data.users).toEqual([{ id: mine, email: 'mine@example.com' }]);
  });

  it('keeps sessions and keys out of the schema', async () => {
    const data = await anonymous.expectOk(`{ __schema { queryType { fields { name } } } }`);
    const fields = data.__schema.queryType.fields.map((field: { name: string }) => field.name);
    for (const name of ['sessions', 'accounts', 'verifications', 'apikeys']) {
      expect(fields).not.toContain(name);
    }
  });
});
