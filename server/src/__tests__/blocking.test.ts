import { beforeEach, describe, expect, it } from 'vitest';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// A todo with an open dependency cannot be completed. The rule has to hold
// whichever door the write arrives at, so every path is exercised: the
// ergonomic mutation, the generated single update, and the generated bulk one.

const CREATE_PROJECT = `mutation { createProject(values: { name: "P" }) { id } }`;
const CREATE_TODO = `mutation ($projectId: UUID!, $title: String!) {
  createTodo(values: { projectId: $projectId, title: $title }) { id }
}`;

let db: TestDb;
let client: TestClient;
let projectId: string;

async function newTodo(title: string): Promise<string> {
  const data = await client.expectOk(CREATE_TODO, { projectId, title });
  return data.createTodo.id as string;
}

beforeEach(async () => {
  db = await createTestDb();
  client = createClient(db, await createUser(db, 'owner@example.com'));
  projectId = (await client.expectOk(CREATE_PROJECT)).createProject.id;
});

describe('blocking', () => {
  it('reports a todo with an open dependency as blocked, and names the blocker', async () => {
    const blocker = await newTodo('Blocker');
    const blocked = await newTodo('Blocked');
    await client.expectOk(`mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id } }`, {
      t: blocked,
      d: blocker,
    });

    const data = await client.expectOk(`query { todos { id title isBlocked blockedBy { id title } } }`);
    const byId = Object.fromEntries(data.todos.map((todo: { id: string }) => [todo.id, todo]));
    expect(byId[blocked].isBlocked).toBe(true);
    expect(byId[blocked].blockedBy).toEqual([{ id: blocker, title: 'Blocker' }]);
    expect(byId[blocker].isBlocked).toBe(false);
    expect(byId[blocker].blockedBy).toEqual([]);
  });

  it('refuses completeTodo while the dependency is open', async () => {
    const blocker = await newTodo('Blocker');
    const blocked = await newTodo('Blocked');
    await client.expectOk(`mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id } }`, {
      t: blocked,
      d: blocker,
    });

    const error = await client.expectError(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: blocked });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('Blocker');
  });

  it('refuses the generated updates that would set completedAt directly', async () => {
    const blocker = await newTodo('Blocker');
    const blocked = await newTodo('Blocked');
    await client.expectOk(`mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id } }`, {
      t: blocked,
      d: blocker,
    });

    const single = await client.expectError(
      `mutation ($id: UUID!, $at: DateTime!) {
        updateTodoSingle(set: { completedAt: $at }, where: { id: { eq: $id } }) { id }
      }`,
      { id: blocked, at: new Date().toISOString() },
    );
    expect(single.code).toBe('BAD_USER_INPUT');

    const bulk = await client.expectError(
      `mutation ($id: UUID!, $at: DateTime!) {
        updateTodo(set: { completedAt: $at }, where: { id: { eq: $id } }) { id }
      }`,
      { id: blocked, at: new Date().toISOString() },
    );
    expect(bulk.code).toBe('BAD_USER_INPUT');

    // A rejected write rolls back whole, so nothing is left completed.
    const after = await client.expectOk(`query { todos { id completedAt } }`);
    expect(after.todos.every((todo: { completedAt: string | null }) => todo.completedAt === null)).toBe(true);
  });

  it('allows a bulk write that completes a blocker and its dependent together', async () => {
    const blocker = await newTodo('Blocker');
    const blocked = await newTodo('Blocked');
    await client.expectOk(`mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id } }`, {
      t: blocked,
      d: blocker,
    });

    // The rule is an invariant over the state a write leaves behind, not an
    // order of operations: finishing both in one statement is consistent, since
    // no completed todo is left waiting on an open one.
    await client.expectOk(`mutation ($at: DateTime!) { updateTodo(set: { completedAt: $at }, where: {}) { id } }`, {
      at: new Date().toISOString(),
    });
    const data = await client.expectOk(`query { todos { completedAt } }`);
    expect(data.todos.every((todo: { completedAt: string | null }) => todo.completedAt !== null)).toBe(true);
  });

  it('unblocks once the blocker is completed', async () => {
    const blocker = await newTodo('Blocker');
    const blocked = await newTodo('Blocked');
    await client.expectOk(`mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id } }`, {
      t: blocked,
      d: blocker,
    });

    await client.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: blocker });
    const data = await client.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id completedAt isBlocked } }`, {
      id: blocked,
    });
    expect(data.completeTodo.completedAt).not.toBeNull();
    expect(data.completeTodo.isBlocked).toBe(false);
  });

  it('blocks again when the blocker is reopened', async () => {
    const blocker = await newTodo('Blocker');
    const blocked = await newTodo('Blocked');
    await client.expectOk(`mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id } }`, {
      t: blocked,
      d: blocker,
    });
    await client.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: blocker });
    await client.expectOk(`mutation ($id: ID!) { reopenTodo(id: $id) { id } }`, { id: blocker });

    const error = await client.expectError(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: blocked });
    expect(error.code).toBe('BAD_USER_INPUT');
  });

  it('counts open and total todos per project', async () => {
    const first = await newTodo('One');
    await newTodo('Two');
    await client.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: first });

    const data = await client.expectOk(`query { projects { todoCount openTodoCount } }`);
    expect(data.projects[0]).toEqual({ todoCount: 2, openTodoCount: 1 });
  });
});
