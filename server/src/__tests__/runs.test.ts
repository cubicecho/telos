import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveActor } from '../auth.ts';
import type { Actor } from '../context.ts';
import { mintRunToken } from '../run-tokens.ts';
import { type Board, CLAIM, createBoard, FINISH, HEARTBEAT, QUEUE, runnerClient, setLane } from './board.ts';
import { authFor, createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

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
  it('lists a todo waiting at a station', async () => {
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
    const claimed = await claim(todoId);
    expect(claimed.agent).toMatchObject({ name: 'Worker', apiKey: 'sk-secret', model: 'tiny', mcpServers: '[]' });
    expect(claimed.brief).toMatchObject({
      projectName: 'P',
      projectContext: 'A test board.',
      laneName: 'To do',
      contract: 'work',
      lanePrompt: 'Do the work.',
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

describe('finishRun', () => {
  it('sends passing work down the success arm, completing it in the done lane', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    const run = await finish(runId, { status: 'ok', output: 'Wrote it.', totalTokens: 42 });
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

  it('does not run a todo again at a station that has finished with it', async () => {
    await setLane(board.person, board.lanes[0].id, { onSuccessLaneId: null });
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await finish(runId, { status: 'ok', output: 'Done here.' });
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[0].id);
    expect(await queue()).toEqual([]);
  });

  it('reads a verdict station’s FAIL and sends the todo down the failure arm', async () => {
    await setLane(board.person, board.lanes[0].id, { contract: 'verdict', onFailureLaneId: board.lanes[1].id });
    const todoId = await board.addTodo('Review it');
    const { runId } = await claim(todoId);
    const run = await finish(runId, { status: 'ok', output: 'FAIL: the second paragraph is missing.' });
    expect(run).toMatchObject({ status: 'ok', verdict: 'fail' });
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[1].id);
    const [note] = await thread(todoId);
    expect(note).toMatchObject({ kind: 'verdict' });
    const events = await db.select().from(dbSchema.todoEvents).where(eq(dbSchema.todoEvents.todoId, todoId));
    expect(events.at(-1)).toMatchObject({ kind: 'move', noteId: note.id, reason: 'The review failed.' });
  });

  it('stops retrying after maxAttempts failures, until a person moves it', async () => {
    await setLane(board.person, board.lanes[0].id, { maxAttempts: 1 });
    const todoId = await board.addTodo('Write it');
    for (let attempt = 0; attempt < 2; attempt++) {
      const { runId } = await claim(todoId);
      await finish(runId, { status: 'error', error: 'The model timed out.' });
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

  it('turns an expansion into child todos down the success arm', async () => {
    await setLane(board.person, board.lanes[0].id, { contract: 'expand', onSuccessLaneId: board.lanes[1].id });
    const parentId = await board.addTodo('Build the thing');
    const { runId } = await claim(parentId);
    await finish(runId, {
      status: 'ok',
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
    ).toEqual(['Build the thing -> Design it', 'Build the thing -> Make it', 'Make it -> Design it']);
    const childEvents = await db
      .select()
      .from(dbSchema.todoEvents)
      .where(eq(dbSchema.todoEvents.todoId, children[0].id));
    expect(childEvents[0]).toMatchObject({ kind: 'create', actorKind: 'agent', runId });
  });

  it('fails an expansion that proposed nothing', async () => {
    await setLane(board.person, board.lanes[0].id, { contract: 'expand', onSuccessLaneId: board.lanes[1].id });
    const parentId = await board.addTodo('Build the thing');
    const { runId } = await claim(parentId);
    const run = await finish(runId, { status: 'ok', output: 'I could not.', todos: [] });
    expect(run).toMatchObject({ status: 'error', error: 'The agent proposed no todos.' });
  });

  it('leaves a todo a person moved mid-run where the person put it', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await board.person.expectOk(`mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`, {
      id: todoId,
      laneId: board.lanes[1].id,
    });
    await finish(runId, { status: 'ok', output: 'Wrote it.' });
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[1].id);
  });

  it('refuses to finish a run twice', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await finish(runId, { status: 'ok', output: 'Wrote it.' });
    const error = await runner.expectError(FINISH, { id: runId, result: { status: 'ok' } });
    expect(error.code).toBe('CONFLICT');
  });
});

describe('stopping a run', () => {
  it('is heard on the next heartbeat, and a stopped run changes nothing', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    expect((await runner.expectOk(HEARTBEAT, { id: runId })).heartbeatRun).toBe(false);
    await board.person.expectOk(`mutation ($id: ID!) { cancelRun(id: $id) { id } }`, { id: runId });
    expect((await runner.expectOk(HEARTBEAT, { id: runId })).heartbeatRun).toBe(true);

    const run = await finish(runId, { status: 'ok', output: 'Wrote it anyway.' });
    expect(run.status).toBe('stopped');
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[0].id);
    expect(await thread(todoId)).toEqual([]);
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
    expect(await actorFor({ 'x-run-token': token })).toEqual({ kind: 'agent', userId: board.userId, runId });
    expect(await actorFor({ 'x-run-token': `${token}x` })).toMatchObject({ kind: 'anonymous' });
    await finish(runId, { status: 'ok', output: 'Wrote it.' });
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
        await agent.expectError(`mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`, {
          id: todoId,
          laneId: board.lanes[2].id,
        })
      ).code,
    ).toBe('FORBIDDEN');
    expect((await agent.expectError(FINISH, { id: runId, result: { status: 'ok' } })).code).toBe('FORBIDDEN');

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

  it('refuses a station arrow into another project’s board', async () => {
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
      Array.from({ length: count }, (_, at) => ({ kind: 'tool_call', name: 'fs__write', text: `call ${from + at}` }));

    await runner.expectOk(HEARTBEAT, { id: runId, events: events(3) });
    await runner.expectOk(HEARTBEAT, { id: runId, events: [{ kind: 'notice', text: 'x'.repeat(10_000) }] });
    let [row] = await runsOf(todoId);
    expect(row.events.map((event: dbSchema.RunEvent) => event.kind)).toEqual([
      'tool_call',
      'tool_call',
      'tool_call',
      'notice',
    ]);
    expect(row.events[3].text).toHaveLength(4000);

    await finish(runId, { status: 'ok', output: 'Done.', events: events(600, 3) });
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
        { kind: 'turn', text: '1' },
        { kind: 'thinking', text: 'Hmm, ' },
      ],
    });
    await runner.expectOk(HEARTBEAT, {
      id: runId,
      events: [
        { kind: 'thinking', text: 'the plan first.' },
        { kind: 'output', text: 'x'.repeat(20_000) },
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
    await finish(runId, { status: 'stopped' });
    [row] = await runsOf(todoId);
    expect(row).toMatchObject({ status: 'stopped', totalTokens: 120, promptTokens: 100 });
  });

  it('takes the prompt from the finish when no heartbeat carried it', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    await finish(runId, { status: 'ok', output: 'Done.', prompt: { system: 'S', user: 'U' } });
    const [row] = await runsOf(todoId);
    expect(row).toMatchObject({ systemPrompt: 'S', userPrompt: 'U' });
  });

  it('deletes a finished run for its owner, and refuses a live one', async () => {
    const todoId = await board.addTodo('Write it');
    const { runId } = await claim(todoId);
    const DELETE = `mutation ($id: ID!) { deleteRun(id: $id) }`;
    expect((await board.person.expectError(DELETE, { id: runId })).code).toBe('CONFLICT');
    await finish(runId, { status: 'ok', output: 'Done.' });

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
      status: 'error',
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
    await finish(runId, { status: 'stopped', artifacts: [{ location: '/work/plan.md', source: 'declared' }] });
    expect(await db.select().from(dbSchema.artifacts)).toEqual([]);

    const mutations = await board.person.expectOk(`query { __type(name: "Mutation") { fields { name } } }`);
    const names: string[] = mutations.__type.fields.map((field: { name: string }) => field.name);
    expect(names.filter((name) => /artifact/i.test(name))).toEqual([]);
  });
});
