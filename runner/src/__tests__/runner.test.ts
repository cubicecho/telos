import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import express from 'express';
import { graphql } from 'graphql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Board, createBoard, setLane } from '../../../server/src/__tests__/board.ts';
import { authFor, createTestDb, type TestDb } from '../../../server/src/__tests__/helpers.ts';
// The runner never imports the server or the database; its test does, to stand
// a real telos up for it to talk to.
import { toHeaders } from '../../../server/src/auth.ts';
import { createSchema } from '../../../server/src/build-schema.ts';
import { mountMcp } from '../../../server/src/mcp.ts';
import { createContextFactory } from '../../../server/src/request-context.ts';
import { startRunner } from '../embed.ts';
import { type LoopOptions, tick } from '../loop.ts';
import { takeTests } from '../probes.ts';
import { createTelos } from '../telos.ts';

// The runner end to end: a real telos over HTTP (GraphQL for the runner, /mcp
// for the agent), and a scripted OpenAI-compatible endpoint standing in for the
// model. What is pinned is the whole path a todo takes through a station.

const RUNNER_KEY = 'runner-secret';

/** One scripted reply: words, or a tool call. */
type Reply = { content: string } | { tool: string; args: Record<string, unknown> } | { fail: number };

let db: TestDb;
let board: Board;
const servers: Server[] = [];
const closers: Array<() => Promise<void>> = [];
let telosUrl: string;
let llm: { url: string; script: (messages: Array<{ role: string; content: unknown }>) => Reply | Promise<Reply> };

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  telosUrl = await serveTelos();
  llm = { url: await serveLlm(), script: () => ({ content: 'Done.' }) };
  await db.update(dbSchema.agents).set({ baseUrl: llm.url }).where(eq(dbSchema.agents.id, board.agentId));
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Listens on an ephemeral port.
 *
 * @param handler The request handler.
 * @returns The origin.
 */
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Telos with AI on: /graphql and /mcp over the test database.
 *
 * @returns Its origin.
 */
async function serveTelos(): Promise<string> {
  const app = express();
  const { schema } = createSchema(db, { ai: true });
  const contextFor = createContextFactory(db, authFor(db), { ai: true, runnerKey: RUNNER_KEY });
  app.post('/graphql', express.json(), async (req, res) => {
    const result = await graphql({
      schema,
      source: req.body.query,
      variableValues: req.body.variables,
      contextValue: await contextFor(toHeaders(req.headers)),
    });
    res.json(result);
  });
  const mcp = mountMcp(app, { ai: true, db, schema, contextFor, version: '0' });
  if (mcp) closers.push(() => mcp.close());
  return listen(app);
}

/**
 * A chat-completions endpoint that streams whatever `llm.script` says.
 *
 * @returns Its base URL.
 */
async function serveLlm(): Promise<string> {
  let calls = 0;
  const origin = await listen((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const reply = await llm.script(JSON.parse(body).messages);
      if ('fail' in reply) {
        res.writeHead(reply.fail, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'The model is on fire.' } }));
        return;
      }
      calls++;
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: `c${calls}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'tiny',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ('tool' in reply) {
        res.write(
          chunk(
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${calls}`,
                  type: 'function',
                  function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
                },
              ],
            },
            null,
          ),
        );
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: reply.content }, null));
        res.write(chunk({}, 'stop'));
      }
      res.write(
        `data: ${JSON.stringify({
          id: `c${calls}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'tiny',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  return `${origin}/v1`;
}

/**
 * An agent's own MCP server: a file tool to write with, and a memory tool its
 * hook calls before every turn. Stateless, a server per request.
 *
 * @param recalled What the memory tool answers.
 * @returns Its URL, and the files written through it.
 */
async function serveTools(recalled: string): Promise<{ url: string; written: Map<string, string> }> {
  const written = new Map<string, string>();
  const app = express();
  app.post('/mcp', express.json(), async (req, res) => {
    const server = new McpServer({ name: 'desk', version: '0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'write_file',
          description: 'Writes a file.',
          inputSchema: {
            type: 'object' as const,
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
        { name: 'recall', description: 'What you remember.', inputSchema: { type: 'object' as const, properties: {} } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'write_file') {
        const args = request.params.arguments as { path: string; content: string };
        written.set(args.path, args.content);
        return { content: [{ type: 'text', text: 'Written.' }] };
      }
      return { content: [{ type: 'text', text: recalled }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return { url: `${await listen(app)}/mcp`, written };
}

/**
 * The runner's loop options against the test telos.
 *
 * @param overrides Anything to change.
 * @returns The options.
 */
function loopOptions(overrides: Partial<LoopOptions> = {}): LoopOptions {
  return {
    telos: createTelos({ telosUrl, runnerKey: RUNNER_KEY }),
    telosUrl,
    allowStdio: false,
    concurrency: 2,
    pollMs: 10,
    heartbeatMs: 50,
    log: () => {},
    ...overrides,
  };
}

/**
 * One pass of the loop, waited out to the end of every run it started.
 *
 * @param options The loop's options.
 * @returns How many runs it started.
 */
async function cycle(options = loopOptions()): Promise<number> {
  const running = new Map<string, Promise<unknown>>();
  const started = await tick(options, running);
  await Promise.all(running.values());
  return started;
}

async function todoRow(id: string) {
  const [row] = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, id));
  return row;
}

async function runsOf(todoId: string) {
  return db.select().from(dbSchema.runs).where(eq(dbSchema.runs.todoId, todoId));
}

describe('the runner', () => {
  it('works a todo through its station, using telos through the run token', async () => {
    const todoId = await board.addTodo('Write it');
    const seen: string[] = [];
    let step = 0;
    llm.script = (messages) => {
      seen.push(...messages.map((message) => String(message.content ?? '')));
      step++;
      return step === 1
        ? { tool: 'telos__add_todo_note', args: { todoId, body: 'Halfway there.' } }
        : { content: 'Wrote it.' };
    };

    expect(await cycle()).toBe(1);

    expect(seen[0]).toContain('Project: P');
    expect(seen[0]).toContain('Do the work.');
    expect(seen[1]).toContain('Todo: Write it');
    const todo = await todoRow(todoId);
    expect(todo.laneId).toBe(board.lanes[2].id);
    expect(todo.completedAt).not.toBeNull();
    const [run] = await runsOf(todoId);
    expect(run).toMatchObject({ status: 'ok', output: 'Wrote it.', toolCalls: 1, totalTokens: 30 });
    const thread = await db.select().from(dbSchema.todoNotes).where(eq(dbSchema.todoNotes.todoId, todoId));
    expect(
      thread.map((note: typeof dbSchema.todoNotes.$inferSelect) => [note.kind, note.body, note.actorKind, note.runId]),
    ).toEqual([
      ['note', 'Halfway there.', 'agent', run.id],
      ['report', 'Wrote it.', 'agent', run.id],
    ]);
  });

  it('runs the agent’s hooks, keeps what it made, and shows its work as it goes', async () => {
    const desk = await serveTools('The owner likes their plans short.');
    await db
      .update(dbSchema.agents)
      .set({
        mcpServers: [
          {
            id: 'desk',
            name: 'Desk',
            url: desk.url,
            hiddenTools: ['recall'],
            hooks: [{ id: 'memory', on: 'beforeTurn', tool: 'recall', inject: true }],
          },
        ],
      })
      .where(eq(dbSchema.agents.id, board.agentId));
    const todoId = await board.addTodo('Plan it');
    const asked: string[] = [];
    let step = 0;
    llm.script = async (messages) => {
      asked.push(messages.map((message) => String(message.content ?? '')).join('\n'));
      step++;
      if (step === 1) return { tool: 'desk__write_file', args: { path: '/work/plan.md', content: '# Plan' } };
      if (step === 2) {
        // Slow enough for a heartbeat to carry the write to telos mid-run.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const [live] = await runsOf(todoId);
        expect(live.status).toBe('running');
        expect(live.events.map((event: dbSchema.RunEvent) => event.kind)).toContain('tool_call');
        return {
          tool: 'record_artifact',
          args: { location: '/work/plan.md', title: 'The plan', description: 'What happens first.' },
        };
      }
      return { content: 'Planned.' };
    };

    await cycle();

    expect(desk.written.get('/work/plan.md')).toBe('# Plan');
    expect(asked[0]).toContain('The owner likes their plans short.');
    const [run] = await runsOf(todoId);
    expect(run.status).toBe('ok');
    const kinds = run.events.map((event: dbSchema.RunEvent) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(['hook', 'tool_call', 'tool_result']));
    expect(run.events.find((event: dbSchema.RunEvent) => event.kind === 'hook')?.text).toContain('likes their plans');
    // What the model said is in the log as it said it, one block, and what it was told is kept.
    expect(
      run.events.filter((event: dbSchema.RunEvent) => event.kind === 'output').map((e: dbSchema.RunEvent) => e.text),
    ).toEqual(['Planned.']);
    expect(kinds).toContain('turn');
    expect(run.userPrompt).toContain('Plan it');
    expect(run.systemPrompt).toBeTruthy();
    expect(run.model).toBeTruthy();
    const made = await db.select().from(dbSchema.artifacts).where(eq(dbSchema.artifacts.todoId, todoId));
    expect(made).toEqual([
      expect.objectContaining({
        location: '/work/plan.md',
        source: 'declared',
        action: 'created',
        serverSlug: 'desk',
        tool: 'write_file',
        title: 'The plan',
        mediaType: 'text/markdown',
        sizeBytes: 6,
        runId: run.id,
      }),
    ]);
  });

  it('turns an expansion’s JSON into child todos', async () => {
    await setLane(board.person, board.lanes[0].id, { contract: 'expand', onSuccessLaneId: board.lanes[1].id });
    const parentId = await board.addTodo('Build the thing');
    llm.script = () => ({
      content: `Here you go:\n${JSON.stringify([
        { title: 'Design it', body: 'Sketch first.', acceptance: 'A sketch.' },
        { title: 'Make it', dependsOn: ['Design it'] },
      ])}`,
    });

    await cycle();

    const children = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.parentId, parentId));
    expect(children.map((child: typeof dbSchema.todos.$inferSelect) => [child.title, child.notes])).toEqual([
      ['Design it', 'Sketch first.'],
      ['Make it', null],
    ]);
  });

  it('reports a model that fails as a failed run, and leaves the todo', async () => {
    const todoId = await board.addTodo('Write it');
    llm.script = () => ({ fail: 400 });

    await cycle();

    const [run] = await runsOf(todoId);
    expect(run.status).toBe('error');
    expect(run.error).toBeTruthy();
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[0].id);
  });

  it('stops when telos says stop, and the stopped run writes nothing', async () => {
    const todoId = await board.addTodo('Write it');
    let release: () => void = () => {};
    llm.script = async () => {
      // Hold the model's answer until the person has cancelled.
      const [run] = await runsOf(todoId);
      await board.person.expectOk(`mutation ($id: ID!) { cancelRun(id: $id) { id } }`, { id: run.id });
      await new Promise<void>((resolve) => {
        release = resolve;
        setTimeout(resolve, 2000);
      });
      return { content: 'Wrote it anyway.' };
    };

    const started = Date.now();
    await cycle();
    release();

    expect(Date.now() - started).toBeLessThan(2000);
    const [run] = await runsOf(todoId);
    expect(run.status).toBe('stopped');
    expect((await todoRow(todoId)).laneId).toBe(board.lanes[0].id);
    const thread = await db.select().from(dbSchema.todoNotes).where(eq(dbSchema.todoNotes.todoId, todoId));
    expect(thread).toEqual([]);
  });

  it('keeps to its concurrency', async () => {
    await setLane(board.person, board.lanes[0].id, { wipLimit: 5 });
    for (const title of ['One', 'Two', 'Three']) await board.addTodo(title);
    expect(await cycle(loopOptions({ concurrency: 2 }))).toBe(2);
    expect(await cycle(loopOptions({ concurrency: 2 }))).toBe(1);
  });

  it('is refused by telos without the right key', async () => {
    await board.addTodo('Write it');
    await expect(cycle(loopOptions({ telos: createTelos({ telosUrl, runnerKey: 'wrong' }) }))).rejects.toThrow();
  });
});

describe('testing an MCP server', () => {
  const ASK = `mutation ($server: String!) { testMcpServer(server: $server) { id } }`;
  const READ = `query ($id: ID!) { mcpProbe(id: $id) { status ok tools { name } error } }`;

  async function testOf(server: Record<string, unknown>, allowStdio = false) {
    const { id } = (await board.person.expectOk(ASK, { server: JSON.stringify(server) })).testMcpServer;
    await Promise.all(await takeTests(createTelos({ telosUrl, runnerKey: RUNNER_KEY }), allowStdio, () => {}));
    return (await board.person.expectOk(READ, { id })).mcpProbe;
  }

  it('lists what a server offers', async () => {
    const tools = await serveTools('');
    expect(await testOf({ id: 'desk', url: tools.url })).toEqual({
      status: 'done',
      ok: true,
      tools: [{ name: 'write_file' }, { name: 'recall' }],
      error: null,
    });
  });

  it('says why a server could not be reached', async () => {
    const probe = await testOf({ id: 'gone', url: 'http://127.0.0.1:9/mcp' });
    expect(probe).toMatchObject({ status: 'done', ok: false, tools: [] });
    expect(probe.error).toBeTruthy();
  });

  it('will not run a command without RUNNER_ALLOW_STDIO', async () => {
    const probe = await testOf({ id: 'local', command: 'echo' });
    expect(probe).toMatchObject({ ok: false, error: expect.stringMatching(/RUNNER_ALLOW_STDIO/) });
  });
});

describe('the runner inside the server', () => {
  it('works the queue on its own from the key it is handed, and stops when asked', async () => {
    const todoId = await board.addTodo('Write it');
    const runner = startRunner({ telosUrl, runnerKey: RUNNER_KEY, env: {} });
    try {
      await expect.poll(async () => (await runsOf(todoId))[0]?.status, { timeout: 5000 }).toBe('ok');
    } finally {
      await runner.stop();
    }
  });
});
