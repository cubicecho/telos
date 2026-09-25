import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, CLAIM, createBoard, FINISH, QUEUE, runnerClient, setLane } from './board.ts';
import { createTestDb, type TestClient, type TestDb } from './helpers.ts';

// The stations as a person reads them, and sending a todo round again.

let db: TestDb;
let board: Board;
let runner: TestClient;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

const STATUS = `query ($projectId: ID) {
  aiStatus(projectId: $projectId) {
    todos { todoId title laneId state reason failures liveRunId }
    projects { projectId name lanes { laneId name station isDone attention running blocked queued parked done } }
    runnerSeenAt
  }
}`;

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function status(): Promise<any> {
  return (await board.person.expectOk(STATUS, { projectId: board.projectId })).aiStatus;
}

async function fail(todoId: string): Promise<void> {
  const claim = (await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id })).claimRun;
  await runner.expectOk(FINISH, { id: claim.runId, result: { status: 'error', error: 'It broke.' } });
}

describe('aiStatus', () => {
  it('says where each open todo stands, and counts each lane', async () => {
    const queued = await board.addTodo('Queued');
    const running = await board.addTodo('Running');
    await setLane(board.person, board.lanes[0].id, { wipLimit: 2 });
    const blocked = await board.addTodo('Blocked');
    await board.person.expectOk(
      `mutation ($a: ID!, $b: ID!) { addTodoDependency(todoId: $a, dependsOnTodoId: $b) { id } }`,
      { a: blocked, b: queued },
    );
    const parked = await board.addTodo('Parked');
    await board.person.expectOk(`mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`, {
      id: parked,
      laneId: board.lanes[1].id,
    });
    const run = (await runner.expectOk(CLAIM, { todoId: running, laneId: board.lanes[0].id })).claimRun;

    const now = await status();
    const byId = new Map(now.todos.map((todo: { todoId: string }) => [todo.todoId, todo]));
    expect(byId.get(queued)).toMatchObject({ state: 'queued', reason: null });
    expect(byId.get(running)).toMatchObject({ state: 'running', liveRunId: run.runId });
    expect(byId.get(blocked)).toMatchObject({ state: 'blocked', reason: 'Waiting on Queued.' });
    expect(byId.get(parked)).toMatchObject({ state: 'parked', reason: 'In progress has no agent.' });

    const [project] = now.projects;
    expect(project.lanes[0]).toMatchObject({ station: true, queued: 1, running: 1, blocked: 1 });
    expect(project.lanes[1]).toMatchObject({ station: false, parked: 1 });
  });

  it('asks for a person when a station gives up, and retryTodo sends it round again', async () => {
    await setLane(board.person, board.lanes[0].id, { maxAttempts: 1 });
    const todoId = await board.addTodo('Flaky');
    await fail(todoId);
    await fail(todoId);
    expect((await runner.expectOk(QUEUE)).runnerQueue).toEqual([]);

    const [stuck] = (await status()).todos;
    expect(stuck).toMatchObject({ state: 'attention', reason: 'It broke.', failures: 2 });

    await board.person.expectOk(`mutation ($id: ID!) { retryTodo(id: $id, reason: "Try the other way.") }`, {
      id: todoId,
    });
    expect((await status()).todos[0]).toMatchObject({ state: 'queued', failures: 0 });
    expect((await runner.expectOk(QUEUE)).runnerQueue).toEqual([
      { todoId, laneId: board.lanes[0].id, projectId: board.projectId },
    ]);
  });

  it('asks for a person when a station finished with a todo and has nowhere to send it', async () => {
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: null });
    const todoId = await board.addTodo('Written');
    const claim = (await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id })).claimRun;
    await runner.expectOk(FINISH, { id: claim.runId, result: { status: 'ok', output: 'Done.' } });
    expect((await status()).todos[0]).toMatchObject({
      state: 'attention',
      reason: 'To do finished with it and has nowhere to send it.',
    });
    await board.person.expectOk(`mutation ($id: ID!) { retryTodo(id: $id) }`, { id: todoId });
    expect((await status()).todos[0].state).toBe('queued');
  });

  it('knows when the runner last asked for work', async () => {
    await runner.expectOk(QUEUE);
    expect(Date.parse((await status()).runnerSeenAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('refuses a retry while an agent works the todo', async () => {
    const todoId = await board.addTodo('Busy');
    await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id });
    const error = await board.person.expectError(`mutation ($id: ID!) { retryTodo(id: $id) }`, { id: todoId });
    expect(error.code).toBe('CONFLICT');
  });

  it('is not there for someone with AI off', async () => {
    await board.person.expectOk(`mutation { setAiEnabled(enabled: false) { id } }`);
    const error = await board.person.expectError(STATUS, { projectId: board.projectId });
    expect(error.code).toBe('NOT_FOUND');
  });
});
