import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Client, createClient } from 'graphql-ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { signInDirectly } from '../auth.ts';
import { createSchema } from '../build-schema.ts';
import { createContextFactory } from '../request-context.ts';
import { serveSubscriptions } from '../routes/subscriptions.ts';
import { type Board, createBoard } from './board.ts';
import { authFor, createTestDb, type TestDb } from './helpers.ts';

// The socket a live board rides, end to end: a real server, graphql-ws's own
// client, and the session token sent the way a browser has to send it, in the
// connection's params.

const WATCH = `subscription ($projectId: ID!) { boardChanged(projectId: $projectId) { projectId table } }`;

let db: TestDb;
let board: Board;
let server: Server | null = null;
let closeSockets: (() => Promise<void>) | null = null;
const clients: Client[] = [];

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
  await closeSockets?.();
  closeSockets = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function serve(): Promise<string> {
  const { schema } = createSchema(db, { ai: false });
  server = createServer();
  closeSockets = serveSubscriptions(server, schema, createContextFactory(db, authFor(db), { ai: false }));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
}

function connect(url: string, token?: string): Client {
  const client = createClient({
    url,
    webSocketImpl: WebSocket,
    connectionParams: token ? { authorization: `Bearer ${token}` } : {},
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

describe('the board socket', () => {
  it('delivers a change to the signed-in owner', async () => {
    const { token } = await signInDirectly(authFor(db), 'owner@example.com');
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

  it('refuses a socket without a session', async () => {
    const client = connect(await serve());
    const result = (await first(client)) as { errors?: Array<{ extensions?: { code?: string } }> };
    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });
});
