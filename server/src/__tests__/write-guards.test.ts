import * as dbSchema from '@telos/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// `scope` confines reads, updates and deletes, but it cannot reach a plain
// insert. These are the holes that leaves: an id a caller states on the way in,
// pointing at a row that is not theirs.

let db: TestDb;
let mine: TestClient;
let theirs: TestClient;
let theirProjectId: string;
let theirTodoId: string;
let theirLabelId: string;

beforeEach(async () => {
  db = await createTestDb();
  mine = createClient(db, await createUser(db, 'mine@example.com'));
  theirs = createClient(db, await createUser(db, 'theirs@example.com'));

  theirProjectId = (await theirs.expectOk(`mutation { createProject(values: { name: "Theirs" }) { id } }`))
    .createProject.id;
  theirTodoId = (
    await theirs.expectOk(`mutation ($p: UUID!) { createTodo(values: { projectId: $p, title: "Theirs" }) { id } }`, {
      p: theirProjectId,
    })
  ).createTodo.id;
  theirLabelId = (
    await theirs.expectOk(`mutation { createLabel(values: { name: "Theirs", color: "#000000" }) { id } }`)
  ).createLabel.id;
});

describe('foreign keys on insert', () => {
  it('refuses a todo created against another user’s project', async () => {
    const error = await mine.expectError(
      `mutation ($p: UUID!) { createTodo(values: { projectId: $p, title: "Sneaky" }) { id } }`,
      { p: theirProjectId },
    );
    // NOT_FOUND, never FORBIDDEN: "you may not touch this" would confirm the row
    // exists, which is itself something the caller is not entitled to know.
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Project not found');

    const rows = await db.select().from(dbSchema.todos);
    expect(rows).toHaveLength(1);
  });

  it('refuses a label attached to another user’s todo', async () => {
    const label = (await mine.expectOk(`mutation { createLabel(values: { name: "Mine", color: "#111111" }) { id } }`))
      .createLabel.id;
    const error = await mine.expectError(
      `mutation ($t: UUID!, $l: UUID!) { createTodoLabel(values: { todoId: $t, labelId: $l }) { id } }`,
      { t: theirTodoId, l: label },
    );
    expect(error.code).toBe('NOT_FOUND');
  });

  it('refuses another user’s label attached to my own todo', async () => {
    const project = (await mine.expectOk(`mutation { createProject(values: { name: "Mine" }) { id } }`)).createProject
      .id;
    const todo = (
      await mine.expectOk(`mutation ($p: UUID!) { createTodo(values: { projectId: $p, title: "Mine" }) { id } }`, {
        p: project,
      })
    ).createTodo.id;

    const error = await mine.expectError(
      `mutation ($t: UUID!, $l: UUID!) { createTodoLabel(values: { todoId: $t, labelId: $l }) { id } }`,
      { t: todo, l: theirLabelId },
    );
    expect(error.code).toBe('NOT_FOUND');
  });

  it('refuses another user’s label attached to a project', async () => {
    const project = (await mine.expectOk(`mutation { createProject(values: { name: "Mine" }) { id } }`)).createProject
      .id;
    const error = await mine.expectError(
      `mutation ($p: UUID!, $l: UUID!) { createProjectLabel(values: { projectId: $p, labelId: $l }) { id } }`,
      { p: project, l: theirLabelId },
    );
    expect(error.code).toBe('NOT_FOUND');
  });

  it('checks every row of a batch insert, not just the first', async () => {
    const project = (await mine.expectOk(`mutation { createProject(values: { name: "Mine" }) { id } }`)).createProject
      .id;
    const error = await mine.expectError(
      `mutation ($mine: UUID!, $theirs: UUID!) {
        createTodos(values: [
          { projectId: $mine, title: "Fine" },
          { projectId: $theirs, title: "Sneaky" }
        ]) { id }
      }`,
      { mine: project, theirs: theirProjectId },
    );
    expect(error.code).toBe('NOT_FOUND');

    // The whole insert rolls back — the acceptable row must not survive.
    const rows = await db.select().from(dbSchema.todos);
    expect(rows).toHaveLength(1);
  });
});

describe('row scope', () => {
  it('hides another user’s rows from every read', async () => {
    const data = await mine.expectOk(`query { projects { id } todos { id } labels { id } }`);
    expect(data).toEqual({ projects: [], todos: [], labels: [] });
  });

  it('refuses to update a row belonging to someone else', async () => {
    const data = await mine.expectOk(
      `mutation ($id: UUID!) { updateTodoSingle(set: { title: "Taken" }, where: { id: { eq: $id } }) { id } }`,
      { id: theirTodoId },
    );
    expect(data.updateTodoSingle).toBeNull();

    const [row] = await db.select().from(dbSchema.todos);
    expect(row.title).toBe('Theirs');
  });

  it('refuses to delete a row belonging to someone else', async () => {
    const data = await mine.expectOk(`mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }`, {
      id: theirTodoId,
    });
    expect(data.deleteTodo).toEqual([]);
    expect(await db.select().from(dbSchema.todos)).toHaveLength(1);
  });

  it('stamps userId from the session rather than accepting it', async () => {
    // The column is not in the input type at all, so stating it is a schema
    // error — ownership is never something a caller says.
    const error = await mine.expectError(
      `mutation ($u: UUID!) { createProject(values: { name: "Sneaky", userId: $u }) { id } }`,
      { u: theirTodoId },
    );
    expect(String(error.message)).toContain('userId');
  });

  it('refuses a dependency edge onto another user’s todo', async () => {
    const project = (await mine.expectOk(`mutation { createProject(values: { name: "Mine" }) { id } }`)).createProject
      .id;
    const todo = (
      await mine.expectOk(`mutation ($p: UUID!) { createTodo(values: { projectId: $p, title: "Mine" }) { id } }`, {
        p: project,
      })
    ).createTodo.id;

    const error = await mine.expectError(
      `mutation ($t: ID!, $d: ID!) { addTodoDependency(todoId: $t, dependsOnTodoId: $d) { id } }`,
      { t: todo, d: theirTodoId },
    );
    expect(error.code).toBe('NOT_FOUND');
  });
});
