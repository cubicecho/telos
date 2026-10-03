import * as dbSchema from '@telos/db/schema';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CURSOR_MAX_AGE_DAYS,
  decodeCursor,
  encodeCursor,
  pruneTombstones,
  TOMBSTONE_RETENTION_DAYS,
} from '../changes.ts';
import { type Board, createBoard } from './board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

// The change feed: a consumer keeping a copy of an account's projects, todos
// and dependency edges reads what changed since its cursor, upserts and
// tombstones, on every path a row can change by — cascades included — and an
// API key sees only what tenancy lets AI see, and is told when something
// leaves its view.

const FEED = `query ($since: String, $limit: Int) {
  changes(since: $since, limit: $limit) {
    projects { id name archivedAt }
    todos { id title archivedAt }
    dependencies { id todoId dependsOnTodoId }
    tombstones { entity id projectId todoId dependsOnTodoId removedAt }
    cursor
    hasMore
  }
}`;
const ADD_DEPENDENCY = `mutation ($todoId: ID!, $dependsOnTodoId: ID!) {
  addTodoDependency(todoId: $todoId, dependsOnTodoId: $dependsOnTodoId) { id }
}`;
const UPDATE_TODO = `mutation ($id: UUID!, $set: UpdateTodoInput!) { updateTodo(set: $set, where: { id: { eq: $id } }) { id } }`;
const ARCHIVE = `mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }`;
const PURGE = `mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }, hard: true) { id } }`;
const DELETE_PROJECT = `mutation ($id: UUID!) { deleteProject(where: { id: { eq: $id } }) { id } }`;
const SET_PROJECT_AI = `mutation ($id: ID!, $enabled: Boolean!) {
  setProjectAiEnabled(projectId: $id, enabled: $enabled) { id }
}`;

interface Tombstone {
  entity: string;
  id: string;
  projectId: string | null;
  todoId: string | null;
  dependsOnTodoId: string | null;
}

interface Feed {
  projects: Array<{ id: string; name: string; archivedAt: string | null }>;
  todos: Array<{ id: string; title: string; archivedAt: string | null }>;
  dependencies: Array<{ id: string; todoId: string; dependsOnTodoId: string }>;
  tombstones: Tombstone[];
  cursor: string;
}

let db: TestDb;
let board: Board;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
});

/** A client holding one of the board owner's API keys. */
function keyClient(): TestClient {
  return createClient(db, board.userId, {
    ai: true,
    actor: { kind: 'apiKey', userId: board.userId, keyId: '00000000-0000-0000-0000-000000000000' },
  });
}

/** Reads every page from `since`, as a consumer catching up would. */
async function readAll(client: TestClient, since: string | null = null, limit?: number): Promise<Feed> {
  const all: Feed = { projects: [], todos: [], dependencies: [], tombstones: [], cursor: since ?? '' };
  for (let cursor = since, more = true; more; ) {
    const page = (await client.expectOk(FEED, { since: cursor, limit })).changes;
    for (const key of ['projects', 'todos', 'dependencies', 'tombstones'] as const) all[key].push(...page[key]);
    all.cursor = page.cursor;
    cursor = page.cursor;
    more = page.hasMore;
  }
  return all;
}

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();

describe('the change feed, for a person', () => {
  it('starts from everything there is, then hands back only what changed', async () => {
    const a = await board.addTodo('A');
    const b = await board.addTodo('B');
    await board.person.expectOk(ADD_DEPENDENCY, { todoId: a, dependsOnTodoId: b });

    const first = await readAll(board.person);
    expect(ids(first.projects)).toEqual([board.projectId]);
    expect(ids(first.todos)).toEqual([a, b].sort());
    expect(first.dependencies).toEqual([expect.objectContaining({ todoId: a, dependsOnTodoId: b })]);
    expect(first.tombstones).toEqual([]);

    expect(await readAll(board.person, first.cursor)).toMatchObject({ projects: [], todos: [], tombstones: [] });

    await board.person.expectOk(UPDATE_TODO, { id: b, set: { title: 'B, renamed' } });
    const next = await readAll(board.person, first.cursor);
    expect(next.todos).toEqual([expect.objectContaining({ id: b, title: 'B, renamed' })]);
    expect(next.projects).toEqual([]);
  });

  it('ignores a write that changes nothing', async () => {
    const a = await board.addTodo('A');
    const { cursor } = await readAll(board.person);
    // Every column as it was; drizzle's update would move updatedAt.
    await db.execute(sql`UPDATE todos SET title = title WHERE id = ${a}`);
    expect((await readAll(board.person, cursor)).todos).toEqual([]);
  });

  it('carries an archived todo as an upsert with archivedAt', async () => {
    const a = await board.addTodo('A');
    const { cursor } = await readAll(board.person);
    await board.person.expectOk(ARCHIVE, { id: a });
    const archived = await readAll(board.person, cursor);
    expect(archived.todos).toEqual([expect.objectContaining({ id: a, archivedAt: expect.anything() })]);
    expect(archived.tombstones).toEqual([]);
  });

  it('leaves a tombstone for a todo deleted for good, and for the edges that went with it', async () => {
    const a = await board.addTodo('A');
    const b = await board.addTodo('B');
    await board.person.expectOk(ADD_DEPENDENCY, { todoId: a, dependsOnTodoId: b });
    const { cursor, dependencies } = await readAll(board.person);

    await board.person.expectOk(PURGE, { id: b });
    const after = await readAll(board.person, cursor);
    expect(after.tombstones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: 'TODO', id: b, projectId: board.projectId }),
        expect.objectContaining({
          entity: 'DEPENDENCY',
          id: dependencies[0].id,
          projectId: board.projectId,
          todoId: a,
          dependsOnTodoId: b,
        }),
      ]),
    );
    expect(after.tombstones).toHaveLength(2);
  });

  it('leaves tombstones for a project deleted with everything in it', async () => {
    const a = await board.addTodo('A');
    const b = await board.addTodo('B');
    await board.person.expectOk(ADD_DEPENDENCY, { todoId: a, dependsOnTodoId: b });
    const { cursor } = await readAll(board.person);

    await board.person.expectOk(DELETE_PROJECT, { id: board.projectId });
    const after = await readAll(board.person, cursor);
    expect(after.tombstones.map((t) => t.entity).sort()).toEqual(['DEPENDENCY', 'PROJECT', 'TODO', 'TODO']);
    for (const tombstone of after.tombstones) expect(tombstone.projectId).toBe(board.projectId);
    expect(after).toMatchObject({ projects: [], todos: [], dependencies: [] });
  });

  it('pages without losing or repeating anything', async () => {
    const made = [];
    for (let i = 0; i < 7; i++) made.push(await board.addTodo(`T${i}`));
    const first = (await board.person.expectOk(FEED, { limit: 3 })).changes;
    expect(first.hasMore).toBe(true);
    const all = await readAll(board.person, null, 3);
    expect(ids(all.todos)).toEqual([...made].sort());
    expect(all.projects).toHaveLength(1);
  });

  it('shows nobody else’s changes', async () => {
    await board.addTodo('Mine');
    const other = await createBoard(db, 'other@example.com');
    const theirs = await readAll(other.person);
    expect(ids(theirs.projects)).toEqual([other.projectId]);
    expect(theirs.todos).toEqual([]);
  });

  it('refuses a cursor it did not make, and a page too big', async () => {
    expect((await board.person.expectError(FEED, { since: 'nonsense' })).code).toBe('BAD_USER_INPUT');
    expect((await board.person.expectError(FEED, { limit: 1001 })).code).toBe('BAD_USER_INPUT');
    expect((await board.person.expectError(FEED, { limit: 0 })).code).toBe('BAD_USER_INPUT');
  });

  it('lets an account go without tripping over its own tombstones', async () => {
    await board.addTodo('A');
    await db.delete(dbSchema.users).where(eq(dbSchema.users.id, board.userId));
    const left = await db.select().from(dbSchema.changeLog).where(eq(dbSchema.changeLog.userId, board.userId));
    expect(left).toEqual([]);
  });
});

describe('the change feed, for an API key', () => {
  it('sees what tenancy lets AI see, and nothing more', async () => {
    const open = await board.addTodo('Open');
    const ignored = await board.addTodo('Ignored');
    const archived = await board.addTodo('Archived');
    await board.person.expectOk(UPDATE_TODO, { id: ignored, set: { aiIgnored: true } });
    await board.person.expectOk(ADD_DEPENDENCY, { todoId: open, dependsOnTodoId: archived });
    await board.person.expectOk(ARCHIVE, { id: archived });
    const closed = (await board.person.expectOk(`mutation { createProject(values: { name: "Closed" }) { id } }`))
      .createProject.id;
    await board.person.expectOk(
      `mutation ($p: UUID!) { createTodo(values: { projectId: $p, title: "Hidden" }) { id } }`,
      { p: closed },
    );

    const key = keyClient();
    const feed = await readAll(key);
    const generated = await key.expectOk(`query {
      projects { id }
      todos(deleted: INCLUDE) { id }
      todoDependencies { id }
    }`);
    expect(ids(feed.projects)).toEqual(ids(generated.projects));
    expect(ids(feed.todos)).toEqual(ids(generated.todos));
    expect(ids(feed.dependencies)).toEqual(ids(generated.todoDependencies));
    expect(ids(feed.todos)).toEqual([open, archived].sort());
    // The ignored todo was seen on its way in, before it was ignored, and the
    // edge before its far end was archived: both went out of view since.
    expect(feed.dependencies).toEqual([]);
    expect(feed.tombstones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: 'TODO', id: ignored }),
        expect.objectContaining({ entity: 'DEPENDENCY', todoId: open, dependsOnTodoId: archived }),
      ]),
    );
    expect(feed.tombstones).toHaveLength(2);
  });

  it('is told when a todo leaves its view, and when it comes back', async () => {
    const a = await board.addTodo('A');
    const key = keyClient();
    const { cursor } = await readAll(key);

    await board.person.expectOk(UPDATE_TODO, { id: a, set: { aiIgnored: true } });
    const gone = await readAll(key, cursor);
    expect(gone.todos).toEqual([]);
    expect(gone.tombstones).toEqual([expect.objectContaining({ entity: 'TODO', id: a, projectId: board.projectId })]);

    await board.person.expectOk(UPDATE_TODO, { id: a, set: { aiIgnored: false } });
    const back = await readAll(key, gone.cursor);
    expect(ids(back.todos)).toEqual([a]);
    expect(back.tombstones).toEqual([]);
  });

  it('is told a project and what is in it went when its AI switch goes off, and gets them back', async () => {
    const a = await board.addTodo('A');
    const b = await board.addTodo('B');
    await board.person.expectOk(ADD_DEPENDENCY, { todoId: a, dependsOnTodoId: b });
    const key = keyClient();
    const { cursor } = await readAll(key);

    await board.person.expectOk(SET_PROJECT_AI, { id: board.projectId, enabled: false });
    const gone = await readAll(key, cursor);
    expect(gone.tombstones.map((t) => t.entity).sort()).toEqual(['DEPENDENCY', 'PROJECT', 'TODO', 'TODO']);

    await board.person.expectOk(SET_PROJECT_AI, { id: board.projectId, enabled: true });
    const back = await readAll(key, gone.cursor);
    expect(ids(back.projects)).toEqual([board.projectId]);
    expect(ids(back.todos)).toEqual([a, b].sort());
    expect(back.dependencies).toHaveLength(1);
    expect(back.tombstones).toEqual([]);
  });

  it('never names what AI was never shown', async () => {
    await board.person.expectOk(SET_PROJECT_AI, { id: board.projectId, enabled: false });
    const key = keyClient();
    const { cursor } = await readAll(key);
    const hidden = await board.addTodo('Behind the switch');
    await board.person.expectOk(PURGE, { id: hidden });
    expect(await readAll(key, cursor)).toMatchObject({ projects: [], todos: [], tombstones: [] });
  });

  it('is the `changes` tool’s field, which a key can switch off', async () => {
    const key = createClient(db, board.userId, {
      ai: true,
      actor: {
        kind: 'apiKey',
        userId: board.userId,
        keyId: '00000000-0000-0000-0000-000000000000',
        toolsOff: new Set(['changes']),
      },
    });
    expect((await key.expectError(FEED)).code).toBe('FORBIDDEN');
  });
});

describe('the cursor', () => {
  it('expires a day before the tombstones behind it are pruned', () => {
    const issued = new Date('2026-01-01T00:00:00Z');
    const cursor = encodeCursor({ xid: '12', seq: '34' }, issued);
    const day = 24 * 60 * 60_000;
    expect(decodeCursor(cursor, new Date(issued.getTime() + CURSOR_MAX_AGE_DAYS * day))).toEqual({
      xid: '12',
      seq: '34',
    });
    expect(() => decodeCursor(cursor, new Date(issued.getTime() + CURSOR_MAX_AGE_DAYS * day + 1))).toThrow(
      expect.objectContaining({ extensions: { code: 'CURSOR_EXPIRED' } }),
    );
    expect(CURSOR_MAX_AGE_DAYS).toBeLessThan(TOMBSTONE_RETENTION_DAYS);
  });
});

describe('pruning', () => {
  it('drops tombstones past their keep, and nothing else', async () => {
    const a = await board.addTodo('A');
    const b = await board.addTodo('B');
    await board.person.expectOk(PURGE, { id: a });
    await board.person.expectOk(PURGE, { id: b });
    await db.execute(
      sql`UPDATE change_log SET deleted_at = now() - make_interval(days => ${TOMBSTONE_RETENTION_DAYS + 1}) WHERE entity_id = ${a}`,
    );

    expect(await pruneTombstones(db)).toBe(1);
    const left = (await db.select().from(dbSchema.changeLog)).map((row: { entityId: string }) => row.entityId);
    expect(left).not.toContain(a);
    expect(left).toContain(b);
    expect(left).toContain(board.projectId);
  });
});
