import { randomUUID } from 'node:crypto';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, CLAIM, createBoard, FINISH, runnerClient } from './board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

// Artifacts from outside a run, and artifacts whose todo is gone. A client
// with an API key says what it made and the board keeps its word as exactly
// that: source `client`, signed with the key. And an artifact outlives its
// todo: deleting the todo for good detaches what was made for it.

let db: TestDb;
let board: Board;
let key: TestClient;
let runner: TestClient;
const KEY_ID = randomUUID();

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  key = keyClient(board.userId);
  runner = runnerClient(db);
});

function keyClient(userId: string, keyId: string = KEY_ID): TestClient {
  return createClient(db, userId, { ai: true, actor: { kind: 'apiKey', userId, keyId } });
}

const RECORD = `mutation ($todoId: ID!, $location: String!, $label: String!, $mediaType: String, $sizeBytes: Int) {
  recordArtifact(todoId: $todoId, location: $location, label: $label, mediaType: $mediaType, sizeBytes: $sizeBytes) {
    id todoId location title source action mediaType sizeBytes runId actorKind
  }
}`;
const ARCHIVE = `mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }`;
const PURGE = `mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }, hard: true) { id } }`;
const UPDATE_TODO = `mutation ($id: UUID!, $set: UpdateTodoInput!) { updateTodo(set: $set, where: { id: { eq: $id } }) { id } }`;
const SET_PROJECT_AI = `mutation ($id: ID!, $enabled: Boolean!) { setProjectAiEnabled(projectId: $id, enabled: $enabled) { id } }`;
const SET_ACCOUNT_AI = `mutation ($enabled: Boolean!) { setAiEnabled(enabled: $enabled) { id } }`;
const DELETE = `mutation ($id: ID!) { deleteArtifact(id: $id) }`;
const PROJECT_ARTIFACTS = `query ($projectId: UUID!) {
  artifacts(where: { projectId: { eq: $projectId } }, orderBy: { location: { direction: asc, priority: 1 } }) {
    location source todoId todoTitle todo { title }
  }
}`;

const PAGE = { location: 'https://example.com/plan', label: 'The plan' };

/**
 * Runs a todo through its station and has the run report `artifacts`.
 *
 * @param todoId - The todo to run.
 * @param artifacts - What the run says it made.
 * @returns The run's id.
 */
async function ranWith(todoId: string, artifacts: Array<Record<string, unknown>>): Promise<string> {
  const { claimRun } = await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id });
  await runner.expectOk(FINISH, { id: claimRun.runId, result: { status: 'ok', output: 'Done.', artifacts } });
  return claimRun.runId;
}

describe('recording an artifact as a client', () => {
  it('keeps where it is and what it is called, as a client’s word, signed with the key', async () => {
    const todoId = await board.addTodo('Write it');
    const { recordArtifact } = await key.expectOk(RECORD, {
      todoId,
      location: '  https://example.com/plan  ',
      label: ' The plan ',
      mediaType: 'text/html',
      sizeBytes: 1200,
    });
    expect(recordArtifact).toMatchObject({
      todoId,
      location: 'https://example.com/plan',
      title: 'The plan',
      source: 'client',
      action: 'created',
      mediaType: 'text/html',
      sizeBytes: 1200,
      runId: null,
      actorKind: 'apiKey',
    });

    const [row] = await db.select().from(dbSchema.artifacts);
    expect(row).toMatchObject({
      userId: board.userId,
      projectId: board.projectId,
      actorKind: 'apiKey',
      actorKeyId: KEY_ID,
      todoTitle: null,
    });
    const read = await board.person.expectOk(
      `query ($id: UUID!) { todos(where: { id: { eq: $id } }) { artifacts { location source } } }`,
      { id: todoId },
    );
    expect(read.todos[0].artifacts).toEqual([{ location: 'https://example.com/plan', source: 'client' }]);
  });

  it('is one artifact however often it is said, and the last word stands', async () => {
    const todoId = await board.addTodo('Write it');
    const first = (await key.expectOk(RECORD, { todoId, ...PAGE })).recordArtifact;
    const otherKey = randomUUID();
    const again = (
      await keyClient(board.userId, otherKey).expectOk(RECORD, { todoId, ...PAGE, label: 'The plan, revised' })
    ).recordArtifact;
    expect(again).toMatchObject({ id: first.id, title: 'The plan, revised', action: 'updated' });
    const rows = await db.select().from(dbSchema.artifacts);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorKeyId).toBe(otherKey);

    // The same place on another todo is another artifact.
    const other = await board.addTodo('Review it');
    await key.expectOk(RECORD, { todoId: other, ...PAGE });
    expect(await db.select().from(dbSchema.artifacts)).toHaveLength(2);
  });

  it('never takes the place of what a run reported at the same location', async () => {
    const todoId = await board.addTodo('Write it');
    await ranWith(todoId, [{ location: PAGE.location, source: 'declared', title: 'From the run' }]);
    await key.expectOk(RECORD, { todoId, ...PAGE });
    const rows = await db.select().from(dbSchema.artifacts);
    expect(rows.map((row: { source: string; title: string }) => [row.source, row.title]).sort()).toEqual([
      ['client', 'The plan'],
      ['declared', 'From the run'],
    ]);
  });

  it('is signed as the person when a person records it', async () => {
    const todoId = await board.addTodo('Write it');
    const { recordArtifact } = await board.person.expectOk(RECORD, { todoId, ...PAGE });
    expect(recordArtifact).toMatchObject({ source: 'client', actorKind: 'user' });
    const [row] = await db.select().from(dbSchema.artifacts);
    expect(row.actorKeyId).toBeNull();
  });

  it('finds a todo it may not see not there at all', async () => {
    const stranger = await createBoard(db, 'stranger@example.com');
    const theirs = await stranger.addTodo('Theirs');
    expect((await key.expectError(RECORD, { todoId: theirs, ...PAGE })).code).toBe('NOT_FOUND');
    expect((await key.expectError(RECORD, { todoId: randomUUID(), ...PAGE })).code).toBe('NOT_FOUND');

    const ignored = await board.addTodo('Private');
    await board.person.expectOk(UPDATE_TODO, { id: ignored, set: { aiIgnored: true } });
    expect((await key.expectError(RECORD, { todoId: ignored, ...PAGE })).code).toBe('NOT_FOUND');

    const archived = await board.addTodo('Archived');
    await board.person.expectOk(ARCHIVE, { id: archived });
    expect((await key.expectError(RECORD, { todoId: archived, ...PAGE })).code).toBe('NOT_FOUND');
    expect(await db.select().from(dbSchema.artifacts)).toEqual([]);
  });

  it('is not there when the project, the account or the instance has AI off', async () => {
    const todoId = await board.addTodo('Write it');
    await board.person.expectOk(SET_PROJECT_AI, { id: board.projectId, enabled: false });
    expect((await key.expectError(RECORD, { todoId, ...PAGE })).code).toBe('NOT_FOUND');
    await board.person.expectOk(SET_PROJECT_AI, { id: board.projectId, enabled: true });

    await board.person.expectOk(SET_ACCOUNT_AI, { enabled: false });
    expect((await key.expectError(RECORD, { todoId, ...PAGE })).code).toBe('NOT_FOUND');
    expect((await board.person.expectError(RECORD, { todoId, ...PAGE })).code).toBe('NOT_FOUND');
    await board.person.expectOk(SET_ACCOUNT_AI, { enabled: true });

    await db.update(dbSchema.instanceSettings).set({ aiEnabled: false });
    expect((await key.expectError(RECORD, { todoId, ...PAGE })).code).toBe('NOT_FOUND');
    expect(await db.select().from(dbSchema.artifacts)).toEqual([]);

    // With AI_ENABLED off the mutation is not in the schema.
    const withoutAi = createClient(db, board.userId);
    const mutations = await withoutAi.expectOk(`query { __type(name: "Mutation") { fields { name } } }`);
    expect(mutations.__type.fields.map((field: { name: string }) => field.name)).not.toContain('recordArtifact');
  });

  it('is not a run’s to call: a run has the runner’s, which is checked', async () => {
    const todoId = await board.addTodo('Write it');
    const { claimRun } = await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id });
    const agent = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'agent', userId: board.userId, runId: claimRun.runId },
    });
    const error = await agent.expectError(RECORD, { todoId, ...PAGE });
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toMatch(/record_artifact/);
    expect(await db.select().from(dbSchema.artifacts)).toEqual([]);
  });

  it('refuses what it cannot keep, and says what to send instead', async () => {
    const todoId = await board.addTodo('Write it');
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ location: '   ' }, /location/],
      [{ label: '' }, /label/],
      [{ location: `https://example.com/${'a'.repeat(2000)}` }, /Keep it to 2000/],
      [{ label: 'a'.repeat(201) }, /Keep it to 200/],
      [{ mediaType: 'a'.repeat(201) }, /Keep it to 200/],
      [{ location: 'telos:note/123' }, /add_todo_note/],
      [{ sizeBytes: -1 }, /negative/],
    ];
    for (const [change, message] of refused) {
      const error = await key.expectError(RECORD, { todoId, ...PAGE, ...change });
      expect(error.code).toBe('BAD_USER_INPUT');
      expect(error.message).toMatch(message);
    }
    expect(await db.select().from(dbSchema.artifacts)).toEqual([]);
  });

  it('is a source no run can claim for itself', async () => {
    const todoId = await board.addTodo('Write it');
    await ranWith(todoId, [
      { location: '/work/plan.md', source: 'client' },
      { location: '/work/draft.md', source: 'declared' },
    ]);
    const rows = await db.select().from(dbSchema.artifacts);
    expect(rows.map((row: { location: string }) => row.location)).toEqual(['/work/draft.md']);
    expect(rows[0]).toMatchObject({ actorKind: 'agent', actorKeyId: null });
  });
});

describe('an artifact whose todo is deleted', () => {
  it('stays on the project, with the todo’s title as it was', async () => {
    const todoId = await board.addTodo('Write the plan');
    const runId = await ranWith(todoId, [{ location: '/work/plan.md', source: 'declared' }]);
    await key.expectOk(RECORD, { todoId, ...PAGE });
    const kept = await board.addTodo('Still here');
    await key.expectOk(RECORD, { todoId: kept, location: 'https://example.com/other', label: 'Other' });
    await board.person.expectOk(UPDATE_TODO, { id: todoId, set: { title: 'Write the plan, twice' } });

    // Archived, it is still the todo's.
    await board.person.expectOk(ARCHIVE, { id: todoId });
    const attached = await db.select().from(dbSchema.artifacts);
    expect(attached.every((row: { todoId: string | null }) => row.todoId !== null)).toBe(true);

    await board.person.expectOk(PURGE, { id: todoId });
    const { artifacts } = await board.person.expectOk(PROJECT_ARTIFACTS, { projectId: board.projectId });
    const gone = { todoId: null, todoTitle: 'Write the plan, twice', todo: null };
    expect(artifacts).toEqual([
      { location: '/work/plan.md', source: 'declared', ...gone },
      {
        location: 'https://example.com/other',
        source: 'client',
        todoId: kept,
        todoTitle: null,
        todo: { title: 'Still here' },
      },
      { location: 'https://example.com/plan', source: 'client', ...gone },
    ]);
    // The run went with the todo; what it made did not.
    expect(await db.select().from(dbSchema.runs).where(eq(dbSchema.runs.id, runId))).toEqual([]);
  });

  it('takes the notes a run filed as artifacts with it, since the notes go too', async () => {
    const todoId = await board.addTodo('Write it');
    await ranWith(todoId, [
      { location: `telos:note/${randomUUID()}`, source: 'detected', serverSlug: 'telos', tool: 'add_todo_note' },
      { location: '/work/plan.md', source: 'declared' },
    ]);
    expect(await db.select().from(dbSchema.artifacts)).toHaveLength(2);
    await board.person.expectOk(PURGE, { id: todoId });
    const rows = await db.select().from(dbSchema.artifacts);
    expect(rows.map((row: { location: string }) => row.location)).toEqual(['/work/plan.md']);
  });

  it('can still be taken off the board, by its owner only', async () => {
    const todoId = await board.addTodo('Write it');
    await key.expectOk(RECORD, { todoId, ...PAGE });
    await board.person.expectOk(PURGE, { id: todoId });
    const [artifact] = await db.select().from(dbSchema.artifacts);

    const stranger = await createBoard(db, 'stranger@example.com');
    expect((await stranger.person.expectError(DELETE, { id: artifact.id })).code).toBe('NOT_FOUND');
    expect((await key.expectError(DELETE, { id: artifact.id })).code).toBe('FORBIDDEN');
    expect(await db.select().from(dbSchema.artifacts)).toHaveLength(1);
    expect((await board.person.expectOk(DELETE, { id: artifact.id })).deleteArtifact).toBe(true);
    expect(await db.select().from(dbSchema.artifacts)).toEqual([]);
  });

  it('is a person’s to see and not an AI caller’s', async () => {
    const todoId = await board.addTodo('Write it');
    await key.expectOk(RECORD, { todoId, ...PAGE });
    expect((await key.expectOk(PROJECT_ARTIFACTS, { projectId: board.projectId })).artifacts).toHaveLength(1);
    await board.person.expectOk(PURGE, { id: todoId });
    expect((await key.expectOk(PROJECT_ARTIFACTS, { projectId: board.projectId })).artifacts).toEqual([]);
    expect((await board.person.expectOk(PROJECT_ARTIFACTS, { projectId: board.projectId })).artifacts).toHaveLength(1);
  });

  it('goes when its project does', async () => {
    const todoId = await board.addTodo('Write it');
    await key.expectOk(RECORD, { todoId, ...PAGE });
    await board.person.expectOk(PURGE, { id: todoId });
    await board.person.expectOk(`mutation ($id: UUID!) { deleteProject(where: { id: { eq: $id } }) { id } }`, {
      id: board.projectId,
    });
    expect(await db.select().from(dbSchema.artifacts)).toEqual([]);
  });
});
