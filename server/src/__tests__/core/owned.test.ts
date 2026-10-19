import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineAbilitiesFor } from '../../auth/abilities.ts';
import { createRateLimiter } from '../../auth/rate-limit.ts';
import type { Actor, Context } from '../../core/context.ts';
import { loadAiProject, loadAiTodo, loadOwnedLane, loadOwnedProject, loadOwnedTodo } from '../../core/owned.ts';
import { createLoaders } from '../../graphql/loaders.ts';
import { type Board, createBoard } from '../board.ts';
import { authFor, createTestDb, createUser, hostFor, TEST_IP, type TestDb } from '../helpers.ts';

// The hand-written lookups follow tenancy's `reachable()`, the scope generated
// CRUD runs under. For a person that is their own rows, as it always was. For
// AI it is narrower: a project with AI off, and a todo it was told to ignore,
// are not there for it, through these lookups as through a generated read.

let db: TestDb;
let board: Board;

/** A request's context for `actor`, as the context factory builds one. */
function contextFor(actor: Actor): Context {
  return {
    db,
    auth: authFor(db),
    authHost: hostFor(db),
    userId: actor.userId,
    actor,
    ability: defineAbilitiesFor(actor),
    loaders: createLoaders(db),
    headers: new Headers(),
    ip: TEST_IP,
    limiter: createRateLimiter(),
  };
}

const person = () => contextFor({ kind: 'user', userId: board.userId });
const key = () => contextFor({ kind: 'apiKey', userId: board.userId, keyId: '00000000-0000-0000-0000-000000000000' });

/** Whether a lookup answered NOT_FOUND. */
async function notFound(lookup: Promise<unknown>): Promise<boolean> {
  return lookup.then(
    () => false,
    (error) => error.extensions?.code === 'NOT_FOUND',
  );
}

beforeEach(async () => {
  db = await createTestDb({ instanceAi: true });
  board = await createBoard(db, 'owner@example.com');
});

describe('owned lookups', () => {
  it('find a person’s own rows, and nobody else’s', async () => {
    const todoId = await board.addTodo('Mine');
    expect((await loadOwnedTodo(person(), todoId)).id).toBe(todoId);
    expect((await loadOwnedProject(person(), board.projectId)).id).toBe(board.projectId);
    expect((await loadOwnedLane(person(), board.lanes[0].id)).id).toBe(board.lanes[0].id);

    const otherId = await createUser(db, 'other@example.com');
    const stranger = contextFor({ kind: 'user', userId: otherId });
    expect(await notFound(loadOwnedTodo(stranger, todoId))).toBe(true);
    expect(await notFound(loadOwnedProject(stranger, board.projectId))).toBe(true);
    expect(await notFound(loadOwnedLane(stranger, board.lanes[0].id))).toBe(true);
  });

  it('find what AI may see for AI', async () => {
    const todoId = await board.addTodo('Visible');
    expect((await loadOwnedTodo(key(), todoId)).id).toBe(todoId);
    expect((await loadOwnedProject(key(), board.projectId)).id).toBe(board.projectId);
    expect((await loadOwnedLane(key(), board.lanes[0].id)).id).toBe(board.lanes[0].id);
  });

  it('hold AI to todos nobody told it to ignore', async () => {
    const todoId = await board.addTodo('Ignored');
    await db.update(dbSchema.todos).set({ aiIgnored: true }).where(eq(dbSchema.todos.id, todoId));
    expect((await loadOwnedTodo(person(), todoId)).id).toBe(todoId);
    expect(await notFound(loadOwnedTodo(key(), todoId))).toBe(true);
  });

  it('hold AI to projects with AI on, and everything in them', async () => {
    const todoId = await board.addTodo('Behind a closed project');
    await db.update(dbSchema.projects).set({ aiEnabled: false }).where(eq(dbSchema.projects.id, board.projectId));
    expect((await loadOwnedProject(person(), board.projectId)).id).toBe(board.projectId);
    expect((await loadOwnedTodo(person(), todoId)).id).toBe(todoId);
    expect(await notFound(loadOwnedProject(key(), board.projectId))).toBe(true);
    expect(await notFound(loadOwnedLane(key(), board.lanes[0].id))).toBe(true);
    expect(await notFound(loadOwnedTodo(key(), todoId))).toBe(true);
  });

  it('keep the AI forms’ rule for a person too: a draft needs AI on for its project', async () => {
    const todoId = await board.addTodo('Draft parent');
    expect((await loadAiTodo(person(), todoId)).id).toBe(todoId);
    await db.update(dbSchema.projects).set({ aiEnabled: false }).where(eq(dbSchema.projects.id, board.projectId));
    expect(await notFound(loadAiProject(person(), board.projectId))).toBe(true);
    expect(await notFound(loadAiTodo(person(), todoId))).toBe(true);
  });
});
