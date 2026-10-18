import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveActor } from '../auth.ts';
import { authFor, createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

// A person's sessions, through better-auth's own endpoints served as GraphQL
// (resolvers/better-auth.ts): see them, end one, end the rest.

const SIGN_IN = `mutation ($email: String!) { signInMagicLink(email: $email) { token userId } }`;
const SESSION = `{ getSession { user { id email } session { id token expiresAt } } }`;

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  process.env.SECURE_LOCAL_NET = 'true';
});

// Test files share a worker, so the switch must not outlive this one.
afterEach(() => {
  delete process.env.SECURE_LOCAL_NET;
});

let addresses = 0;

/** Signs an address in (SECURE_LOCAL_NET) and returns a client carrying its session. */
async function signIn(
  email = `sessions${++addresses}@example.com`,
): Promise<{ client: TestClient; token: string; userId: string }> {
  const auth = authFor(db);
  const { signInMagicLink } = await createClient(db, null, { auth }).expectOk(SIGN_IN, { email });
  const { token, userId } = signInMagicLink as { token: string; userId: string };
  return { client: clientFor(token, userId), token, userId };
}

function clientFor(token: string, userId: string): TestClient {
  return createClient(db, userId, { auth: authFor(db), headers: new Headers({ authorization: `Bearer ${token}` }) });
}

async function signedIn(token: string): Promise<boolean> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  return (await resolveActor(authFor(db), db, headers, { ai: false })).userId !== null;
}

describe('sessions', () => {
  it('reads the session the request carries, and none without one', async () => {
    const { client, token, userId } = await signIn();
    const data = await client.expectOk(SESSION);
    expect(data.getSession.user.id).toBe(userId);
    expect(data.getSession.session.token).toBe(token);
    expect(new Date(data.getSession.session.expiresAt).getTime()).toBeGreaterThan(Date.now());

    expect(await createClient(db, null).expectOk(SESSION)).toEqual({ getSession: null });
  });

  it('lists them and ends another one', async () => {
    const first = await signIn('two-devices@example.com');
    const second = await signIn('two-devices@example.com');
    const { listSessions } = await first.client.expectOk(`{ listSessions { id token } }`);
    expect(listSessions).toHaveLength(2);

    await first.client.expectOk(`mutation ($token: String!) { revokeSession(token: $token) { status } }`, {
      token: second.token,
    });
    expect(await signedIn(second.token)).toBe(false);
    expect(await signedIn(first.token)).toBe(true);
  });

  it('ends every other session, then this one', async () => {
    const first = await signIn('three-devices@example.com');
    const second = await signIn('three-devices@example.com');
    expect(await first.client.expectOk(`mutation { revokeOtherSessions { status } }`)).toEqual({
      revokeOtherSessions: { status: true },
    });
    expect(await signedIn(second.token)).toBe(false);

    expect(await first.client.expectOk(`mutation { signOut { success } }`)).toEqual({ signOut: { success: true } });
    expect(await signedIn(first.token)).toBe(false);
  });

  it('refuses a caller with no session', async () => {
    const error = await createClient(db, null).expectError(`{ listSessions { id } }`);
    expect(error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses an API key or an agent, whatever headers it brings', async () => {
    const { token, userId } = await signIn();
    const headers = new Headers({ authorization: `Bearer ${token}` });
    for (const actor of [
      { kind: 'apiKey' as const, userId, keyId: 'k' },
      { kind: 'agent' as const, userId, runId: 'r' },
    ]) {
      const client = createClient(db, userId, { actor, headers, ai: true });
      const error = await client.expectError(`{ listSessions { id } }`);
      expect(error.code).toBe('FORBIDDEN');
    }
  });
});
