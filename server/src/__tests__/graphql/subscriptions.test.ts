import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Client, createClient } from 'graphql-sse';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signInOnLocalNet } from '../../auth/better-auth.ts';
import { createApp } from '../../http/app.ts';
import { type Board, createBoard } from '../board.ts';
import { authFor, createTestDb, hostFor, schemaFor, type TestDb } from '../helpers.ts';

// The stream a live board rides, end to end: the real app, graphql-sse's own
// client in distinct-connections mode (what Yoga serves on /graphql), and the
// session token in the Authorization header, as every other request sends it.

const WATCH = `subscription ($projectId: ID!) { boardChanged(projectId: $projectId) { projectId table } }`;

let db: TestDb;
let board: Board;
let server: Server | null = null;
const clients: Client[] = [];

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function serve(): Promise<string> {
  const { app } = createApp({
    db,
    authHost: hostFor(db),
    schema: schemaFor(db, false).schema,
    ai: false,
    version: '0',
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
}

function connect(url: string, token?: string): Client {
  const client = createClient({
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    retryAttempts: 0,
  });
  clients.push(client);
  return client;
}

/** The first result of watching the board, whether a change or an error. */
function first(client: Client, projectId = board.projectId): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const stop = client.subscribe(
      { query: WATCH, variables: { projectId } },
      {
        next: (result) => {
          stop();
          resolve(result);
        },
        error: reject,
        complete: () => {},
      },
    );
  });
}

describe('the board stream', () => {
  it('delivers a change to the signed-in owner', async () => {
    const { token } = await signInOnLocalNet(authFor(db), 'owner@example.com');
    const client = connect(await serve(), token);
    const change = first(client);
    // The subscription has to be in place before the change it should hear; a
    // change keeps landing until the first one is heard.
    let heard = false;
    void change.then(() => {
      heard = true;
    });
    for (let i = 0; !heard && i < 20; i++) {
      await board.addTodo(`Todo ${i}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await change).toEqual({ data: { boardChanged: { projectId: board.projectId, table: 'todos' } } });
  });

  it('refuses a stream without a session', async () => {
    const client = connect(await serve());
    const result = (await first(client)) as { errors?: Array<{ extensions?: { code?: string } }> };
    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });
});
