import { randomUUID } from 'node:crypto';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, CLAIM, createBoard, FINISH, runnerClient } from './board.ts';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// Who may rewrite a note or take one away: whoever signed it, and nobody at all
// when it is what a run reported.

const NOTE = `mutation ($todoId: UUID!, $body: String!) { createTodoNote(values: { todoId: $todoId, body: $body }) { id editedAt } }`;
const ADD_NOTE = `mutation ($todoId: ID!, $body: String!) { addTodoNote(todoId: $todoId, body: $body) { id } }`;
const EDIT = `mutation ($id: ID!, $body: String!) { editTodoNote(id: $id, body: $body) { id body editedAt actorKind } }`;
const DELETE = `mutation ($id: ID!) { deleteTodoNote(id: $id) { id } }`;
const MARKS = `query ($projectId: ID!) { cardMarks(projectId: $projectId) { todoId notes } }`;

let db: TestDb;
let board: Board;
let todoId: string;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  todoId = await board.addTodo('Write it');
});

function keyClient(keyId: string = randomUUID()): TestClient {
  return createClient(db, board.userId, { ai: true, actor: { kind: 'apiKey', userId: board.userId, keyId } });
}

async function personNote(body = 'Mind the second paragrpah.'): Promise<string> {
  return (await board.person.expectOk(NOTE, { todoId, body })).createTodoNote.id;
}

async function keyNote(key: TestClient, body = 'From outside.'): Promise<string> {
  return (await key.expectOk(ADD_NOTE, { todoId, body })).addTodoNote.id;
}

/** Runs the todo's station once, which leaves a report on the thread. */
async function reportId(): Promise<string> {
  const runner = runnerClient(db);
  const { runId } = (await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id })).claimRun;
  await runner.expectOk(FINISH, { id: runId, result: { status: 'ok', output: 'Wrote it.' } });
  const thread = await db.select().from(dbSchema.todoNotes).where(eq(dbSchema.todoNotes.todoId, todoId));
  return thread.find((note: { kind: string }) => note.kind === 'report').id;
}

async function bodyOf(id: string): Promise<string | undefined> {
  const [note] = await db.select().from(dbSchema.todoNotes).where(eq(dbSchema.todoNotes.id, id));
  return note?.body;
}

describe('editing a note', () => {
  it('rewrites a person’s own note and says when', async () => {
    const id = await personNote();
    const { editTodoNote } = await board.person.expectOk(EDIT, { id, body: '  Mind the second paragraph.  ' });
    expect(editTodoNote).toMatchObject({ id, body: 'Mind the second paragraph.', actorKind: 'user' });
    expect(Number.isNaN(Date.parse(editTodoNote.editedAt))).toBe(false);
  });

  it('starts out unedited, and stays so when saved as it reads', async () => {
    const created = (await board.person.expectOk(NOTE, { todoId, body: 'As written.' })).createTodoNote;
    expect(created.editedAt).toBeNull();
    const { editTodoNote } = await board.person.expectOk(EDIT, { id: created.id, body: 'As written.' });
    expect(editTodoNote.editedAt).toBeNull();
  });

  it('refuses an empty body', async () => {
    const id = await personNote();
    const error = await board.person.expectError(EDIT, { id, body: '   ' });
    expect(error.code).toBe('BAD_USER_INPUT');
    expect(await bodyOf(id)).toBe('Mind the second paragrpah.');
  });

  it('lets an API key rewrite a note it signed', async () => {
    const key = keyClient();
    const id = await keyNote(key);
    const { editTodoNote } = await key.expectOk(EDIT, { id, body: 'From outside, corrected.' });
    expect(editTodoNote).toMatchObject({ body: 'From outside, corrected.', actorKind: 'apiKey' });
    expect(editTodoNote.editedAt).not.toBeNull();
  });

  it('keeps a key off a person’s note and another key’s', async () => {
    const mine = await personNote();
    const theirs = await keyNote(keyClient());
    const key = keyClient();
    for (const id of [mine, theirs]) {
      const error = await key.expectError(EDIT, { id, body: 'Changed' });
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toMatch(/notes you signed/);
    }
    expect(await bodyOf(mine)).toBe('Mind the second paragrpah.');
    expect(await bodyOf(theirs)).toBe('From outside.');
  });

  it('keeps a person off a key’s note, and says what to do instead', async () => {
    const id = await keyNote(keyClient());
    const error = await board.person.expectError(EDIT, { id, body: 'Changed' });
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toMatch(/note of your own/);
    expect(await bodyOf(id)).toBe('From outside.');
  });

  it('leaves a run’s report as written, for its person too', async () => {
    const id = await reportId();
    const error = await board.person.expectError(EDIT, { id, body: 'It went better than that.' });
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toMatch(/report is what a run said.*Add a note/);
    expect(await bodyOf(id)).toBe('Wrote it.');
  });

  it('lets a run rewrite a note it left, and no other run', async () => {
    const runner = runnerClient(db);
    const { runId } = (await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id })).claimRun;
    const agent = createClient(db, board.userId, { ai: true, actor: { kind: 'agent', userId: board.userId, runId } });
    const id = (await agent.expectOk(ADD_NOTE, { todoId, body: 'Halfway.' })).addTodoNote.id;
    expect((await agent.expectOk(EDIT, { id, body: 'Two thirds.' })).editTodoNote.body).toBe('Two thirds.');

    const later = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'agent', userId: board.userId, runId: randomUUID() },
    });
    expect((await later.expectError(EDIT, { id, body: 'Mine now.' })).code).toBe('FORBIDDEN');
  });

  it('answers not found for a note that is someone else’s', async () => {
    const id = await personNote();
    const stranger = createClient(db, await createUser(db, 'stranger@example.com'), { ai: true });
    for (const operation of [EDIT, DELETE]) {
      const error = await stranger.expectError(operation, { id, body: 'Hello' });
      expect(error.code).toBe('NOT_FOUND');
    }
    expect(await bodyOf(id)).toBe('Mind the second paragrpah.');
  });

  it('answers a key not found once its todo is hidden from AI', async () => {
    const key = keyClient();
    const id = await keyNote(key);
    await board.person.expectOk(
      `mutation ($id: UUID!) { updateTodo(set: { aiIgnored: true }, where: { id: { eq: $id } }) { id } }`,
      { id: todoId },
    );
    expect((await key.expectError(EDIT, { id, body: 'Changed' })).code).toBe('NOT_FOUND');
    expect((await key.expectError(DELETE, { id })).code).toBe('NOT_FOUND');
    expect(await bodyOf(id)).toBe('From outside.');
  });

  it('works for a person on an instance with AI off', async () => {
    const plainDb = await createTestDb();
    const person = createClient(plainDb, await createUser(plainDb, 'plain@example.com'));
    const projectId = (await person.expectOk(`mutation { createProject(values: { name: "P" }) { id } }`)).createProject
      .id;
    const plainTodo = (
      await person.expectOk(
        `mutation ($projectId: UUID!) { createTodo(values: { projectId: $projectId, title: "T" }) { id } }`,
        { projectId },
      )
    ).createTodo.id;
    const id = (await person.expectOk(NOTE, { todoId: plainTodo, body: 'Typo' })).createTodoNote.id;
    expect((await person.expectOk(EDIT, { id, body: 'Fixed' })).editTodoNote.body).toBe('Fixed');
    expect((await person.expectOk(DELETE, { id })).deleteTodoNote.id).toBe(id);
  });
});

describe('deleting a note', () => {
  it('takes a person’s note off the thread and off the card’s count', async () => {
    const id = await personNote();
    await personNote('And the third.');
    expect((await board.person.expectOk(MARKS, { projectId: board.projectId })).cardMarks).toEqual([
      { todoId, notes: 2 },
    ]);
    expect((await board.person.expectOk(DELETE, { id })).deleteTodoNote.id).toBe(id);
    expect(await bodyOf(id)).toBeUndefined();
    expect((await board.person.expectOk(MARKS, { projectId: board.projectId })).cardMarks).toEqual([
      { todoId, notes: 1 },
    ]);
  });

  it('lets a person clear a key’s note off their board', async () => {
    const id = await keyNote(keyClient());
    await board.person.expectOk(DELETE, { id });
    expect(await bodyOf(id)).toBeUndefined();
  });

  it('lets a key take back its own note and no one else’s', async () => {
    const key = keyClient();
    const own = await keyNote(key);
    const persons = await personNote();
    const otherKeys = await keyNote(keyClient());
    await key.expectOk(DELETE, { id: own });
    expect(await bodyOf(own)).toBeUndefined();
    for (const id of [persons, otherKeys]) {
      const error = await key.expectError(DELETE, { id });
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toMatch(/notes you signed/);
      expect(await bodyOf(id)).toBeDefined();
    }
  });

  it('keeps a run’s report, for its person and for a key', async () => {
    const id = await reportId();
    for (const client of [board.person, keyClient()]) {
      const error = await client.expectError(DELETE, { id });
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toMatch(/stays as written/);
    }
    expect(await bodyOf(id)).toBe('Wrote it.');
  });

  it('is not something generated CRUD offers', async () => {
    const data = await board.person.expectOk(`query { __schema { mutationType { fields { name args { name } } } } }`);
    const fields: Array<{ name: string; args: Array<{ name: string }> }> = data.__schema.mutationType.fields;
    const noteWrites = fields.filter((field) => field.name.endsWith('TodoNote') || field.name.endsWith('TodoNotes'));
    expect(noteWrites.map((field) => `${field.name}(${field.args.map((arg) => arg.name).join(', ')})`).sort()).toEqual([
      'addTodoNote(todoId, body)',
      'createTodoNote(values)',
      'createTodoNotes(values)',
      'deleteTodoNote(id)',
      'editTodoNote(id, body)',
    ]);
  });
});
