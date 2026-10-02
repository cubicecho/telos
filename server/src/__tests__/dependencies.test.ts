import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// Dependency edges form a DAG. A cycle is a deadlock — every todo in it waits on
// another and none can ever be completed — so the graph is checked on the way in.

const ADD = `mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id isBlocked } }`;
const SET = `mutation ($id: ID!, $d: [ID!]!) { setTodoDependencies(id: $id, dependsOn: $d) { id isBlocked blockedBy { id } } }`;
const REMOVE = `mutation ($t: ID!, $d: ID!) { removeTodoDependency(todoId: $t, dependsOnTodoId: $d) { id isBlocked } }`;

let db: TestDb;
let client: TestClient;
let userId: string;
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
  userId = await createUser(db, 'owner@example.com');
  client = createClient(db, userId);
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
    expect(error.message).toContain('cycle: "B" waits on "A", which waits on "B".');
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
    expect(error.message).toContain('cycle: "C" waits on "A", which waits on "B", which waits on "C".');
  });

  it('names the short way round when a diamond offers two', async () => {
    const top = await newTodo('Top');
    const left = await newTodo('Left');
    const right = await newTodo('Right');
    const bottom = await newTodo('Bottom');
    await client.expectOk(ADD, { t: top, d: left });
    await client.expectOk(ADD, { t: left, d: right });
    await client.expectOk(ADD, { t: right, d: bottom });
    await client.expectOk(ADD, { t: top, d: bottom });

    const error = await client.expectError(ADD, { t: bottom, d: top });
    expect(error.message).toContain('"Bottom" waits on "Top", which waits on "Bottom".');
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
      'setTodoDependencies',
    ]);
  });
});

describe('setting the whole list', () => {
  async function waitsOn(id: string): Promise<string[]> {
    const data = await client.expectOk(
      `query ($id: UUID!) { todoDependencies(where: { todoId: { eq: $id } }) { dependsOnTodoId } }`,
      { id },
    );
    return data.todoDependencies.map((edge: { dependsOnTodoId: string }) => edge.dependsOnTodoId).sort();
  }

  it('replaces what a todo waits on: adds, keeps and drops in one call', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    const c = await newTodo('C');
    const d = await newTodo('D');
    await client.expectOk(ADD, { t: a, d: b });
    await client.expectOk(ADD, { t: a, d: c });

    const data = await client.expectOk(SET, { id: a, d: [c, d, d] });
    expect(data.setTodoDependencies.isBlocked).toBe(true);
    expect(await waitsOn(a)).toEqual([c, d].sort());
  });

  it('clears the list when given none', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    await client.expectOk(ADD, { t: a, d: b });

    const data = await client.expectOk(SET, { id: a, d: [] });
    expect(data.setTodoDependencies).toMatchObject({ isBlocked: false, blockedBy: [] });
    expect(await waitsOn(a)).toEqual([]);
  });

  it('refuses a list that would close a loop, names it, and leaves the old list whole', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    const c = await newTodo('C');
    const d = await newTodo('D');
    await client.expectOk(ADD, { t: a, d: b });
    await client.expectOk(ADD, { t: c, d: d });
    await client.expectOk(ADD, { t: b, d: c });

    // Dropping D and adding A: the add closes C → A → B → C, so D stays too.
    const error = await client.expectError(SET, { id: c, d: [a] });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('cycle: "C" waits on "A", which waits on "B", which waits on "C".');
    expect(await waitsOn(c)).toEqual([d]);
  });

  it('judges the loop against the list as it will be, not as it was', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    const c = await newTodo('C');
    await client.expectOk(ADD, { t: a, d: b });
    await client.expectOk(ADD, { t: b, d: c });

    // B stops waiting on C in the same call that makes it wait on... nothing
    // that leads back: C → A is fine once B → C is gone.
    await client.expectOk(SET, { id: b, d: [] });
    await client.expectOk(SET, { id: c, d: [a] });
    expect(await waitsOn(c)).toEqual([a]);
  });

  it('refuses a todo waiting on itself', async () => {
    const a = await newTodo('A');
    const error = await client.expectError(SET, { id: a, d: [a] });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('itself');
  });

  it('refuses to make a completed todo wait on an open one, and writes nothing', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    const c = await newTodo('C');
    await client.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: b });
    await client.expectOk(ADD, { t: a, d: b });
    await client.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: a });

    const error = await client.expectError(SET, { id: a, d: [c] });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(error.message).toContain('Reopen');
    expect(await waitsOn(a)).toEqual([b]);
  });

  it('answers not found for a stranger’s todo on either side', async () => {
    const a = await newTodo('A');
    const b = await newTodo('B');
    await client.expectOk(ADD, { t: a, d: b });
    const stranger = createClient(db, await createUser(db, 'stranger@example.com'));
    const theirProject = (await stranger.expectOk(`mutation { createProject(values: { name: "Q" }) { id } }`))
      .createProject.id;
    const theirs = (
      await stranger.expectOk(
        `mutation ($projectId: UUID!) { createTodo(values: { projectId: $projectId, title: "Theirs" }) { id } }`,
        { projectId: theirProject },
      )
    ).createTodo.id;

    expect((await client.expectError(SET, { id: a, d: [b, theirs] })).code).toBe('NOT_FOUND');
    expect((await stranger.expectError(SET, { id: a, d: [] })).code).toBe('NOT_FOUND');
    expect(await waitsOn(a)).toEqual([b]);
  });

  it('is closed to an API key', async () => {
    const a = await newTodo('A');
    const key = createClient(db, userId, { ai: true, actor: { kind: 'apiKey', userId, keyId: randomUUID() } });
    const error = await key.expectError(SET, { id: a, d: [] });
    expect(error.code).toBe('FORBIDDEN');
  });
});
