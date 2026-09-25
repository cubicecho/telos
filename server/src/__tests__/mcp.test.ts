import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintApiKey } from '../auth.ts';
import { createSchema } from '../build-schema.ts';
import type { Actor } from '../context.ts';
import { mountMcp } from '../mcp.ts';
import { createContextFactory } from '../request-context.ts';
import { authFor, createClient, createTestDb, createUser, type TestDb } from './helpers.ts';

// The AI door end to end: a real HTTP server, the MCP SDK's own client, and an
// API key in the header — the path Claude Code takes. What a key may see and
// write is pinned here too, through the same schema the door serves.

const TOOLS = ['projects', 'todos', 'request', 'submit_request', 'cancel_request', 'add_todo_note'];

let db: TestDb;
let server: Server | null = null;
let closeMcp: (() => Promise<void>) | null = null;
const clients: Client[] = [];

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await closeMcp?.();
  closeMcp = null;
  // Keep-alive sockets would otherwise hold `close` open past the hook's timeout.
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** Serves /mcp over the test database on an ephemeral port and returns its URL. */
async function serve(ai = true): Promise<URL> {
  const app = express();
  const { schema } = createSchema(db, { ai });
  const handler = mountMcp(app, {
    ai,
    db,
    schema,
    contextFor: createContextFactory(db, authFor(db), { ai }),
    version: '0',
  });
  closeMcp = handler ? () => handler.close() : null;
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
}

async function connect(url: URL, key: string): Promise<Client> {
  const client = new Client({ name: 'telos-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-api-key': key } } }));
  clients.push(client);
  return client;
}

/** Calls a tool and returns its structured result, throwing on a tool error. */
// biome-ignore lint/suspicious/noExplicitAny: callers shape the result
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? '').join('\n');
  if (result.isError) throw new Error(text);
  return ((result.structuredContent ?? JSON.parse(text)) as { data: unknown }).data;
}

/** A tool call that must fail; returns its message. */
async function callError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
}

interface Board {
  userId: string;
  key: string;
  keyId: string;
  projectId: string;
  lanes: { todo: string; doing: string; done: string };
}

/** A user with AI on, a project open to AI with three lanes, and a key. */
async function board(email = 'a@example.com', options: { projectAi?: boolean } = {}): Promise<Board> {
  const userId = await createUser(db, email);
  await db.update(dbSchema.users).set({ aiEnabled: true }).where(eq(dbSchema.users.id, userId));
  const [project] = await db
    .insert(dbSchema.projects)
    .values({ userId, name: 'Board', aiEnabled: options.projectAi ?? true })
    .returning();
  const lanes = await db
    .insert(dbSchema.lanes)
    .values([
      { userId, projectId: project.id, name: 'To do', position: 0 },
      { userId, projectId: project.id, name: 'Doing', position: 1 },
      { userId, projectId: project.id, name: 'Done', position: 2, isDone: true },
    ])
    .returning();
  const { id: keyId, key } = await mintApiKey(authFor(db), { userId, name: 'claude' });
  return {
    userId,
    key,
    keyId,
    projectId: project.id,
    lanes: { todo: lanes[0].id, doing: lanes[1].id, done: lanes[2].id },
  };
}

async function addTodo(b: Board, values: Record<string, unknown> = {}): Promise<string> {
  const [todo] = await db
    .insert(dbSchema.todos)
    .values({ userId: b.userId, projectId: b.projectId, laneId: b.lanes.todo, title: 'Existing', ...values })
    .returning();
  return todo.id;
}

function keyActor(b: Board): Actor {
  return { kind: 'apiKey', userId: b.userId, keyId: b.keyId };
}

describe('the tool surface', () => {
  it('is the hand-written operations and nothing else', async () => {
    const b = await board();
    const client = await connect(await serve(), b.key);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOLS].sort());
  });

  it('stays inside its size budgets', async () => {
    const b = await board();
    const client = await connect(await serve(), b.key);
    const { tools } = await client.listTools();
    for (const tool of tools) expect(JSON.stringify(tool).length, tool.name).toBeLessThan(40_000);
    expect(JSON.stringify(tools).length).toBeLessThan(250_000);
  });

  it('marks the reads read-only and the writes not', async () => {
    const b = await board();
    const client = await connect(await serve(), b.key);
    const byName = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    for (const read of ['projects', 'todos', 'request']) expect(byName.get(read)?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('submit_request')?.annotations?.readOnlyHint).toBe(false);
  });
});

describe('submitting a request', () => {
  it('lands at the back of the first open lane and reads back in full', async () => {
    const b = await board();
    await addTodo(b, { position: 4 });
    const client = await connect(await serve(), b.key);

    const { submitRequest } = await call(client, 'submit_request', {
      projectId: b.projectId,
      title: 'Write the changelog',
      brief: 'Summarise the last release.',
      acceptance: 'Every merged PR is mentioned.',
    });
    expect(submitRequest.lane).toEqual({ id: b.lanes.todo, name: 'To do' });

    await call(client, 'add_todo_note', { todoId: submitRequest.id, body: 'Link each PR.' });

    const { todo } = await call(client, 'request', { id: submitRequest.id });
    expect(todo).toMatchObject({
      title: 'Write the changelog',
      brief: 'Summarise the last release.',
      acceptance: 'Every merged PR is mentioned.',
      completedAt: null,
      lane: { name: 'To do', isDone: false },
    });
    expect(todo.thread).toEqual([expect.objectContaining({ body: 'Link each PR.', actorKind: 'apiKey' })]);
    expect(todo.history).toEqual([expect.objectContaining({ kind: 'create', actorKind: 'apiKey' })]);

    const [row] = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, submitRequest.id));
    expect(row.position).toBe(5);
  });

  it('lists what it can see through projects and todos', async () => {
    const b = await board();
    const existing = await addTodo(b);
    const client = await connect(await serve(), b.key);
    const { projects } = await call(client, 'projects');
    expect(projects).toEqual([
      expect.objectContaining({ id: b.projectId, lanes: [expect.anything(), expect.anything(), expect.anything()] }),
    ]);
    const { todos } = await call(client, 'todos', { projectId: b.projectId });
    expect(todos.map((todo: { id: string }) => todo.id)).toEqual([existing]);
  });

  it('nests under a parent in the same project only', async () => {
    const b = await board();
    const parent = await addTodo(b);
    const client = await connect(await serve(), b.key);
    const { submitRequest } = await call(client, 'submit_request', {
      projectId: b.projectId,
      title: 'Part one',
      parentId: parent,
    });
    const { todo } = await call(client, 'request', { id: parent });
    expect(todo.children.map((child: { id: string }) => child.id)).toEqual([submitRequest.id]);

    const other = await board('b@example.com');
    const stranger = await addTodo(other);
    expect(
      await callError(client, 'submit_request', { projectId: b.projectId, title: 'x', parentId: stranger }),
    ).toMatch(/not found/i);
  });

  it('is withdrawn by cancelling, which hands it back to its owner', async () => {
    const b = await board();
    const client = await connect(await serve(), b.key);
    const { submitRequest } = await call(client, 'submit_request', { projectId: b.projectId, title: 'Oops' });
    expect(await call(client, 'cancel_request', { id: submitRequest.id, reason: 'Filed twice.' })).toEqual({
      cancelRequest: true,
    });
    expect((await call(client, 'request', { id: submitRequest.id })).todo).toBeNull();

    const [row] = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, submitRequest.id));
    expect(row.aiIgnored).toBe(true);
    const events = await db.select().from(dbSchema.todoEvents).where(eq(dbSchema.todoEvents.todoId, row.id));
    expect(events.at(-1)).toMatchObject({ actorKind: 'apiKey', reason: 'Filed twice.' });
    expect(events.at(-1).noteId).not.toBeNull();
  });
});

describe('what a key may not do', () => {
  it('moves, completes or edits nothing', async () => {
    const b = await board();
    const todo = await addTodo(b);
    const client = createClient(db, b.userId, { ai: true, actor: keyActor(b) });
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['mutation($id: ID!, $lane: ID!) { moveTodo(id: $id, laneId: $lane) { id } }', { id: todo, lane: b.lanes.doing }],
      ['mutation($id: ID!) { completeTodo(id: $id) { id } }', { id: todo }],
      [
        'mutation($id: UUID!, $lane: UUID!) { updateTodo(set: { laneId: $lane }, where: { id: { eq: $id } }) { id } }',
        { id: todo, lane: b.lanes.done },
      ],
      ['mutation($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }', { id: todo }],
      ['mutation($p: ID!) { setProjectAiEnabled(projectId: $p, enabled: false) { id } }', { p: b.projectId }],
    ];
    for (const [query, variables] of attempts) {
      expect((await client.expectError(query, variables)).code, query).toBe('FORBIDDEN');
    }
    const [row] = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, todo));
    expect(row.laneId).toBe(b.lanes.todo);
  });

  it('leaves a person free to do all of it', async () => {
    const b = await board();
    const todo = await addTodo(b);
    const client = createClient(db, b.userId, { ai: true });
    await client.expectOk('mutation($id: ID!, $lane: ID!) { moveTodo(id: $id, laneId: $lane) { id } }', {
      id: todo,
      lane: b.lanes.doing,
    });
  });
});

describe('what a key may not see', () => {
  it('finds a project closed to AI not there at all', async () => {
    const b = await board('a@example.com', { projectAi: false });
    const todo = await addTodo(b);
    const client = await connect(await serve(), b.key);
    expect((await call(client, 'projects')).projects).toEqual([]);
    expect((await call(client, 'todos', { projectId: b.projectId })).todos).toEqual([]);
    expect((await call(client, 'request', { id: todo })).todo).toBeNull();
    expect(await callError(client, 'submit_request', { projectId: b.projectId, title: 'x' })).toMatch(/not found/i);
    expect(await callError(client, 'add_todo_note', { todoId: todo, body: 'x' })).toMatch(/not found/i);
  });

  it('never sees an ignored todo, even as a blocker', async () => {
    const b = await board();
    const secret = await addTodo(b, { title: 'Secret', aiIgnored: true });
    const visible = await addTodo(b, { title: 'Visible' });
    await db.insert(dbSchema.todoDependencies).values({ userId: b.userId, todoId: visible, dependsOnTodoId: secret });
    await db.insert(dbSchema.todoNotes).values({ userId: b.userId, todoId: secret, body: 'private' });
    const client = await connect(await serve(), b.key);

    const { todos } = await call(client, 'todos', { projectId: b.projectId });
    expect(todos.map((todo: { id: string }) => todo.id)).toEqual([visible]);
    expect(todos[0].isBlocked).toBe(true);
    expect((await call(client, 'request', { id: secret })).todo).toBeNull();
    expect((await call(client, 'request', { id: visible })).todo.blockedBy).toEqual([]);
    expect(await callError(client, 'add_todo_note', { todoId: secret, body: 'x' })).toMatch(/not found/i);
    expect(await callError(client, 'cancel_request', { id: secret })).toMatch(/not found/i);

    const notes = await createClient(db, b.userId, { ai: true, actor: keyActor(b) }).expectOk(
      '{ todoNotes { id } todoDependencies { id } }',
    );
    expect(notes).toEqual({ todoNotes: [], todoDependencies: [] });
  });

  it('sees nothing of another user', async () => {
    const b = await board();
    const other = await board('b@example.com');
    const theirs = await addTodo(other);
    const client = await connect(await serve(), b.key);
    expect((await call(client, 'projects')).projects.map((p: { id: string }) => p.id)).toEqual([b.projectId]);
    expect((await call(client, 'request', { id: theirs })).todo).toBeNull();
    expect(await callError(client, 'submit_request', { projectId: other.projectId, title: 'x' })).toMatch(/not found/i);
  });
});

describe('switching AI off', () => {
  it('closes the door when the account switches it off', async () => {
    const b = await board();
    const client = await connect(await serve(), b.key);
    await db.update(dbSchema.users).set({ aiEnabled: false }).where(eq(dbSchema.users.id, b.userId));
    expect(await callError(client, 'projects')).toMatch(/authenticat/i);
    expect(await callError(client, 'submit_request', { projectId: b.projectId, title: 'x' })).toMatch(/authenticat/i);
  });

  it('is a 404 when the instance has AI off', async () => {
    const url = await serve(false);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(404);
  });
});
