import { beforeEach, describe, expect, it } from 'vitest';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// The board and the list are two renderings of the same todos, so the thing
// worth testing is that they cannot come to disagree: whichever way completion
// or a lane is written, `completed <=> in the done lane` still holds afterwards.

const CREATE_PROJECT = `mutation { createProject(values: { name: "P" }) { id } }`;
const CREATE_TODO = `mutation ($projectId: UUID!, $title: String!) {
  createTodo(values: { projectId: $projectId, title: $title }) { id }
}`;
const LANES = `query ($projectId: UUID!) {
  lanes(where: { projectId: { eq: $projectId } }, orderBy: { position: { direction: asc, priority: 1 } }) {
    id name position isDone
  }
}`;
const TODO = `query ($id: UUID!) {
  todo(where: { id: { eq: $id } }) { id completedAt lane { id name isDone } }
}`;
const MOVE = `mutation ($id: ID!, $laneId: ID!, $position: Int) {
  moveTodo(id: $id, laneId: $laneId, position: $position) { id completedAt }
}`;

let db: TestDb;
let client: TestClient;
let projectId: string;
let lanes: Array<{ id: string; name: string; position: number; isDone: boolean }>;

async function newTodo(title: string): Promise<string> {
  return (await client.expectOk(CREATE_TODO, { projectId, title })).createTodo.id as string;
}

async function readLanes(): Promise<typeof lanes> {
  return (await client.expectOk(LANES, { projectId })).lanes;
}

async function readTodo(id: string) {
  return (await client.expectOk(TODO, { id })).todo;
}

beforeEach(async () => {
  db = await createTestDb();
  client = createClient(db, await createUser(db, 'owner@example.com'));
  projectId = (await client.expectOk(CREATE_PROJECT)).createProject.id;
  lanes = await readLanes();
});

describe('seeding', () => {
  it('gives a new project a board, with exactly one lane meaning done', () => {
    expect(lanes.map((lane) => lane.name)).toEqual(['To do', 'In progress', 'Done']);
    expect(lanes.filter((lane) => lane.isDone).map((lane) => lane.name)).toEqual(['Done']);
  });

  it('refuses to remove a project’s last lane', async () => {
    await client.expectOk(`mutation ($id: UUID!) { deleteLane(where: { id: { eq: $id } }) { id } }`, {
      id: lanes[0].id,
    });
    await client.expectOk(`mutation ($id: UUID!) { deleteLane(where: { id: { eq: $id } }) { id } }`, {
      id: lanes[1].id,
    });
    const error = await client.expectError(`mutation ($id: UUID!) { deleteLane(where: { id: { eq: $id } }) { id } }`, {
      id: lanes[2].id,
    });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(await readLanes()).toHaveLength(1);
  });
});

describe('moveTodo', () => {
  it('completes a todo dropped into the done lane and reopens it on the way out', async () => {
    const id = await newTodo('Write it');
    const done = lanes.find((lane) => lane.isDone)!;

    await client.expectOk(MOVE, { id, laneId: done.id });
    expect((await readTodo(id)).completedAt).not.toBeNull();

    await client.expectOk(MOVE, { id, laneId: lanes[1].id });
    const reopened = await readTodo(id);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.lane.name).toBe('In progress');
  });

  it('refuses to drop a blocked todo into the done lane', async () => {
    const blocker = await newTodo('Blocker');
    const blocked = await newTodo('Blocked');
    await client.expectOk(`mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id } }`, {
      t: blocked,
      d: blocker,
    });

    const error = await client.expectError(MOVE, { id: blocked, laneId: lanes.find((l) => l.isDone)!.id });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('Blocker');
    // The refusal is total: the todo did not quietly change columns either.
    expect((await readTodo(blocked)).lane.name).toBe('To do');
  });

  it('refuses to advance a blocked todo to any other lane', async () => {
    const blocker = await newTodo('Blocker');
    const blocked = await newTodo('Blocked');
    await client.expectOk(`mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id } }`, {
      t: blocked,
      d: blocker,
    });

    // Not the done lane — work that is waiting on something else has no
    // business being called "in progress" either.
    const error = await client.expectError(MOVE, { id: blocked, laneId: lanes[1].id });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('Blocker');
    expect((await readTodo(blocked)).lane.name).toBe('To do');

    // Completing the blocker is what frees it.
    await client.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: blocker });
    await client.expectOk(MOVE, { id: blocked, laneId: lanes[1].id });
    expect((await readTodo(blocked)).lane.name).toBe('In progress');
  });

  it('still reorders a blocked todo inside its own lane', async () => {
    const blocker = await newTodo('Blocker');
    const a = await newTodo('A');
    const blocked = await newTodo('Blocked');
    await client.expectOk(`mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id } }`, {
      t: blocked,
      d: blocker,
    });

    await client.expectOk(MOVE, { id: blocked, laneId: lanes[0].id, position: 0 });

    const ordered = (
      await client.expectOk(
        `query ($projectId: UUID!) {
          todos(where: { projectId: { eq: $projectId } }, orderBy: { position: { direction: asc, priority: 1 } }) { id }
        }`,
        { projectId },
      )
    ).todos;
    expect(ordered.map((todo: { id: string }) => todo.id)).toEqual([blocked, blocker, a]);
  });

  it('refuses a lane from another project', async () => {
    const id = await newTodo('Write it');
    const otherProject = (await client.expectOk(CREATE_PROJECT)).createProject.id;
    const otherLanes = (await client.expectOk(LANES, { projectId: otherProject })).lanes;

    const error = await client.expectError(MOVE, { id, laneId: otherLanes[0].id });
    expect(error.code).toBe('BAD_USER_INPUT');
  });

  it('reorders within a lane without disturbing the other lanes’ order', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    const c = await newTodo('C');
    const [todoLane, doing] = lanes;

    await client.expectOk(MOVE, { id: b, laneId: doing.id, position: 0 });
    // C to the front of the lane it is already in, ahead of A.
    await client.expectOk(MOVE, { id: c, laneId: todoLane.id, position: 0 });

    const ordered = (
      await client.expectOk(
        `query ($projectId: UUID!) {
          todos(where: { projectId: { eq: $projectId } }, orderBy: { position: { direction: asc, priority: 1 } }) {
            id lane { name }
          }
        }`,
        { projectId },
      )
    ).todos;
    expect(ordered.map((todo: { id: string }) => todo.id)).toEqual([c, a, b]);
    expect(ordered.map((todo: { lane: { name: string } }) => todo.lane.name)).toEqual([
      'To do',
      'To do',
      'In progress',
    ]);
  });
});

describe('completeTodo and the board', () => {
  it('moves a ticked todo into the done lane and back out when reopened', async () => {
    const id = await newTodo('Write it');
    await client.expectOk(MOVE, { id, laneId: lanes[1].id });

    await client.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id });
    expect((await readTodo(id)).lane.name).toBe('Done');

    await client.expectOk(`mutation ($id: ID!) { reopenTodo(id: $id) { id } }`, { id });
    expect((await readTodo(id)).lane.name).toBe('To do');
  });
});

describe('setDoneLane', () => {
  const SET_DONE = `mutation ($projectId: ID!, $laneId: ID) {
    setDoneLane(projectId: $projectId, laneId: $laneId) { id name isDone }
  }`;

  it('moves the flag, and the todos’ completion with it', async () => {
    const shipped = await newTodo('Shipped');
    const doing = await newTodo('Doing');
    await client.expectOk(MOVE, { id: shipped, laneId: lanes[2].id });
    await client.expectOk(MOVE, { id: doing, laneId: lanes[1].id });

    const updated = (await client.expectOk(SET_DONE, { projectId, laneId: lanes[1].id })).setDoneLane;
    expect(
      updated.filter((lane: { isDone: boolean }) => lane.isDone).map((lane: { name: string }) => lane.name),
    ).toEqual(['In progress']);
    expect((await readTodo(doing)).completedAt).not.toBeNull();
    expect((await readTodo(shipped)).completedAt).toBeNull();
  });

  it('clears the flag entirely without reopening finished work', async () => {
    const shipped = await newTodo('Shipped');
    await client.expectOk(MOVE, { id: shipped, laneId: lanes[2].id });

    const updated = (await client.expectOk(SET_DONE, { projectId, laneId: null })).setDoneLane;
    expect(updated.some((lane: { isDone: boolean }) => lane.isDone)).toBe(false);
    expect((await readTodo(shipped)).completedAt).not.toBeNull();
  });

  it('refuses to flag a lane holding blocked work', async () => {
    const blocker = await newTodo('Blocker');
    const blocked = await newTodo('Blocked');
    // Moved first and blocked after: a todo already in the lane is how blocked
    // work gets there at all, since a blocked todo cannot be moved into one.
    await client.expectOk(MOVE, { id: blocked, laneId: lanes[1].id });
    await client.expectOk(`mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id } }`, {
      t: blocked,
      d: blocker,
    });

    const error = await client.expectError(SET_DONE, { projectId, laneId: lanes[1].id });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect((await readLanes()).find((lane) => lane.isDone)?.name).toBe('Done');
  });
});

describe('reorderLanes', () => {
  const REORDER = `mutation ($projectId: ID!, $laneIds: [ID!]!) {
    reorderLanes(projectId: $projectId, laneIds: $laneIds) { id name position }
  }`;

  it('rewrites order from the given ids', async () => {
    const reversed = [...lanes].reverse().map((lane) => lane.id);
    const updated = (await client.expectOk(REORDER, { projectId, laneIds: reversed })).reorderLanes;
    expect(updated.map((lane: { name: string }) => lane.name)).toEqual(['Done', 'In progress', 'To do']);
  });

  it('refuses a list that is not every lane exactly once', async () => {
    const partial = await client.expectError(REORDER, { projectId, laneIds: [lanes[0].id] });
    expect(partial.code).toBe('BAD_USER_INPUT');

    const duplicated = await client.expectError(REORDER, {
      projectId,
      laneIds: [lanes[0].id, lanes[0].id, lanes[1].id],
    });
    expect(duplicated.code).toBe('BAD_USER_INPUT');
  });
});

describe('generated writes', () => {
  it('reserves the done flag for setDoneLane', async () => {
    const error = await client.expectError(
      `mutation ($id: UUID!) { updateLane(set: { isDone: true }, where: { id: { eq: $id } }) { id } }`,
      { id: lanes[0].id },
    );
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('setDoneLane');
  });

  it('moves the lane to match when a generated write states completion', async () => {
    const id = await newTodo('Write it');
    await client.expectOk(
      `mutation ($id: UUID!, $at: DateTime!) {
        updateTodo(set: { completedAt: $at }, where: { id: { eq: $id } }) { id }
      }`,
      { id, at: new Date().toISOString() },
    );
    expect((await readTodo(id)).lane.name).toBe('Done');

    await client.expectOk(`mutation ($id: ID!) { reopenTodo(id: $id) { id } }`, { id });
    expect((await readTodo(id)).lane.name).toBe('To do');
  });

  it('refuses a generated write that only moves the lane, pointing at moveTodo', async () => {
    const id = await newTodo('Write it');
    const error = await client.expectError(
      `mutation ($id: UUID!, $laneId: UUID!) {
        updateTodo(set: { laneId: $laneId }, where: { id: { eq: $id } }) { id }
      }`,
      { id, laneId: lanes[2].id },
    );
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('moveTodo');
    expect((await readTodo(id)).lane.name).toBe('To do');
  });

  it('gives a todo created without one the project’s first lane', async () => {
    expect((await readTodo(await newTodo('Fresh'))).lane.name).toBe('To do');
  });

  it('rehomes a lane’s todos when the lane is deleted', async () => {
    const id = await newTodo('Write it');
    await client.expectOk(MOVE, { id, laneId: lanes[1].id });
    await client.expectOk(`mutation ($id: UUID!) { deleteLane(where: { id: { eq: $id } }) { id } }`, {
      id: lanes[1].id,
    });
    expect((await readTodo(id)).lane.name).toBe('To do');
  });

  it('refuses another user’s lane on a todo', async () => {
    const intruder = createClient(db, await createUser(db, 'other@example.com'));
    const theirProject = (await intruder.expectOk(CREATE_PROJECT)).createProject.id;
    const theirLanes = (await intruder.expectOk(LANES, { projectId: theirProject })).lanes;

    const error = await client.expectError(CREATE_TODO_WITH_LANE, {
      projectId,
      title: 'Sneaky',
      laneId: theirLanes[0].id,
    });
    expect(error.code).toBe('NOT_FOUND');
  });
});

const CREATE_TODO_WITH_LANE = `mutation ($projectId: UUID!, $title: String!, $laneId: UUID!) {
  createTodo(values: { projectId: $projectId, title: $title, laneId: $laneId }) { id }
}`;
