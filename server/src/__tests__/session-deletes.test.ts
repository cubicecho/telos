import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_DELETE_ATTEMPTS } from '../resolvers/session-deletes.ts';
import { type Board, createBoard, FINISH, runnerClient } from './board.ts';
import { createTestDb, type TestClient, type TestDb } from './helpers.ts';

// A todo is the session an agent's MCP hooks file things under. What is pinned
// here is the server's half of telling those servers a todo is gone: the
// session is recorded when an agent first works the todo, a delete marks it
// owed, and the runner takes what is owed and reports back.

let db: TestDb;
let board: Board;
let runner: TestClient;

const CLAIM = `mutation ($todoId: ID!, $laneId: ID!) {
  claimRun(todoId: $todoId, laneId: $laneId) { runId turn opensSession }
}`;
const TAKE = `mutation ($limit: Int) { takeSessionDeletes(limit: $limit) { id todoId agentName attempt mcpServers } }`;
const DONE = `mutation ($id: ID!, $error: String) { finishSessionDelete(id: $id, error: $error) }`;
const PURGE = `mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }, hard: true) { id } }`;
const HOOKED = {
  id: 'memory',
  name: 'Memory',
  url: 'http://memory.test/mcp',
  hooks: [{ id: 'forget', on: 'sessionDelete', tool: 'forget', args: { session: '{{session.id}}' } }],
};
const UNHOOKED = { id: 'desk', name: 'Desk', url: 'http://desk.test/mcp' };

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

/** Makes these the account's servers. The board's agent names none, so it reaches them all. */
async function setServers(servers: Array<{ id: string; name: string; url: string; hooks?: unknown[] }>): Promise<void> {
  await db.delete(dbSchema.mcpServers).where(eq(dbSchema.mcpServers.userId, board.userId));
  await db
    .insert(dbSchema.mcpServers)
    .values(
      servers.map(({ id, name, url, hooks }) => ({ userId: board.userId, slug: id, name, url, hooks: hooks ?? [] })),
    );
}

async function claim(todoId: string): Promise<{ runId: string; turn: number; opensSession: boolean }> {
  return (await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id })).claimRun;
}

/** A todo an agent has worked, with the run failed so the todo stays put. */
async function workedTodo(title = 'Write it'): Promise<string> {
  const todoId = await board.addTodo(title);
  const { runId } = await claim(todoId);
  await runner.expectOk(FINISH, { id: runId, result: { status: 'error', error: 'model unreachable' } });
  return todoId;
}

async function sessions(): Promise<dbSchema.TodoSession[]> {
  return db.select().from(dbSchema.todoSessions);
}

async function take(): Promise<Array<{ id: string; todoId: string; attempt: number; mcpServers: string }>> {
  return (await runner.expectOk(TAKE)).takeSessionDeletes;
}

/** Makes every held or waiting session takeable now. */
async function letTimePass(): Promise<void> {
  await db.update(dbSchema.todoSessions).set({ retryAt: new Date(0) });
}

describe('a todo’s session', () => {
  it('opens with the first run and is not opened again', async () => {
    const todoId = await board.addTodo('Write it');
    const first = await claim(todoId);
    expect(first).toMatchObject({ turn: 0, opensSession: true });
    await runner.expectOk(FINISH, { id: first.runId, result: { status: 'error', error: 'model unreachable' } });

    expect(await claim(todoId)).toMatchObject({ turn: 1, opensSession: false });
    expect(await sessions()).toEqual([
      expect.objectContaining({ todoId, agentId: board.agentId, userId: board.userId, deletedAt: null }),
    ]);
  });

  it('stays opened when the todo’s runs have been pruned', async () => {
    const todoId = await workedTodo();
    await db.delete(dbSchema.runs).where(eq(dbSchema.runs.todoId, todoId));

    expect(await claim(todoId)).toMatchObject({ turn: 0, opensSession: false });
  });
});

describe('deleting a todo', () => {
  it('owes its agent’s servers a sessionDelete, and only the servers that asked', async () => {
    await setServers([HOOKED, UNHOOKED]);
    const todoId = await workedTodo();
    expect(await take()).toEqual([]);

    await board.person.expectOk(PURGE, { id: todoId });

    const [owed, ...rest] = await take();
    expect(rest).toEqual([]);
    expect(owed).toMatchObject({ todoId, agentName: 'Worker', attempt: 1 });
    expect(JSON.parse(owed.mcpServers)).toEqual([HOOKED]);
    // Held: a second runner asking now is handed nothing.
    expect(await take()).toEqual([]);

    expect((await runner.expectOk(DONE, { id: owed.id })).finishSessionDelete).toBe(true);
    expect(await sessions()).toEqual([]);
    expect((await runner.expectOk(DONE, { id: owed.id })).finishSessionDelete).toBe(false);
  });

  it('is owed when the todo goes with its project', async () => {
    await setServers([HOOKED]);
    const todoId = await workedTodo();
    await db.delete(dbSchema.projects).where(eq(dbSchema.projects.id, board.projectId));

    expect(await take()).toEqual([expect.objectContaining({ todoId })]);
  });

  it('owes nothing for an archived todo, which may yet come back', async () => {
    await setServers([HOOKED]);
    const todoId = await workedTodo();
    await board.person.expectOk(`mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }`, {
      id: todoId,
    });

    expect(await take()).toEqual([]);
    expect(await sessions()).toHaveLength(1);
  });

  it('forgets a session nobody asked to hear the end of', async () => {
    await setServers([UNHOOKED, { ...HOOKED, hooks: [{ ...HOOKED.hooks[0], enabled: false }] }]);
    const todoId = await workedTodo();
    await board.person.expectOk(PURGE, { id: todoId });

    expect(await take()).toEqual([]);
    expect(await sessions()).toEqual([]);
  });

  it('tries again after a failure, and gives up when the tries are spent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setServers([HOOKED]);
    const todoId = await workedTodo();
    await board.person.expectOk(PURGE, { id: todoId });

    for (let attempt = 1; attempt <= SESSION_DELETE_ATTEMPTS; attempt++) {
      const [owed] = await take();
      expect(owed).toMatchObject({ todoId, attempt });
      await runner.expectOk(DONE, { id: owed.id, error: 'Memory: connection refused' });
      // Not straight away.
      expect(await take()).toEqual([]);
      await letTimePass();
    }

    expect(await sessions()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
    warn.mockRestore();
  });

  it('gives up on one a runner kept taking and never reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setServers([HOOKED]);
    const todoId = await workedTodo();
    await board.person.expectOk(PURGE, { id: todoId });

    for (let attempt = 1; attempt <= SESSION_DELETE_ATTEMPTS; attempt++) {
      expect(await take()).toHaveLength(1);
      await letTimePass();
    }
    expect(await take()).toEqual([]);
    expect(await sessions()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('waits while the account has AI off', async () => {
    await setServers([HOOKED]);
    const todoId = await workedTodo();
    await board.person.expectOk(PURGE, { id: todoId });
    await db.update(dbSchema.users).set({ aiEnabled: false }).where(eq(dbSchema.users.id, board.userId));

    expect(await take()).toEqual([]);
    expect(await sessions()).toHaveLength(1);

    await db.update(dbSchema.users).set({ aiEnabled: true }).where(eq(dbSchema.users.id, board.userId));
    expect(await take()).toEqual([expect.objectContaining({ todoId })]);
  });

  it('goes with the agent, whose servers are who would have been told', async () => {
    await setServers([HOOKED]);
    const todoId = await workedTodo();
    await board.person.expectOk(PURGE, { id: todoId });
    await db.delete(dbSchema.agents).where(eq(dbSchema.agents.id, board.agentId));

    expect(await sessions()).toEqual([]);
  });

  it('is the runner’s alone to take and report', async () => {
    expect((await board.person.expectError(TAKE)).code).toBe('FORBIDDEN');
    expect((await board.person.expectError(DONE, { id: '00000000-0000-0000-0000-000000000000' })).code).toBe(
      'FORBIDDEN',
    );
  });
});
