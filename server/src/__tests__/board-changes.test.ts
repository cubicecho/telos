import { type ExecutionResult, parse, subscribe } from 'graphql';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema } from '../build-schema.ts';
import type { Actor, Context } from '../context.ts';
import { createLoaders } from '../loaders.ts';
import { type Board, createBoard } from './board.ts';
import { authFor, createTestDb, createUser, type TestDb } from './helpers.ts';

// Live boards: the database announces each change (the board_notify trigger),
// and `boardChanged` relays the ones to a project its owner is watching.

let db: TestDb;
let board: Board;

const WATCH = `subscription ($projectId: ID!) { boardChanged(projectId: $projectId) { projectId table } }`;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
});

type Changes = AsyncIterableIterator<ExecutionResult>;

async function watch(projectId: string, actor: Actor): Promise<Changes | ExecutionResult> {
  const { schema } = createSchema(db, { ai: true });
  const contextValue: Context = { db, auth: authFor(db), userId: actor.userId, actor, loaders: createLoaders(db) };
  return (await subscribe({ schema, document: parse(WATCH), variableValues: { projectId }, contextValue })) as
    | Changes
    | ExecutionResult;
}

async function watchAsOwner(projectId = board.projectId): Promise<Changes> {
  const result = await watch(projectId, { kind: 'user', userId: board.userId });
  if (!(Symbol.asyncIterator in result)) throw new Error(JSON.stringify(result.errors));
  return result;
}

// A read that timed out is still waiting on the iterator, and would take the
// next change; so it is kept and handed to the next call instead of abandoned.
const pending = new WeakMap<Changes, Promise<IteratorResult<ExecutionResult>>>();

/** The next change, or null if none comes within `ms`. */
async function next(changes: Changes, ms = 500) {
  const read = pending.get(changes) ?? changes.next();
  pending.set(changes, read);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  const result = await Promise.race([read, timeout]);
  if (!result) return null;
  pending.delete(changes);
  if (result.done) return null;
  return (result.value.data as { boardChanged: { projectId: string; table: string } }).boardChanged;
}

describe('boardChanged', () => {
  it('tells the owner when a todo is added or moved, and a lane reordered', async () => {
    const changes = await watchAsOwner();
    const todo = await board.addTodo('Watch me');
    expect(await next(changes)).toEqual({ projectId: board.projectId, table: 'todos' });
    // Drain anything else the create touched.
    while (await next(changes, 100));

    await board.person.expectOk(`mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`, {
      id: todo,
      laneId: board.lanes[1].id,
    });
    expect(await next(changes)).toMatchObject({ table: 'todos' });
    while (await next(changes, 100));

    const ids = board.lanes.map((lane) => lane.id);
    await board.person.expectOk(
      `mutation ($projectId: ID!, $laneIds: [ID!]!) { reorderLanes(projectId: $projectId, laneIds: $laneIds) { id } }`,
      { projectId: board.projectId, laneIds: [ids[1], ids[0], ids[2]] },
    );
    // One notice for the whole reorder: Postgres folds identical ones.
    expect(await next(changes)).toMatchObject({ table: 'lanes' });
    expect(await next(changes, 200)).toBeNull();
    await changes.return?.();
  });

  it('hears nothing from another project', async () => {
    const changes = await watchAsOwner();
    const other = (await board.person.expectOk(`mutation { createProject(values: { name: "Other" }) { id } }`))
      .createProject.id;
    await board.person.expectOk(
      `mutation ($id: UUID!) { updateProject(set: { name: "Renamed" }, where: { id: { eq: $id } }) { id } }`,
      {
        id: other,
      },
    );
    expect(await next(changes, 300)).toBeNull();
    await changes.return?.();
  });

  it('is only for the project’s owner, signed in', async () => {
    const otherId = await createUser(db, 'other@example.com');
    const theirs = await watch(board.projectId, { kind: 'user', userId: otherId });
    expect((theirs as ExecutionResult).errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    const key = await watch(board.projectId, { kind: 'apiKey', userId: board.userId, keyId: 'k' });
    expect((key as ExecutionResult).errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const nobody = await watch(board.projectId, { kind: 'anonymous', userId: null });
    expect((nobody as ExecutionResult).errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('lets go when the client leaves a quiet board', async () => {
    const changes = await watchAsOwner();
    const pending = changes.next();
    await changes.return?.();
    expect(await pending).toMatchObject({ done: true });
  });
});
