import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { pruneRuns } from '../retention.ts';
import {
  answeredDraft,
  type Board,
  claimedDraft,
  createBoard,
  DRAFT_USAGE,
  FINISH,
  QUEUE,
  runnerClient,
  setLane,
} from './board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

// A draft's replies are runs, and everything that reads runs to decide
// something about a todo must not count them: what is ready, what an agent
// gave up on, what a card says, whether an account has started. They do count
// where runs are simply listed and added up: a project's runs and its spend.

let db: TestDb;
let board: Board;
let runner: TestClient;

const DAY = 24 * 60 * 60_000;
const RETENTION_DAYS = 30;
const later = (days: number) => new Date(Date.now() + days * DAY);
const KEY_ID = '00000000-0000-0000-0000-000000000000';
const FAILED = { error: 'model unreachable' };

const CLAIM_TURN = `mutation ($todoId: ID!, $laneId: ID!) { claimRun(todoId: $todoId, laneId: $laneId) { runId turn } }`;
const MARKS = `query ($projectId: ID!) { cardMarks(projectId: $projectId) { todoId lastRun attempts } }`;
const STATUS = `query ($projectId: ID) {
  aiStatus(projectId: $projectId) {
    todos { todoId state failures liveRunId }
    projects { lanes { laneId attention running queued } }
  }
}`;
const PROJECT_RUNS = `query ($projectId: UUID!) {
  runs(where: { projectId: { eq: $projectId } }, orderBy: { startedAt: { direction: asc, priority: 1 } }) {
    id kind status draft { id } todo { id }
  }
  all: runsAggregate(where: { projectId: { eq: $projectId } }) { count sum { totalTokens } }
  drafts: runsAggregate(where: { projectId: { eq: $projectId }, kind: { eq: "draft" } }) { count sum { totalTokens } }
}`;
const TODO_RUNS = `query ($id: UUID!) { todo(where: { id: { eq: $id } }) { runs { id kind } } }`;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

async function queue(): Promise<string[]> {
  return (await runner.expectOk(QUEUE)).runnerQueue.map((row: { todoId: string }) => row.todoId);
}

describe('a draft’s runs and the lanes’ agents', () => {
  it('leaves the queue and a lane’s WIP limit alone while a reply is under way', async () => {
    const todoId = await board.addTodo('Ready');
    await claimedDraft(board, runner);
    // The lane takes one at a time, and a draft's reply is not one of them.
    expect(await queue()).toEqual([todoId]);
  });

  it('is not one of a todo’s turns: the first run of a todo is still its first', async () => {
    const todoId = await board.addTodo('Ready');
    await answeredDraft(board, runner);
    await answeredDraft(board, runner, FAILED);
    const claim = (await runner.expectOk(CLAIM_TURN, { todoId, laneId: board.lanes[0].id })).claimRun;
    expect(claim.turn).toBe(0);
  });

  it('never counts as a todo’s failure, so no agent gives up over a failed reply', async () => {
    await setLane(board.person, board.lanes[0].id, { maxAttempts: 1 });
    const todoId = await board.addTodo('Ready');
    await answeredDraft(board, runner, FAILED);
    await answeredDraft(board, runner, FAILED);
    expect(await queue()).toEqual([todoId]);

    const status = (await board.person.expectOk(STATUS, { projectId: board.projectId })).aiStatus;
    expect(status.todos).toEqual([{ todoId, state: 'queued', failures: 0, liveRunId: null }]);
    expect(status.projects[0].lanes[0]).toMatchObject({ attention: 0, running: 0, queued: 1 });
  });

  it('shows nothing running in a lane while only a draft is being answered', async () => {
    const todoId = await board.addTodo('Ready');
    await claimedDraft(board, runner);
    const status = (await board.person.expectOk(STATUS, { projectId: board.projectId })).aiStatus;
    expect(status.todos).toEqual([{ todoId, state: 'queued', failures: 0, liveRunId: null }]);
    expect(status.projects[0].lanes[0]).toMatchObject({ running: 0, queued: 1 });
  });

  it('marks no card: a failed reply is not a failed todo', async () => {
    await board.addTodo('Plain');
    await answeredDraft(board, runner, FAILED);
    expect((await board.person.expectOk(MARKS, { projectId: board.projectId })).cardMarks).toEqual([]);
  });

  it('leaves a todo’s own marks as they were', async () => {
    const todoId = await board.addTodo('Fails once');
    const { runId } = (await runner.expectOk(CLAIM_TURN, { todoId, laneId: board.lanes[0].id })).claimRun;
    await runner.expectOk(FINISH, { id: runId, result: { status: 'error', error: 'It broke.' } });
    // A later, passing reply to a draft does not clear the todo's failure.
    await answeredDraft(board, runner);
    expect((await board.person.expectOk(MARKS, { projectId: board.projectId })).cardMarks).toEqual([
      { todoId, lastRun: 'errored', attempts: 1 },
    ]);
  });
});

describe('a draft’s runs where runs are listed', () => {
  it('appears among a project’s runs and in its spend, marked as a draft’s', async () => {
    const todoId = await board.addTodo('Ready');
    const { runId: todoRunId } = (await runner.expectOk(CLAIM_TURN, { todoId, laneId: board.lanes[0].id })).claimRun;
    await runner.expectOk(FINISH, { id: todoRunId, result: { status: 'ok', output: 'Done.', totalTokens: 7 } });
    const { draftId, runId } = await answeredDraft(board, runner);

    const read = await board.person.expectOk(PROJECT_RUNS, { projectId: board.projectId });
    expect(read.runs).toEqual([
      { id: todoRunId, kind: 'todo', status: 'ok', draft: null, todo: { id: todoId } },
      { id: runId, kind: 'draft', status: 'ok', draft: { id: draftId }, todo: null },
    ]);
    expect(read.all).toEqual({ count: 2, sum: { totalTokens: 7 + DRAFT_USAGE.totalTokens } });
    expect(read.drafts).toEqual({ count: 1, sum: { totalTokens: DRAFT_USAGE.totalTokens } });
  });

  it('is not among a todo’s runs, even the todo its draft became', async () => {
    const { draftId } = await answeredDraft(board, runner);
    const todo = (
      await board.person.expectOk(`mutation ($id: ID!) { makeTodoFromDraft(id: $id) { id } }`, { id: draftId })
    ).makeTodoFromDraft;
    expect((await board.person.expectOk(TODO_RUNS, { id: todo.id })).todo.runs).toEqual([]);
  });

  it('is hidden from an API key and an agent, as the draft is', async () => {
    await answeredDraft(board, runner);
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: KEY_ID },
    });
    const read = await key.expectOk(PROJECT_RUNS, { projectId: board.projectId });
    expect(read.runs).toEqual([]);
    expect(read.all.count).toBe(0);
  });

  it('cannot be written through the generated API', async () => {
    const { runId } = await answeredDraft(board, runner);
    const result = await board.person.run(
      `mutation ($id: UUID!) { updateRun(set: { status: "running" }, where: { id: { eq: $id } }) { id } }`,
      { id: runId },
    );
    expect(result.errors?.length).toBeGreaterThan(0);
  });
});

describe('pruning a draft’s runs', () => {
  beforeEach(async () => {
    await board.person.expectOk(`mutation ($days: Int) { setRunRetention(days: $days) { id } }`, {
      days: RETENTION_DAYS,
    });
  });

  async function runIds(): Promise<string[]> {
    return (await db.select({ id: dbSchema.runs.id }).from(dbSchema.runs)).map((row: { id: string }) => row.id);
  }

  it('takes finished replies past the account’s retention, passed or failed, and keeps the conversation', async () => {
    const passed = await answeredDraft(board, runner);
    await answeredDraft(board, runner, FAILED);

    expect(await pruneRuns(db, later(RETENTION_DAYS - 1))).toBe(0);
    expect(await pruneRuns(db, later(RETENTION_DAYS + 1))).toBe(2);
    expect(await runIds()).toEqual([]);
    const messages = await db
      .select()
      .from(dbSchema.draftMessages)
      .where(eq(dbSchema.draftMessages.draftId, passed.draftId));
    expect(messages).toHaveLength(2);
  });

  it('leaves a reply still under way, and an account that keeps runs for good', async () => {
    const { runId } = await claimedDraft(board, runner);
    const other = await createBoard(db, 'other@example.com');
    const theirs = await answeredDraft(other, runner);

    expect(await pruneRuns(db, later(RETENTION_DAYS * 2))).toBe(0);
    expect((await runIds()).sort()).toEqual([runId, theirs.runId].sort());
  });
});
