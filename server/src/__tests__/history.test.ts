import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// A todo's history, its notes, and the columns that came with them. History is
// written by a trigger rather than by the resolvers, so these tests go through
// every door a todo can be changed by and check each one left a mark, and that
// the marks say who.

const CREATE_PROJECT = `mutation { createProject(values: { name: "P" }) { id } }`;
const CREATE_TODO = `mutation ($projectId: UUID!, $title: String!) {
  createTodo(values: { projectId: $projectId, title: $title }) { id }
}`;
const UPDATE = `mutation ($id: UUID!, $set: UpdateTodoInput!) {
  updateTodo(set: $set, where: { id: { eq: $id } }) { id }
}`;
const HISTORY = `query ($id: UUID!) {
  todo(where: { id: { eq: $id } }) {
    history(orderBy: { at: { direction: asc, priority: 1 } }) {
      kind fromLaneId toLaneId fields actorKind actorKeyId reason
    }
  }
}`;
const LANES = `query ($projectId: UUID!) {
  lanes(where: { projectId: { eq: $projectId } }, orderBy: { position: { direction: asc, priority: 1 } }) {
    id name isDone
  }
}`;

let db: TestDb;
let userId: string;
let client: TestClient;
let projectId: string;
let todoId: string;
let lanes: Array<{ id: string; name: string; isDone: boolean }>;

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function history(id = todoId, as = client): Promise<any[]> {
  return (await as.expectOk(HISTORY, { id })).todo.history;
}

beforeEach(async () => {
  db = await createTestDb();
  userId = await createUser(db, 'owner@example.com');
  client = createClient(db, userId);
  projectId = (await client.expectOk(CREATE_PROJECT)).createProject.id;
  todoId = (await client.expectOk(CREATE_TODO, { projectId, title: 'Write it' })).createTodo.id;
  lanes = (await client.expectOk(LANES, { projectId })).lanes;
});

describe('todo history', () => {
  it('records the create, by the person who made it', async () => {
    expect(await history()).toEqual([
      expect.objectContaining({ kind: 'create', fromLaneId: null, toLaneId: lanes[0].id, actorKind: 'user' }),
    ]);
  });

  it('records an edit and names the fields it changed', async () => {
    await client.expectOk(UPDATE, { id: todoId, set: { title: 'Write it well', acceptance: 'Two paragraphs.' } });
    const events = await history();
    expect(events.at(-1)).toMatchObject({ kind: 'edit', fields: ['title', 'acceptance'], actorKind: 'user' });
  });

  it('records completion with the lanes it crossed and the reason given', async () => {
    await client.expectOk(`mutation ($id: ID!) { completeTodo(id: $id, reason: "Shipped") { id } }`, { id: todoId });
    await client.expectOk(`mutation ($id: ID!) { reopenTodo(id: $id) { id } }`, { id: todoId });
    const [, complete, reopen] = await history();
    expect(complete).toMatchObject({ kind: 'complete', fromLaneId: lanes[0].id, toLaneId: lanes[2].id });
    expect(complete.reason).toBe('Shipped');
    // A reason is for one change, not for the rest of the request's life.
    expect(reopen).toMatchObject({ kind: 'reopen', toLaneId: lanes[0].id, reason: null });
  });

  it('records a move across the board with its reason', async () => {
    await client.expectOk(
      `mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId, reason: "Started") { id } }`,
      {
        id: todoId,
        laneId: lanes[1].id,
      },
    );
    expect((await history()).at(-1)).toMatchObject({
      kind: 'move',
      fromLaneId: lanes[0].id,
      toLaneId: lanes[1].id,
      reason: 'Started',
    });
  });

  it('records one event per request, however many writes it took', async () => {
    // The update completes the todo; realignLanes then moves it to the done
    // lane in a second statement. One thing happened, so one event.
    await client.expectOk(UPDATE, { id: todoId, set: { title: 'Done it', completedAt: new Date().toISOString() } });
    const events = await history();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      kind: 'complete',
      fromLaneId: lanes[0].id,
      toLaneId: lanes[2].id,
      fields: ['title'],
    });
  });

  it('records nothing for a reorder within a lane', async () => {
    await client.expectOk(CREATE_TODO, { projectId, title: 'Another' });
    const before = await history();
    await client.expectOk(
      `mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId, position: 1) { id } }`,
      {
        id: todoId,
        laneId: lanes[0].id,
      },
    );
    expect(await history()).toEqual(before);
  });

  it('records what setDoneLane does to the todos it moves', async () => {
    await client.expectOk(
      `mutation ($projectId: ID!, $laneId: ID) { setDoneLane(projectId: $projectId, laneId: $laneId) { id } }`,
      {
        projectId,
        laneId: lanes[0].id,
      },
    );
    expect((await history()).at(-1)).toMatchObject({ kind: 'complete', actorKind: 'user' });
  });

  it('says when an API key made the change, and which key', async () => {
    const keyId = randomUUID();
    const key = createClient(db, userId, { actor: { kind: 'apiKey', userId, keyId } });
    await key.expectOk(UPDATE, { id: todoId, set: { notes: 'From Claude.' } });
    expect((await history()).at(-1)).toMatchObject({ kind: 'edit', actorKind: 'apiKey', actorKeyId: keyId });
  });

  it('cannot be written through the API', async () => {
    const error = await client.expectError(
      `mutation ($todoId: UUID!) { createTodoEvent(values: { todoId: $todoId, kind: "complete", actorKind: "user" }) { id } }`,
      { todoId },
    );
    expect(error.message).toMatch(/createTodoEvent/);
  });

  it('is only ever the owner’s to read', async () => {
    const stranger = createClient(db, await createUser(db, 'stranger@example.com'));
    expect((await stranger.expectOk(`{ todoEvents { id } }`)).todoEvents).toEqual([]);
  });
});

describe('todo notes', () => {
  const ADD = `mutation ($todoId: UUID!, $body: String!) {
    createTodoNote(values: { todoId: $todoId, body: $body }) { id kind body actorKind actorKeyId }
  }`;

  it('adds a note, signed by whoever wrote it', async () => {
    const note = (await client.expectOk(ADD, { todoId, body: 'Check the edge case.' })).createTodoNote;
    expect(note).toMatchObject({ kind: 'note', body: 'Check the edge case.', actorKind: 'user', actorKeyId: null });

    const keyId = randomUUID();
    const key = createClient(db, userId, { actor: { kind: 'apiKey', userId, keyId } });
    const byKey = (await key.expectOk(ADD, { todoId, body: 'Done, see PR.' })).createTodoNote;
    expect(byKey).toMatchObject({ actorKind: 'apiKey', actorKeyId: keyId });
  });

  it('refuses a caller-stated signature', async () => {
    const error = await client.expectError(
      `mutation ($todoId: UUID!) { createTodoNote(values: { todoId: $todoId, body: "x", actorKind: "agent" }) { id } }`,
      { todoId },
    );
    expect(error.message).toMatch(/actorKind/);
  });

  it('refuses reports and verdicts, which only the server writes', async () => {
    const error = await client.expectError(
      `mutation ($todoId: UUID!) { createTodoNote(values: { todoId: $todoId, body: "Pass", kind: "verdict" }) { id } }`,
      { todoId },
    );
    expect(error.code).toBe('BAD_USER_INPUT');
  });

  it('can be deleted but not rewritten', async () => {
    const note = (await client.expectOk(ADD, { todoId, body: 'Typo' })).createTodoNote;
    const rewrite = await client.expectError(
      `mutation ($id: UUID!) { updateTodoNote(set: { body: "Fixed" }, where: { id: { eq: $id } }) { id } }`,
      { id: note.id },
    );
    expect(rewrite.message).toMatch(/updateTodoNote/);
    await client.expectOk(`mutation ($id: UUID!) { deleteTodoNote(where: { id: { eq: $id } }) { id } }`, {
      id: note.id,
    });
    const read = await client.expectOk(`query ($id: UUID!) { todo(where: { id: { eq: $id } }) { thread { id } } }`, {
      id: todoId,
    });
    expect(read.todo.thread).toEqual([]);
  });

  it('cannot be added to someone else’s todo', async () => {
    const stranger = createClient(db, await createUser(db, 'stranger@example.com'));
    const error = await stranger.expectError(ADD, { todoId, body: 'Hello' });
    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('the AI-ignore flag', () => {
  it('is a person’s to set', async () => {
    await client.expectOk(UPDATE, { id: todoId, set: { aiIgnored: true } });
    expect((await history()).at(-1)).toMatchObject({ kind: 'edit', fields: ['aiIgnored'] });
  });

  it('cannot be cleared by a key', async () => {
    await client.expectOk(UPDATE, { id: todoId, set: { aiIgnored: true } });
    const key = createClient(db, userId, { actor: { kind: 'apiKey', userId, keyId: randomUUID() } });
    const error = await key.expectError(UPDATE, { id: todoId, set: { aiIgnored: false } });
    expect(error.code).toBe('FORBIDDEN');
  });
});

describe('parent todos', () => {
  const setParent = (id: string, parentId: string) => client.run(UPDATE, { id, set: { parentId } });

  it('links a child to its parent both ways', async () => {
    const childId = (await client.expectOk(CREATE_TODO, { projectId, title: 'Piece' })).createTodo.id;
    await client.expectOk(UPDATE, { id: childId, set: { parentId: todoId } });
    const read = await client.expectOk(
      `query ($id: UUID!) { todo(where: { id: { eq: $id } }) { children { id } parent { id } } }`,
      { id: todoId },
    );
    expect(read.todo).toEqual({ children: [{ id: childId }], parent: null });
  });

  it('refuses a cycle, including a todo that is its own parent', async () => {
    const childId = (await client.expectOk(CREATE_TODO, { projectId, title: 'Piece' })).createTodo.id;
    expect((await setParent(todoId, todoId)).errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
    await client.expectOk(UPDATE, { id: childId, set: { parentId: todoId } });
    expect((await setParent(todoId, childId)).errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('refuses a parent in another project', async () => {
    const otherProject = (await client.expectOk(CREATE_PROJECT)).createProject.id;
    const elsewhere = (await client.expectOk(CREATE_TODO, { projectId: otherProject, title: 'Far' })).createTodo.id;
    expect((await setParent(todoId, elsewhere)).errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('refuses someone else’s todo as a parent', async () => {
    const stranger = createClient(db, await createUser(db, 'stranger@example.com'));
    const theirProject = (await stranger.expectOk(CREATE_PROJECT)).createProject.id;
    const theirs = (await stranger.expectOk(CREATE_TODO, { projectId: theirProject, title: 'Mine' })).createTodo.id;
    expect((await setParent(todoId, theirs)).errors?.[0].extensions?.code).toBe('NOT_FOUND');
  });

  it('leaves the pieces standing when the parent is deleted', async () => {
    const childId = (await client.expectOk(CREATE_TODO, { projectId, title: 'Piece' })).createTodo.id;
    await client.expectOk(UPDATE, { id: childId, set: { parentId: todoId } });
    await client.expectOk(`mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }`, { id: todoId });
    const read = await client.expectOk(`query ($id: UUID!) { todo(where: { id: { eq: $id } }) { parent { id } } }`, {
      id: childId,
    });
    expect(read.todo.parent).toBeNull();
  });
});

describe('the AI switches', () => {
  const SET_ACCOUNT = `mutation ($enabled: Boolean!) { setAiEnabled(enabled: $enabled) { id aiEnabled } }`;
  const SET_PROJECT = `mutation ($projectId: ID!, $enabled: Boolean!) {
    setProjectAiEnabled(projectId: $projectId, enabled: $enabled) { id aiEnabled }
  }`;

  it('are not there when the instance has AI off', async () => {
    const error = await client.expectError(SET_ACCOUNT, { enabled: true });
    expect(error.message).toMatch(/setAiEnabled/);
  });

  it('cannot be flipped through a generated write', async () => {
    const error = await client.expectError(
      `mutation ($id: UUID!) { updateProject(set: { aiEnabled: true }, where: { id: { eq: $id } }) { id } }`,
      { id: projectId },
    );
    expect(error.code).toBe('BAD_USER_INPUT');
  });

  it('open a project only once the account has AI on', async () => {
    const ai = createClient(db, userId, { ai: true });
    expect((await ai.expectError(SET_PROJECT, { projectId, enabled: true })).code).toBe('NOT_FOUND');
    expect((await ai.expectOk(SET_ACCOUNT, { enabled: true })).setAiEnabled.aiEnabled).toBe(true);
    expect((await ai.expectOk(SET_PROJECT, { projectId, enabled: true })).setProjectAiEnabled.aiEnabled).toBe(true);
    // Switching the account off leaves the project's own switch alone, so
    // switching back on restores what the user had.
    await ai.expectOk(SET_ACCOUNT, { enabled: false });
    expect((await ai.expectOk(SET_PROJECT, { projectId, enabled: false })).setProjectAiEnabled.aiEnabled).toBe(false);
  });

  it('are a person’s, never a key’s', async () => {
    const key = createClient(db, userId, { ai: true, actor: { kind: 'apiKey', userId, keyId: randomUUID() } });
    expect((await key.expectError(SET_ACCOUNT, { enabled: false })).code).toBe('FORBIDDEN');
    expect((await key.expectError(SET_PROJECT, { projectId, enabled: false })).code).toBe('FORBIDDEN');
  });

  it('cannot reach someone else’s project', async () => {
    const stranger = createClient(db, await createUser(db, 'stranger@example.com'), { ai: true });
    expect((await stranger.expectError(SET_PROJECT, { projectId, enabled: false })).code).toBe('NOT_FOUND');
  });
});
