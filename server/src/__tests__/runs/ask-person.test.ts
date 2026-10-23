import { randomUUID } from 'node:crypto';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { QUESTION_PREFIX } from '../../runs/resolvers.ts';
import { type Board, CLAIM, createBoard, FINISH, QUEUE, runnerClient } from '../board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from '../helpers.ts';

// An agent that asks a person and waits. The run ends as `asked` with its
// question on the thread, costing no attempt; the todo is held out of the
// queue until a person (or their own MCP client) writes a note after the
// question; and the next run is handed both.

let db: TestDb;
let board: Board;
let runner: TestClient;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

const ANSWER = `mutation ($todoId: ID!, $text: String!) { answerTodo(todoId: $todoId, text: $text) { id kind actorKind body } }`;
const ADD_NOTE = `mutation ($todoId: UUID!, $body: String!) { createTodoNote(values: { todoId: $todoId, body: $body }) { id } }`;
const STATUS = `query ($projectId: ID) { aiStatus(projectId: $projectId) { todos { todoId state reason failures } projects { lanes { laneId asked } } } }`;
const QUESTION = `query ($id: UUID!) { todo(where: { id: { eq: $id } }) { question } }`;
const MARKS = `query ($projectId: ID!) { cardMarks(projectId: $projectId) { todoId question } }`;
const RUN = `mutation ($id: ID!) { runTodo(id: $id) { id } }`;

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function queue(): Promise<any[]> {
  return (await runner.expectOk(QUEUE)).runnerQueue;
}

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function claim(todoId: string): Promise<any> {
  return (await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id })).claimRun;
}

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function finish(runId: string, result: Record<string, unknown>): Promise<any> {
  return (await runner.expectOk(FINISH, { id: runId, result })).finishRun;
}

/** A todo whose run asked `question`, and that run. */
async function asked(question = 'Which database should it use?') {
  const todoId = await board.addTodo('Store the settings');
  const { runId } = await claim(todoId);
  const run = await finish(runId, { status: 'ASKED', question, totalTokens: 12 });
  return { todoId, runId, run };
}

async function thread(todoId: string) {
  return db.select().from(dbSchema.todoNotes).where(eq(dbSchema.todoNotes.todoId, todoId));
}

function keyClient(): TestClient {
  return createClient(db, board.userId, {
    ai: true,
    actor: { kind: 'apiKey', userId: board.userId, keyId: randomUUID() },
  });
}

describe('asking a person', () => {
  it('ends the run as asked, with the question on the thread, and leaves the todo where it is', async () => {
    const { todoId, run } = await asked();
    expect(run).toMatchObject({
      status: 'asked',
      verdict: 'none',
      output: 'Which database should it use?',
      error: null,
    });
    expect(run.totalTokens).toBe(12);
    const notes = await thread(todoId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'question', actorKind: 'agent', body: 'Which database should it use?' });
    const [todo] = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, todoId));
    expect(todo.laneId).toBe(board.lanes[0].id);
  });

  it('uses up no attempt', async () => {
    const { todoId } = await asked();
    const { todos } = (await board.person.expectOk(STATUS, { projectId: board.projectId })).aiStatus;
    expect(todos.find((todo: { todoId: string }) => todo.todoId === todoId)).toMatchObject({
      state: 'ASKED',
      failures: 0,
      reason: 'Waiting on a person: Which database should it use?',
    });
  });

  it('fails a run that says it asked but asks nothing', async () => {
    const todoId = await board.addTodo('Store the settings');
    const { runId } = await claim(todoId);
    const run = await finish(runId, { status: 'ASKED', question: '   ' });
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/asked nothing/);
    expect(await thread(todoId)).toHaveLength(0);
  });

  it('writes nothing for a run stopped while it asked', async () => {
    const todoId = await board.addTodo('Store the settings');
    const { runId } = await claim(todoId);
    await board.person.expectOk(`mutation ($id: ID!) { cancelRun(id: $id) { id } }`, { id: runId });
    const run = await finish(runId, { status: 'ASKED', question: 'Which one?' });
    expect(run.status).toBe('stopped');
    expect(await thread(todoId)).toHaveLength(0);
  });
});

describe('waiting', () => {
  it('keeps the todo out of the queue until it is answered', async () => {
    const { todoId } = await asked();
    expect(await queue()).toEqual([]);
    expect(await claim(todoId)).toBeNull();

    await board.person.expectOk(ADD_NOTE, { todoId, body: 'Postgres.' });
    expect((await queue()).map((row) => row.todoId)).toEqual([todoId]);
  });

  it('says so on the todo, its card and its lane', async () => {
    const { todoId } = await asked();
    expect((await board.person.expectOk(QUESTION, { id: todoId })).todo.question).toBe('Which database should it use?');
    expect((await board.person.expectOk(MARKS, { projectId: board.projectId })).cardMarks).toEqual([
      { todoId, question: 'Which database should it use?' },
    ]);
    const { projects } = (await board.person.expectOk(STATUS, { projectId: board.projectId })).aiStatus;
    expect(projects[0].lanes.find((lane: { laneId: string }) => lane.laneId === board.lanes[0].id).asked).toBe(1);

    await board.person.expectOk(ANSWER, { todoId, text: 'Postgres.' });
    expect((await board.person.expectOk(QUESTION, { id: todoId })).todo.question).toBeNull();
  });

  it('will not be run past by runTodo', async () => {
    const { todoId } = await asked();
    const error = await board.person.expectError(RUN, { id: todoId });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toMatch(/asked a question/);
  });

  it('is answered only by a person or their own client', async () => {
    const { todoId, runId } = await asked();
    // An agent's note, or the server's, is not an answer: an agent could unblock itself.
    await db.insert(dbSchema.todoNotes).values([
      { userId: board.userId, todoId, kind: 'note', body: 'I will guess.', actorKind: 'agent', runId },
      { userId: board.userId, todoId, kind: 'note', body: 'Ping.', actorKind: 'system' },
    ]);
    expect(await queue()).toEqual([]);

    const answer = (await keyClient().expectOk(ANSWER, { todoId, text: 'SQLite is fine.' })).answerTodo;
    expect(answer).toMatchObject({ kind: 'note', actorKind: 'apiKey', body: 'SQLite is fine.' });
    expect((await queue()).map((row) => row.todoId)).toEqual([todoId]);
  });

  it('waits again for a second question', async () => {
    const { todoId } = await asked();
    await board.person.expectOk(ANSWER, { todoId, text: 'Postgres.' });
    const { runId } = await claim(todoId);
    await finish(runId, { status: 'ASKED', question: 'Which version?' });
    expect(await queue()).toEqual([]);
    await board.person.expectOk(ANSWER, { todoId, text: '17.' });
    expect((await queue()).map((row) => row.todoId)).toEqual([todoId]);
  });
});

describe('answerTodo', () => {
  it('refuses a todo with nothing to answer', async () => {
    const todoId = await board.addTodo('Store the settings');
    const error = await board.person.expectError(ANSWER, { todoId, text: 'Postgres.' });
    expect(error.code).toBe('BAD_USER_INPUT');
  });

  it('refuses a run', async () => {
    const { todoId } = await asked();
    const run = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'agent', userId: board.userId, runId: randomUUID() },
    });
    const error = await run.expectError(ANSWER, { todoId, text: 'Postgres.' });
    expect(error.code).toBe('FORBIDDEN');
    expect(await queue()).toEqual([]);
  });

  it("refuses someone else's todo", async () => {
    const { todoId } = await asked();
    const other = await createBoard(db, 'other@example.com');
    const error = await other.person.expectError(ANSWER, { todoId, text: 'Postgres.' });
    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('the next run', () => {
  it('is handed the question and its answer', async () => {
    const { todoId } = await asked();
    await board.person.expectOk(ANSWER, { todoId, text: 'Postgres.' });
    const { assignment } = await claim(todoId);
    expect(assignment.notes).toEqual([`${QUESTION_PREFIX}Which database should it use?`, 'Postgres.']);
  });
});
