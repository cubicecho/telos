import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Board, createBoard } from './board.ts';
import { createClient, createTestDb, type TestDb } from './helpers.ts';

// Picking a model: the server asks the agent's endpoint what it serves.

let endpoint: Server;
let baseUrl: string;
let lastAuth: string | undefined;

beforeAll(async () => {
  endpoint = createServer((request: IncomingMessage, response) => {
    lastAuth = request.headers.authorization;
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          data: [{ id: 'zeta' }, { id: 'alpha', context_length: 8192 }, { id: 'alpha' }, { nope: true }],
        }),
      );
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => endpoint.close(() => resolve())));

let db: TestDb;
let board: Board;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  lastAuth = undefined;
});

const MODELS = `query ($baseUrl: String!, $agentId: ID) { agentModels(baseUrl: $baseUrl, agentId: $agentId) { id contextLength } }`;

describe('agentModels', () => {
  it('lists what the endpoint serves, sorted, once each', async () => {
    const { agentModels } = await board.person.expectOk(MODELS, { baseUrl: `${baseUrl}/` });
    expect(agentModels).toEqual([
      { id: 'alpha', contextLength: 8192 },
      { id: 'zeta', contextLength: null },
    ]);
    expect(lastAuth).toBeUndefined();
  });

  it("asks with the agent's stored key", async () => {
    await board.person.expectOk(MODELS, { baseUrl, agentId: board.agentId });
    expect(lastAuth).toBe('Bearer sk-secret');
  });

  it('says why when the endpoint will not list them', async () => {
    const missing = await board.person.expectError(MODELS, { baseUrl: `${baseUrl}/nothing` });
    expect(missing).toMatchObject({ code: 'BAD_USER_INPUT' });
    expect(missing.message).toMatch(/answered 404/);
    const odd = await board.person.expectError(MODELS, { baseUrl: 'file:///etc' });
    expect(odd.message).toMatch(/http or https/);
  });

  it("will not use another person's agent, or answer an API key", async () => {
    const other = await createBoard(db, 'other@example.com');
    const theirs = await other.person.expectError(MODELS, { baseUrl, agentId: board.agentId });
    expect(theirs.code).toBe('NOT_FOUND');
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: '00000000-0000-0000-0000-000000000000' },
    });
    expect((await key.expectError(MODELS, { baseUrl })).code).toBe('FORBIDDEN');
  });
});
