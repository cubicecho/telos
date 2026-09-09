import { beforeEach, describe, expect, it } from 'vitest';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// Dependency edges form a DAG. A cycle is a deadlock — every todo in it waits on
// another and none can ever be completed — so the graph is checked on the way in.

const ADD = `mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id isBlocked } }`;
const REMOVE = `mutation ($t: ID!, $d: ID!) { removeTodoDependency(todoId: $t, dependsOnTodoId: $d) { id isBlocked } }`;

let db: TestDb;
let client: TestClient;
let projectId: string;

async function newTodo(title: string): Promise<string> {
  const data = await client.expectOk(
    `mutation ($projectId: UUID!, $title: String!) {
      createTodo(values: { projectId: $projectId, title: $title }) { id }
    }`,
    { projectId, title },
  );
  return data.createTodo.id as string;
}

beforeEach(async () => {
  db = await createTestDb();
  client = createClient(db, await createUser(db, 'owner@example.com'));
  projectId = (await client.expectOk(`mutation { createProject(values: { name: "P" }) { id } }`)).createProject.id;
});

describe('dependency edges', () => {
  it('rejects a todo depending on itself', async () => {
    const a = await newTodo('A');
    const error = await client.expectError(ADD, { t: a, d: a });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('itself');
  });

  it('rejects a direct cycle', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    await client.expectOk(ADD, { t: a, d: b });

    const error = await client.expectError(ADD, { t: b, d: a });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('cycle');
  });

  it('rejects a transitive cycle', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    const c = await newTodo('C');
    await client.expectOk(ADD, { t: a, d: b });
    await client.expectOk(ADD, { t: b, d: c });

    // A → B → C already; C → A would close the loop.
    const error = await client.expectError(ADD, { t: c, d: a });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('cycle');
  });

  it('accepts a diamond, which is not a cycle', async () => {
    const top = await newTodo('Top');
    const left = await newTodo('Left');
    const right = await newTodo('Right');
    const bottom = await newTodo('Bottom');
    await client.expectOk(ADD, { t: top, d: left });
    await client.expectOk(ADD, { t: top, d: right });
    await client.expectOk(ADD, { t: left, d: bottom });
    await client.expectOk(ADD, { t: right, d: bottom });

    const data = await client.expectOk(`query { todos { id isBlocked } }`);
    const blocked = data.todos.filter((todo: { isBlocked: boolean }) => todo.isBlocked).length;
    expect(blocked).toBe(3);
  });

  it('is idempotent — adding the same edge twice changes nothing', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    await client.expectOk(ADD, { t: a, d: b });
    await client.expectOk(ADD, { t: a, d: b });

    const data = await client.expectOk(`query { todos(where: { id: { eq: "${a}" } }) { blockedBy { id } } }`);
    expect(data.todos[0].blockedBy).toHaveLength(1);
  });

  it('removes an edge, unblocking the todo', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    await client.expectOk(ADD, { t: a, d: b });

    const data = await client.expectOk(REMOVE, { t: a, d: b });
    expect(data.removeTodoDependency.isBlocked).toBe(false);
  });

  it('refuses to make a completed todo depend on an open one', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    await client.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: a });

    // Otherwise the todo would be completed and blocked at once, and isBlocked
    // would stop meaning "cannot be completed".
    const error = await client.expectError(ADD, { t: a, d: b });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('Reopen');
  });

  it('exposes no generated mutations for the dependency table', async () => {
    // The custom mutations own the graph; a generated createTodoDependency
    // would let a caller close a cycle without ever meeting assertNoCycle.
    const data = await client.expectOk(`query { __schema { mutationType { fields { name } } } }`);
    const names: string[] = data.__schema.mutationType.fields.map((field: { name: string }) => field.name);
    expect(names.filter((name) => name.toLowerCase().includes('tododependenc')).sort()).toEqual([
      'addTodoDependency',
      'removeTodoDependency',
    ]);
  });
});
