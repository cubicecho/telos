import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, CLAIM, createBoard, FINISH, runnerClient, setLane } from './board.ts';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// What a board's cards say about notes and runs, in one query for the board.

let db: TestDb;
let board: Board;
let runner: TestClient;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

const MARKS = `query ($projectId: ID!) {
  cardMarks(projectId: $projectId) { todoId notes lastRun reason runId attempts maxAttempts }
}`;
const NOTE = `mutation ($todoId: UUID!, $body: String!) { createTodoNote(values: { todoId: $todoId, body: $body }) { id } }`;
const ADD_NOTE = `mutation ($todoId: ID!, $body: String!) { addTodoNote(todoId: $todoId, body: $body) { id } }`;
const KEY_ID = '00000000-0000-0000-0000-000000000000';
const AI_STATUS = `query ($projectId: ID) { aiStatus(projectId: $projectId) { todos { todoId failures } } }`;

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function marks(client: TestClient = board.person): Promise<any[]> {
  return (await client.expectOk(MARKS, { projectId: board.projectId })).cardMarks;
}

async function runOnce(todoId: string, result: Record<string, unknown>): Promise<string> {
  const lane = (await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, todoId)))[0].laneId;
  const { runId } = (await runner.expectOk(CLAIM, { todoId, laneId: lane })).claimRun;
  await runner.expectOk(FINISH, { id: runId, result });
  return runId;
}

describe('cardMarks', () => {
  it('lists nothing for a board with nothing to mark', async () => {
    await board.addTodo('Plain');
    expect(await marks()).toEqual([]);
  });

  it('counts the notes a person and an outside client wrote, not what an agent reported', async () => {
    const todoId = await board.addTodo('Write it');
    await board.person.expectOk(NOTE, { todoId, body: 'Mind the second paragraph.' });
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: KEY_ID },
    });
    await key.expectOk(ADD_NOTE, { todoId, body: 'From outside.' });
    // A work run leaves a report on the thread.
    await runOnce(todoId, { status: 'ok', output: 'Wrote it.' });
    const thread = await db.select().from(dbSchema.todoNotes).where(eq(dbSchema.todoNotes.todoId, todoId));
    expect(thread.map((note: { kind: string }) => note.kind).sort()).toEqual(['note', 'note', 'report']);

    expect(await marks()).toEqual([
      { todoId, notes: 2, lastRun: null, reason: null, runId: null, attempts: 0, maxAttempts: null },
    ]);
  });

  it('says a reviewer sent it back, with the reason and the run', async () => {
    await setLane(board.person, board.lanes[0].id, { contract: 'verdict', onFailureLaneId: board.lanes[1].id });
    const todoId = await board.addTodo('Review it');
    const runId = await runOnce(todoId, { status: 'ok', output: 'FAIL: the second paragraph is missing.' });

    const [mark] = await marks();
    expect(mark).toMatchObject({ todoId, lastRun: 'rejected', runId, attempts: 1, maxAttempts: null });
    expect(mark.reason).toContain('the second paragraph is missing');
  });

  it('says a run errored, apart from being rejected, and how many attempts are used', async () => {
    await setLane(board.person, board.lanes[0].id, { maxAttempts: 2 });
    const todoId = await board.addTodo('Write it');
    await runOnce(todoId, { status: 'error', error: 'The model did not answer.' });
    const runId = await runOnce(todoId, { status: 'error', error: 'The endpoint refused.' });

    expect(await marks()).toEqual([
      {
        todoId,
        notes: 0,
        lastRun: 'errored',
        reason: 'The endpoint refused.',
        runId,
        attempts: 2,
        maxAttempts: 2,
      },
    ]);
  });

  it('counts attempts as aiStatus counts failures, and forgets them when a person retries', async () => {
    const todoId = await board.addTodo('Write it');
    await runOnce(todoId, { status: 'error', error: 'No.' });
    const { todos } = (await board.person.expectOk(AI_STATUS, { projectId: board.projectId })).aiStatus;
    const [mark] = await marks();
    expect(mark.attempts).toBe(todos[0].failures);
    expect(mark.attempts).toBe(1);

    await board.person.expectOk(`mutation ($id: ID!) { retryTodo(id: $id) }`, { id: todoId });
    // The last run still errored; the count starts over.
    expect(await marks()).toMatchObject([{ todoId, lastRun: 'errored', attempts: 0 }]);
  });

  it('drops the mark once a later run passes, and ignores a run that was called off', async () => {
    const todoId = await board.addTodo('Write it');
    await runOnce(todoId, { status: 'error', error: 'No.' });
    await runOnce(todoId, { status: 'stopped' });
    expect(await marks()).toMatchObject([{ todoId, lastRun: 'errored' }]);

    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: board.lanes[1].id });
    await runOnce(todoId, { status: 'ok', output: 'Wrote it.' });
    expect(await marks()).toMatchObject([{ todoId, lastRun: null, reason: null, runId: null, attempts: 1 }]);
  });

  it('leaves archived todos out', async () => {
    const todoId = await board.addTodo('Old');
    await board.person.expectOk(NOTE, { todoId, body: 'A note.' });
    expect(await marks()).toHaveLength(1);
    await db.update(dbSchema.todos).set({ archivedAt: new Date() }).where(eq(dbSchema.todos.id, todoId));
    expect(await marks()).toEqual([]);
  });

  it('keeps to notes while AI is off for the project or the account', async () => {
    const todoId = await board.addTodo('Write it');
    await board.person.expectOk(NOTE, { todoId, body: 'A note.' });
    await runOnce(todoId, { status: 'error', error: 'No.' });
    expect(await marks()).toMatchObject([{ notes: 1, lastRun: 'errored', attempts: 1 }]);

    const notesOnly = [{ todoId, notes: 1, lastRun: null, reason: null, runId: null, attempts: 0, maxAttempts: null }];
    await board.person.expectOk(`mutation ($id: ID!) { setProjectAiEnabled(projectId: $id, enabled: false) { id } }`, {
      id: board.projectId,
    });
    expect(await marks()).toEqual(notesOnly);

    await board.person.expectOk(`mutation ($id: ID!) { setProjectAiEnabled(projectId: $id, enabled: true) { id } }`, {
      id: board.projectId,
    });
    await db.update(dbSchema.users).set({ aiEnabled: false }).where(eq(dbSchema.users.id, board.userId));
    expect(await marks()).toEqual(notesOnly);
  });

  it('answers with notes where the server offers no AI at all', async () => {
    const todoId = await board.addTodo('Write it');
    await board.person.expectOk(NOTE, { todoId, body: 'A note.' });
    await runOnce(todoId, { status: 'error', error: 'No.' });
    expect(await marks(createClient(db, board.userId))).toMatchObject([
      { todoId, notes: 1, lastRun: null, attempts: 0 },
    ]);
  });

  it("does not find someone else's project", async () => {
    const otherId = await createUser(db, 'other@example.com');
    const error = await createClient(db, otherId, { ai: true }).expectError(MARKS, { projectId: board.projectId });
    expect(error.code).toBe('NOT_FOUND');
  });

  it('is a person’s: an API key is refused', async () => {
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: KEY_ID },
    });
    const error = await key.expectError(MARKS, { projectId: board.projectId });
    expect(error.code).toBe('FORBIDDEN');
  });
});
