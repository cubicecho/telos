import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, CLAIM_DRAFT, createBoard, QUEUE, runnerClient, START_DRAFT } from './board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from './helpers.ts';

// What an account's agents inherit: set in Settings, handed to the runner with
// every claim, and never read back with its key.

const READ = `query {
  agentDefaults {
    id baseUrl model temperature maxTokens contextLength maxToolIterations toolDiscovery
    toolSelectModel reasoningEffort requestTimeoutSeconds maxRetries hasApiKey
    resolved { baseUrl model temperature maxTokens maxToolIterations toolDiscovery requestTimeoutSeconds maxRetries }
  }
}`;
const SET = `mutation ($values: AgentDefaultsInput!) {
  setAgentDefaults(values: $values) { baseUrl model temperature maxTokens maxRetries hasApiKey resolved { model temperature maxTokens } }
}`;
const SET_KEY = `mutation ($apiKey: String) { setAgentDefaultsApiKey(apiKey: $apiKey) { hasApiKey baseUrl } }`;
const UPDATE_AGENT = `mutation ($id: UUID!, $set: UpdateAgentInput!) {
  updateAgent(set: $set, where: { id: { eq: $id } }) { id }
}`;
const MODELS = `query ($baseUrl: String!, $agentId: ID) { agentModels(baseUrl: $baseUrl, agentId: $agentId) { id } }`;

let db: TestDb;
let board: Board;
let runner: TestClient;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

describe('agentDefaults', () => {
  it('reads as blank, over agent-core’s own, before anything is set', async () => {
    const { agentDefaults } = await board.person.expectOk(READ);
    expect(agentDefaults).toMatchObject({
      id: board.userId,
      baseUrl: null,
      model: null,
      temperature: null,
      hasApiKey: false,
      resolved: { baseUrl: '', model: '', temperature: 0.7, maxTokens: 0, toolDiscovery: false, maxRetries: 0 },
    });
    expect(agentDefaults.resolved.requestTimeoutSeconds).toBeNull();
  });

  it('stores the whole layer, trimmed, with zero kept and blank as null', async () => {
    const { setAgentDefaults } = await board.person.expectOk(SET, {
      values: { baseUrl: ' http://llm.local/v1 ', model: 'qwen', temperature: 0, maxTokens: 0, maxRetries: 3 },
    });
    expect(setAgentDefaults).toMatchObject({
      baseUrl: 'http://llm.local/v1',
      model: 'qwen',
      temperature: 0,
      maxTokens: 0,
      maxRetries: 3,
      resolved: { model: 'qwen', temperature: 0, maxTokens: 0 },
    });
    // A save is the whole layer: what is left out is cleared.
    const again = (await board.person.expectOk(SET, { values: { model: '  ' } })).setAgentDefaults;
    expect(again).toMatchObject({ baseUrl: null, model: null, temperature: null, maxRetries: null });
  });

  it('stores a reasoning effort, which an agent can turn off and the runner is handed', async () => {
    await board.person.expectOk(SET, { values: { baseUrl: 'http://llm.local/v1', reasoningEffort: ' high ' } });
    const { agentDefaults } = await board.person.expectOk(
      'query { agentDefaults { reasoningEffort resolved { reasoningEffort } builtIn { reasoningEffort } } }',
    );
    expect(agentDefaults).toEqual({
      reasoningEffort: 'high',
      resolved: { reasoningEffort: 'high' },
      builtIn: { reasoningEffort: '' },
    });

    await board.person.expectOk(UPDATE_AGENT, { id: board.agentId, set: { reasoningEffort: 'off' } });
    const todoId = await board.addTodo('Think less');
    const { claimRun } = await runner.expectOk(
      `mutation ($todoId: ID!, $laneId: ID!) {
        claimRun(todoId: $todoId, laneId: $laneId) { agent { reasoningEffort defaults { reasoningEffort } } }
      }`,
      { todoId, laneId: board.lanes[0].id },
    );
    expect(claimRun.agent).toEqual({ reasoningEffort: 'off', defaults: { reasoningEffort: 'high' } });
  });

  it('refuses a value the runner would drop', async () => {
    const hot = await board.person.expectError(SET, { values: { temperature: 5 } });
    expect(hot.code).toBe('BAD_USER_INPUT');
    expect(hot.message).toMatch(/temperature/);
    const none = await board.person.expectError(SET, { values: { maxToolIterations: 0 } });
    expect(none.code).toBe('BAD_USER_INPUT');
  });

  it('keeps the key write-only, and apart from the rest', async () => {
    await board.person.expectOk(SET, { values: { baseUrl: 'http://llm.local/v1' } });
    expect((await board.person.expectOk(SET_KEY, { apiKey: ' sk-default ' })).setAgentDefaultsApiKey).toEqual({
      hasApiKey: true,
      baseUrl: 'http://llm.local/v1',
    });
    // Saving the rest leaves the key alone.
    expect((await board.person.expectOk(SET, { values: { model: 'm' } })).setAgentDefaults.hasApiKey).toBe(true);
    const asked = await board.person.expectError(`query { agentDefaults { apiKey } }`);
    expect(asked.message).toMatch(/apiKey/);
    expect((await board.person.expectOk(SET_KEY, { apiKey: null })).setAgentDefaultsApiKey.hasApiKey).toBe(false);
  });

  it('is one account’s own', async () => {
    await board.person.expectOk(SET, { values: { model: 'mine' } });
    const other = await createBoard(db, 'other@example.com');
    expect((await other.person.expectOk(READ)).agentDefaults.model).toBeNull();
  });

  it('is closed to AI and to the runner', async () => {
    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: '00000000-0000-0000-0000-000000000000' },
    });
    expect((await key.expectError(READ)).code).toBe('FORBIDDEN');
    expect((await key.expectError(SET, { values: { model: 'x' } })).code).toBe('FORBIDDEN');
    expect((await key.expectError(SET_KEY, { apiKey: 'x' })).code).toBe('FORBIDDEN');
    expect((await runner.expectError(SET_KEY, { apiKey: 'x' })).code).toBe('FORBIDDEN');
  });

  it('is not there with AI switched off for the account', async () => {
    await db.update(dbSchema.users).set({ aiEnabled: false }).where(eq(dbSchema.users.id, board.userId));
    expect((await board.person.expectError(READ)).code).toBe('NOT_FOUND');
  });
});

describe('an agent over its defaults', () => {
  beforeEach(async () => {
    await board.person.expectOk(SET, {
      values: { baseUrl: 'http://llm.test/v1', model: 'big', temperature: 0.2, maxTokens: 4096 },
    });
    await board.person.expectOk(SET_KEY, { apiKey: 'sk-default' });
  });

  it('goes to a run with its defaults, and the run records the model it inherits', async () => {
    await board.person.expectOk(UPDATE_AGENT, { id: board.agentId, set: { model: null } });
    const todoId = await board.addTodo('Inherit');
    const { claimRun } = await runner.expectOk(
      `mutation ($todoId: ID!, $laneId: ID!) {
        claimRun(todoId: $todoId, laneId: $laneId) {
          runId agent { model defaults { baseUrl model apiKey temperature maxTokens } }
        }
      }`,
      { todoId, laneId: board.lanes[0].id },
    );
    expect(claimRun.agent).toEqual({
      model: null,
      defaults: {
        baseUrl: 'http://llm.test/v1',
        model: 'big',
        apiKey: 'sk-default',
        temperature: 0.2,
        maxTokens: 4096,
      },
    });
    const [run] = await db.select().from(dbSchema.runs).where(eq(dbSchema.runs.id, claimRun.runId));
    expect(run.model).toBe('big');
  });

  it('shows AI the model it runs, its own or inherited', async () => {
    const roster = `query { agentRoster { id model enabled } }`;
    expect((await board.person.expectOk(roster)).agentRoster).toEqual([
      { id: board.agentId, model: 'tiny', enabled: true },
    ]);
    await board.person.expectOk(UPDATE_AGENT, { id: board.agentId, set: { model: null } });
    expect((await board.person.expectOk(roster)).agentRoster[0].model).toBe('big');
  });

  it('lists models with the default key only at the default endpoint', async () => {
    let lastAuth: string | undefined;
    const endpoint: Server = createServer((request: IncomingMessage, response) => {
      lastAuth = request.headers.authorization;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'm' }] }));
    });
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`;
      await board.person.expectOk(MODELS, { baseUrl: url });
      expect(lastAuth).toBeUndefined();
      await board.person.expectOk(SET, { values: { baseUrl: url } });
      await board.person.expectOk(MODELS, { baseUrl: url });
      expect(lastAuth).toBe('Bearer sk-default');
      // The agent's own key wins wherever it is sent.
      await board.person.expectOk(MODELS, { baseUrl: url, agentId: board.agentId });
      expect(lastAuth).toBe('Bearer sk-secret');
    } finally {
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }
  });
});

describe('an agent switched off', () => {
  it('takes no runs and no drafts', async () => {
    const draftId = (
      await board.person.expectOk(START_DRAFT, { projectId: board.projectId, agentId: board.agentId, message: 'Hi' })
    ).startDraft.id;
    await board.addTodo('Waits');
    expect((await runner.expectOk(QUEUE)).runnerQueue).toHaveLength(1);

    await board.person.expectOk(UPDATE_AGENT, { id: board.agentId, set: { enabled: false } });
    expect((await runner.expectOk(QUEUE)).runnerQueue).toEqual([]);
    expect((await runner.expectOk(CLAIM_DRAFT, { id: draftId })).claimDraft).toBeNull();
    const refused = await board.person.expectError(START_DRAFT, {
      projectId: board.projectId,
      agentId: board.agentId,
      message: 'Again',
    });
    expect(refused).toMatchObject({ code: 'CONFLICT' });
    expect(refused.message).toMatch(/Worker is switched off/);
    expect((await board.person.expectOk(`query { agentRoster { enabled } }`)).agentRoster).toEqual([
      { enabled: false },
    ]);

    await board.person.expectOk(UPDATE_AGENT, { id: board.agentId, set: { enabled: true } });
    expect((await runner.expectOk(QUEUE)).runnerQueue).toHaveLength(1);
  });
});
