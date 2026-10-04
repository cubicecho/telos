import { randomUUID } from 'node:crypto';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, CLAIM, createBoard, FINISH, QUEUE, runnerClient, SET_AUTO_RUN, setLane } from './board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

// A person asking for one todo to be worked now, on a board that does not run
// by itself.

let db: TestDb;
let board: Board;
let runner: TestClient;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
  await board.person.expectOk(SET_AUTO_RUN, { id: board.projectId, enabled: false });
});

const RUN = `mutation ($id: ID!) { runTodo(id: $id) { id runRequestedAt } }`;
const MOVE = `mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`;
const UPDATE = `mutation ($id: UUID!, $set: UpdateTodoInput!) {
  updateTodo(set: $set, where: { id: { eq: $id } }) { id }
}`;
const STATUS = `query ($projectId: ID) { aiStatus(projectId: $projectId) { todos { todoId state reason failures awaitsRun runRequested } } }`;
const SET_PROJECT_AI = `mutation ($id: ID!, $enabled: Boolean!) {
  setProjectAiEnabled(projectId: $id, enabled: $enabled) { id }
}`;

/** Where one todo stands with the lanes' agents. */
async function stateOf(todoId: string): Promise<{ state: string; reason: string | null; failures: number }> {
  const { todos } = (await board.person.expectOk(STATUS, { projectId: board.projectId })).aiStatus;
  return todos.find((todo: { todoId: string }) => todo.todoId === todoId);
}

/** The todo's row. */
// biome-ignore lint/suspicious/noExplicitAny: a row
async function rowOf(todoId: string): Promise<any> {
  const [row] = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, todoId));
  return row;
}

/** Claims a todo in the board's agent lane; null when its agent will not take it. */
async function claim(todoId: string, laneId = board.lanes[0].id): Promise<{ runId: string } | null> {
  return (await runner.expectOk(CLAIM, { todoId, laneId })).claimRun;
}

/** The todos the runner is offered. */
async function queued(): Promise<string[]> {
  return (await runner.expectOk(QUEUE)).runnerQueue.map((ready: { todoId: string }) => ready.todoId);
}

describe('runTodo', () => {
  it('has an agent work the one todo asked for, and leaves the rest waiting', async () => {
    const asked = await board.addTodo('Asked');
    const other = await board.addTodo('Other');
    expect(await queued()).toEqual([]);
    expect(await stateOf(asked)).toMatchObject({
      state: 'parked',
      reason: 'Auto-run is off.',
      awaitsRun: true,
      runRequested: false,
    });

    const todo = (await board.person.expectOk(RUN, { id: asked })).runTodo;
    expect(todo).toMatchObject({ id: asked });
    expect(todo.runRequestedAt).not.toBeNull();
    expect(await stateOf(asked)).toMatchObject({ state: 'queued', reason: null, awaitsRun: false, runRequested: true });
    expect(await stateOf(other)).toMatchObject({ state: 'parked', reason: 'Auto-run is off.' });
    expect(await queued()).toEqual([asked]);
    expect(await claim(other)).toBeNull();

    const run = await claim(asked);
    expect(run).not.toBeNull();
    expect((await rowOf(asked)).runRequestedAt).toBeNull();
    await runner.expectOk(FINISH, { id: run?.runId, result: { status: 'ok', output: 'Done.' } });
    const done = await rowOf(asked);
    expect(done.laneId).toBe(board.lanes[2].id);
    expect(done.completedAt).not.toBeNull();
  });

  it('is one run: the todo follows its success route and waits in the next agent lane', async () => {
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: board.lanes[1].id });
    await setLane(board.person, board.lanes[1].id, { agentId: board.agentId, onSuccessLaneId: board.lanes[2].id });
    const todoId = await board.addTodo('Two agent lanes');
    await board.person.expectOk(RUN, { id: todoId });
    const run = await claim(todoId);
    await runner.expectOk(FINISH, { id: run?.runId, result: { status: 'ok', output: 'Half done.' } });

    expect((await rowOf(todoId)).laneId).toBe(board.lanes[1].id);
    expect(await queued()).toEqual([]);
    expect(await claim(todoId, board.lanes[1].id)).toBeNull();
    expect(await stateOf(todoId)).toMatchObject({ state: 'parked', reason: 'Auto-run is off.' });
  });

  it('is one run when the run fails too', async () => {
    const todoId = await board.addTodo('Flaky');
    await board.person.expectOk(RUN, { id: todoId });
    const run = await claim(todoId);
    await runner.expectOk(FINISH, { id: run?.runId, result: { status: 'error', error: 'It broke.' } });

    expect(await queued()).toEqual([]);
    expect(await stateOf(todoId)).toMatchObject({ state: 'parked', reason: 'Auto-run is off.', failures: 1 });
  });

  it('is a retry: it forgets failures and restarts an agent that finished with the todo', async () => {
    await setLane(board.person, board.lanes[0].id, { maxAttempts: 1, onSuccessLaneId: null });
    const failed = await board.addTodo('Failed');
    await board.person.expectOk(RUN, { id: failed });
    const first = await claim(failed);
    await runner.expectOk(FINISH, { id: first?.runId, result: { status: 'error', error: 'It broke.' } });
    await board.person.expectOk(RUN, { id: failed });
    expect(await stateOf(failed)).toMatchObject({ state: 'queued', failures: 0 });

    const again = await claim(failed);
    await runner.expectOk(FINISH, { id: again?.runId, result: { status: 'ok', output: 'Done.' } });
    expect((await stateOf(failed)).state).toBe('attention');
    await board.person.expectOk(RUN, { id: failed });
    expect((await stateOf(failed)).state).toBe('queued');
    expect(await claim(failed)).not.toBeNull();
  });

  it('keeps to the lane’s limit on work in progress', async () => {
    const first = await board.addTodo('First');
    const second = await board.addTodo('Second');
    await board.person.expectOk(RUN, { id: first });
    await board.person.expectOk(RUN, { id: second });
    const run = await claim(first);
    expect(await claim(second)).toBeNull();
    expect((await rowOf(second)).runRequestedAt).not.toBeNull();

    await runner.expectOk(FINISH, { id: run?.runId, result: { status: 'ok', output: 'Done.' } });
    expect(await claim(second)).not.toBeNull();
  });

  it('works on a board that runs by itself, as a retry', async () => {
    await board.person.expectOk(SET_AUTO_RUN, { id: board.projectId, enabled: true });
    const todoId = await board.addTodo('Either way');
    await board.person.expectOk(RUN, { id: todoId });
    expect(await claim(todoId)).not.toBeNull();
    expect((await rowOf(todoId)).runRequestedAt).toBeNull();
  });

  it('writes the asking into the todo’s history, once', async () => {
    const todoId = await board.addTodo('Recorded');
    await board.person.expectOk(RUN, { id: todoId });
    const events = await db.select().from(dbSchema.todoEvents).where(eq(dbSchema.todoEvents.todoId, todoId));
    const runs = events.filter((event: { kind: string }) => event.kind === 'run');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ actorKind: 'user', fromLaneId: board.lanes[0].id, toLaneId: board.lanes[0].id });
    expect(events).toHaveLength(2);
  });

  it('may be asked by a key, and is signed with it', async () => {
    const todoId = await board.addTodo('Asked by a client');
    const keyId = randomUUID();
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId },
    });
    expect((await key.expectOk(RUN, { id: todoId })).runTodo.runRequestedAt).not.toBeNull();
    const events = await db.select().from(dbSchema.todoEvents).where(eq(dbSchema.todoEvents.todoId, todoId));
    expect(events.at(-1)).toMatchObject({ kind: 'run', actorKind: 'apiKey', actorKeyId: keyId });
  });
});

describe('a run request that no longer stands', () => {
  it('goes when the todo is moved, ignored, done or archived', async () => {
    const moved = await board.addTodo('Moved');
    const ignored = await board.addTodo('Ignored');
    const done = await board.addTodo('Done');
    const archived = await board.addTodo('Archived');
    for (const id of [moved, ignored, done, archived]) {
      await board.person.expectOk(RUN, { id });
    }

    await board.person.expectOk(MOVE, { id: moved, laneId: board.lanes[1].id });
    await board.person.expectOk(UPDATE, { id: ignored, set: { aiIgnored: true } });
    await board.person.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: done });
    await board.person.expectOk(`mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }`, {
      id: archived,
    });

    for (const id of [moved, ignored, done, archived]) {
      expect((await rowOf(id)).runRequestedAt).toBeNull();
    }
    // Back where it was asked for, it is not asked for any more.
    await board.person.expectOk(MOVE, { id: moved, laneId: board.lanes[0].id });
    await board.person.expectOk(UPDATE, { id: ignored, set: { aiIgnored: false } });
    expect(await queued()).toEqual([]);
  });

  it('goes when AI is switched off for the project', async () => {
    const todoId = await board.addTodo('Asked');
    await board.person.expectOk(RUN, { id: todoId });
    await board.person.expectOk(SET_PROJECT_AI, { id: board.projectId, enabled: false });
    expect((await rowOf(todoId)).runRequestedAt).toBeNull();

    await board.person.expectOk(SET_PROJECT_AI, { id: board.projectId, enabled: true });
    expect(await queued()).toEqual([]);
  });
});

describe('runTodo refuses', () => {
  /** Asks, and expects to be told no. */
  async function refusal(todoId: string): Promise<{ message: string; code: unknown }> {
    const error = await board.person.expectError(RUN, { id: todoId });
    expect((await rowOf(todoId)).runRequestedAt).toBeNull();
    return error;
  }

  it('while AI is off for the project', async () => {
    const todoId = await board.addTodo('Shut');
    await board.person.expectOk(SET_PROJECT_AI, { id: board.projectId, enabled: false });
    expect(await refusal(todoId)).toEqual({ message: 'AI is off for its project.', code: 'BAD_USER_INPUT' });
  });

  it('while AI is off for the account', async () => {
    const todoId = await board.addTodo('Shut');
    await board.person.expectOk(`mutation { setAiEnabled(enabled: false) { id } }`);
    expect((await refusal(todoId)).code).toBe('NOT_FOUND');
  });

  it('on an instance without AI', async () => {
    const todoId = await board.addTodo('Shut');
    const plain = createClient(db, board.userId, { ai: false });
    expect((await plain.expectError(RUN, { id: todoId })).code).not.toBeNull();
    expect((await rowOf(todoId)).runRequestedAt).toBeNull();
  });

  it('a todo AI is told to ignore', async () => {
    const todoId = await board.addTodo('Ignored');
    await board.person.expectOk(UPDATE, { id: todoId, set: { aiIgnored: true } });
    expect(await refusal(todoId)).toEqual({ message: 'AI is told to ignore it.', code: 'BAD_USER_INPUT' });
  });

  it('a todo that is done', async () => {
    const todoId = await board.addTodo('Done');
    await board.person.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: todoId });
    expect(await refusal(todoId)).toEqual({ message: 'It is already done.', code: 'BAD_USER_INPUT' });
  });

  it('a todo in a lane with no agent', async () => {
    const todoId = await board.addTodo('Nobody home');
    await board.person.expectOk(MOVE, { id: todoId, laneId: board.lanes[1].id });
    expect(await stateOf(todoId)).toMatchObject({ state: 'parked', awaitsRun: false });
    expect(await refusal(todoId)).toEqual({ message: 'In progress has no agent.', code: 'BAD_USER_INPUT' });
  });

  it('a todo waiting on another', async () => {
    const first = await board.addTodo('First');
    const second = await board.addTodo('Second');
    await board.person.expectOk(
      `mutation ($a: ID!, $b: ID!) { addTodoDependency(todoId: $a, dependsOnTodoId: $b) { id } }`,
      { a: second, b: first },
    );
    expect(await refusal(second)).toEqual({ message: 'It is waiting on First.', code: 'BAD_USER_INPUT' });
  });

  it('a todo an agent is working', async () => {
    await board.person.expectOk(SET_AUTO_RUN, { id: board.projectId, enabled: true });
    const todoId = await board.addTodo('Busy');
    await claim(todoId);
    expect(await refusal(todoId)).toEqual({ message: 'An agent is working it now.', code: 'CONFLICT' });
  });

  it('an archived todo, as not found', async () => {
    const todoId = await board.addTodo('Archived');
    await board.person.expectOk(`mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }`, {
      id: todoId,
    });
    expect((await refusal(todoId)).code).toBe('NOT_FOUND');
  });

  it('another person’s todo, as not found', async () => {
    const todoId = await board.addTodo('Mine');
    const other = await createBoard(db, 'other@example.com');
    expect((await other.person.expectError(RUN, { id: todoId })).code).toBe('NOT_FOUND');
    expect((await rowOf(todoId)).runRequestedAt).toBeNull();
  });

  it('a key with run_todo switched off, and someone signed out', async () => {
    const todoId = await board.addTodo('Mine');
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: randomUUID(), toolsOff: new Set(['run_todo']) },
    });
    expect((await key.expectError(RUN, { id: todoId })).code).toBe('FORBIDDEN');
    const nobody = createClient(db, null, { ai: true });
    expect((await nobody.expectError(RUN, { id: todoId })).code).toBe('UNAUTHENTICATED');
    expect((await rowOf(todoId)).runRequestedAt).toBeNull();
  });

  it('a generated write that states the request', async () => {
    const todoId = await board.addTodo('Sneaky');
    const error = await board.person.expectError(UPDATE, {
      id: todoId,
      set: { runRequestedAt: new Date().toISOString() },
    });
    expect(error).toEqual({ message: 'Use runTodo to ask for a todo to be run.', code: 'BAD_USER_INPUT' });
    expect(await queued()).toEqual([]);
  });
});
