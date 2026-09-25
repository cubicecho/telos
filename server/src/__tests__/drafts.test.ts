import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, createBoard, runnerClient } from './board.ts';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// Drafts: a person talks a request over with an agent, the runner has the
// agent answer, and the brief becomes a todo.

let db: TestDb;
let board: Board;
let runner: TestClient;

const START = `mutation ($projectId: ID!, $agentId: ID!, $message: String!) {
  startDraft(projectId: $projectId, agentId: $agentId, message: $message) { id waitingSince }
}`;
const SAY = `mutation ($id: ID!, $message: String!) { sayToDraft(id: $id, message: $message) { id waitingSince } }`;
const STOP = `mutation ($id: ID!) { stopDraft(id: $id) { id waitingSince } }`;
const MAKE = `mutation ($id: ID!, $title: String, $brief: String) {
  makeTodoFromDraft(id: $id, title: $title, brief: $brief) { id title notes laneId }
}`;
const READ = `query ($id: UUID!) {
  draft(where: { id: { eq: $id } }) { title brief error todoId waitingSince messages(orderBy: { createdAt: { direction: asc, priority: 1 } }) { role content } }
}`;
const WAITING = `query { runnerDrafts }`;
const CLAIM = `mutation ($id: ID!) {
  claimDraft(id: $id) { draftId projectName projectContext title brief agent { id apiKey model } messages { role content } }
}`;
const FINISH = `mutation ($id: ID!, $reply: String, $title: String, $brief: String, $error: String) {
  finishDraft(id: $id, reply: $reply, title: $title, brief: $brief, error: $error)
}`;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

async function start(message = 'Make the export faster'): Promise<string> {
  return (await board.person.expectOk(START, { projectId: board.projectId, agentId: board.agentId, message }))
    .startDraft.id;
}

async function answer(id: string, reply: string, title: string, brief: string) {
  const claim = (await runner.expectOk(CLAIM, { id })).claimDraft;
  expect(claim).not.toBeNull();
  return (await runner.expectOk(FINISH, { id, reply, title, brief })).finishDraft;
}

describe('drafts', () => {
  it('goes from a message, through an answer, to a todo in the first open lane', async () => {
    const id = await start();
    expect((await runner.expectOk(WAITING)).runnerDrafts).toEqual([id]);

    const claim = (await runner.expectOk(CLAIM, { id })).claimDraft;
    expect(claim).toMatchObject({
      projectName: 'P',
      projectContext: 'A test board.',
      agent: { id: board.agentId, apiKey: 'sk-secret' },
      messages: [{ role: 'user', content: 'Make the export faster' }],
    });
    // Taken: nobody else gets it.
    expect((await runner.expectOk(WAITING)).runnerDrafts).toEqual([]);
    expect((await runner.expectOk(CLAIM, { id })).claimDraft).toBeNull();

    expect(
      (await runner.expectOk(FINISH, { id, reply: 'Which export?', title: 'Faster export', brief: 'Speed up export.' }))
        .finishDraft,
    ).toBe(true);
    await board.person.expectOk(SAY, { id, message: 'The CSV one' });
    await answer(id, 'Got it.', '', 'Speed up the CSV export.');

    const draft = (await board.person.expectOk(READ, { id })).draft;
    expect(draft).toMatchObject({ title: 'Faster export', brief: 'Speed up the CSV export.', waitingSince: null });
    expect(draft.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    const todo = (await board.person.expectOk(MAKE, { id })).makeTodoFromDraft;
    expect(todo).toMatchObject({
      title: 'Faster export',
      notes: 'Speed up the CSV export.',
      laneId: board.lanes[0].id,
    });
    expect((await board.person.expectOk(READ, { id })).draft.todoId).toBe(todo.id);
    expect((await board.person.expectError(MAKE, { id })).code).toBe('CONFLICT');
    expect((await board.person.expectError(SAY, { id, message: 'More' })).code).toBe('CONFLICT');
  });

  it('takes turns: nothing more is said while the agent answers, and stopping drops the answer', async () => {
    const id = await start();
    expect((await board.person.expectError(SAY, { id, message: 'And another thing' })).code).toBe('CONFLICT');
    await runner.expectOk(CLAIM, { id });
    const stopped = (await board.person.expectOk(STOP, { id })).stopDraft;
    expect(stopped.waitingSince).toBeNull();
    expect((await runner.expectOk(FINISH, { id, reply: 'Late', brief: 'Late brief' })).finishDraft).toBe(false);
    const draft = (await board.person.expectOk(READ, { id })).draft;
    expect(draft.messages).toHaveLength(1);
    expect(draft.brief).toBe('');
    // With no brief there is nothing to make, unless the person writes one.
    expect((await board.person.expectError(MAKE, { id })).code).toBe('BAD_USER_INPUT');
    const todo = (await board.person.expectOk(MAKE, { id, brief: 'Export CSV faster.\nFor big boards.' }))
      .makeTodoFromDraft;
    expect(todo.title).toBe('Export CSV faster.');
  });

  it('records an error, and gives the turn back', async () => {
    const id = await start();
    await runner.expectOk(CLAIM, { id });
    expect((await runner.expectOk(FINISH, { id, error: 'model unreachable' })).finishDraft).toBe(true);
    expect((await board.person.expectOk(READ, { id })).draft).toMatchObject({
      error: 'model unreachable',
      waitingSince: null,
    });
    const said = (await board.person.expectOk(SAY, { id, message: 'Try again' })).sayToDraft;
    expect(said.waitingSince).not.toBeNull();
    expect((await board.person.expectOk(READ, { id })).draft.error).toBeNull();
  });

  it('is not the runner’s once AI is off for the project or the account', async () => {
    const id = await start();
    await db.update(dbSchema.projects).set({ aiEnabled: false }).where(eq(dbSchema.projects.id, board.projectId));
    expect((await runner.expectOk(WAITING)).runnerDrafts).toEqual([]);
    expect((await runner.expectOk(CLAIM, { id })).claimDraft).toBeNull();
    expect((await board.person.expectError(SAY, { id, message: 'Hello' })).code).toBe('NOT_FOUND');

    await db.update(dbSchema.projects).set({ aiEnabled: true }).where(eq(dbSchema.projects.id, board.projectId));
    await db.update(dbSchema.users).set({ aiEnabled: false }).where(eq(dbSchema.users.id, board.userId));
    expect((await runner.expectOk(WAITING)).runnerDrafts).toEqual([]);
    expect((await board.person.expectError(STOP, { id })).code).toBe('NOT_FOUND');
  });

  it('keeps to the caller’s own projects, agents and drafts, and away from AI callers', async () => {
    const id = await start();
    const otherId = await createUser(db, 'other@example.com');
    await db.update(dbSchema.users).set({ aiEnabled: true }).where(eq(dbSchema.users.id, otherId));
    const other = createClient(db, otherId, { ai: true });
    expect((await other.expectError(SAY, { id, message: 'Hi' })).code).toBe('NOT_FOUND');
    expect((await other.expectOk(READ, { id })).draft).toBeNull();
    expect(
      (await other.expectError(START, { projectId: board.projectId, agentId: board.agentId, message: 'Hi' })).code,
    ).toBe('NOT_FOUND');

    // A person's drafts are nothing an MCP client or agent may read or write.
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: 'k' },
    });
    expect((await key.expectOk(READ, { id })).draft).toBeNull();
    expect((await key.expectError(SAY, { id, message: 'Hi' })).code).toBe('FORBIDDEN');
    // And the runner only answers; it cannot talk as the person.
    expect((await runner.expectError(SAY, { id, message: 'Hi' })).code).toBe('FORBIDDEN');
    expect((await board.person.expectError(FINISH, { id, reply: 'Me' })).code).toBe('FORBIDDEN');
  });
});
