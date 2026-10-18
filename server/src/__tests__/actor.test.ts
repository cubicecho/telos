import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintApiKey, resolveActor, signInOnLocalNet } from '../auth.ts';
import type { Actor } from '../context.ts';
import { authFor, createClient, createTestDb, createUser, sessionClient, type TestDb } from './helpers.ts';

// Every other server test hands the context its actor directly — helpers.ts
// calls `graphql()` and never goes through Express — so this is where a
// request's headers are actually read. It is the only thing standing between a
// request and someone else's data, which is reason enough to pin it.

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

const resolve = (headers: Record<string, string>, ai = true) =>
  resolveActor(authFor(db), db, new Headers(headers), { ai });

async function session(email: string) {
  return signInOnLocalNet(authFor(db), email);
}

async function setAi(userId: string, on: boolean) {
  await db.update(dbSchema.users).set({ aiEnabled: on }).where(eq(dbSchema.users.id, userId));
}

describe('sessions', () => {
  it('reads the user out of a valid Bearer token', async () => {
    const { token, userId } = await session('a@example.com');
    expect(await resolve({ authorization: `Bearer ${token}` })).toEqual({ kind: 'user', userId });
  });

  it('is anonymous with no header at all', async () => {
    expect((await resolve({})).userId).toBeNull();
    expect((await resolve({ authorization: '' })).userId).toBeNull();
  });

  it('requires the scheme, spelled that way', async () => {
    const { token } = await session('a@example.com');
    for (const header of [token, `bearer ${token}`, `Basic ${token}`, `Bearer${token}`]) {
      expect((await resolve({ authorization: header })).userId).toBeNull();
    }
  });

  it('is anonymous rather than throwing on a token that is not one', async () => {
    for (const header of ['Bearer ', 'Bearer not-a-token', 'Bearer a.b.c']) {
      expect((await resolve({ authorization: header })).userId).toBeNull();
    }
  });

  it('ends when the session row goes', async () => {
    const { token, userId } = await session('a@example.com');
    await db.delete(dbSchema.sessions).where(eq(dbSchema.sessions.userId, userId));
    expect((await resolve({ authorization: `Bearer ${token}` })).userId).toBeNull();
  });
});

describe('API keys', () => {
  async function keyFor(email: string, ai = true) {
    const userId = await createUser(db, email);
    await setAi(userId, ai);
    const { id, key } = await mintApiKey(authFor(db), { userId, name: 'test' });
    return { userId, keyId: id, key };
  }

  it('resolve to their owner, marked as a key', async () => {
    const { userId, keyId, key } = await keyFor('a@example.com');
    expect(await resolve({ 'x-api-key': key })).toEqual({ kind: 'apiKey', userId, keyId, toolsOff: new Set() });
  });

  it('start with the prefix, so a leaked one is recognisable', async () => {
    expect((await keyFor('a@example.com')).key).toMatch(/^telos_/);
  });

  it('are refused while the instance has AI off', async () => {
    const { key } = await keyFor('a@example.com');
    expect((await resolve({ 'x-api-key': key }, false)).userId).toBeNull();
  });

  it('are refused while their owner has AI off', async () => {
    const { userId, key } = await keyFor('a@example.com');
    await setAi(userId, false);
    expect((await resolve({ 'x-api-key': key })).userId).toBeNull();
  });

  it('are refused once revoked', async () => {
    const { keyId, key } = await keyFor('a@example.com');
    await db.delete(dbSchema.apikeys).where(eq(dbSchema.apikeys.id, keyId));
    expect((await resolve({ 'x-api-key': key })).userId).toBeNull();
  });

  it('are refused when they are not keys', async () => {
    await keyFor('a@example.com');
    expect((await resolve({ 'x-api-key': 'telos_nope' })).userId).toBeNull();
  });
});

describe('managing keys', () => {
  const CREATE = `mutation ($name: String!) { createApiKey(name: $name) { key id name start } }`;
  const LIST = `{ apiKeys { id name } }`;
  const DELETE = `mutation ($id: String!) { deleteApiKey(keyId: $id) { success } }`;

  async function person(ai = true) {
    const userId = await createUser(db, `${crypto.randomUUID()}@example.com`);
    await setAi(userId, ai);
    return { userId, client: await sessionClient(db, userId, { ai: true }) };
  }

  it('mints, lists and revokes, and the minted key works', async () => {
    const { userId, client } = await person();
    const created = (await client.expectOk(CREATE, { name: 'Claude Code' })).createApiKey;
    expect(created.name).toBe('Claude Code');
    expect(created.key.startsWith(created.start)).toBe(true);
    expect((await resolve({ 'x-api-key': created.key })).userId).toBe(userId);

    expect((await client.expectOk(LIST)).apiKeys).toEqual([{ id: created.id, name: 'Claude Code' }]);
    expect((await client.expectOk(DELETE, { id: created.id })).deleteApiKey).toEqual({ success: true });
    expect((await resolve({ 'x-api-key': created.key })).userId).toBeNull();
  });

  it('never shows or revokes someone else’s key', async () => {
    const mine = await person();
    const theirs = await person();
    const created = (await theirs.client.expectOk(CREATE, { name: 'theirs' })).createApiKey;
    expect((await mine.client.expectOk(LIST)).apiKeys).toEqual([]);
    expect((await mine.client.expectError(DELETE, { id: created.id })).code).toBe('NOT_FOUND');
    expect((await theirs.client.expectOk(LIST)).apiKeys).toHaveLength(1);
  });

  it('needs a name, and an expiry of a day to a year', async () => {
    const { client } = await person();
    expect((await client.expectError(CREATE, { name: '  ' })).code).toBe('BAD_USER_INPUT');
    const EXPIRING = `mutation ($s: Float!) { createApiKey(name: "x", expiresIn: $s) { expiresAt } }`;
    expect((await client.expectError(EXPIRING, { s: 60 })).code).toBe('BAD_USER_INPUT');
    expect((await client.expectError(EXPIRING, { s: 400 * 86400 })).code).toBe('BAD_USER_INPUT');
    const { createApiKey } = await client.expectOk(EXPIRING, { s: 7 * 86400 });
    expect(new Date(createApiKey.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
  });

  it('is for people only: a key cannot mint its own successor', async () => {
    const { userId } = await person();
    const actor: Actor = { kind: 'apiKey', userId, keyId: 'k' };
    const asKey = createClient(db, userId, { ai: true, actor });
    expect((await asKey.expectError(CREATE, { name: 'escape' })).code).toBe('FORBIDDEN');
    expect((await asKey.expectError(LIST)).code).toBe('FORBIDDEN');
  });

  it('is not there for an account with AI off', async () => {
    const { client } = await person(false);
    expect((await client.expectError(CREATE, { name: 'x' })).code).toBe('NOT_FOUND');
    expect((await client.expectError(LIST)).code).toBe('NOT_FOUND');
  });

  it('does not exist at all on an instance with AI off', async () => {
    const { userId } = await person();
    const error = await createClient(db, userId).expectError(LIST);
    expect(error.message).toMatch(/Cannot query field "apiKeys"/);
  });
});
