import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { pruneRuns } from '../retention.ts';
import { type Board, CLAIM, createBoard, FINISH, QUEUE, runnerClient } from './board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

// Old runs, pruned after the account's retention, but never one the stations
// still count: pruning changes what is kept, not what runs next.

let db: TestDb;
let board: Board;
let runner: TestClient;

const DAY = 24 * 60 * 60_000;
const later = (days: number) => new Date(Date.now() + days * DAY);

const RETAIN = `mutation ($days: Int) { setRunRetention(days: $days) { id runRetentionDays } }`;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
  await board.person.expectOk(RETAIN, { days: 30 });
});

/** Claims `todoId` at `on`'s station and finishes the run with `result`. */
async function work(todoId: string, result: Record<string, unknown>, on = board): Promise<string> {
  const { runId } = (await runner.expectOk(CLAIM, { todoId, laneId: on.lanes[0].id })).claimRun;
  await runner.expectOk(FINISH, { id: runId, result });
  return runId;
}

async function runIds(): Promise<string[]> {
  return (await db.select({ id: dbSchema.runs.id }).from(dbSchema.runs)).map((row: { id: string }) => row.id);
}

describe('pruning runs', () => {
  it('takes a done todo’s runs once they are old enough', async () => {
    const todo = await board.addTodo('Done soon');
    await work(todo, { status: 'ok', output: 'Done.' });

    expect(await pruneRuns(db, later(10))).toBe(0);
    expect(await pruneRuns(db, later(31))).toBe(1);
    expect(await runIds()).toEqual([]);
    // What the run did stays.
    const history = await db.select().from(dbSchema.todoEvents).where(eq(dbSchema.todoEvents.todoId, todo));
    expect(history.some((event: { runId: string | null }) => event.runId)).toBe(true);
  });

  it('keeps a failure the station still counts, until a person touches the todo', async () => {
    const todo = await board.addTodo('Keeps failing');
    await work(todo, { status: 'error', error: 'It broke.' });

    expect(await pruneRuns(db, later(60))).toBe(0);
    await board.person.expectOk(
      `mutation ($id: UUID!) { updateTodo(where: { id: { eq: $id } }, set: { title: "Try again" }) { id } }`,
      { id: todo },
    );
    expect(await pruneRuns(db, later(60))).toBe(1);
  });

  it('never wakes a todo a station finished with', async () => {
    await db.update(dbSchema.lanes).set({ onSuccessLaneId: null }).where(eq(dbSchema.lanes.id, board.lanes[0].id));
    const todo = await board.addTodo('Stays put');
    await work(todo, { status: 'ok', output: 'Done here.' });

    expect(await pruneRuns(db, later(60))).toBe(0);
    const queue = (await runner.expectOk(QUEUE)).runnerQueue.map((row: { todoId: string }) => row.todoId);
    expect(queue).not.toContain(todo);
  });

  it('leaves a running run, and an account that keeps runs for good', async () => {
    const todo = await board.addTodo('Busy');
    await runner.expectOk(CLAIM, { todoId: todo, laneId: board.lanes[0].id });
    const other = await createBoard(db, 'other@example.com');
    await work(await other.addTodo('Theirs'), { status: 'ok', output: 'Done.' }, other);

    expect(await pruneRuns(db, later(365))).toBe(0);
    expect(await runIds()).toHaveLength(2);
  });
});

describe('setRunRetention', () => {
  it('takes days, or null for good, from a person only', async () => {
    expect((await board.person.expectOk(RETAIN, { days: null })).setRunRetention.runRetentionDays).toBeNull();
    expect((await board.person.expectError(RETAIN, { days: 0 })).code).toBe('BAD_USER_INPUT');
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: '00000000-0000-0000-0000-000000000000' },
    });
    expect((await key.expectError(RETAIN, { days: 1 })).code).toBe('FORBIDDEN');
  });
});
