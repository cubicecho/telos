import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveActor } from '../auth.ts';
import { authFor, createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

const REQUEST = `mutation ($email: String!) { requestMagicLink(email: $email) { ok magicLink token userId } }`;
const VERIFY = `mutation ($token: String!) { verifyMagicLink(token: $token) { token userId } }`;

let db: TestDb;
let anonymous: TestClient;

// Each test uses a fresh address: the sign-in limiter is per process and
// per address, and would otherwise carry counts between tests.
let addresses = 0;
const nextEmail = () => `user${++addresses}@example.com`;

const originalEnv = { ...process.env };

beforeEach(async () => {
  db = await createTestDb();
  anonymous = createClient(db, null);
  process.env.AUTH_MAGIC_LINK = 'true';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/** Requests a link and pulls the token back out of it, as the app's verify screen does. */
async function magicToken(email: string): Promise<string> {
  const data = await anonymous.expectOk(REQUEST, { email });
  const link = new URL(data.requestMagicLink.magicLink);
  const token = link.searchParams.get('token');
  if (!token) throw new Error(`no token in ${link}`);
  return token;
}

/** Who a session token signs in as, through the same path a request takes. */
async function whoIs(token: string): Promise<string | null> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  return (await resolveActor(authFor(db), db, headers, { ai: false })).userId;
}

describe('requestMagicLink', () => {
  it('returns a link and no session when magic links are on', async () => {
    const data = await anonymous.expectOk(REQUEST, { email: nextEmail() });
    expect(data.requestMagicLink.ok).toBe(true);
    expect(data.requestMagicLink.token).toBeNull();
    expect(data.requestMagicLink.magicLink).toContain('/auth/verify?token=');
  });

  it('withholds the link when exposing it is off', async () => {
    process.env.EXPOSE_MAGIC_LINK = 'false';
    process.env.NODE_ENV = 'production';
    const data = await anonymous.expectOk(REQUEST, { email: nextEmail() });
    expect(data.requestMagicLink.ok).toBe(true);
    expect(data.requestMagicLink.magicLink).toBeNull();
  });

  it('signs straight in when magic links are off', async () => {
    process.env.AUTH_MAGIC_LINK = 'false';
    const data = await anonymous.expectOk(REQUEST, { email: nextEmail() });
    expect(data.requestMagicLink.magicLink).toBeNull();
    expect(data.requestMagicLink.userId).toBeTruthy();
    expect(await whoIs(data.requestMagicLink.token)).toBe(data.requestMagicLink.userId);
  });

  it('rate-limits repeated attempts for one address', async () => {
    const email = nextEmail();
    for (let attempt = 0; attempt < 5; attempt++) {
      await anonymous.expectOk(REQUEST, { email });
    }
    const error = await anonymous.expectError(REQUEST, { email });
    expect(error.code).toBe('TOO_MANY_REQUESTS');
  });
});

describe('verifyMagicLink', () => {
  it('opens a session the next request is signed in with', async () => {
    const data = await anonymous.expectOk(VERIFY, { token: await magicToken(nextEmail()) });
    expect(await whoIs(data.verifyMagicLink.token)).toBe(data.verifyMagicLink.userId);
  });

  it('creates the account on first use and reuses it on the second', async () => {
    const email = nextEmail();
    const first = await anonymous.expectOk(VERIFY, { token: await magicToken(email) });
    const second = await anonymous.expectOk(VERIFY, { token: await magicToken(email) });
    expect(first.verifyMagicLink.userId).toBe(second.verifyMagicLink.userId);
  });

  it('signs an existing account in as itself, keeping its id', async () => {
    // Accounts from before better-auth have no `accounts` row and a uuid
    // better-auth never minted. Both have to keep working.
    const email = nextEmail();
    const existing = await createUser(db, email);
    const data = await anonymous.expectOk(VERIFY, { token: await magicToken(email) });
    expect(data.verifyMagicLink.userId).toBe(existing);
  });

  it('treats addresses case-insensitively', async () => {
    const email = nextEmail();
    const lower = await anonymous.expectOk(VERIFY, { token: await magicToken(email) });
    const upper = await anonymous.expectOk(VERIFY, { token: await magicToken(email.toUpperCase()) });
    expect(upper.verifyMagicLink.userId).toBe(lower.verifyMagicLink.userId);
  });

  it('works once', async () => {
    const token = await magicToken(nextEmail());
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
    const data = await anonymous.expectOk(VERIFY, { token: await magicToken(nextEmail()) });
    const [user] = await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, data.verifyMagicLink.userId));
    expect(user.emailVerified).toBe(true);
  });
});

describe('authConfig', () => {
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
