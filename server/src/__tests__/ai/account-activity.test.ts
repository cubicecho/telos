import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { DELETED_AGENT } from '../../ai/account-activity.ts';
import { type Board, CLAIM, createBoard, FINISH, runnerClient, SET_AUTO_RUN, setLane } from '../board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from '../helpers.ts';

// An account's activity across its projects: what its runs spent, by project
// and by agent, and which todos wait on a person because of how a run went.

let db: TestDb;
let board: Board;
let runner: TestClient;

const DAY = 24 * 60 * 60_000;
const KEY_ID = '00000000-0000-0000-0000-000000000000';
const LINE = 'id name runs promptTokens completionTokens totalTokens';
const SPEND = `query ($since: DateTime!) {
  accountSpend(since: $since) {
    since keptSince retentionDays
    total { ${LINE} }
    byProject { ${LINE} }
    byAgent { ${LINE} }
  }
}`;
const HANDED_BACK = `query {
  accountHandedBack {
    todoId title projectId projectName laneId laneName handedBack reason runId attempts maxAttempts
  }
}`;
const ACCOUNT_LISTS = `query {
  runs(orderBy: { startedAt: { direction: desc, priority: 1 } }) { id project { id name } todo { id title } }
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

/** A second project of the board's account, with a lane of its own worked by a second agent. */
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
  await setLane(person, lanes[0].id, { agentId, onSuccessLaneId: lanes[2].id });
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
async function handedBack(client: TestClient = board.person): Promise<any[]> {
  return (await client.expectOk(HANDED_BACK)).accountHandedBack;
}

/** Has a lane's agent give a todo up after its first failure. */
async function giveUpAtOnce(client: TestClient, laneId: string): Promise<void> {
  await setLane(client, laneId, { maxAttempts: 0 });
}

describe('accountSpend', () => {
  it('is all zeroes for an account whose agents have done nothing', async () => {
    const read = await spend();
    expect(read.total).toEqual({
      id: null,
      name: 'Every project',
      runs: 0,
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
    await runOnce(first, { status: 'OK', output: 'Wrote it.', promptTokens: 5, completionTokens: 2, totalTokens: 7 });
    const other = await second.addTodo('Review it');
    await runOnce(other, { status: 'OK', output: 'Fine.', promptTokens: 80, completionTokens: 20, totalTokens: 100 });
    await runOnce(await second.addTodo('And this'), { status: 'ERROR', error: 'No.', totalTokens: 3 });

    const read = await spend();
    expect(read.total).toMatchObject({ runs: 3, promptTokens: 85, completionTokens: 22 });
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

  it('leaves out runs from before the window', async () => {
    const runId = await runOnce(await board.addTodo('Old'), { status: 'OK', output: 'Done.', totalTokens: 9 });
    await db
      .update(dbSchema.runs)
      .set({ startedAt: new Date(Date.now() - 40 * DAY) })
      .where(eq(dbSchema.runs.id, runId));
    await runOnce(await board.addTodo('New'), { status: 'OK', output: 'Done.', totalTokens: 4 });

    expect((await spend(ago(30))).total).toMatchObject({ runs: 1, totalTokens: 4 });
    expect((await spend(ago(60))).total).toMatchObject({ runs: 2, totalTokens: 13 });
  });

  it('files the runs of a deleted agent under a line of their own', async () => {
    await runOnce(await board.addTodo('Write it'), { status: 'OK', output: 'Wrote it.', totalTokens: 7 });
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
    await runOnce(await other.addTodo('Theirs'), { status: 'OK', output: 'Done.', totalTokens: 50 });
    await runOnce(await board.addTodo('Mine'), { status: 'OK', output: 'Done.', totalTokens: 4 });

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

describe('accountHandedBack', () => {
  beforeEach(async () => {
    await giveUpAtOnce(board.person, board.lanes[0].id);
  });

  it('lists nothing while every run passed', async () => {
    await runOnce(await board.addTodo('Write it'), { status: 'OK', output: 'Wrote it.' });
    await board.addTodo('Untouched');
    expect(await handedBack()).toEqual([]);
  });

  it('lists nothing for a todo that failed with attempts left: its agent tries again', async () => {
    await setLane(board.person, board.lanes[0].id, { maxAttempts: 1 });
    await runOnce(await board.addTodo('Write it'), { status: 'ERROR', error: 'The model did not answer.' });
    expect(await handedBack()).toEqual([]);
  });

  it('lists a todo its agent gave up on, with the error, the run and where it is', async () => {
    const todoId = await board.addTodo('Write it');
    const runId = await runOnce(todoId, { status: 'ERROR', error: 'The model did not answer.' });

    expect(await handedBack()).toEqual([
      {
        todoId,
        title: 'Write it',
        projectId: board.projectId,
        projectName: 'P',
        laneId: board.lanes[0].id,
        laneName: board.lanes[0].name,
        handedBack: 'GAVE_UP',
        reason: 'The model did not answer.',
        runId,
        attempts: 1,
        maxAttempts: 0,
      },
    ]);
  });

  it('lists a todo its agent gave up on when its runs were sent back rather than errored', async () => {
    // The work lane hands on to a reviewer, who sends what fails back to it.
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: board.lanes[1].id });
    await setLane(board.person, board.lanes[1].id, {
      agentId: board.agentId,
      onSuccessLaneId: board.lanes[2].id,
      onFailureLaneId: board.lanes[0].id,
    });
    const todoId = await board.addTodo('Write it');
    await runOnce(todoId, { status: 'OK', output: 'Wrote it.' });
    expect(await handedBack()).toEqual([]);

    const runId = await runOnce(todoId, { status: 'OK', output: 'FAIL: the second paragraph is missing.' });
    const [row] = await handedBack();
    expect(row).toMatchObject({ todoId, laneId: board.lanes[0].id, handedBack: 'GAVE_UP', runId, attempts: 1 });
    expect(row.reason).toContain('the second paragraph is missing');
  });

  it('lists a todo its agent finished with and has nowhere to send', async () => {
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: null });
    const todoId = await board.addTodo('Write it');
    const runId = await runOnce(todoId, { status: 'OK', output: 'Wrote it.' });

    expect(await handedBack()).toMatchObject([
      { todoId, handedBack: 'FINISHED', reason: 'To do finished with it and has nowhere to send it.', runId },
    ]);
  });

  it('gathers them across projects, the latest run first', async () => {
    const second = await secondProject();
    const secondLane = (await db.select().from(dbSchema.lanes).where(eq(dbSchema.lanes.agentId, second.agentId)))[0];
    await giveUpAtOnce(board.person, secondLane.id);
    const first = await board.addTodo('Write it');
    await runOnce(first, { status: 'ERROR', error: 'No.' });
    const other = await second.addTodo('Review it');
    const runId = await runOnce(other, { status: 'ERROR', error: 'Nor this.' });
    await db
      .update(dbSchema.runs)
      .set({ startedAt: new Date(Date.now() + 60_000) })
      .where(eq(dbSchema.runs.id, runId));

    expect(await handedBack()).toMatchObject([
      { todoId: other, projectId: second.projectId, projectName: 'Q' },
      { todoId: first, projectId: board.projectId, projectName: 'P' },
    ]);
  });

  it('drops a todo once a person sends it round again', async () => {
    const kept = await board.addTodo('Kept');
    await runOnce(kept, { status: 'ERROR', error: 'No.' });
    const retried = await board.addTodo('Retried');
    await runOnce(retried, { status: 'ERROR', error: 'No.' });
    expect(await handedBack()).toHaveLength(2);

    await board.person.expectOk(`mutation ($id: ID!) { retryTodo(id: $id) }`, { id: retried });
    expect((await handedBack()).map((row) => row.todoId)).toEqual([kept]);
  });

  it('leaves out what nobody is waiting on: archived, done, ignored, or in a project with AI off', async () => {
    const archived = await board.addTodo('Archived');
    const done = await board.addTodo('Done');
    const ignored = await board.addTodo('Ignored');
    for (const todoId of [archived, done, ignored]) {
      await runOnce(todoId, { status: 'ERROR', error: 'No.' });
    }
    expect(await handedBack()).toHaveLength(3);

    const setAi = `mutation ($id: ID!, $enabled: Boolean!) { setProjectAiEnabled(projectId: $id, enabled: $enabled) { id } }`;
    await board.person.expectOk(setAi, { id: board.projectId, enabled: false });
    expect(await handedBack()).toEqual([]);
    await board.person.expectOk(setAi, { id: board.projectId, enabled: true });
    expect(await handedBack()).toHaveLength(3);

    await db.update(dbSchema.todos).set({ archivedAt: new Date() }).where(eq(dbSchema.todos.id, archived));
    await db.update(dbSchema.todos).set({ completedAt: new Date() }).where(eq(dbSchema.todos.id, done));
    await db.update(dbSchema.todos).set({ aiIgnored: true }).where(eq(dbSchema.todos.id, ignored));
    expect(await handedBack()).toEqual([]);
  });

  it('is the account’s own, and a person’s', async () => {
    const other = await createBoard(db, 'other@example.com');
    await giveUpAtOnce(other.person, other.lanes[0].id);
    await runOnce(await other.addTodo('Theirs'), { status: 'ERROR', error: 'No.' });
    expect(await handedBack()).toEqual([]);
    expect(await handedBack(other.person)).toHaveLength(1);

    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: KEY_ID },
    });
    expect((await key.expectError(HANDED_BACK)).code).toBe('FORBIDDEN');
    await db.update(dbSchema.users).set({ aiEnabled: false }).where(eq(dbSchema.users.id, board.userId));
    expect((await board.person.expectError(HANDED_BACK)).code).toBe('NOT_FOUND');
  });
});

describe('the account’s lists', () => {
  it('reads runs, artifacts and archived todos across projects, each with its project', async () => {
    const second = await secondProject();
    const first = await board.addTodo('Write it');
    const firstRun = await runOnce(first, {
      status: 'OK',
      output: 'Wrote it.',
      artifacts: [{ location: 'https://files.test/report.md', source: 'declared', title: 'Report' }],
    });
    const other = await second.addTodo('Review it');
    const otherRun = await runOnce(other, { status: 'OK', output: 'Fine.' });
    await db
      .update(dbSchema.runs)
      .set({ startedAt: new Date(Date.now() + 60_000) })
      .where(eq(dbSchema.runs.id, otherRun));
    await board.person.expectOk(`mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }`, {
      id: other,
    });

    const theirs = await createBoard(db, 'other@example.com');
    await runOnce(await theirs.addTodo('Theirs'), { status: 'OK', output: 'Done.' });

    const read = await board.person.expectOk(ACCOUNT_LISTS);
    expect(read.runs).toEqual([
      // An archived todo is still what its run was about.
      {
        id: otherRun,
        project: { id: second.projectId, name: 'Q' },
        todo: { id: other, title: 'Review it' },
      },
      {
        id: firstRun,
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
