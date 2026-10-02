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
import { DOOR_TOOLS } from '../door.ts';
import { mountMcp } from '../mcp.ts';
import { createContextFactory } from '../request-context.ts';
import { AI_MUTATIONS } from '../resolvers/actor-lock.ts';
import { CLAIM, createBoard, FINISH, runnerClient, SET_AUTO_RUN } from './board.ts';
import { authFor, createClient, createTestDb, createUser, type TestDb } from './helpers.ts';

// The AI door end to end: a real HTTP server, the MCP SDK's own client, and an
// API key in the header — the path Claude Code takes. What a key may see and
// write is pinned here too, through the same schema the door serves.

const READS = [
  'projects',
  'lanes',
  'todos',
  'request',
  'todo_notes',
  'todo_history',
  'blockers',
  'runs',
  'run_events',
  'artifacts',
  'agents',
  'spend',
  'board_templates',
  'drafts',
  'draft',
];

const WRITES = [
  'create_project',
  'update_project',
  'submit_request',
  'cancel_request',
  'create_todo',
  'update_todo',
  'move_todo',
  'retry_todo',
  'run_todo',
  'stop_run',
  'set_todo_dependencies',
  'archive_todo',
  'restore_todo',
  'delete_todo',
  'add_todo_note',
  'edit_todo_note',
  'delete_todo_note',
  'record_artifact',
  'start_draft',
  'say_to_draft',
  'stop_draft',
  'make_todo_from_draft',
  'discard_draft',
  'save_board_template',
  'apply_board_template',
];

const TOOLS = [...READS, ...WRITES];

const SET_TOOLS = `mutation ($id: ID!, $off: [String!]!) { setApiKeyTools(id: $id, off: $off) { id toolsOff } }`;

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

function keyActor(b: Board, off: string[] = []): Actor {
  return { kind: 'apiKey', userId: b.userId, keyId: b.keyId, toolsOff: new Set(off) };
}

/** Switches tools off for a key, as its owner does in Settings. */
async function switchOff(b: Board, off: string[]): Promise<void> {
  await createClient(db, b.userId, { ai: true }).expectOk(SET_TOOLS, { id: b.keyId, off });
}

/** The todo's row. */
// biome-ignore lint/suspicious/noExplicitAny: a row
async function rowOf(id: string): Promise<any> {
  const [row] = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, id));
  return row;
}

describe('the tool surface', () => {
  it('is the hand-written operations and nothing else', async () => {
    const b = await board();
    const client = await connect(await serve(), b.key);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOLS].sort());
    expect(DOOR_TOOLS.map((tool) => tool.name)).toEqual(TOOLS);
  });

  it('writes with exactly the mutations the lock opens to AI', () => {
    const fields = new Set(DOOR_TOOLS.filter((tool) => tool.writes).flatMap((tool) => tool.fields));
    expect([...fields].sort()).toEqual([...AI_MUTATIONS].sort());
  });

  it('describes every tool', () => {
    for (const tool of DOOR_TOOLS) expect(tool.description, tool.name).not.toBe('');
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
    for (const read of READS) expect(byName.get(read)?.annotations?.readOnlyHint, read).toBe(true);
    for (const write of WRITES) expect(byName.get(write)?.annotations?.readOnlyHint, write).toBe(false);
  });
});

describe('the prompts', () => {
  it('are offered beside the tools, each described, and said so on the way in', async () => {
    const b = await board();
    const client = await connect(await serve(), b.key);
    expect(client.getServerCapabilities()?.prompts).toBeTruthy();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      'start_project',
      'submit_work',
      'telos_guide',
      'triage_board',
    ]);
    for (const prompt of prompts) {
      expect(prompt.description, prompt.name).toBeTruthy();
      for (const argument of prompt.arguments ?? []) {
        expect(argument.description, `${prompt.name}.${argument.name}`).toBeTruthy();
      }
    }
    const start = prompts.find((prompt) => prompt.name === 'start_project');
    expect(start?.arguments?.map((argument) => [argument.name, argument.required])).toEqual([
      ['goal', true],
      ['name', false],
    ]);
  });

  it('render, arguments and all, naming only tools that exist', async () => {
    const b = await board();
    const client = await connect(await serve(), b.key);
    const text = async (name: string, args?: Record<string, string>) =>
      (await client.getPrompt({ name, ...(args ? { arguments: args } : {}) })).messages
        .map((message) => (message.content.type === 'text' ? message.content.text : ''))
        .join('\n');

    expect(await text('telos_guide')).toMatch(/Call `projects`/);
    const submit = await text('submit_work', { project: 'Kitchen', request: 'Fix the tap' });
    expect(submit).toContain('**Board:** Kitchen');
    expect(submit).toContain('Fix the tap');

    // Every tool a prompt names in backticks, in snake case, is one the door serves.
    for (const name of ['telos_guide', 'start_project', 'submit_work', 'triage_board']) {
      const body = await text(name, { goal: 'g', project: 'p', request: 'r' });
      for (const [, tool] of body.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)) {
        if (tool.includes('_') || TOOLS.includes(tool)) expect(TOOLS, `${name} names ${tool}`).toContain(tool);
      }
    }
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

  it('records what the client made for it, as the client’s word, signed with the key', async () => {
    const b = await board();
    const todo = await addTodo(b);
    const client = await connect(await serve(), b.key);
    const { recordArtifact } = await call(client, 'record_artifact', {
      todoId: todo,
      location: 'https://example.com/changelog',
      label: 'The changelog',
      mediaType: 'text/html',
    });
    expect(recordArtifact).toMatchObject({
      location: 'https://example.com/changelog',
      title: 'The changelog',
      source: 'client',
      action: 'created',
    });
    const [row] = await db.select().from(dbSchema.artifacts);
    expect(row).toMatchObject({ todoId: todo, runId: null, actorKind: 'apiKey', actorKeyId: b.keyId });

    const other = await board('b@example.com');
    const stranger = await addTodo(other);
    expect(await callError(client, 'record_artifact', { todoId: stranger, location: '/tmp/x', label: 'x' })).toMatch(
      /not found/i,
    );
  });
});

describe('working the board', () => {
  it('makes a project open to AI, and renames it, and nothing more', async () => {
    const b = await board();
    const client = await connect(await serve(), b.key);
    const { createProject } = await call(client, 'create_project', {
      name: 'Garden',
      description: 'Beds and paths.',
      context: 'The back garden.',
    });
    expect(createProject.lanes.length).toBeGreaterThan(0);
    const [made] = await db.select().from(dbSchema.projects).where(eq(dbSchema.projects.id, createProject.id));
    expect(made).toMatchObject({ userId: b.userId, aiEnabled: true, autoRun: false });

    const { updateProject } = await call(client, 'update_project', { id: createProject.id, name: 'Yard' });
    expect(updateProject).toMatchObject({ name: 'Yard', description: 'Beds and paths.' });

    const key = createClient(db, b.userId, { ai: true, actor: keyActor(b) });
    for (const set of [{ aiEnabled: false }, { autoRun: true }, { archivedAt: new Date().toISOString() }]) {
      await key.expectError(
        'mutation ($id: UUID!, $set: UpdateProjectInput!) { updateProject(set: $set, where: { id: { eq: $id } }) { id } }',
        { id: createProject.id, set },
      );
    }
    const [after] = await db.select().from(dbSchema.projects).where(eq(dbSchema.projects.id, createProject.id));
    expect(after).toMatchObject({ aiEnabled: true, autoRun: false, archivedAt: null });
  });

  it('adds a todo to a lane, edits, moves, completes, archives, restores and deletes it', async () => {
    const b = await board();
    const client = await connect(await serve(), b.key);
    const { lanes } = await call(client, 'lanes', { projectId: b.projectId });
    expect(lanes.map((lane: { name: string }) => lane.name)).toEqual(['To do', 'Doing', 'Done']);

    const { createTodo } = await call(client, 'create_todo', {
      projectId: b.projectId,
      laneId: b.lanes.doing,
      title: 'Paint the fence',
    });
    expect(createTodo.laneId).toBe(b.lanes.doing);
    const id = createTodo.id;

    const { updateTodo } = await call(client, 'update_todo', { id, brief: 'Green.', acceptance: 'No bare wood.' });
    expect(updateTodo).toMatchObject({ title: 'Paint the fence', brief: 'Green.', acceptance: 'No bare wood.' });

    const { moveTodo } = await call(client, 'move_todo', { id, laneId: b.lanes.done, reason: 'Painted.' });
    expect(moveTodo.completedAt).not.toBeNull();

    const { todoEvents } = await call(client, 'todo_history', { todoId: id });
    expect(todoEvents.map((event: { kind: string }) => event.kind)).toEqual(['create', 'edit', 'complete']);
    expect(new Set(todoEvents.map((event: { actorKind: string }) => event.actorKind))).toEqual(new Set(['apiKey']));

    await call(client, 'archive_todo', { id });
    expect((await rowOf(id)).archivedAt).not.toBeNull();
    await call(client, 'restore_todo', { id });
    expect((await rowOf(id)).archivedAt).toBeNull();
    await call(client, 'delete_todo', { id });
    expect(await rowOf(id)).toBeUndefined();
  });

  it('sets what a todo waits on, and reads it back as blockers', async () => {
    const b = await board();
    const first = await addTodo(b, { title: 'First' });
    const second = await addTodo(b, { title: 'Second' });
    const client = await connect(await serve(), b.key);
    const { setTodoDependencies } = await call(client, 'set_todo_dependencies', { id: second, dependsOn: [first] });
    expect(setTodoDependencies).toMatchObject({ id: second, isBlocked: true, blockedBy: [{ id: first }] });
    const { todo } = await call(client, 'blockers', { id: first });
    expect(todo.dependents.map((dependent: { id: string }) => dependent.id)).toEqual([second]);
    const waiting = await call(client, 'blockers', { id: second });
    expect(waiting.todo.dependencies.map((dependency: { id: string }) => dependency.id)).toEqual([first]);
    expect(await callError(client, 'move_todo', { id: second, laneId: b.lanes.done })).toBeTruthy();
    expect((await rowOf(second)).completedAt).toBeNull();
  });

  it('keeps an edge to a todo it cannot see when it sets the list', async () => {
    const b = await board();
    const secret = await addTodo(b, { title: 'Secret', aiIgnored: true });
    const shown = await addTodo(b, { title: 'Shown' });
    const todo = await addTodo(b, { title: 'Waiting' });
    await db.insert(dbSchema.todoDependencies).values({ userId: b.userId, todoId: todo, dependsOnTodoId: secret });
    const client = await connect(await serve(), b.key);
    await call(client, 'set_todo_dependencies', { id: todo, dependsOn: [shown] });
    const edges = await db.select().from(dbSchema.todoDependencies).where(eq(dbSchema.todoDependencies.todoId, todo));
    expect(edges.map((edge: { dependsOnTodoId: string }) => edge.dependsOnTodoId).sort()).toEqual(
      [secret, shown].sort(),
    );
    expect(await callError(client, 'set_todo_dependencies', { id: todo, dependsOn: [secret] })).toMatch(/not found/i);
  });

  it('reads and writes the thread', async () => {
    const b = await board();
    const todo = await addTodo(b);
    const client = await connect(await serve(), b.key);
    const { addTodoNote } = await call(client, 'add_todo_note', { todoId: todo, body: 'First.' });
    await call(client, 'edit_todo_note', { id: addTodoNote.id, body: 'First, edited.' });
    expect((await call(client, 'todo_notes', { todoId: todo })).todoNotes).toEqual([
      expect.objectContaining({ body: 'First, edited.', actorKind: 'apiKey' }),
    ]);
    await call(client, 'delete_todo_note', { id: addTodoNote.id });
    expect((await call(client, 'todo_notes', { todoId: todo })).todoNotes).toEqual([]);
  });
});

describe('the board’s agents and runs', () => {
  /** A board with a station, an agent and a key, which runs only what it is asked to. */
  async function station() {
    const b = await createBoard(db, 'a@example.com');
    const { id: keyId, key } = await mintApiKey(authFor(db), { userId: b.userId, name: 'claude' });
    await b.person.expectOk(SET_AUTO_RUN, { id: b.projectId, enabled: false });
    return { ...b, keyId, key };
  }

  it('lists the agents and their stations, and nothing secret about them', async () => {
    const b = await station();
    const client = await connect(await serve(), b.key);
    const result = await call(client, 'agents');
    expect(result.agentRoster).toEqual([
      expect.objectContaining({
        id: b.agentId,
        name: 'Worker',
        model: 'tiny',
        hasApiKey: true,
        stations: [expect.objectContaining({ laneId: b.lanes[0].id })],
      }),
    ]);
    const text = JSON.stringify(result);
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('llm.test');
    expect(text).not.toContain('Do the work.');
  });

  it('asks for a run, reads it and its log, stops it, and sends the todo round again', async () => {
    const b = await station();
    const todo = await b.addTodo('Work me');
    const client = await connect(await serve(), b.key);
    expect((await call(client, 'run_todo', { id: todo })).runTodo.runRequestedAt).not.toBeNull();

    const { runId } = (await runnerClient(db).expectOk(CLAIM, { todoId: todo, laneId: b.lanes[0].id })).claimRun;
    const { runs } = await call(client, 'runs', { todoId: todo });
    expect(runs).toEqual([expect.objectContaining({ id: runId, status: 'running' })]);
    expect((await call(client, 'run_events', { id: runId })).run).toMatchObject({ id: runId });

    const { cancelRun } = await call(client, 'stop_run', { id: runId });
    expect(cancelRun.cancelRequestedAt).not.toBeNull();
    await runnerClient(db).expectOk(FINISH, { id: runId, result: { status: 'error', error: 'Stopped.' } });

    // Stopping it set the todo aside from AI; its owner lets AI back at it.
    await db.update(dbSchema.todos).set({ aiIgnored: false }).where(eq(dbSchema.todos.id, todo));
    await call(client, 'retry_todo', { id: todo, reason: 'Try again.' });
    const events = await db.select().from(dbSchema.todoEvents).where(eq(dbSchema.todoEvents.todoId, todo));
    expect(events.at(-1)).toMatchObject({ kind: 'retry', actorKind: 'apiKey', actorKeyId: b.keyId });
  });

  it('says what the account has spent', async () => {
    const b = await station();
    const client = await connect(await serve(), b.key);
    const { aiSpend } = await call(client, 'spend', { since: new Date(0).toISOString() });
    expect(aiSpend.total).toMatchObject({ runs: 0, totalTokens: 0 });
  });

  it('talks a draft over and makes a todo of it, or discards it', async () => {
    const b = await station();
    const client = await connect(await serve(), b.key);
    const { startDraft } = await call(client, 'start_draft', {
      projectId: b.projectId,
      agentId: b.agentId,
      message: 'Faster export?',
    });
    expect(startDraft.waitingSince).not.toBeNull();
    expect((await call(client, 'drafts', { projectId: b.projectId })).drafts).toEqual([
      expect.objectContaining({ id: startDraft.id }),
    ]);
    expect((await call(client, 'stop_draft', { id: startDraft.id })).stopDraft.waitingSince).toBeNull();
    await call(client, 'say_to_draft', { id: startDraft.id, message: 'The CSV one.' });
    await call(client, 'stop_draft', { id: startDraft.id });
    const { draft } = await call(client, 'draft', { id: startDraft.id });
    expect(draft.messages.length).toBeGreaterThan(1);

    const { makeTodoFromDraft } = await call(client, 'make_todo_from_draft', {
      id: startDraft.id,
      title: 'Faster CSV export',
      brief: 'Stream it.',
    });
    expect((await rowOf(makeTodoFromDraft.id)).title).toBe('Faster CSV export');

    const { startDraft: second } = await call(client, 'start_draft', {
      projectId: b.projectId,
      agentId: b.agentId,
      message: 'Never mind',
    });
    await call(client, 'stop_draft', { id: second.id });
    expect(await call(client, 'discard_draft', { id: second.id })).toEqual({ discardDraft: true });
  });

  it('saves a board as a template and gives a new board one', async () => {
    const b = await station();
    const client = await connect(await serve(), b.key);
    const { saveBoardTemplate } = await call(client, 'save_board_template', {
      projectId: b.projectId,
      name: 'Pipeline',
    });
    expect((await call(client, 'board_templates')).boardTemplates).toEqual([
      expect.objectContaining({ id: saveBoardTemplate.id, name: 'Pipeline' }),
    ]);
    const { createProject } = await call(client, 'create_project', { name: 'Fresh' });
    const { applyBoardTemplate } = await call(client, 'apply_board_template', {
      projectId: createProject.id,
      templateId: saveBoardTemplate.id,
    });
    expect(applyBoardTemplate.lanes.map((lane: { name: string }) => lane.name)).toEqual(
      b.lanes.map((lane) => lane.name),
    );
  });

  it('lets a run do what a key does, without switches', async () => {
    const b = await station();
    const todo = await b.addTodo('Worked');
    await b.person.expectOk('mutation ($id: ID!) { runTodo(id: $id) { id } }', { id: todo });
    const { runId } = (await runnerClient(db).expectOk(CLAIM, { todoId: todo, laneId: b.lanes[0].id })).claimRun;
    const agent = createClient(db, b.userId, { ai: true, actor: { kind: 'agent', userId: b.userId, runId } });
    await agent.expectOk('mutation ($id: ID!, $lane: ID!) { moveTodo(id: $id, laneId: $lane) { id } }', {
      id: await b.addTodo('Moved by a run'),
      lane: b.lanes[1].id,
    });
    await agent.expectOk('mutation ($p: UUID!) { createTodo(values: { projectId: $p, title: "Follow-up" }) { id } }', {
      p: b.projectId,
    });
  });
});

describe('a key’s switches', () => {
  it('start all on, and are set by the key’s owner', async () => {
    const b = await board();
    const person = createClient(db, b.userId, { ai: true });
    const { mcpTools } = await person.expectOk('{ mcpTools { name writes description } }');
    expect(mcpTools.map((tool: { name: string }) => tool.name)).toEqual(TOOLS);
    expect((await person.expectOk('{ apiKeys { id toolsOff } }')).apiKeys).toEqual([{ id: b.keyId, toolsOff: [] }]);

    const set = await person.expectOk(SET_TOOLS, { id: b.keyId, off: ['delete_todo', 'projects', 'delete_todo'] });
    expect(set.setApiKeyTools.toolsOff).toEqual(['projects', 'delete_todo']);
    expect((await person.expectOk('{ apiKeys { toolsOff } }')).apiKeys).toEqual([
      { toolsOff: ['projects', 'delete_todo'] },
    ]);
    await person.expectOk(SET_TOOLS, { id: b.keyId, off: [] });
    expect((await person.expectOk('{ apiKeys { toolsOff } }')).apiKeys).toEqual([{ toolsOff: [] }]);
  });

  it('refuse a tool the door does not have, and a key that is not yours', async () => {
    const b = await board();
    const other = await board('b@example.com');
    const person = createClient(db, b.userId, { ai: true });
    const unknown = await person.expectError(SET_TOOLS, { id: b.keyId, off: ['launch_rockets'] });
    expect(unknown.code).toBe('BAD_USER_INPUT');
    expect((await person.expectError(SET_TOOLS, { id: other.keyId, off: [] })).code).toBe('NOT_FOUND');
    expect((await person.expectError(SET_TOOLS, { id: 'nope', off: [] })).code).toBe('NOT_FOUND');
  });

  it('cannot be changed by a key', async () => {
    const b = await board();
    const key = createClient(db, b.userId, { ai: true, actor: keyActor(b) });
    await key.expectError(SET_TOOLS, { id: b.keyId, off: [] });
    expect(await db.select().from(dbSchema.apiKeyTools)).toEqual([]);
  });

  it.each(TOOLS)('take %s out of the listing, and refuse it, when it is off', async (tool) => {
    const b = await board();
    await switchOff(b, [tool]);
    const client = await connect(await serve(), b.key);
    const names = (await client.listTools()).tools.map((listed) => listed.name);
    expect(names).not.toContain(tool);
    expect(names).toHaveLength(TOOLS.length - 1);
    expect(await callError(client, tool, {})).toBe(`MCP error -32602: Tool ${tool} not found`);
  });

  it('are held by the lock too, whichever door a key comes in by', async () => {
    const b = await board();
    const todo = await addTodo(b);
    const key = createClient(db, b.userId, { ai: true, actor: keyActor(b, ['create_todo', 'projects']) });
    const create = await key.expectError(
      'mutation ($p: UUID!) { createTodo(values: { projectId: $p, title: "x" }) { id } }',
      { p: b.projectId },
    );
    expect(create).toEqual({ message: 'createTodo is switched off for this key.', code: 'FORBIDDEN' });
    expect((await key.expectError('{ projects { id } }')).code).toBe('FORBIDDEN');
    // Other tools still read a todo, so that field stays open.
    await key.expectOk('query ($id: UUID!) { todo(where: { id: { eq: $id } }) { id } }', { id: todo });
  });

  it('tell archiving and deleting for good apart', async () => {
    const b = await board();
    const kept = await addTodo(b);
    const gone = await addTodo(b);
    const key = createClient(db, b.userId, { ai: true, actor: keyActor(b, ['archive_todo']) });
    const archive = 'mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }';
    expect((await key.expectError(archive, { id: kept })).code).toBe('FORBIDDEN');
    await key.expectOk('mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }, hard: true) { id } }', {
      id: gone,
    });
    expect((await rowOf(kept)).archivedAt).toBeNull();
    expect(await rowOf(gone)).toBeUndefined();
  });

  it('make a key read-only by turning its writing tools off', async () => {
    const b = await board();
    await switchOff(b, WRITES);
    const client = await connect(await serve(), b.key);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([...READS].sort());
    expect((await call(client, 'projects')).projects).toHaveLength(1);
  });

  it('sit under the AI switches', async () => {
    const b = await board();
    const client = await connect(await serve(), b.key);
    await db.update(dbSchema.projects).set({ aiEnabled: false }).where(eq(dbSchema.projects.id, b.projectId));
    expect(await callError(client, 'create_todo', { projectId: b.projectId, title: 'x' })).toMatch(/not found/i);
  });
});

describe('what a key may not do', () => {
  it('reaches nothing that decides how far AI goes', async () => {
    const b = await board();
    const todo = await addTodo(b);
    const client = createClient(db, b.userId, { ai: true, actor: keyActor(b) });
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['mutation($id: ID!) { completeTodo(id: $id) { id } }', { id: todo }],
      ['mutation($p: ID!) { setProjectAiEnabled(projectId: $p, enabled: false) { id } }', { p: b.projectId }],
      ['mutation($p: ID!) { setProjectAutoRun(projectId: $p, enabled: true) { id } }', { p: b.projectId }],
      ['mutation($p: UUID!) { deleteProject(where: { id: { eq: $p } }) { id } }', { p: b.projectId }],
      ['mutation($p: UUID!) { deleteTodos(where: { projectId: { eq: $p } }) { id } }', { p: b.projectId }],
      [
        'mutation($p: UUID!) { updateTodos(set: { title: "x" }, where: { projectId: { eq: $p } }) { id } }',
        { p: b.projectId },
      ],
      [
        'mutation($id: UUID!) { updateLane(set: { name: "x" }, where: { id: { eq: $id } }) { id } }',
        { id: b.lanes.todo },
      ],
      ['mutation { createAgent(values: { name: "x", baseUrl: "http://x.test", model: "m" }) { id } }', {}],
      ['mutation { createApiKey(name: "x") { key } }', {}],
    ];
    for (const [query, variables] of attempts) {
      expect((await client.expectError(query, variables)).code, query).toBe('FORBIDDEN');
    }
    expect(await rowOf(todo)).toMatchObject({ laneId: b.lanes.todo, completedAt: null, archivedAt: null });
  });

  it('cannot read the agents table itself', async () => {
    const b = await board();
    await db.insert(dbSchema.agents).values({ userId: b.userId, name: 'Secret', baseUrl: 'http://x.test', model: 'm' });
    const key = createClient(db, b.userId, { ai: true, actor: keyActor(b) });
    expect((await key.expectOk('{ agents { id } }')).agents).toEqual([]);
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
    expect(await callError(client, 'create_todo', { projectId: b.projectId, title: 'x' })).toMatch(/not found/i);
    expect(await callError(client, 'move_todo', { id: todo, laneId: b.lanes.done })).toMatch(/not found/i);
    expect(await callError(client, 'run_todo', { id: todo })).toMatch(/not found/i);
    expect((await call(client, 'lanes', { projectId: b.projectId })).lanes).toEqual([]);
    await call(client, 'update_project', { id: b.projectId, name: 'Renamed' });
    const [project] = await db.select().from(dbSchema.projects).where(eq(dbSchema.projects.id, b.projectId));
    expect(project.name).toBe('Board');
    expect((await rowOf(todo)).laneId).toBe(b.lanes.todo);
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
    expect(await callError(client, 'move_todo', { id: secret, laneId: b.lanes.done })).toMatch(/not found/i);
    expect(await callError(client, 'retry_todo', { id: secret })).toMatch(/not found/i);
    expect((await call(client, 'todo_notes', { todoId: secret })).todoNotes).toEqual([]);
    expect((await call(client, 'update_todo', { id: secret, title: 'x' })).updateTodo).toBeNull();
    expect((await rowOf(secret)).title).toBe('Secret');

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
