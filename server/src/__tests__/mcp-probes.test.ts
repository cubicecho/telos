import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProbes, PROBE_LIMIT, PROBE_PICKUP_MS } from '../mcp-probes.ts';
import { type Board, createBoard, runnerClient } from './board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

// Testing an MCP server: a person asks, the runner takes the test and says
// what it found, and the person reads the answer.

let db: TestDb;
let board: Board;
let runner: TestClient;

beforeEach(async () => {
  clearProbes();
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

afterEach(() => {
  vi.useRealTimers();
});

const TEST = `mutation ($server: String!) { testMcpServer(server: $server) { id status } }`;
const READ = `query ($id: ID!) { mcpProbe(id: $id) { status ok tools { name description } instructions error } }`;
const TAKE = `query { runnerProbes { id server } }`;
const FINISH = `mutation ($id: ID!, $result: ProbeResultInput!) { finishProbe(id: $id, result: $result) }`;

const SERVER = JSON.stringify({ id: 'docs', name: 'Docs', url: 'http://127.0.0.1:9/mcp' });

describe('testing an MCP server', () => {
  it('goes to the runner and comes back with the tools', async () => {
    const asked = (await board.person.expectOk(TEST, { server: SERVER })).testMcpServer;
    expect(asked.status).toBe('pending');

    const taken = (await runner.expectOk(TAKE)).runnerProbes;
    expect(taken).toEqual([{ id: asked.id, server: SERVER }]);
    // Taken once: the next ask finds nothing.
    expect((await runner.expectOk(TAKE)).runnerProbes).toEqual([]);
    expect((await board.person.expectOk(READ, { id: asked.id })).mcpProbe.status).toBe('testing');

    await runner.expectOk(FINISH, {
      id: asked.id,
      result: { ok: true, tools: [{ name: 'search', description: 'Finds things.' }], instructions: 'Search first.' },
    });
    expect((await board.person.expectOk(READ, { id: asked.id })).mcpProbe).toEqual({
      status: 'done',
      ok: true,
      tools: [{ name: 'search', description: 'Finds things.' }],
      instructions: 'Search first.',
      error: null,
    });
  });

  it('carries the reason a server could not be reached', async () => {
    const { id } = (await board.person.expectOk(TEST, { server: SERVER })).testMcpServer;
    await runner.expectOk(TAKE);
    await runner.expectOk(FINISH, { id, result: { ok: false, tools: [], error: 'connect ECONNREFUSED' } });
    expect((await board.person.expectOk(READ, { id })).mcpProbe).toMatchObject({
      ok: false,
      error: 'connect ECONNREFUSED',
    });
  });

  it('says so when no runner takes it', async () => {
    const { id } = (await board.person.expectOk(TEST, { server: SERVER })).testMcpServer;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + PROBE_PICKUP_MS + 1000);
    expect((await board.person.expectOk(READ, { id })).mcpProbe).toMatchObject({
      status: 'done',
      ok: false,
      error: expect.stringMatching(/No runner/),
    });
  });

  it('refuses a row it could not test', async () => {
    for (const server of ['nope', '{}', JSON.stringify({ id: 'x' }), JSON.stringify({ id: 'x', url: 'file:///' })]) {
      expect((await board.person.expectError(TEST, { server })).code).toBe('BAD_USER_INPUT');
    }
  });

  it('keeps a person to a few at once', async () => {
    for (let i = 0; i < PROBE_LIMIT; i++) await board.person.expectOk(TEST, { server: SERVER });
    expect((await board.person.expectError(TEST, { server: SERVER })).code).toBe('BAD_USER_INPUT');
  });

  it("is its asker's alone, and the runner's to make", async () => {
    const { id } = (await board.person.expectOk(TEST, { server: SERVER })).testMcpServer;
    const other = await createBoard(db, 'other@example.com');
    expect((await other.person.expectOk(READ, { id })).mcpProbe).toBeNull();

    expect((await board.person.expectError(TAKE)).code).toBe('FORBIDDEN');
    expect((await board.person.expectError(FINISH, { id, result: { ok: true, tools: [] } })).code).toBe('FORBIDDEN');
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: '00000000-0000-0000-0000-000000000000' },
    });
    expect((await key.expectError(TEST, { server: SERVER })).code).toBe('FORBIDDEN');
    expect((await runner.expectError(TEST, { server: SERVER })).code).toBe('FORBIDDEN');
  });
});
