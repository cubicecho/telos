import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintApiKey, resolveActor, signInDirectly } from '../auth.ts';
import { type Board, CLAIM, createBoard, FINISH, HEARTBEAT, QUEUE, runnerClient } from './board.ts';
import { authFor, createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

// The instance's AI switch: an admin's, off by default, and over every
// account's. Off, nothing an account turned on works, and whatever was running
// is asked to stop.

const AUTH_CONFIG = `query { authConfig { ai aiAvailable } }`;
const SET_INSTANCE = `mutation ($enabled: Boolean!) { setInstanceAiEnabled(enabled: $enabled) { ai aiAvailable } }`;

let db: TestDb;
let board: Board;
let admin: TestClient;
let runner: TestClient;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'person@example.com');
  await db.update(dbSchema.users).set({ isAdmin: true }).where(eq(dbSchema.users.id, board.userId));
  admin = board.person;
  runner = runnerClient(db);
});

const resolve = (headers: Record<string, string>) =>
  resolveActor(authFor(db), db, new Headers(headers), { ai: true, runnerKey: 'runner-secret' });

describe('who runs the instance', () => {
  it('makes the first account an admin, and no other', async () => {
    const fresh = await createTestDb();
    const first = await signInDirectly(authFor(fresh), 'first@example.com');
    const second = await signInDirectly(authFor(fresh), 'second@example.com');
    const flags = await fresh.select({ id: dbSchema.users.id, isAdmin: dbSchema.users.isAdmin }).from(dbSchema.users);
    expect(flags).toEqual(
      expect.arrayContaining([
        { id: first.userId, isAdmin: true },
        { id: second.userId, isAdmin: false },
      ]),
    );
  });

  it('lets only an admin, signed in, flip the switch', async () => {
    const other = await createBoard(db, 'other@example.com');
    expect((await other.person.expectError(SET_INSTANCE, { enabled: false })).code).toBe('FORBIDDEN');

    const { key } = await mintApiKey(authFor(db), { userId: board.userId, name: 'k' });
    const viaKey = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: key },
    });
    expect((await viaKey.expectError(SET_INSTANCE, { enabled: false })).code).toBe('FORBIDDEN');

    expect((await admin.expectOk(SET_INSTANCE, { enabled: false })).setInstanceAiEnabled).toEqual({
      ai: false,
      aiAvailable: true,
    });
  });

  it('keeps the admin flag out of every client’s hands', async () => {
    const other = await createBoard(db, 'other@example.com');
    const result = await other.person.run(
      `mutation ($id: UUID!) {
      updateUser(where: { id: { eq: $id } }, set: { isAdmin: true }) { id }
    }`,
      { id: other.userId },
    );
    expect(result.errors).toBeDefined();
    const [row] = await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, other.userId));
    expect(row.isAdmin).toBe(false);
  });
});

describe('an instance with its switch off', () => {
  it('starts that way, and says so before anyone signs in', async () => {
    const fresh = await createTestDb({ instanceAi: false });
    expect((await createClient(fresh, null, { ai: true }).expectOk(AUTH_CONFIG)).authConfig).toEqual({
      ai: false,
      aiAvailable: true,
    });
    expect((await createClient(fresh, null, { ai: false }).expectOk(AUTH_CONFIG)).authConfig).toEqual({
      ai: false,
      aiAvailable: false,
    });
  });

  it('refuses every AI door an account had open', async () => {
    const todoId = await board.addTodo('Work');
    const { key } = await mintApiKey(authFor(db), { userId: board.userId, name: 'k' });
    const { token } = (await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id })).claimRun;
    expect((await resolve({ 'x-api-key': key })).kind).toBe('apiKey');
    expect((await resolve({ 'x-run-token': token })).kind).toBe('agent');

    await admin.expectOk(SET_INSTANCE, { enabled: false });

    expect((await resolve({ 'x-api-key': key })).kind).toBe('anonymous');
    expect((await resolve({ 'x-run-token': token })).kind).toBe('anonymous');
    // And nothing AI can be switched on under it.
    const reopen = `mutation ($id: ID!) { setProjectAiEnabled(projectId: $id, enabled: true) { id } }`;
    expect((await admin.expectError(reopen, { id: board.projectId })).code).toBe('NOT_FOUND');
  });

  it('empties the queue and stops what was running', async () => {
    const running = await board.addTodo('Running');
    await board.addTodo('Waiting');
    const { runId } = (await runner.expectOk(CLAIM, { todoId: running, laneId: board.lanes[0].id })).claimRun;

    await admin.expectOk(SET_INSTANCE, { enabled: false });

    expect((await runner.expectOk(QUEUE)).runnerQueue).toEqual([]);
    // The runner still hears it: its heartbeat is told to stop.
    expect((await resolve({ 'x-runner-key': 'runner-secret' })).kind).toBe('system');
    expect((await runner.expectOk(HEARTBEAT, { id: runId })).heartbeatRun).toBe(true);
    const [run] = await db.select().from(dbSchema.runs).where(eq(dbSchema.runs.id, runId));
    expect(run.cancelRequestedAt).not.toBeNull();

    // Once the runner reports it stopped, switching back on opens the queue again.
    await runner.expectOk(FINISH, { id: runId, result: { status: 'ok', output: 'Done anyway.' } });
    await admin.expectOk(SET_INSTANCE, { enabled: true });
    expect((await runner.expectOk(QUEUE)).runnerQueue).toHaveLength(1);
  });
});
