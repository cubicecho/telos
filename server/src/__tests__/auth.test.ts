import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signMagicToken, signToken, verifyMagicToken, verifyToken } from '../resolvers/auth.ts';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

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
  process.env.JWT_SECRET = 'test-secret';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('tokens', () => {
  it('round-trips a session token', () => {
    expect(verifyToken(signToken('a-user-id'))).toMatchObject({ userId: 'a-user-id' });
  });

  it('round-trips a magic token', () => {
    expect(verifyMagicToken(signMagicToken('Someone@Example.com'))).toMatchObject({
      email: 'Someone@Example.com',
    });
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken('a-user-id');
    process.env.JWT_SECRET = 'a-different-secret';
    expect(verifyToken(token)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyToken('not-a-jwt')).toBeNull();
    expect(verifyMagicToken('not-a-jwt')).toBeNull();
  });
});

describe('requestMagicLink', () => {
  it('returns a link and no session when magic links are on', async () => {
    process.env.AUTH_MAGIC_LINK = 'true';
    const data = await anonymous.expectOk(REQUEST, { email: nextEmail() });
    expect(data.requestMagicLink.ok).toBe(true);
    expect(data.requestMagicLink.token).toBeNull();
    expect(data.requestMagicLink.magicLink).toContain('/auth/verify?token=');
  });

  it('withholds the link when exposing it is off', async () => {
    process.env.AUTH_MAGIC_LINK = 'true';
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
    expect(verifyToken(data.requestMagicLink.token)).toMatchObject({ userId: data.requestMagicLink.userId });
  });

  it('rate-limits repeated attempts for one address', async () => {
    process.env.AUTH_MAGIC_LINK = 'true';
    const email = nextEmail();
    for (let attempt = 0; attempt < 5; attempt++) {
      await anonymous.expectOk(REQUEST, { email });
    }
    const error = await anonymous.expectError(REQUEST, { email });
    expect(error.code).toBe('TOO_MANY_REQUESTS');
  });
});

describe('verifyMagicLink', () => {
  it('creates the account on first use and reuses it on the second', async () => {
    const email = nextEmail();
    const first = await anonymous.expectOk(VERIFY, { token: signMagicToken(email) });
    const second = await anonymous.expectOk(VERIFY, { token: signMagicToken(email) });
    expect(first.verifyMagicLink.userId).toBe(second.verifyMagicLink.userId);
  });

  it('treats addresses case-insensitively', async () => {
    const email = nextEmail();
    const lower = await anonymous.expectOk(VERIFY, { token: signMagicToken(email) });
    const upper = await anonymous.expectOk(VERIFY, { token: signMagicToken(email.toUpperCase()) });
    expect(upper.verifyMagicLink.userId).toBe(lower.verifyMagicLink.userId);
  });

  it('rejects a garbage token as bad input, not as an expired session', async () => {
    // UNAUTHENTICATED is what the client drops its token on; a bad magic link is
    // a bad argument and must not sign anyone out.
    const error = await anonymous.expectError(VERIFY, { token: 'not-a-jwt' });
    expect(error.code).toBe('BAD_USER_INPUT');
  });

  it('rejects an expired token', async () => {
    const expired = signMagicToken(nextEmail());
    process.env.JWT_SECRET = 'rotated-secret';
    const error = await anonymous.expectError(VERIFY, { token: expired });
    expect(error.code).toBe('BAD_USER_INPUT');
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
});
