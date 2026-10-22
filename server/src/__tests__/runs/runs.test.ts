import * as dbSchema from '@telos/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveActor } from '../../auth/actor.ts';
import type { Actor } from '../../core/context.ts';
import { runToolsOff } from '../../mcp/door.ts';
import { mintRunToken } from '../../runs/tokens.ts';
import { type Board, CLAIM, createBoard, FINISH, HEARTBEAT, QUEUE, runnerClient, setLane } from '../board.ts';
import { authFor, createClient, createTestDb, type TestClient, type TestDb } from '../helpers.ts';

// The runner's side of the board: what is ready, claiming it, keeping it, and
// what a finished run does to the todo. The runner is the system principal
// here, as it is in production, and the agent is a run token.

let db: TestDb;
let board: Board;
let runner: TestClient;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function queue(): Promise<any[]> {
  return (await runner.expectOk(QUEUE)).runnerQueue;
}

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function claim(todoId: string, laneId = board.lanes[0].id): Promise<any> {
  return (await runner.expectOk(CLAIM, { todoId, laneId })).claimRun;
}

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function finish(runId: string, result: Record<string, unknown>): Promise<any> {
  return (await runner.expectOk(FINISH, { id: runId, result })).finishRun;
}

const SET_NEW_TODO_LANE = `mutation ($id: UUID!, $laneId: UUID) {
  updateProject(set: { newTodoLaneId: $laneId }, where: { id: { eq: $id } }) { id }
}`;

async function todoRow(id: string) {
  const [row] = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, id));
  return row;
}

async function thread(todoId: string) {
  return db.select().from(dbSchema.todoNotes).where(eq(dbSchema.todoNotes.todoId, todoId));
}

async function actorFor(headers: Record<string, string>): Promise<Actor> {
  return resolveActor(authFor(db), db, new Headers(headers), { ai: true, runnerKey: 'runner-secret' });
}

describe('runnerQueue', () => {
  it('lists a todo waiting in a lane with an agent', async () => {
    const todoId = await board.addTodo('Write it');
    expect(await queue()).toEqual([{ todoId, laneId: board.lanes[0].id, projectId: board.projectId }]);
  });

  it('skips lanes with no agent', async () => {
    const todoId = await board.addTodo('Write it');
    await board.person.expectOk(`mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`, {
      id: todoId,
      laneId: board.lanes[1].id,
    });
    expect(await queue()).toEqual([]);
  });

  it("respects the account's switch", async () => {
    await board.addTodo('Write it');
    await board.person.expectOk(`mutation { setAiEnabled(enabled: false) { id } }`);
    expect(await queue()).toEqual([]);
  });

  it("respects the project's switch", async () => {
    await board.addTodo('Write it');
    await board.person.expectOk(`mutation ($id: ID!) { setProjectAiEnabled(projectId: $id, enabled: false) { id } }`, {
      id: board.projectId,
    });
    expect(await queue()).toEqual([]);
  });

  it('skips a todo AI is told to ignore', async () => {
    const todoId = await board.addTodo('Write it');
    await board.person.expectOk(
      `mutation ($id: UUID!) { updateTodo(set: { aiIgnored: true }, where: { id: { eq: $id } }) { id } }`,
      { id: todoId },
    );
    expect(await queue()).toEqual([]);
  });

  it('skips a blocked todo until what it waits on is done', async () => {
    const first = await board.addTodo('First');
    const second = await board.addTodo('Second');
    await board.person.expectOk(
      `mutation ($a: ID!, $b: ID!) { addTodoDependency(todoId: $a, dependsOnTodoId: $b) { id } }`,
      {
        a: second,
        b: first,
      },
    );
    expect((await queue()).map((row) => row.todoId)).toEqual([first]);
  });

  it('keeps to the WIP limit', async () => {
    const first = await board.addTodo('First');
    const second = await board.addTodo('Second');
    expect((await queue()).map((row) => row.todoId)).toEqual([first]);
    await claim(first);
    expect(await queue()).toEqual([]);
    await setLane(board.person, board.lanes[0].id, { wipLimit: 2 });
    expect((await queue()).map((row) => row.todoId)).toEqual([second]);
  });

  it('is the runner’s alone', async () => {
    const error = await board.person.expectError(QUEUE);
    expect(error.code).toBe('FORBIDDEN');
  });
});

describe('claimRun', () => {
  it('hands the runner the agent, its secret, the brief and a run token', async () => {
    const todoId = await board.addTodo('Write it');
    await board.person.expectOk(
      `mutation ($id: UUID!) { updateTodo(set: { notes: "The brief.", acceptance: "It exists." }, where: { id: { eq: $id } }) { id } }`,
      { id: todoId },
    );
    await board.person.expectOk(
      `mutation { createTodoNote(values: { todoId: "${todoId}", body: "Mind the tone." }) { id } }`,
    );
    await board.person.expectOk(
      `mutation ($id: UUID!) { updateProject(set: { prompt: "Keep artifacts in /srv/p." }, where: { id: { eq: $id } }) { id } }`,
      { id: board.projectId },
    );
    const claimed = await claim(todoId);
    expect(claimed.agent).toMatchObject({ name: 'Worker', apiKey: 'sk-secret', model: 'tiny', mcpServers: '[]' });
    expect(claimed.assignment).toMatchObject({
      projectName: 'P',
      projectContext: 'A test board.',
      projectPrompt: 'Keep artifacts in /srv/p.',
      laneName: 'To do',
      title: 'Write it',
      brief: 'The brief.',
      acceptance: 'It exists.',
      notes: ['Mind the tone.'],
    });
    expect(claimed.token).toBe(mintRunToken(claimed.runId));
  });

  it('gives two concurrent claims one winner', async () => {
    const todoId = await board.addTodo('Write it');
    await setLane(board.person, board.lanes[0].id, { wipLimit: 5 });
    const results = await Promise.all([claim(todoId), claim(todoId), claim(todoId)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('answers null for a todo that is not ready', async () => {
    const todoId = await board.addTodo('Write it');
    expect(await claim(todoId, board.lanes[1].id)).toBeNull();
  });

  it('frees a todo whose runner stopped renewing its lease', async () => {
    const todoId = await board.addTodo('Write it');
    const first = await claim(todoId);
    await db
      .update(dbSchema.runs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(dbSchema.runs.id, first.runId));
    const second = await claim(todoId);
    expect(second.runId).not.toBe(first.runId);
    const [abandoned] = await db.select().from(dbSchema.runs).where(eq(dbSchema.runs.id, first.runId));
    expect(abandoned.status).toBe('error');
  });

  it('is the runner’s alone', async () => {
    const todoId = await board.addTodo('Write it');
    const error = await board.person.expectError(CLAIM, { todoId, laneId: board.lanes[0].id });
    expect(error.code).toBe('FORBIDDEN');
  });
});

describe('a lane that reviews work', () => {
  // To do works it and passes it to In progress, which reviews it: its
  // failure route goes back to the lane that feeds it.
  const WORKED =
    '## Changes\nAdded src/search.tsx.\n\n## Verification\nAll good, trust me.\n\n## Open questions\nNone.';
  const RULING = 'FAIL\n- The box is labelled: not met. src/search.tsx:4 has no label.';

  beforeEach(async () => {
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: board.lanes[1].id });
    await setLane(board.person, board.lanes[1].id, {
      agentId: board.agentId,
      onSuccessLaneId: board.lanes[2].id,
      onFailureLaneId: board.lanes[0].id,
    });
  });

  async function worked(): Promise<{ todoId: string; runId: string }> {
    const todoId = await board.addTodo('Add a search box');
    const { runId } = await claim(todoId);
    await finish(runId, { status: 'OK', output: WORKED });
    return { todoId, runId };
  }

  it('is handed the todo and where the work is, but not the worker’s account of it', async () => {
    const { todoId, runId } = await worked();
    await board.person.expectOk(
      `mutation { createTodoNote(values: { todoId: "${todoId}", body: "Mind the tone." }) { id } }`,
    );
    await db
      .insert(dbSchema.todoNotes)
      .values({ userId: board.userId, todoId, kind: 'note', body: 'I checked it all.', actorKind: 'agent', runId });
    await db.insert(dbSchema.artifacts).values([
      {
        userId: board.userId,
        projectId: board.projectId,
        todoId,
        runId,
        location: 'src/search.tsx',
        source: 'detected',
      },
      {
        userId: board.userId,
        projectId: board.projectId,
        todoId,
        runId,
        location: 'telos:note/x',
        source: 'detected',
      },
    ]);

    const review = await claim(todoId, board.lanes[1].id);
    expect(review.assignment).toMatchObject({
      title: 'Add a search box',
      reviews: true,
      report: null,
      why: null,
      ruling: null,
      notes: ['Mind the tone.'],
      artifacts: [{ location: 'src/search.tsx', action: 'created', title: null }],
    });
  });

  it('is handed its last ruling when the work comes round again, and the worker its report and the ruling', async () => {
    const { todoId } = await worked();
    await finish((await claim(todoId, board.lanes[1].id)).runId, { status: 'OK', output: RULING });

    const rework = await claim(todoId);
    expect(rework.assignment).toMatchObject({ reviews: false, report: WORKED, why: RULING, ruling: RULING });
    await finish(rework.runId, { status: 'OK', output: WORKED });

    const again = await claim(todoId, board.lanes[1].id);
    expect(again.assignment).toMatchObject({ reviews: true, report: null, why: null, ruling: RULING });
  });

  it('is only one whose failure route goes back to a lane that feeds it', async () => {
    await setLane(board.person, board.lanes[1].id, { onFailureLaneId: null });
    const { todoId } = await worked();
    const claimed = await claim(todoId, board.lanes[1].id);
    expect(claimed.assignment).toMatchObject({ reviews: false, report: WORKED, why: WORKED });
  });
});

describe('finishRun', () => {
  it('sends passing work down the success route, completing it in the done lane', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    const run = await finish(runId, { status: 'OK', output: 'Wrote it.', totalTokens: 42 });
    expect(run).toMatchObject({ status: 'ok', verdict: 'none', output: 'Wrote it.', totalTokens: 42 });

    const todo = await todoRow(todoId);
    expect(todo.laneId).toBe(board.lanes[2].id);
    expect(todo.completedAt).not.toBeNull();
    expect(await thread(todoId)).toEqual([
      expect.objectContaining({ kind: 'report', body: 'Wrote it.', actorKind: 'agent', runId }),
    ]);
    const events = await db.select().from(dbSchema.todoEvents).where(eq(dbSchema.todoEvents.todoId, todoId));
    expect(events.at(-1)).toMatchObject({ kind: 'complete', actorKind: 'agent', runId });
  });

  it('does not run a todo again in a lane whose agent has finished with it', async () => {
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: null });
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await finish(runId, { status: 'OK', output: 'Done here.' });
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[0].id);
    expect(await queue()).toEqual([]);
  });

  it('reads a reply that opens with FAIL as a failing verdict, down the failure route', async () => {
    await setLane(board.person, board.lanes[0].id, { onFailureLaneId: board.lanes[1].id });
    const todoId = await board.addTodo('Review it');
    const { runId } = await claim(todoId);
    const run = await finish(runId, { status: 'OK', output: 'FAIL: the second paragraph is missing.' });
    expect(run).toMatchObject({ status: 'ok', verdict: 'fail' });
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[1].id);
    const [note] = await thread(todoId);
    expect(note).toMatchObject({ kind: 'verdict' });
    const events = await db.select().from(dbSchema.todoEvents).where(eq(dbSchema.todoEvents.todoId, todoId));
    expect(events.at(-1)).toMatchObject({ kind: 'move', noteId: note.id, reason: 'The review failed.' });
  });

  it('reads a ruling per acceptance criterion off its first word alone', async () => {
    await setLane(board.person, board.lanes[0].id, { onFailureLaneId: board.lanes[1].id });
    const ruling = (verdict: string) =>
      `${verdict}\n- Typing filters the list: met. \`npm test\` printed "12 passed".\n` +
      `- The box is labelled: not met. src/search.tsx:4 reads \`<input />\`, with no label.`;
    const failing = await board.addTodo('Review it');
    expect(await finish((await claim(failing)).runId, { status: 'OK', output: ruling('FAIL') })).toMatchObject({
      verdict: 'fail',
    });
    const passing = await board.addTodo('Review it again');
    expect(await finish((await claim(passing)).runId, { status: 'OK', output: ruling('PASS') })).toMatchObject({
      verdict: 'pass',
    });
    // A structured report is a report, whatever its sections say.
    const working = await board.addTodo('Do it');
    const report =
      '## Changes\nAdded the box.\n\n## Verification\nFAIL at first, then 12 passed.\n\n## Open questions\nNone.';
    expect(await finish((await claim(working)).runId, { status: 'OK', output: report })).toMatchObject({
      verdict: 'none',
    });
  });

  it('hands the agent a todo comes back to the ruling that sent it back', async () => {
    await setLane(board.person, board.lanes[0].id, { onFailureLaneId: board.lanes[1].id });
    await setLane(board.person, board.lanes[1].id, { agentId: board.agentId, onSuccessLaneId: board.lanes[0].id });
    const todoId = await board.addTodo('Review it');
    const ruling = 'FAIL\n- The box is labelled: not met. src/search.tsx:4 has no label.';
    await finish((await claim(todoId)).runId, { status: 'OK', output: ruling });
    const back = await claim(todoId, board.lanes[1].id);
    expect(back.assignment.why).toBe(ruling);
  });

  it('stops retrying after maxAttempts failures, until a person moves it', async () => {
    await setLane(board.person, board.lanes[0].id, { maxAttempts: 1 });
    const todoId = await board.addTodo('Write it');
    for (let attempt = 0; attempt < 2; attempt++) {
      const { runId } = await claim(todoId);
      await finish(runId, { status: 'ERROR', error: 'The model timed out.' });
    }
    expect(await queue()).toEqual([]);
    await board.person.expectOk(`mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`, {
      id: todoId,
      laneId: board.lanes[0].id,
    });
    // A reorder in place is no move; take it out and back.
    await board.person.expectOk(`mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`, {
      id: todoId,
      laneId: board.lanes[1].id,
    });
    await board.person.expectOk(`mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`, {
      id: todoId,
      laneId: board.lanes[0].id,
    });
    expect((await queue()).map((row) => row.todoId)).toEqual([todoId]);
  });

  it('reads a reply that opens with PASS as a passing verdict', async () => {
    const todoId = await board.addTodo('Review it');
    const run = await finish((await claim(todoId)).runId, { status: 'OK', output: 'PASS: reads well.' });
    expect(run).toMatchObject({ status: 'ok', verdict: 'pass' });
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[2].id);
    expect(await thread(todoId)).toEqual([expect.objectContaining({ kind: 'verdict', body: 'PASS: reads well.' })]);
  });

  it("puts a run's proposed todos where the project's new todos land, and makes the parent an umbrella", async () => {
    await board.person.expectOk(SET_NEW_TODO_LANE, { id: board.projectId, laneId: board.lanes[1].id });
    const parentId = await board.addTodo('Build the thing');
    const { runId } = await claim(parentId);
    await finish(runId, {
      status: 'OK',
      output: '[...]',
      todos: [
        { title: 'Design it', acceptance: 'A sketch.' },
        { title: 'Make it', dependsOn: ['Design it', 'Nonexistent'] },
      ],
    });
    const children = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.parentId, parentId));
    expect(children.map((child: { title: string; laneId: string }) => [child.title, child.laneId])).toEqual([
      ['Design it', board.lanes[1].id],
      ['Make it', board.lanes[1].id],
    ]);
    const edges = await db.select().from(dbSchema.todoDependencies);
    const byId = new Map<string, string>(
      children.map((child: { id: string; title: string }) => [child.id, child.title]),
    );
    byId.set(parentId, 'Build the thing');
    expect(
      edges
        .map(
          (edge: { todoId: string; dependsOnTodoId: string }) =>
            `${byId.get(edge.todoId)} -> ${byId.get(edge.dependsOnTodoId)}`,
        )
        .sort(),
    ).toEqual(['Make it -> Design it']);
    const childEvents = await db
      .select()
      .from(dbSchema.todoEvents)
      .where(eq(dbSchema.todoEvents.todoId, children[0].id));
    expect(childEvents[0]).toMatchObject({ kind: 'create', actorKind: 'agent', runId });
    expect(await todoRow(parentId)).toMatchObject({
      laneId: board.lanes[0].id,
      completedAt: null,
      splitAt: expect.any(Date),
    });
    expect((await thread(parentId)).map((note: { body: string }) => note.body)).toEqual([
      '[...]',
      'Split into 2 todos: Design it; Make it',
    ]);
  });

  it('puts proposed todos in the first open lane when the project names none, or names the done lane', async () => {
    const lanesOfChildren = async (parentId: string) =>
      (await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.parentId, parentId))).map(
        (child: { laneId: string }) => child.laneId,
      );
    const pieces = [{ title: 'One piece' }, { title: 'Another' }];
    const unset = await board.addTodo('Unset');
    await finish((await claim(unset)).runId, { status: 'OK', todos: pieces });
    expect(await lanesOfChildren(unset)).toEqual([board.lanes[0].id, board.lanes[0].id]);

    await board.person.expectOk(SET_NEW_TODO_LANE, { id: board.projectId, laneId: board.lanes[2].id });
    const done = await board.addTodo('Done lane');
    await finish((await claim(done)).runId, { status: 'OK', todos: pieces });
    expect(await lanesOfChildren(done)).toEqual([board.lanes[0].id, board.lanes[0].id]);
  });

  it('takes no todos from a run that failed', async () => {
    await setLane(board.person, board.lanes[0].id, { onFailureLaneId: board.lanes[1].id });
    const todoId = await board.addTodo('Review it');
    await finish((await claim(todoId)).runId, { status: 'OK', output: 'FAIL: no.', todos: [{ title: 'Fix it' }] });
    expect(await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.parentId, todoId))).toEqual([]);
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[1].id);
  });

  it('sends the pieces of a todo split in the new-todo lane on down its success route, already planned', async () => {
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: board.lanes[1].id });
    const parentId = await board.addTodo('Build the thing');
    await finish((await claim(parentId)).runId, {
      status: 'OK',
      todos: [{ title: 'Design it' }, { title: 'Make it' }],
    });
    const children = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.parentId, parentId));
    expect(children.map((child: { laneId: string }) => child.laneId)).toEqual([board.lanes[1].id, board.lanes[1].id]);
    expect((await todoRow(parentId)).laneId).toBe(board.lanes[0].id);
  });

  it('rewrites a todo its run refined, keeps what the refine left out, and passes it on', async () => {
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: board.lanes[1].id });
    const todoId = await board.addTodo('Do the thing');
    await db.update(dbSchema.todos).set({ acceptance: 'It works.' }).where(eq(dbSchema.todos.id, todoId));
    const run = await finish((await claim(todoId)).runId, {
      status: 'OK',
      output: 'Narrowed it to the export.',
      refine: { title: 'Speed up the CSV export', brief: '  Stream rows instead of building one string.  ' },
    });
    expect(run).toMatchObject({ status: 'ok', verdict: 'none' });
    expect(await todoRow(todoId)).toMatchObject({
      title: 'Speed up the CSV export',
      notes: 'Stream rows instead of building one string.',
      acceptance: 'It works.',
      laneId: board.lanes[1].id,
    });
    expect(await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.parentId, todoId))).toEqual([]);
  });

  it('reads a lone proposed todo as a refine, not a copy of the todo to wait on', async () => {
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: board.lanes[1].id });
    const todoId = await board.addTodo('Do the thing');
    await finish((await claim(todoId)).runId, {
      status: 'OK',
      todos: [{ title: 'Do the thing, cleanly', acceptance: 'Tests pass.', dependsOn: ['Nothing'] }],
    });
    expect(await todoRow(todoId)).toMatchObject({
      title: 'Do the thing, cleanly',
      acceptance: 'Tests pass.',
      laneId: board.lanes[1].id,
    });
    expect(await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.parentId, todoId))).toEqual([]);
    expect(await db.select().from(dbSchema.todoDependencies)).toEqual([]);
  });

  it('fails a run that both refined and split its todo, and does neither', async () => {
    await setLane(board.person, board.lanes[0].id, { onFailureLaneId: board.lanes[1].id });
    const todoId = await board.addTodo('Do the thing');
    const run = await finish((await claim(todoId)).runId, {
      status: 'OK',
      output: 'Both.',
      refine: { title: 'Something else' },
      todos: [{ title: 'One' }, { title: 'Two' }],
    });
    expect(run).toMatchObject({ status: 'error', error: expect.stringMatching(/either refined or split/) });
    expect(await todoRow(todoId)).toMatchObject({ title: 'Do the thing', laneId: board.lanes[1].id });
    expect(await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.parentId, todoId))).toEqual([]);
  });

  it('does not hand a refined todo back to the lane that refined it', async () => {
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: null });
    const todoId = await board.addTodo('Do the thing');
    await finish((await claim(todoId)).runId, { status: 'OK', refine: { title: 'Do the thing well' } });
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[0].id);
    expect(await queue()).toEqual([]);
  });

  it('leaves a todo a person moved mid-run where the person put it', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await board.person.expectOk(`mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`, {
      id: todoId,
      laneId: board.lanes[1].id,
    });
    await finish(runId, { status: 'OK', output: 'Wrote it.' });
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[1].id);
  });

  it('refuses to finish a run twice', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await finish(runId, { status: 'OK', output: 'Wrote it.' });
    const error = await runner.expectError(FINISH, { id: runId, result: { status: 'OK' } });
    expect(error.code).toBe('CONFLICT');
  });
});

describe('an umbrella', () => {
  const COMPLETE = `mutation ($id: ID!) { completeTodo(id: $id) { id } }`;
  const REOPEN = `mutation ($id: ID!) { reopenTodo(id: $id) { id } }`;
  const MOVE = `mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`;
  const ARCHIVE = `mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }`;
  const UNSPLIT = `mutation ($id: ID!) { unsplitTodo(id: $id) { id splitAt } }`;
  const PROGRESS = `query ($id: UUID!) { todo(where: { id: { eq: $id } }) { pieceCount donePieceCount } }`;

  /** Splits a new todo in the first lane into two pieces, which land in the second. */
  async function split(): Promise<{ umbrellaId: string; pieceIds: string[] }> {
    await board.person.expectOk(SET_NEW_TODO_LANE, { id: board.projectId, laneId: board.lanes[1].id });
    const umbrellaId = await board.addTodo('Build the thing');
    await finish((await claim(umbrellaId)).runId, {
      status: 'OK',
      todos: [{ title: 'Design it' }, { title: 'Make it' }],
    });
    const pieces = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.parentId, umbrellaId));
    return { umbrellaId, pieceIds: pieces.map((piece: { id: string }) => piece.id) };
  }

  async function events(todoId: string) {
    return db.select().from(dbSchema.todoEvents).where(eq(dbSchema.todoEvents.todoId, todoId));
  }

  it('is never queued, and counts its pieces', async () => {
    const { umbrellaId, pieceIds } = await split();
    expect(await queue()).toEqual([]);
    await board.person.expectOk(COMPLETE, { id: pieceIds[0] });
    expect((await board.person.expectOk(PROGRESS, { id: umbrellaId })).todo).toEqual({
      pieceCount: 2,
      donePieceCount: 1,
    });
  });

  it('shows as waiting, with how many of its pieces are done', async () => {
    const { umbrellaId, pieceIds } = await split();
    await board.person.expectOk(COMPLETE, { id: pieceIds[0] });
    const { aiStatus } = await board.person.expectOk(
      `query ($id: ID!) { aiStatus(projectId: $id) { todos { todoId state reason } projects { lanes { laneId waiting } } } }`,
      { id: board.projectId },
    );
    expect(aiStatus.todos.find((todo: { todoId: string }) => todo.todoId === umbrellaId)).toEqual({
      todoId: umbrellaId,
      state: 'WAITING',
      reason: '1 of 2 pieces done.',
    });
    expect(aiStatus.projects[0].lanes[0]).toEqual({ laneId: board.lanes[0].id, waiting: 1 });
  });

  it('completes itself, as the system, when its last piece completes', async () => {
    const { umbrellaId, pieceIds } = await split();
    await board.person.expectOk(COMPLETE, { id: pieceIds[0] });
    expect((await todoRow(umbrellaId)).completedAt).toBeNull();
    await board.person.expectOk(COMPLETE, { id: pieceIds[1] });
    expect(await todoRow(umbrellaId)).toMatchObject({
      completedAt: expect.any(Date),
      laneId: board.lanes[2].id,
      archivedAt: null,
    });
    expect((await events(umbrellaId)).at(-1)).toMatchObject({
      kind: 'complete',
      actorKind: 'system',
      toLaneId: board.lanes[2].id,
    });
    // The piece's own completion is still the person's.
    expect((await events(pieceIds[1])).at(-1)).toMatchObject({ kind: 'complete', actorKind: 'user' });
  });

  it('completes itself when its last open piece is archived, but not when every piece is dropped', async () => {
    const { umbrellaId, pieceIds } = await split();
    await board.person.expectOk(COMPLETE, { id: pieceIds[0] });
    await board.person.expectOk(ARCHIVE, { id: pieceIds[1] });
    expect((await todoRow(umbrellaId)).completedAt).not.toBeNull();

    const other = await split();
    await board.person.expectOk(ARCHIVE, { id: other.pieceIds[0] });
    await board.person.expectOk(ARCHIVE, { id: other.pieceIds[1] });
    expect((await todoRow(other.umbrellaId)).completedAt).toBeNull();
  });

  it('completes itself when its pieces are completed and archived in one write', async () => {
    // As a lane that archives on success puts each piece away.
    const { umbrellaId, pieceIds } = await split();
    for (const id of pieceIds) {
      await db
        .update(dbSchema.todos)
        .set({ completedAt: new Date(), archivedAt: new Date() })
        .where(eq(dbSchema.todos.id, id));
    }
    expect((await todoRow(umbrellaId)).completedAt).not.toBeNull();
  });

  it('is archived when it was split in a lane that archives on success', async () => {
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: null, archiveOnSuccess: true });
    const { umbrellaId, pieceIds } = await split();
    expect((await todoRow(umbrellaId)).archivedAt).toBeNull();
    for (const id of pieceIds) await board.person.expectOk(COMPLETE, { id });
    expect(await todoRow(umbrellaId)).toMatchObject({ completedAt: expect.any(Date), archivedAt: expect.any(Date) });
    expect((await events(umbrellaId)).at(-1)).toMatchObject({ kind: 'archive', actorKind: 'system' });
  });

  it('reopens into the first open lane when a piece reopens, or a new piece is added', async () => {
    const { umbrellaId, pieceIds } = await split();
    for (const id of pieceIds) await board.person.expectOk(COMPLETE, { id });
    await board.person.expectOk(REOPEN, { id: pieceIds[0] });
    expect(await todoRow(umbrellaId)).toMatchObject({ completedAt: null, laneId: board.lanes[0].id });
    expect((await events(umbrellaId)).at(-1)).toMatchObject({ kind: 'reopen', actorKind: 'system' });

    await board.person.expectOk(COMPLETE, { id: pieceIds[0] });
    expect((await todoRow(umbrellaId)).completedAt).not.toBeNull();
    await board.person.expectOk(
      `mutation ($projectId: UUID!, $parentId: UUID!) {
        createTodo(values: { projectId: $projectId, parentId: $parentId, title: "Ship it" }) { id }
      }`,
      { projectId: board.projectId, parentId: umbrellaId },
    );
    expect(await todoRow(umbrellaId)).toMatchObject({ completedAt: null, laneId: board.lanes[0].id });
  });

  it('stays archived when a piece reopens', async () => {
    const { umbrellaId, pieceIds } = await split();
    for (const id of pieceIds) await board.person.expectOk(COMPLETE, { id });
    await board.person.expectOk(ARCHIVE, { id: umbrellaId });
    await board.person.expectOk(REOPEN, { id: pieceIds[0] });
    expect(await todoRow(umbrellaId)).toMatchObject({ completedAt: expect.any(Date), archivedAt: expect.any(Date) });
    // Put away, it stands in no other todo's way.
    const other = await board.addTodo('Something else');
    await board.person.expectOk(
      `mutation ($id: UUID!) { updateTodo(set: { completedAt: "2026-01-01T00:00:00Z" }, where: { id: { eq: $id } }) { id } }`,
      { id: other },
    );
  });

  it('cannot be completed by hand while a piece is open, by any door', async () => {
    const { umbrellaId, pieceIds } = await split();
    await board.person.expectOk(COMPLETE, { id: pieceIds[0] });
    const refusals = [
      await board.person.expectError(COMPLETE, { id: umbrellaId }),
      await board.person.expectError(MOVE, { id: umbrellaId, laneId: board.lanes[2].id }),
      await board.person.expectError(
        `mutation ($id: UUID!) { updateTodo(set: { completedAt: "2026-01-01T00:00:00Z" }, where: { id: { eq: $id } }) { id } }`,
        { id: umbrellaId },
      ),
    ];
    for (const error of refusals) {
      expect(error.message).toBe(
        'This todo is split, and Make it is not done yet. It completes when its pieces do; unsplit it to finish it alone.',
      );
    }
    expect((await todoRow(umbrellaId)).completedAt).toBeNull();
  });

  it('is an ordinary todo again once a person unsplits it', async () => {
    const { umbrellaId, pieceIds } = await split();
    expect((await board.person.expectOk(UNSPLIT, { id: umbrellaId })).unsplitTodo).toEqual({
      id: umbrellaId,
      splitAt: null,
    });
    expect((await events(umbrellaId)).at(-1)).toMatchObject({ kind: 'edit', fields: ['splitAt'], actorKind: 'user' });
    await board.person.expectOk(COMPLETE, { id: umbrellaId });
    expect((await todoRow(umbrellaId)).completedAt).not.toBeNull();
    // Its pieces stay as they were, and no longer close or reopen it.
    await board.person.expectOk(REOPEN, { id: umbrellaId });
    for (const id of pieceIds) await board.person.expectOk(COMPLETE, { id });
    expect((await todoRow(umbrellaId)).completedAt).toBeNull();
  });

  it('is split and unsplit only by a run and unsplitTodo', async () => {
    const todoId = await board.addTodo('Plain');
    const error = await board.person.expectError(
      `mutation ($id: UUID!) { updateTodo(set: { splitAt: "2026-01-01T00:00:00Z" }, where: { id: { eq: $id } }) { id } }`,
      { id: todoId },
    );
    expect(error.message).toMatch(/unsplitTodo/);
  });
});

describe('a lane that archives on success', () => {
  const ARCHIVES = { onSuccessLaneId: null, archiveOnSuccess: true };
  const UPDATE_LANE = `mutation ($id: UUID!, $set: UpdateLaneInput!) { updateLane(set: $set, where: { id: { eq: $id } }) { id } }`;
  const DEPEND = `mutation ($a: ID!, $b: ID!) { addTodoDependency(todoId: $a, dependsOnTodoId: $b) { id } }`;

  it('completes a passing todo and archives it, as the run', async () => {
    await setLane(board.person, board.lanes[0].id, ARCHIVES);
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await finish(runId, { status: 'OK', output: 'Wrote it.' });

    const todo = await todoRow(todoId);
    expect(todo.archivedAt).not.toBeNull();
    expect(todo.completedAt).not.toBeNull();
    expect(todo.laneId).toBe(board.lanes[2].id);
    const [note] = await thread(todoId);
    expect(note).toMatchObject({ kind: 'report', body: 'Wrote it.' });
    const events = await db.select().from(dbSchema.todoEvents).where(eq(dbSchema.todoEvents.todoId, todoId));
    expect(events.at(-1)).toMatchObject({ kind: 'archive', actorKind: 'agent', runId, noteId: note.id });
    expect(events.filter((event: { kind: string }) => event.kind === 'archive')).toHaveLength(1);
    expect(await queue()).toEqual([]);
  });

  it('frees what was waiting on the todo', async () => {
    await setLane(board.person, board.lanes[0].id, ARCHIVES);
    const first = await board.addTodo('First');
    const second = await board.addTodo('Second');
    await board.person.expectOk(DEPEND, { a: second, b: first });
    const { runId } = await claim(first);
    await finish(runId, { status: 'OK', output: 'Done.' });
    expect((await queue()).map((row) => row.todoId)).toEqual([second]);
  });

  it('archives a PASS, and still sends a FAIL down the failure route', async () => {
    await setLane(board.person, board.lanes[0].id, { ...ARCHIVES, onFailureLaneId: board.lanes[1].id });
    const passes = await board.addTodo('Good');
    const fails = await board.addTodo('Bad');
    await finish((await claim(passes)).runId, { status: 'OK', output: 'PASS: reads well.' });
    await finish((await claim(fails)).runId, { status: 'OK', output: 'FAIL: the ending is missing.' });

    expect((await todoRow(passes)).archivedAt).not.toBeNull();
    const failed = await todoRow(fails);
    expect(failed).toMatchObject({ laneId: board.lanes[1].id, archivedAt: null, completedAt: null });
  });

  it('leaves a run that errored where it is', async () => {
    await setLane(board.person, board.lanes[0].id, ARCHIVES);
    const todoId = await board.addTodo('Write it');
    await finish((await claim(todoId)).runId, { status: 'ERROR', error: 'The model did not answer.' });
    expect(await todoRow(todoId)).toMatchObject({ laneId: board.lanes[0].id, archivedAt: null, completedAt: null });
  });

  it('leaves a todo a person moved mid-run where the person put it', async () => {
    await setLane(board.person, board.lanes[0].id, ARCHIVES);
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await board.person.expectOk(`mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`, {
      id: todoId,
      laneId: board.lanes[1].id,
    });
    await finish(runId, { status: 'OK', output: 'Wrote it.' });
    expect(await todoRow(todoId)).toMatchObject({ laneId: board.lanes[1].id, archivedAt: null, completedAt: null });
  });

  it('leaves a todo that came to wait on another mid-run', async () => {
    await setLane(board.person, board.lanes[0].id, ARCHIVES);
    const todoId = await board.addTodo('Write it');
    const blocker = await board.addTodo('First this');
    const { runId } = await claim(todoId);
    await board.person.expectOk(DEPEND, { a: todoId, b: blocker });
    await finish(runId, { status: 'OK', output: 'Wrote it.' });
    expect(await todoRow(todoId)).toMatchObject({ laneId: board.lanes[0].id, archivedAt: null, completedAt: null });
  });

  it('archives in place on a board with no done lane', async () => {
    await db.update(dbSchema.lanes).set({ isDone: false }).where(eq(dbSchema.lanes.id, board.lanes[2].id));
    await setLane(board.person, board.lanes[0].id, ARCHIVES);
    const todoId = await board.addTodo('Write it');
    await finish((await claim(todoId)).runId, { status: 'OK', output: 'Wrote it.' });
    const todo = await todoRow(todoId);
    expect(todo.laneId).toBe(board.lanes[0].id);
    expect(todo.archivedAt).not.toBeNull();
    expect(todo.completedAt).not.toBeNull();
  });

  it('is one or the other: archive, or a success route', async () => {
    const both = await board.person.expectError(UPDATE_LANE, {
      id: board.lanes[0].id,
      set: { archiveOnSuccess: true },
    });
    expect(both.code).toBe('BAD_USER_INPUT');
    expect(both.message).toContain('not both');

    await setLane(board.person, board.lanes[0].id, ARCHIVES);
    const routed = await board.person.expectError(UPDATE_LANE, {
      id: board.lanes[0].id,
      set: { onSuccessLaneId: board.lanes[2].id },
    });
    expect(routed.code).toBe('BAD_USER_INPUT');
    // Swapping them in one write is fine.
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: board.lanes[2].id, archiveOnSuccess: false });
  });
});

describe('stopping a run', () => {
  it('is heard on the next heartbeat, and a stopped run changes nothing', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    expect((await runner.expectOk(HEARTBEAT, { id: runId })).heartbeatRun).toBe(false);
    await board.person.expectOk(`mutation ($id: ID!) { cancelRun(id: $id) { id } }`, { id: runId });
    expect((await runner.expectOk(HEARTBEAT, { id: runId })).heartbeatRun).toBe(true);

    const run = await finish(runId, { status: 'OK', output: 'Wrote it anyway.' });
    expect(run.status).toBe('stopped');
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[0].id);
    expect(await thread(todoId)).toEqual([]);
  });

  it('tells AI to ignore the todo, so the lane’s agent does not take it straight back', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await board.person.expectOk(`mutation ($id: ID!) { cancelRun(id: $id) { id } }`, { id: runId });
    await finish(runId, { status: 'STOPPED' });

    expect((await todoRow(todoId)).aiIgnored).toBe(true);
    expect((await queue()).map((ready) => ready.todoId)).not.toContain(todoId);
    const [event] = await db
      .select()
      .from(dbSchema.todoEvents)
      .where(and(eq(dbSchema.todoEvents.todoId, todoId), eq(dbSchema.todoEvents.kind, 'edit')));
    expect(event).toMatchObject({ actorKind: 'user', reason: 'Its run was stopped.' });

    // Switching it back off is the way back in.
    await board.person.expectOk(
      `mutation ($id: UUID!) { updateTodo(set: { aiIgnored: false }, where: { id: { eq: $id } }) { id } }`,
      { id: todoId },
    );
    expect((await queue()).map((ready) => ready.todoId)).toContain(todoId);
  });

  it('happens when the project is closed to AI', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await board.person.expectOk(`mutation ($id: ID!) { setProjectAiEnabled(projectId: $id, enabled: false) { id } }`, {
      id: board.projectId,
    });
    expect((await runner.expectOk(HEARTBEAT, { id: runId })).heartbeatRun).toBe(true);
  });

  it('happens when the todo is ignored', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await board.person.expectOk(
      `mutation ($id: UUID!) { updateTodo(set: { aiIgnored: true }, where: { id: { eq: $id } }) { id } }`,
      { id: todoId },
    );
    const [run] = await db.select().from(dbSchema.runs).where(eq(dbSchema.runs.id, runId));
    expect(run.cancelRequestedAt).not.toBeNull();
  });
});

describe('who may do what', () => {
  it('lets a run token act as the run’s agent, only while the run is live', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId, token } = await claim(todoId);
    // An agent nobody has switched tools on or off for has the run default.
    expect(await actorFor({ 'x-run-token': token })).toEqual({
      kind: 'agent',
      userId: board.userId,
      runId,
      toolsOff: runToolsOff(null),
    });
    expect(await actorFor({ 'x-run-token': `${token}x` })).toMatchObject({ kind: 'anonymous' });
    await finish(runId, { status: 'OK', output: 'Wrote it.' });
    expect(await actorFor({ 'x-run-token': token })).toMatchObject({ kind: 'anonymous' });
  });

  it('keeps a run token to its own user’s rows, and off the board’s controls', async () => {
    const other = await createBoard(db, 'other@example.com');
    const theirs = await other.addTodo('Theirs');
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    const agent = createClient(db, board.userId, { ai: true, actor: { kind: 'agent', userId: board.userId, runId } });

    const seen = await agent.expectOk(`query { todos { id } }`);
    expect(seen.todos.map((todo: { id: string }) => todo.id)).toEqual([todoId]);
    expect(
      (await agent.expectOk(`query ($id: UUID!) { todo(where: { id: { eq: $id } }) { id } }`, { id: theirs })).todo,
    ).toBeNull();
    expect(
      (
        await agent.expectError(`mutation ($id: ID!) { setProjectAiEnabled(projectId: $id, enabled: false) { id } }`, {
          id: board.projectId,
        })
      ).code,
    ).toBe('FORBIDDEN');
    expect((await agent.expectError(FINISH, { id: runId, result: { status: 'OK' } })).code).toBe('FORBIDDEN');

    const note = await agent.expectOk(
      `mutation ($id: ID!) { addTodoNote(todoId: $id, body: "Halfway.") { actorKind runId } }`,
      {
        id: todoId,
      },
    );
    expect(note.addTodoNote).toEqual({ actorKind: 'agent', runId });
  });

  it('lets the runner key in as the system principal, which cannot touch rows', async () => {
    expect(await actorFor({ 'x-runner-key': 'runner-secret' })).toEqual({ kind: 'system', userId: null });
    expect(await actorFor({ 'x-runner-key': 'wrong' })).toMatchObject({ kind: 'anonymous' });
    const error = await runner.expectError(
      `mutation ($projectId: UUID!) { createTodo(values: { projectId: $projectId, title: "Sneaky" }) { id } }`,
      { projectId: board.projectId },
    );
    expect(error.code).toBe('FORBIDDEN');
    expect((await runner.expectError(`query { todos { id } }`)).code).toBe('UNAUTHENTICATED');
  });

  it('never shows an agent’s secret through the generated schema', async () => {
    const fields = await board.person.expectOk(`query { __type(name: "Agent") { fields { name } } }`);
    const names = fields.__type.fields.map((field: { name: string }) => field.name);
    expect(names).not.toContain('apiKey');
    expect(names).toContain('hasApiKey');
    const agents = await board.person.expectOk(`query { agents { hasApiKey } }`);
    expect(agents.agents).toEqual([{ hasApiKey: true }]);
  });

  it('refuses a success route into another project’s board', async () => {
    const other = await createBoard(db, 'other@example.com');
    const error = await board.person.expectError(
      `mutation ($id: UUID!, $set: UpdateLaneInput!) { updateLane(set: $set, where: { id: { eq: $id } }) { id } }`,
      { id: board.lanes[0].id, set: { onSuccessLaneId: other.lanes[2].id } },
    );
    expect(error.code).toBe('NOT_FOUND');
    const second = await board.person.expectOk(`mutation { createProject(values: { name: "Q" }) { id } }`);
    const [elsewhere] = await db
      .select()
      .from(dbSchema.lanes)
      .where(eq(dbSchema.lanes.projectId, second.createProject.id));
    const stray = await board.person.expectError(
      `mutation ($id: UUID!, $set: UpdateLaneInput!) { updateLane(set: $set, where: { id: { eq: $id } }) { id } }`,
      { id: board.lanes[0].id, set: { onSuccessLaneId: elsewhere.id } },
    );
    expect(stray.code).toBe('BAD_USER_INPUT');
  });
});

async function runsOf(todoId: string) {
  return db.select().from(dbSchema.runs).where(eq(dbSchema.runs.todoId, todoId));
}

describe('what a run shows as it goes, and leaves behind', () => {
  it('keeps the events each heartbeat and the finish report, newest last and capped', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    const events = (count: number, from = 0) =>
      Array.from({ length: count }, (_, at) => ({ kind: 'TOOL_CALL', name: 'fs__write', text: `call ${from + at}` }));

    await runner.expectOk(HEARTBEAT, { id: runId, events: events(3) });
    await runner.expectOk(HEARTBEAT, { id: runId, events: [{ kind: 'NOTICE', text: 'x'.repeat(10_000) }] });
    let [row] = await runsOf(todoId);
    expect(row.events.map((event: dbSchema.RunEvent) => event.kind)).toEqual([
      'tool_call',
      'tool_call',
      'tool_call',
      'notice',
    ]);
    expect(row.events[3].text).toHaveLength(4000);

    await finish(runId, { status: 'OK', output: 'Done.', events: events(600, 3) });
    [row] = await runsOf(todoId);
    expect(row.events).toHaveLength(500);
    expect(row.events.at(-1)?.text).toBe('call 602');

    const read = await board.person.expectOk(`query ($id: UUID!) { runs(where: { id: { eq: $id } }) { events } }`, {
      id: runId,
    });
    expect(read.runs[0].events).toHaveLength(500);
  });

  it('joins what the model streams into one block across heartbeats', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await runner.expectOk(HEARTBEAT, {
      id: runId,
      events: [
        { kind: 'TURN', text: '1' },
        { kind: 'THINKING', text: 'Hmm, ' },
      ],
    });
    await runner.expectOk(HEARTBEAT, {
      id: runId,
      events: [
        { kind: 'THINKING', text: 'the plan first.' },
        { kind: 'OUTPUT', text: 'x'.repeat(20_000) },
      ],
    });
    const [row] = await runsOf(todoId);
    expect(row.events.map((event: dbSchema.RunEvent) => [event.kind, event.text?.length])).toEqual([
      ['turn', 1],
      ['thinking', 20],
      ['output', 16_000],
    ]);
    expect(row.events[1].text).toBe('Hmm, the plan first.');
    expect(row.events[2].text?.startsWith('…')).toBe(true);
  });

  it('keeps the model, the prompt once, and what the run has spent as it goes', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId, agent } = await claim(todoId);
    await runner.expectOk(HEARTBEAT, {
      id: runId,
      prompt: { system: 'You are careful.', user: 'Write it.' },
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, toolCalls: 2 },
    });
    await runner.expectOk(HEARTBEAT, { id: runId, prompt: { system: 'Something else.', user: 'No.' } });
    let [row] = await runsOf(todoId);
    expect(row).toMatchObject({
      model: agent.model,
      systemPrompt: 'You are careful.',
      userPrompt: 'Write it.',
      totalTokens: 120,
      toolCalls: 2,
    });

    // Stopped with nothing to report, it still says what it spent.
    await finish(runId, { status: 'STOPPED' });
    [row] = await runsOf(todoId);
    expect(row).toMatchObject({ status: 'stopped', totalTokens: 120, promptTokens: 100 });
  });

  it('keeps how much of the prompt came from the cache, and nothing when the endpoint never said', async () => {
    const silent = await board.addTodo('Write it');
    const quiet = await claim(silent);
    await runner.expectOk(HEARTBEAT, {
      id: quiet.runId,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
    await finish(quiet.runId, { status: 'OK', output: 'Wrote it.', promptTokens: 100 });
    expect((await runsOf(silent))[0].cachedInputTokens).toBeNull();

    const cached = await board.addTodo('Write it again');
    const { runId } = await claim(cached);
    await runner.expectOk(HEARTBEAT, {
      id: runId,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedInputTokens: 60 },
    });
    expect((await runsOf(cached))[0].cachedInputTokens).toBe(60);
    // A finish that says nothing of the cache keeps what the heartbeat said.
    await finish(runId, { status: 'OK', output: 'Wrote it.' });
    expect((await runsOf(cached))[0].cachedInputTokens).toBe(60);
  });

  it('takes the prompt from the finish when no heartbeat carried it', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await finish(runId, { status: 'OK', output: 'Done.', prompt: { system: 'S', user: 'U' } });
    const [row] = await runsOf(todoId);
    expect(row).toMatchObject({ systemPrompt: 'S', userPrompt: 'U' });
  });

  it('deletes a finished run for its owner, and refuses a live one', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    const DELETE = `mutation ($id: ID!) { deleteRun(id: $id) }`;
    expect((await board.person.expectError(DELETE, { id: runId })).code).toBe('CONFLICT');
    await finish(runId, { status: 'OK', output: 'Done.' });

    const stranger = await createBoard(db, 'stranger@example.com');
    expect((await stranger.person.expectError(DELETE, { id: runId })).code).toBe('NOT_FOUND');
    expect((await board.person.expectOk(DELETE, { id: runId })).deleteRun).toBe(true);
    expect(await runsOf(todoId)).toEqual([]);
    // What it did stays: its report is still on the todo.
    expect((await thread(todoId)).map((note: { kind: string }) => note.kind)).toEqual(['report']);
  });

  it('records the artifacts a run reports, drops the malformed, and lists them on the todo', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await finish(runId, {
      status: 'ERROR',
      error: 'Ran out of turns.',
      artifacts: [
        { location: '/work/plan.md', source: 'declared', title: 'The plan', mediaType: 'text/markdown' },
        { location: '/work/draft.md', source: 'detected', action: 'updated', serverSlug: 'fs', tool: 'write_file' },
        { location: '  ', source: 'declared' },
        { location: '/work/x', source: 'guessed' },
      ],
    });

    const read = await board.person.expectOk(
      `query ($id: UUID!) { todos(where: { id: { eq: $id } }) { artifacts(orderBy: { location: { direction: asc, priority: 1 } }) { location source action title runId } } }`,
      { id: todoId },
    );
    expect(read.todos[0].artifacts).toEqual([
      { location: '/work/draft.md', source: 'detected', action: 'updated', title: null, runId },
      { location: '/work/plan.md', source: 'declared', action: 'created', title: 'The plan', runId },
    ]);
  });

  it('keeps nothing a stopped run made, and no one but the server writes artifacts', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await finish(runId, { status: 'STOPPED', artifacts: [{ location: '/work/plan.md', source: 'declared' }] });
    expect(await db.select().from(dbSchema.artifacts)).toEqual([]);

    const mutations = await board.person.expectOk(`query { __type(name: "Mutation") { fields { name } } }`);
    const names: string[] = mutations.__type.fields.map((field: { name: string }) => field.name);
    // recordArtifact is a client's word, kept under a source of its own.
    expect(names.filter((name) => /artifact/i.test(name)).sort()).toEqual(['deleteArtifact', 'recordArtifact']);
  });

  it('lets the owner take an artifact off the board, and no one else', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await finish(runId, {
      status: 'OK',
      output: 'Done.',
      artifacts: [{ location: '/work/plan.md', source: 'declared' }],
    });
    const [artifact] = await db.select().from(dbSchema.artifacts);
    const DELETE = `mutation ($id: ID!) { deleteArtifact(id: $id) }`;

    const stranger = await createBoard(db, 'stranger@example.com');
    expect((await stranger.person.expectError(DELETE, { id: artifact.id })).code).toBe('NOT_FOUND');
    const agent = createClient(db, board.userId, { ai: true, actor: { kind: 'agent', userId: board.userId, runId } });
    expect((await agent.expectError(DELETE, { id: artifact.id })).code).toBe('FORBIDDEN');
    expect((await board.person.expectOk(DELETE, { id: artifact.id })).deleteArtifact).toBe(true);
    expect(await db.select().from(dbSchema.artifacts)).toEqual([]);
    expect((await board.person.expectError(DELETE, { id: artifact.id })).code).toBe('NOT_FOUND');
    // The run that made it is untouched.
    expect(await runsOf(todoId)).toHaveLength(1);
  });
});
