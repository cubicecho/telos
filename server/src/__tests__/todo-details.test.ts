import * as dbSchema from '@telos/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// `dueAt` and `notes` carry no invariant, and that is exactly what is worth
// pinning down. They are written by the generated `updateTodo` — the same
// mutation the write guards watch for lane and completion changes — so the
// question these tests answer is whether an edit that names neither can still
// disturb either. It cannot, because both guards key off the presence of a key
// rather than the shape of the row, and nothing here should let that drift.

const CREATE_PROJECT = `mutation { createProject(values: { name: "P" }) { id } }`;
const CREATE_TODO = `mutation ($projectId: UUID!) {
  createTodo(values: { projectId: $projectId, title: "Write it" }) { id }
}`;
const UPDATE = `mutation ($id: UUID!, $set: UpdateTodoInput!) {
  updateTodo(set: $set, where: { id: { eq: $id } }) { id title notes dueAt }
}`;
const READ = `query ($id: UUID!) {
  todo(where: { id: { eq: $id } }) {
    id title notes dueAt completedAt position lane { id name isDone }
  }
}`;

let db: TestDb;
let client: TestClient;
let projectId: string;
let todoId: string;

beforeEach(async () => {
  db = await createTestDb();
  client = createClient(db, await createUser(db, 'owner@example.com'));
  projectId = (await client.expectOk(CREATE_PROJECT)).createProject.id;
  todoId = (await client.expectOk(CREATE_TODO, { projectId })).createTodo.id;
});

describe('editing a todo’s details', () => {
  it('sets title, notes and dueAt without disturbing the lane or the checkbox', async () => {
    const before = (await client.expectOk(READ, { id: todoId })).todo;

    await client.expectOk(UPDATE, {
      id: todoId,
      set: { title: 'Write it well', notes: 'Two paragraphs.', dueAt: '2026-12-01T09:00:00.000Z' },
    });

    const after = (await client.expectOk(READ, { id: todoId })).todo;
    expect(after.title).toBe('Write it well');
    expect(after.notes).toBe('Two paragraphs.');
    // `expectOk` returns graphql-js's `data` without a JSON round-trip, and
    // `GraphQLDateTime.serialize` answers a Date — which is what the HTTP layer
    // then stringifies into the ISO string the client sees. Compare the instant.
    expect(new Date(after.dueAt).toISOString()).toBe('2026-12-01T09:00:00.000Z');
    // The write names neither `completedAt` nor `laneId`, so the guard that
    // refuses a lane-only write has nothing to say about it, and the todo comes
    // out in the column and the state it went in with.
    expect(after.completedAt).toBeNull();
    expect(after.lane).toEqual(before.lane);
    expect(after.position).toBe(before.position);
  });

  it('leaves a completed todo completed, and in the done lane', async () => {
    await client.expectOk(`mutation ($id: ID!) { completeTodo(id: $id) { id } }`, { id: todoId });

    await client.expectOk(UPDATE, { id: todoId, set: { notes: 'Shipped.' } });

    const after = (await client.expectOk(READ, { id: todoId })).todo;
    expect(after.completedAt).not.toBeNull();
    expect(after.lane.isDone).toBe(true);
  });

  it('clears a due date rather than writing the epoch', async () => {
    await client.expectOk(UPDATE, { id: todoId, set: { dueAt: '2026-12-01T09:00:00.000Z' } });
    await client.expectOk(UPDATE, { id: todoId, set: { dueAt: null, notes: null } });

    const after = (await client.expectOk(READ, { id: todoId })).todo;
    // Not merely falsy. Without the scalar override in `build-schema.ts` the
    // library's remapper runs `new Date(null)` on the way in, which is
    // 1970-01-01 rather than NaN and so survives every validity check it makes.
    // This is the regression test for that.
    expect(after.dueAt).toBeNull();
    expect(after.notes).toBeNull();
  });

  it('refuses an unparseable due date at the scalar, before anything is written', async () => {
    const error = await client.expectError(UPDATE, { id: todoId, set: { dueAt: 'next tuesday' } });
    expect(error.message).toContain('DateTime');

    const [row] = await db.select().from(dbSchema.todos);
    expect(row.dueAt).toBeNull();
  });

  it('stamps updatedAt, which only the hand-written resolvers used to do', async () => {
    const [before] = await db.select().from(dbSchema.todos);

    await client.expectOk(UPDATE, { id: todoId, set: { notes: 'Later.' } });

    const [after] = await db.select().from(dbSchema.todos);
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.createdAt.getTime() - 1);
  });
});

describe('another user’s todo', () => {
  it('is not editable, and does not say it exists', async () => {
    const stranger = createClient(db, await createUser(db, 'stranger@example.com'));

    // `scope` is ANDed into the UPDATE, so the statement matches no row and the
    // single-row mutation answers null — never FORBIDDEN, which would confirm
    // the todo is there.
    const data = await stranger.expectOk(UPDATE, {
      id: todoId,
      set: { title: 'Taken', notes: 'Mine now.', dueAt: '2026-12-01T09:00:00.000Z' },
    });
    expect(data.updateTodo).toBeNull();

    const [row] = await db.select().from(dbSchema.todos);
    expect(row.title).toBe('Write it');
    expect(row.notes).toBeNull();
    expect(row.dueAt).toBeNull();
  });
});
