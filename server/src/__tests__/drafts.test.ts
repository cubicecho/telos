import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { DRAFT_LEASE_LAPSED } from '../draft-runs.ts';
import {
  type Board,
  CLAIM_DRAFT as CLAIM,
  claimedDraft,
  createBoard,
  DRAFT_USAGE,
  FINISH_DRAFT as FINISH,
  FINISH as FINISH_RUN,
  HEARTBEAT,
  runnerClient,
  START_DRAFT as START,
} from './board.ts';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// Drafts: a person talks a request over with an agent, the runner has the
// agent answer, and the brief becomes a todo.

let db: TestDb;
let board: Board;
let runner: TestClient;

const SAY = `mutation ($id: ID!, $message: String!) { sayToDraft(id: $id, message: $message) { id waitingSince } }`;
const STOP = `mutation ($id: ID!) { stopDraft(id: $id) { id waitingSince } }`;
const MAKE = `mutation ($id: ID!, $title: String, $brief: String) {
  makeTodoFromDraft(id: $id, title: $title, brief: $brief) { id title notes laneId }
}`;
const READ = `query ($id: UUID!) {
  draft(where: { id: { eq: $id } }) { title brief error todoId waitingSince messages(orderBy: { createdAt: { direction: asc, priority: 1 } }) { role content } }
}`;
const WAITING = `query { runnerDrafts }`;
const RUNS = `query ($id: UUID!) {
  draft(where: { id: { eq: $id } }) {
    runs(orderBy: { startedAt: { direction: asc, priority: 1 } }) {
      id kind status todoId draftId laneId contract verdict model systemPrompt userPrompt output error
      promptTokens completionTokens totalTokens startedAt finishedAt cancelRequestedAt
      agent { id } draft { id } todo { id }
    }
  }
}`;
const CANCEL_RUN = `mutation ($id: ID!) { cancelRun(id: $id) { id status } }`;
const DELETE_RUN = `mutation ($id: ID!) { deleteRun(id: $id) }`;
const PROMPT = { system: 'You refine requests.', user: 'Make the export faster' };
const EVENTS = [
  { kind: 'notice', text: 'Token counts are estimates.' },
  { kind: 'output', text: 'Which export?' },
];

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function runsOf(id: string): Promise<any[]> {
  return (await board.person.expectOk(RUNS, { id })).draft.runs;
}

async function storedRun(id: string) {
  const [run] = await db.select().from(dbSchema.runs).where(eq(dbSchema.runs.id, id));
  return run;
}

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

describe('a draft’s replies as runs', () => {
  it('records a reply as a run: who answered, what it was told, what it said and what it spent', async () => {
    const { draftId, runId } = await claimedDraft(board, runner);
    expect(await runsOf(draftId)).toMatchObject([
      { id: runId, kind: 'draft', status: 'running', draftId, todoId: null, laneId: null, contract: null },
    ]);

    await runner.expectOk(FINISH, {
      id: draftId,
      runId,
      reply: 'Which export?',
      title: 'Faster export',
      brief: 'Speed up export.',
      prompt: PROMPT,
      usage: DRAFT_USAGE,
      events: EVENTS,
    });
    const [run] = await runsOf(draftId);
    expect(run).toMatchObject({
      id: runId,
      kind: 'draft',
      status: 'ok',
      verdict: 'none',
      model: 'tiny',
      systemPrompt: PROMPT.system,
      userPrompt: PROMPT.user,
      output: 'Which export?',
      error: null,
      ...DRAFT_USAGE,
      agent: { id: board.agentId },
      draft: { id: draftId },
      todo: null,
    });
    expect(run.finishedAt).not.toBeNull();
    expect((await storedRun(runId)).events.map((event: { kind: string }) => event.kind)).toEqual(['notice', 'output']);
  });

  it('makes one run a turn, and finishes the running one when the runner names none', async () => {
    const { draftId } = await claimedDraft(board, runner);
    expect((await runner.expectOk(FINISH, { id: draftId, reply: 'Which export?' })).finishDraft).toBe(true);
    await board.person.expectOk(SAY, { id: draftId, message: 'The CSV one' });
    await runner.expectOk(CLAIM, { id: draftId });
    await runner.expectOk(FINISH, { id: draftId, reply: 'Got it.', brief: 'Speed up the CSV export.' });

    expect((await runsOf(draftId)).map((run) => [run.status, run.output])).toEqual([
      ['ok', 'Which export?'],
      ['ok', 'Got it.'],
    ]);
  });

  it('records a failed reply with its error, so it can be read', async () => {
    const { draftId, runId } = await claimedDraft(board, runner);
    await runner.expectOk(FINISH, {
      id: draftId,
      runId,
      error: 'model unreachable',
      prompt: PROMPT,
      usage: { promptTokens: 40, completionTokens: 0, totalTokens: 40 },
    });
    expect(await runsOf(draftId)).toMatchObject([
      { status: 'error', error: 'model unreachable', output: null, userPrompt: PROMPT.user, totalTokens: 40 },
    ]);
  });

  it('stops the run when the person stops waiting, and keeps what a late answer spent', async () => {
    const { draftId, runId } = await claimedDraft(board, runner);
    await board.person.expectOk(STOP, { id: draftId });
    expect(await storedRun(runId)).toMatchObject({ status: 'stopped', totalTokens: 0 });

    const late = await runner.expectOk(FINISH, { id: draftId, runId, reply: 'Late', usage: DRAFT_USAGE });
    expect(late.finishDraft).toBe(false);
    expect(await storedRun(runId)).toMatchObject({ status: 'stopped', output: null, totalTokens: 50 });
    expect((await board.person.expectOk(READ, { id: draftId })).draft.messages).toHaveLength(1);
  });

  it('stops a draft’s run through cancelRun as stopDraft does, without setting a todo aside', async () => {
    const todoId = await board.addTodo('Untouched');
    const { draftId, runId } = await claimedDraft(board, runner);
    expect((await board.person.expectOk(CANCEL_RUN, { id: runId })).cancelRun).toEqual({
      id: runId,
      status: 'stopped',
    });
    expect((await board.person.expectOk(READ, { id: draftId })).draft.waitingSince).toBeNull();
    const [todo] = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, todoId));
    expect(todo.aiIgnored).toBe(false);
    // The turn is the person's again.
    await board.person.expectOk(SAY, { id: draftId, message: 'Never mind, the CSV one' });
  });

  it('closes a reply whose runner died and lets the draft be taken again', async () => {
    const { draftId, runId } = await claimedDraft(board, runner);
    expect((await runner.expectOk(WAITING)).runnerDrafts).toEqual([]);
    await db
      .update(dbSchema.runs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(dbSchema.runs.id, runId));
    expect((await runner.expectOk(WAITING)).runnerDrafts).toEqual([draftId]);

    const again = (await runner.expectOk(CLAIM, { id: draftId })).claimDraft;
    expect(again.runId).not.toBe(runId);
    expect(await storedRun(runId)).toMatchObject({ status: 'error', error: DRAFT_LEASE_LAPSED });

    // The first runner was only slow. Its answer is not the one being waited for.
    expect((await runner.expectOk(FINISH, { id: draftId, runId, reply: 'Old', usage: DRAFT_USAGE })).finishDraft).toBe(
      false,
    );
    expect(await storedRun(runId)).toMatchObject({ status: 'error', totalTokens: 50 });
    expect((await runner.expectOk(FINISH, { id: draftId, runId: again.runId, reply: 'New' })).finishDraft).toBe(true);
    const draft = (await board.person.expectOk(READ, { id: draftId })).draft;
    expect(draft.messages.map((m: { content: string }) => m.content)).toEqual(['Make the export faster', 'New']);
  });

  it('drops a reply that lands after AI was switched off, and records it as stopped', async () => {
    const { draftId, runId } = await claimedDraft(board, runner);
    await db.update(dbSchema.projects).set({ aiEnabled: false }).where(eq(dbSchema.projects.id, board.projectId));
    const landed = await runner.expectOk(FINISH, {
      id: draftId,
      runId,
      reply: 'Too late',
      prompt: PROMPT,
      usage: DRAFT_USAGE,
      events: EVENTS,
    });
    expect(landed.finishDraft).toBe(false);
    expect(await storedRun(runId)).toMatchObject({
      status: 'stopped',
      output: null,
      events: [],
      userPrompt: null,
      totalTokens: 50,
    });
    expect(await db.select().from(dbSchema.draftMessages)).toHaveLength(1);
  });

  it('keeps the runs with the draft when it becomes a todo, and the todo points back at it', async () => {
    const { draftId, runId } = await claimedDraft(board, runner);
    await runner.expectOk(FINISH, {
      id: draftId,
      runId,
      reply: 'Done.',
      title: 'Faster export',
      brief: 'Speed it up.',
    });
    const todo = (await board.person.expectOk(MAKE, { id: draftId })).makeTodoFromDraft;

    const read = await board.person.expectOk(
      `query ($id: UUID!) { todo(where: { id: { eq: $id } }) { runs { id } draft { id runs { id kind } } } }`,
      { id: todo.id },
    );
    expect(read.todo).toEqual({ runs: [], draft: { id: draftId, runs: [{ id: runId, kind: 'draft' }] } });
    expect(await storedRun(runId)).toMatchObject({ draftId, todoId: null });
  });

  it('stops a reply still on its way when the draft becomes a todo', async () => {
    const { draftId, runId } = await claimedDraft(board, runner);
    await board.person.expectOk(MAKE, { id: draftId, brief: 'Speed up the export.' });
    expect(await storedRun(runId)).toMatchObject({ status: 'stopped' });
    expect((await runner.expectOk(FINISH, { id: draftId, runId, reply: 'Late' })).finishDraft).toBe(false);
  });

  it('deletes the runs with a discarded draft, and a finished one on its own', async () => {
    const first = await claimedDraft(board, runner);
    await runner.expectOk(FINISH, { id: first.draftId, runId: first.runId, reply: 'Done.' });
    expect((await board.person.expectOk(DELETE_RUN, { id: first.runId })).deleteRun).toBe(true);
    expect(await runsOf(first.draftId)).toEqual([]);

    const second = await claimedDraft(board, runner);
    expect((await board.person.expectError(DELETE_RUN, { id: second.runId })).code).toBe('CONFLICT');
    await board.person.expectOk(`mutation ($id: ID!) { discardDraft(id: $id) }`, { id: second.draftId });
    expect(await storedRun(second.runId)).toBeUndefined();
    expect(
      (await runner.expectOk(FINISH, { id: second.draftId, runId: second.runId, reply: 'Late' })).finishDraft,
    ).toBe(false);
  });

  it('is not a station’s run: finishRun and heartbeatRun refuse it and say what to use', async () => {
    const { runId } = await claimedDraft(board, runner);
    const finish = await runner.expectError(FINISH_RUN, { id: runId, result: { status: 'ok', output: 'Hi' } });
    expect(finish.code).toBe('BAD_USER_INPUT');
    expect(finish.message).toContain('finishDraft');
    expect((await runner.expectError(HEARTBEAT, { id: runId })).code).toBe('BAD_USER_INPUT');
    expect(await storedRun(runId)).toMatchObject({ status: 'running' });
  });

  it('holds a run to exactly the owner its kind names', async () => {
    const todoId = await board.addTodo('A todo');
    const { draftId } = await claimedDraft(board, runner);
    const base = { userId: board.userId, projectId: board.projectId, leaseExpiresAt: new Date() };
    const insert = (values: Record<string, unknown>) =>
      db.insert(dbSchema.runs).values({ ...base, ...values } as typeof dbSchema.runs.$inferInsert);

    await expect(insert({ kind: 'draft', todoId, contract: 'work' })).rejects.toThrow();
    await expect(insert({ kind: 'todo', draftId })).rejects.toThrow();
    await expect(insert({ kind: 'todo', todoId, draftId, contract: 'work' })).rejects.toThrow();
    await expect(insert({ kind: 'draft' })).rejects.toThrow();
    // One live reply per draft.
    await expect(insert({ kind: 'draft', draftId })).rejects.toThrow();
  });
});
