import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, CLAIM, createBoard, QUEUE, runnerClient } from './board.ts';
import { createTestDb, type TestClient, type TestDb } from './helpers.ts';

// Deleting a todo archives it: out of every list, count and queue, but kept,
// with its history, until someone restores it or deletes it for good.

let db: TestDb;
let board: Board;
let runner: TestClient;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

const ARCHIVE = `mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id archivedAt } }`;
const RESTORE = `mutation ($id: UUID!) { restoreTodo(where: { id: { eq: $id } }) { id archivedAt } }`;
const PURGE = `mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }, hard: true) { id } }`;

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function lists(): Promise<any> {
  return board.person.expectOk(
    `query ($projectId: UUID!) {
      live: todos(where: { projectId: { eq: $projectId } }) { id }
      archived: todos(where: { projectId: { eq: $projectId } }, deleted: ONLY) { id title }
      project(where: { id: { eq: $projectId } }) { todoCount openTodoCount }
    }`,
    { projectId: board.projectId },
  );
}

describe('archiving a todo', () => {
  it('takes it out of the lists, the counts and the queue, and restores it', async () => {
    const kept = await board.addTodo('Kept');
    const gone = await board.addTodo('Gone');

    const archived = (await board.person.expectOk(ARCHIVE, { id: gone })).deleteTodo;
    expect(archived.archivedAt).not.toBeNull();

    let now = await lists();
    expect(now.live.map((row: { id: string }) => row.id)).toEqual([kept]);
    expect(now.archived).toEqual([{ id: gone, title: 'Gone' }]);
    expect(now.project).toEqual({ todoCount: 1, openTodoCount: 1 });
    const queue = (await runner.expectOk(QUEUE)).runnerQueue.map((row: { todoId: string }) => row.todoId);
    expect(queue).not.toContain(gone);

    await board.person.expectOk(RESTORE, { id: gone });
    now = await lists();
    expect(now.live).toHaveLength(2);
    expect(now.archived).toEqual([]);

    const history = (
      await board.person.expectOk(`query ($id: UUID!) { todo(where: { id: { eq: $id } }) { history { kind } } }`, {
        id: gone,
      })
    ).todo.history.map((event: { kind: string }) => event.kind);
    expect(history).toEqual(expect.arrayContaining(['create', 'archive', 'restore']));
  });

  it('stops the agent working it', async () => {
    const todo = await board.addTodo('Busy');
    const claim = (await runner.expectOk(CLAIM, { todoId: todo, laneId: board.lanes[0].id })).claimRun;
    await board.person.expectOk(ARCHIVE, { id: todo });
    const heartbeat = await runner.expectOk(`mutation ($id: ID!) { heartbeatRun(id: $id) }`, { id: claim.runId });
    expect(heartbeat.heartbeatRun).toBe(true);
  });

  it('no longer blocks what waited on it', async () => {
    const first = await board.addTodo('First');
    const second = await board.addTodo('Second');
    await board.person.expectOk(
      `mutation ($a: ID!, $b: ID!) { addTodoDependency(todoId: $a, dependsOnTodoId: $b) { id } }`,
      { a: second, b: first },
    );
    await board.person.expectOk(ARCHIVE, { id: first });
    const todo = (
      await board.person.expectOk(`query ($id: UUID!) { todo(where: { id: { eq: $id } }) { isBlocked } }`, {
        id: second,
      })
    ).todo;
    expect(todo.isBlocked).toBe(false);
    await board.person.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: second });
  });

  it('cannot be moved, completed or edited while archived', async () => {
    const todo = await board.addTodo('Away');
    await board.person.expectOk(ARCHIVE, { id: todo });
    const moved = await board.person.expectError(
      `mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`,
      { id: todo, laneId: board.lanes[1].id },
    );
    expect(moved.code).toBe('NOT_FOUND');
    const completed = await board.person.expectError(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, {
      id: todo,
    });
    expect(completed.code).toBe('NOT_FOUND');
    const edited = await board.person.expectOk(
      `mutation ($id: UUID!) { updateTodo(where: { id: { eq: $id } }, set: { title: "New" }) { id } }`,
      { id: todo },
    );
    expect(edited.updateTodo).toBeNull();
  });

  it('deletes it for good, and only its owner can', async () => {
    const todo = await board.addTodo('Doomed');
    await board.person.expectOk(ARCHIVE, { id: todo });
    const other = await createBoard(db, 'other@example.com');
    expect((await other.person.expectOk(PURGE, { id: todo })).deleteTodo).toBeNull();
    expect((await lists()).archived).toHaveLength(1);

    await board.person.expectOk(PURGE, { id: todo });
    expect((await lists()).archived).toEqual([]);
  });
});
