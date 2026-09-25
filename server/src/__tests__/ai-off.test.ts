import * as dbSchema from '@telos/db/schema';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintApiKey, resolveActor } from '../auth.ts';
import { type Board, CLAIM, createBoard, FINISH, HEARTBEAT, QUEUE, runnerClient } from './board.ts';
import { authFor, createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

// The promise the whole AI side rests on: a person who turns it off is left
// alone. Not "mostly": a full runner cycle over the instance leaves their rows
// exactly as they were, and nothing an AI holds for them still opens a door.

let db: TestDb;
let off: Board;
let on: Board;
let runner: TestClient;

beforeEach(async () => {
  db = await createTestDb();
  off = await createBoard(db, 'off@example.com');
  on = await createBoard(db, 'on@example.com');
  runner = runnerClient(db);
});

/**
 * Everything of one user's the board and the runner could write.
 *
 * @param userId The user.
 * @returns Their rows, in a stable order.
 */
async function snapshot(userId: string) {
  return {
    todos: await db
      .select()
      .from(dbSchema.todos)
      .where(eq(dbSchema.todos.userId, userId))
      .orderBy(asc(dbSchema.todos.id)),
    notes: await db
      .select()
      .from(dbSchema.todoNotes)
      .where(eq(dbSchema.todoNotes.userId, userId))
      .orderBy(asc(dbSchema.todoNotes.id)),
    lanes: await db
      .select()
      .from(dbSchema.lanes)
      .where(eq(dbSchema.lanes.userId, userId))
      .orderBy(asc(dbSchema.lanes.id)),
    events: await db
      .select()
      .from(dbSchema.todoEvents)
      .where(eq(dbSchema.todoEvents.userId, userId))
      .orderBy(asc(dbSchema.todoEvents.id)),
    runs: await db.select().from(dbSchema.runs).where(eq(dbSchema.runs.userId, userId)).orderBy(asc(dbSchema.runs.id)),
  };
}

/**
 * One pass of what the runner does: claim everything ready and finish it.
 *
 * @returns Nothing.
 */
async function runnerCycle(): Promise<void> {
  const ready = (await runner.expectOk(QUEUE)).runnerQueue as Array<{ todoId: string; laneId: string }>;
  for (const { todoId, laneId } of ready) {
    const claimed = (await runner.expectOk(CLAIM, { todoId, laneId })).claimRun;
    if (!claimed) continue;
    await runner.expectOk(HEARTBEAT, { id: claimed.runId });
    await runner.expectOk(FINISH, { id: claimed.runId, result: { status: 'ok', output: 'Did it.' } });
  }
}

async function switchOff(board: Board): Promise<void> {
  await board.person.expectOk(`mutation { setAiEnabled(enabled: false) { id } }`);
}

describe('a person with AI off', () => {
  it('has rows a runner cycle does not change by a byte', async () => {
    const todoId = await off.addTodo('Mine');
    await on.addTodo('Theirs');
    await switchOff(off);
    const before = await snapshot(off.userId);

    await runnerCycle();

    expect(await snapshot(off.userId)).toEqual(before);
    // The cycle did run: the other board's todo was worked.
    expect((await snapshot(on.userId)).runs).toHaveLength(1);
    expect((await runner.expectOk(CLAIM, { todoId, laneId: off.lanes[0].id })).claimRun).toBeNull();
  });

  it('holds no key or run token that still resolves', async () => {
    const todoId = await off.addTodo('Mine');
    const { key } = await mintApiKey(authFor(db), { userId: off.userId, name: 'test' });
    const { token } = (await runner.expectOk(CLAIM, { todoId, laneId: off.lanes[0].id })).claimRun;
    await switchOff(off);

    const resolve = (headers: Record<string, string>) =>
      resolveActor(authFor(db), db, new Headers(headers), { ai: true });
    expect((await resolve({ 'x-api-key': key })).kind).toBe('anonymous');
    expect((await resolve({ 'x-run-token': token })).kind).toBe('anonymous');
  });

  it('keeps a run that was working when they switched off from writing anything', async () => {
    const todoId = await off.addTodo('Mine');
    const { runId } = (await runner.expectOk(CLAIM, { todoId, laneId: off.lanes[0].id })).claimRun;
    await switchOff(off);
    const before = await snapshot(off.userId);

    expect((await runner.expectOk(HEARTBEAT, { id: runId })).heartbeatRun).toBe(true);
    await runner.expectOk(FINISH, { id: runId, result: { status: 'ok', output: 'Did it anyway.' } });

    const after = await snapshot(off.userId);
    expect({ ...after, runs: [] }).toEqual({ ...before, runs: [] });
    expect(after.runs).toEqual([expect.objectContaining({ id: runId, status: 'stopped' })]);
  });
});

describe('an instance with AI off', () => {
  it('has no runner, agents or stations in its schema', async () => {
    const person = createClient(db, off.userId, { ai: false });
    const schema = await person.expectOk(`query {
      query: __type(name: "Query") { fields { name } }
      mutation: __type(name: "Mutation") { fields { name } }
      agent: __type(name: "Agent") { name }
      run: __type(name: "Run") { name }
      artifact: __type(name: "Artifact") { name }
      lane: __type(name: "Lane") { fields { name } }
    }`);
    const names = (type: { fields: Array<{ name: string }> }) => type.fields.map((field) => field.name);
    expect(names(schema.query)).not.toContain('runnerQueue');
    expect(names(schema.query)).not.toContain('agents');
    expect(names(schema.mutation)).not.toContain('claimRun');
    expect(names(schema.mutation)).not.toContain('setAgentApiKey');
    expect(schema.agent).toBeNull();
    expect(schema.run).toBeNull();
    expect(schema.artifact).toBeNull();
    expect(names(schema.lane)).not.toContain('agentId');
    expect(names(schema.lane)).not.toContain('onSuccessLaneId');
  });

  it('has no system principal, whatever key is sent', async () => {
    const actor = await resolveActor(authFor(db), db, new Headers({ 'x-runner-key': 'runner-secret' }), {
      ai: false,
      runnerKey: 'runner-secret',
    });
    expect(actor.kind).toBe('anonymous');
  });
});
