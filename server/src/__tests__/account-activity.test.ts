import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { DELETED_AGENT } from '../resolvers/account-activity.ts';
import {
  answeredDraft,
  type Board,
  CLAIM,
  claimedDraft,
  createBoard,
  DRAFT_USAGE,
  FINISH,
  runnerClient,
  SET_AUTO_RUN,
  setLane,
} from './board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

// An account's activity across its projects: what its runs spent, by project
// and by agent, and which todos wait on a person because of how a run went.

let db: TestDb;
let board: Board;
let runner: TestClient;

const DAY = 24 * 60 * 60_000;
const KEY_ID = '00000000-0000-0000-0000-000000000000';
const LINE = 'id name runs draftReplies promptTokens completionTokens totalTokens';
const SPEND = `query ($since: DateTime!) {
  accountSpend(since: $since) {
    since keptSince retentionDays
    total { ${LINE} }
    byProject { ${LINE} }
    byAgent { ${LINE} }
  }
}`;
const ATTENTION = `query {
  accountAttention {
    todoId title projectId projectName laneId laneName outOfAttempts errored reason runId attempts maxAttempts
  }
}`;
const ACCOUNT_LISTS = `query {
  runs(orderBy: { startedAt: { direction: desc, priority: 1 } }) { id kind project { id name } todo { id title } }
  artifacts(orderBy: { createdAt: { direction: desc, priority: 1 } }) { id location project { id name } todo { id title } }
  todos(deleted: ONLY, orderBy: { archivedAt: { direction: desc, priority: 1 } }) { id title project { id name } }
}`;
const RESTORE = `mutation ($id: UUID!) { restoreTodo(where: { id: { eq: $id } }) { id } }`;

const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

/** Works a todo once where it stands and reports how it went. */
async function runOnce(todoId: string, result: Record<string, unknown>): Promise<string> {
  const lane = (await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, todoId)))[0].laneId;
  const { runId } = (await runner.expectOk(CLAIM, { todoId, laneId: lane })).claimRun;
  await runner.expectOk(FINISH, { id: runId, result });
  return runId;
}

/** A second project of the board's account, with a station of its own worked by a second agent. */
async function secondProject(): Promise<{
  projectId: string;
  agentId: string;
  addTodo: (title: string) => Promise<string>;
}> {
  const { person } = board;
  const projectId = (await person.expectOk(`mutation { createProject(values: { name: "Q" }) { id } }`)).createProject
    .id;
  await person.expectOk(`mutation ($id: ID!) { setProjectAiEnabled(projectId: $id, enabled: true) { id } }`, {
    id: projectId,
  });
  await person.expectOk(SET_AUTO_RUN, { id: projectId, enabled: true });
  const lanes = (
    await person.expectOk(
      `query ($projectId: UUID!) {
        lanes(where: { projectId: { eq: $projectId } }, orderBy: { position: { direction: asc, priority: 1 } }) { id }
      }`,
      { projectId },
    )
  ).lanes;
  const agentId = (
    await person.expectOk(
      `mutation { createAgent(values: { name: "Reviewer", baseUrl: "http://llm.test/v1", model: "tiny" }) { id } }`,
    )
  ).createAgent.id;
  await setLane(person, lanes[0].id, { agentId, onSuccessLaneId: lanes[2].id, prompt: 'Review it.' });
  const addTodo = async (title: string) =>
    (
      await person.expectOk(
        `mutation ($projectId: UUID!, $title: String!) { createTodo(values: { projectId: $projectId, title: $title }) { id } }`,
        { projectId, title },
      )
    ).createTodo.id as string;
  return { projectId, agentId, addTodo };
}

async function spend(since: string = ago(30), client: TestClient = board.person) {
  return (await client.expectOk(SPEND, { since })).accountSpend;
}

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function attention(client: TestClient = board.person): Promise<any[]> {
  return (await client.expectOk(ATTENTION)).accountAttention;
}

describe('accountSpend', () => {
  it('is all zeroes for an account whose agents have done nothing', async () => {
    const read = await spend();
    expect(read.total).toEqual({
      id: null,
      name: 'Every project',
      runs: 0,
      draftReplies: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    expect(read.byProject).toEqual([]);
    expect(read.byAgent).toEqual([]);
  });

  it('adds up every project’s runs, by project and by agent, the most spent first', async () => {
    const second = await secondProject();
    const first = await board.addTodo('Write it');
    await runOnce(first, { status: 'ok', output: 'Wrote it.', promptTokens: 5, completionTokens: 2, totalTokens: 7 });
    const other = await second.addTodo('Review it');
    await runOnce(other, { status: 'ok', output: 'Fine.', promptTokens: 80, completionTokens: 20, totalTokens: 100 });
    await runOnce(await second.addTodo('And this'), { status: 'error', error: 'No.', totalTokens: 3 });

    const read = await spend();
    expect(read.total).toMatchObject({ runs: 3, draftReplies: 0, promptTokens: 85, completionTokens: 22 });
    expect(read.total.totalTokens).toBe(110);
    expect(read.byProject).toMatchObject([
      { id: second.projectId, name: 'Q', runs: 2, totalTokens: 103 },
      { id: board.projectId, name: 'P', runs: 1, totalTokens: 7 },
    ]);
    expect(read.byAgent).toMatchObject([
      { id: second.agentId, name: 'Reviewer', runs: 2, totalTokens: 103 },
      { id: board.agentId, name: 'Worker', runs: 1, totalTokens: 7 },
    ]);
  });

  it('counts a draft’s replies with the rest, and says how many they were', async () => {
    await runOnce(await board.addTodo('Write it'), { status: 'ok', output: 'Wrote it.', totalTokens: 7 });
    await answeredDraft(board, runner);

    const read = await spend();
    expect(read.total).toMatchObject({ runs: 2, draftReplies: 1, totalTokens: 7 + DRAFT_USAGE.totalTokens });
    expect(read.byProject).toMatchObject([{ id: board.projectId, runs: 2, draftReplies: 1 }]);
    expect(read.byAgent).toMatchObject([{ id: board.agentId, runs: 2, draftReplies: 1 }]);
  });

  it('leaves out runs from before the window', async () => {
    const runId = await runOnce(await board.addTodo('Old'), { status: 'ok', output: 'Done.', totalTokens: 9 });
    await db
      .update(dbSchema.runs)
      .set({ startedAt: new Date(Date.now() - 40 * DAY) })
      .where(eq(dbSchema.runs.id, runId));
    await runOnce(await board.addTodo('New'), { status: 'ok', output: 'Done.', totalTokens: 4 });

    expect((await spend(ago(30))).total).toMatchObject({ runs: 1, totalTokens: 4 });
    expect((await spend(ago(60))).total).toMatchObject({ runs: 2, totalTokens: 13 });
  });

  it('files the runs of a deleted agent under a line of their own', async () => {
    await runOnce(await board.addTodo('Write it'), { status: 'ok', output: 'Wrote it.', totalTokens: 7 });
    await setLane(board.person, board.lanes[0].id, { agentId: null });
    await db.delete(dbSchema.agents).where(eq(dbSchema.agents.id, board.agentId));

    expect((await spend()).byAgent).toMatchObject([{ id: null, name: DELETED_AGENT, runs: 1, totalTokens: 7 }]);
  });

  it('says where the window really starts once retention keeps less than was asked for', async () => {
    const whole = await spend(ago(30));
    expect(whole).toMatchObject({ keptSince: null, retentionDays: null });

    await db.update(dbSchema.users).set({ runRetentionDays: 7 }).where(eq(dbSchema.users.id, board.userId));
    const trimmed = await spend(ago(30));
    expect(trimmed.retentionDays).toBe(7);
    const kept = Date.parse(trimmed.keptSince);
    expect(Math.abs(kept - (Date.now() - 7 * DAY))).toBeLessThan(60_000);

    // A window shorter than what is kept is whole.
    expect((await spend(ago(3))).keptSince).toBeNull();
  });

  it('is the account’s own: another account’s runs are not in it', async () => {
    const other = await createBoard(db, 'other@example.com');
    await runOnce(await other.addTodo('Theirs'), { status: 'ok', output: 'Done.', totalTokens: 50 });
    await runOnce(await board.addTodo('Mine'), { status: 'ok', output: 'Done.', totalTokens: 4 });

    const read = await spend();
    expect(read.total).toMatchObject({ runs: 1, totalTokens: 4 });
    expect(read.byProject.map((line: { id: string }) => line.id)).toEqual([board.projectId]);
    expect(read.byAgent.map((line: { id: string }) => line.id)).toEqual([board.agentId]);
  });

  it('is a person’s: not there for a key, nor with AI off for the account or the instance', async () => {
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: KEY_ID },
    });
    expect((await key.expectError(SPEND, { since: ago(30) })).code).toBe('FORBIDDEN');

    await db.update(dbSchema.users).set({ aiEnabled: false }).where(eq(dbSchema.users.id, board.userId));
    expect((await board.person.expectError(SPEND, { since: ago(30) })).code).toBe('NOT_FOUND');

    // With AI off for the instance the field is not in the schema at all.
    const off = createClient(db, board.userId);
    expect((await off.expectError(SPEND, { since: ago(30) })).message).toContain('accountSpend');
  });
});

describe('accountAttention', () => {
  it('lists nothing while every run passed', async () => {
    await runOnce(await board.addTodo('Write it'), { status: 'ok', output: 'Wrote it.' });
    await board.addTodo('Untouched');
    expect(await attention()).toEqual([]);
  });

  it('lists a todo whose last run errored, with the error, the run and where it is', async () => {
    const todoId = await board.addTodo('Write it');
    const runId = await runOnce(todoId, { status: 'error', error: 'The model did not answer.' });

    expect(await attention()).toEqual([
      {
        todoId,
        title: 'Write it',
        projectId: board.projectId,
        projectName: 'P',
        laneId: board.lanes[0].id,
        laneName: board.lanes[0].name,
        outOfAttempts: false,
        errored: true,
        reason: 'The model did not answer.',
        runId,
        attempts: 1,
        maxAttempts: expect.any(Number),
      },
    ]);
  });

  it('lists a todo out of attempts, even when its runs were sent back rather than errored', async () => {
    // The work lane hands on to a reviewer, who sends what fails back to it.
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: board.lanes[1].id, maxAttempts: 0 });
    await setLane(board.person, board.lanes[1].id, {
      agentId: board.agentId,
      contract: 'verdict',
      onSuccessLaneId: board.lanes[2].id,
      onFailureLaneId: board.lanes[0].id,
    });
    const todoId = await board.addTodo('Write it');
    await runOnce(todoId, { status: 'ok', output: 'Wrote it.' });
    expect(await attention()).toEqual([]);

    const runId = await runOnce(todoId, { status: 'ok', output: 'FAIL: the second paragraph is missing.' });
    const [row] = await attention();
    expect(row).toMatchObject({
      todoId,
      laneId: board.lanes[0].id,
      outOfAttempts: true,
      errored: false,
      runId,
      attempts: 1,
      maxAttempts: 0,
    });
    expect(row.reason).toContain('the second paragraph is missing');
  });

  it('gathers them across projects, the latest failure first', async () => {
    const second = await secondProject();
    const first = await board.addTodo('Write it');
    await runOnce(first, { status: 'error', error: 'No.' });
    const other = await second.addTodo('Review it');
    const runId = await runOnce(other, { status: 'error', error: 'Nor this.' });
    await db
      .update(dbSchema.runs)
      .set({ startedAt: new Date(Date.now() + 60_000) })
      .where(eq(dbSchema.runs.id, runId));

    expect(await attention()).toMatchObject([
      { todoId: other, projectId: second.projectId, projectName: 'Q' },
      { todoId: first, projectId: board.projectId, projectName: 'P' },
    ]);
  });

  it('drops a todo once a later run passes, or a person sends it round again', async () => {
    const passed = await board.addTodo('Passes later');
    await runOnce(passed, { status: 'error', error: 'No.' });
    const retried = await board.addTodo('Retried');
    await runOnce(retried, { status: 'error', error: 'No.' });
    expect(await attention()).toHaveLength(2);

    await runOnce(passed, { status: 'ok', output: 'Wrote it.' });
    expect((await attention()).map((row) => row.todoId)).toEqual([retried]);

    await board.person.expectOk(`mutation ($id: ID!) { retryTodo(id: $id) }`, { id: retried });
    expect(await attention()).toEqual([]);
  });

  it('never lists a draft: a failed reply is not a todo waiting on anyone', async () => {
    await board.addTodo('Plain');
    await answeredDraft(board, runner, { error: 'model unreachable' });
    await claimedDraft(board, runner);
    expect(await attention()).toEqual([]);
  });

  it('leaves out what nobody is waiting on: archived, done, ignored, being worked, or in a project with AI off', async () => {
    const archived = await board.addTodo('Archived');
    const done = await board.addTodo('Done');
    const ignored = await board.addTodo('Ignored');
    const working = await board.addTodo('Working');
    for (const todoId of [archived, done, ignored, working]) {
      await runOnce(todoId, { status: 'error', error: 'No.' });
    }
    expect(await attention()).toHaveLength(4);

    const setAi = `mutation ($id: ID!, $enabled: Boolean!) { setProjectAiEnabled(projectId: $id, enabled: $enabled) { id } }`;
    await board.person.expectOk(setAi, { id: board.projectId, enabled: false });
    expect(await attention()).toEqual([]);
    await board.person.expectOk(setAi, { id: board.projectId, enabled: true });
    expect(await attention()).toHaveLength(4);

    await db.update(dbSchema.todos).set({ archivedAt: new Date() }).where(eq(dbSchema.todos.id, archived));
    await db.update(dbSchema.todos).set({ completedAt: new Date() }).where(eq(dbSchema.todos.id, done));
    await db.update(dbSchema.todos).set({ aiIgnored: true }).where(eq(dbSchema.todos.id, ignored));
    await runner.expectOk(CLAIM, { todoId: working, laneId: board.lanes[0].id });
    expect(await attention()).toEqual([]);
  });

  it('is the account’s own, and a person’s', async () => {
    const other = await createBoard(db, 'other@example.com');
    await runOnce(await other.addTodo('Theirs'), { status: 'error', error: 'No.' });
    expect(await attention()).toEqual([]);
    expect(await attention(other.person)).toHaveLength(1);

    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: KEY_ID },
    });
    expect((await key.expectError(ATTENTION)).code).toBe('FORBIDDEN');
    await db.update(dbSchema.users).set({ aiEnabled: false }).where(eq(dbSchema.users.id, board.userId));
    expect((await board.person.expectError(ATTENTION)).code).toBe('NOT_FOUND');
  });
});

describe('the account’s lists', () => {
  it('reads runs, artifacts and archived todos across projects, each with its project', async () => {
    const second = await secondProject();
    const first = await board.addTodo('Write it');
    const firstRun = await runOnce(first, {
      status: 'ok',
      output: 'Wrote it.',
      artifacts: [{ location: 'https://files.test/report.md', source: 'declared', title: 'Report' }],
    });
    const other = await second.addTodo('Review it');
    const otherRun = await runOnce(other, { status: 'ok', output: 'Fine.' });
    await db
      .update(dbSchema.runs)
      .set({ startedAt: new Date(Date.now() + 60_000) })
      .where(eq(dbSchema.runs.id, otherRun));
    const { runId: draftRun } = await answeredDraft(board, runner);
    await db
      .update(dbSchema.runs)
      .set({ startedAt: new Date(Date.now() + 120_000) })
      .where(eq(dbSchema.runs.id, draftRun));
    await board.person.expectOk(`mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }`, {
      id: other,
    });

    const theirs = await createBoard(db, 'other@example.com');
    await runOnce(await theirs.addTodo('Theirs'), { status: 'ok', output: 'Done.' });

    const read = await board.person.expectOk(ACCOUNT_LISTS);
    expect(read.runs).toEqual([
      { id: draftRun, kind: 'draft', project: { id: board.projectId, name: 'P' }, todo: null },
      // An archived todo is still what its run was about.
      {
        id: otherRun,
        kind: 'todo',
        project: { id: second.projectId, name: 'Q' },
        todo: { id: other, title: 'Review it' },
      },
      {
        id: firstRun,
        kind: 'todo',
        project: { id: board.projectId, name: 'P' },
        todo: { id: first, title: 'Write it' },
      },
    ]);
    expect(read.artifacts).toMatchObject([
      {
        location: 'https://files.test/report.md',
        project: { id: board.projectId, name: 'P' },
        todo: { id: first, title: 'Write it' },
      },
    ]);
    expect(read.todos).toEqual([{ id: other, title: 'Review it', project: { id: second.projectId, name: 'Q' } }]);

    await board.person.expectOk(RESTORE, { id: other });
    expect((await board.person.expectOk(ACCOUNT_LISTS)).todos).toEqual([]);
  });
});
