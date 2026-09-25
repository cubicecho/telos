import { PGlite } from '@electric-sql/pglite';
import * as dbSchema from '@telos/db/schema';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, createUser, type TestDb } from '../../server/src/__tests__/helpers.ts';
import { fromPglite, type ImportReport, importKanban, type KanbanSource } from '../import-kanban.ts';

// The source is a hand-written kanban_server schema with only the columns the
// import reads, quoted camelCase as kanban_server's migrations write them.
const KANBAN_SCHEMA = `
  CREATE TABLE settings ("id" text PRIMARY KEY, "baseUrl" text, "apiKey" text, "model" text, "maxTokens" int,
    "contextLength" int, "temperature" real, "maxToolIterations" int, "toolDiscovery" text, "toolSelectModel" text,
    "requestTimeoutSeconds" int, "maxRetries" int);
  CREATE TABLE roles ("id" text PRIMARY KEY, "name" text, "contract" text, "prompt" text);
  CREATE TABLE agents ("id" text PRIMARY KEY, "name" text, "enabled" boolean, "baseUrl" text, "apiKey" text,
    "model" text, "systemPrompt" text, "maxTokens" int, "contextLength" int, "temperature" real,
    "maxToolIterations" int, "toolDiscovery" text, "requestTimeoutSeconds" int, "maxRetries" int,
    "createdAt" timestamptz DEFAULT now());
  CREATE TABLE mcp_servers ("id" text PRIMARY KEY, "slug" text, "label" text, "enabled" boolean, "transport" text,
    "command" text, "args" jsonb, "env" jsonb, "url" text, "headers" jsonb, "hiddenTools" jsonb, "hooks" jsonb);
  CREATE TABLE agent_servers ("id" text PRIMARY KEY, "agentId" text, "serverId" text);
  CREATE TABLE projects ("id" text PRIMARY KEY, "name" text, "description" text, "context" text, "autoRun" boolean,
    "createdAt" timestamptz DEFAULT now(), "updatedAt" timestamptz DEFAULT now());
  CREATE TABLE lanes ("id" text PRIMARY KEY, "projectId" text, "name" text, "position" int, "roleId" text,
    "prompt" text, "agentId" text, "onSuccessLaneId" text, "onFailureLaneId" text, "archiveOnSuccess" boolean,
    "wipLimit" int, "maxAttempts" int, "createdAt" timestamptz DEFAULT now());
  CREATE TABLE cards ("id" text PRIMARY KEY, "projectId" text, "parentId" text, "laneId" text, "title" text,
    "body" text, "acceptance" text, "position" int, "archivedAt" timestamptz,
    "createdAt" timestamptz DEFAULT now(), "updatedAt" timestamptz DEFAULT now());
  CREATE TABLE card_deps ("id" text PRIMARY KEY, "cardId" text, "dependsOnCardId" text);
  CREATE TABLE card_notes ("id" text PRIMARY KEY, "cardId" text, "kind" text, "author" text, "body" text,
    "createdAt" timestamptz DEFAULT now());
  CREATE TABLE card_events ("id" text PRIMARY KEY, "cardId" text, "fromLaneId" text, "toLaneId" text,
    "noteId" text, "actor" text, "createdAt" timestamptz DEFAULT now());
  CREATE TABLE runs ("id" text PRIMARY KEY);
`;

const KANBAN_DATA = `
  INSERT INTO settings VALUES ('default', 'http://llm.lan/v1', 'sk-settings', 'qwen', 0, 0, 0.7, 0, 'eager', '', 0, -1);
  INSERT INTO roles VALUES ('r-work', 'Doing', 'work', 'Do the card.'), ('r-review', 'Review', 'verdict', 'Judge it.');
  INSERT INTO agents ("id", "name", "enabled", "baseUrl", "apiKey", "model", "systemPrompt", "maxTokens",
    "contextLength", "temperature", "maxToolIterations", "toolDiscovery", "requestTimeoutSeconds", "maxRetries")
  VALUES ('a-exec', 'executor', true, '', 'sk-secret', '', 'Be terse.', 0, 0, -1, 0, 'inherit', 0, -1);
  INSERT INTO mcp_servers VALUES ('m-1', 'files', 'Files', true, 'http', '', null, null, 'http://mcp.lan/mcp',
    '{"Authorization": "Bearer xyz"}', '["forget"]', '[]');
  INSERT INTO agent_servers VALUES ('as-1', 'a-exec', 'm-1');
  INSERT INTO projects ("id", "name", "description", "context", "autoRun")
    VALUES ('p-1', 'Research', 'Look into things', 'The repo is X', true);
  INSERT INTO lanes ("id", "projectId", "name", "position", "roleId", "prompt", "agentId", "onSuccessLaneId",
    "onFailureLaneId", "archiveOnSuccess", "wipLimit", "maxAttempts") VALUES
    ('l-backlog', 'p-1', 'Backlog', 0, null, '', null, null, null, false, 1, 0),
    ('l-doing', 'p-1', 'Doing', 1, 'r-work', 'Here, use pnpm.', 'a-exec', 'l-review', null, false, 2, 0),
    ('l-review', 'p-1', 'Review', 2, 'r-review', '', 'a-exec', 'l-done', 'l-doing', false, 0, 3),
    ('l-done', 'p-1', 'Done', 3, null, '', null, null, null, false, 1, 0);
  INSERT INTO cards ("id", "projectId", "parentId", "laneId", "title", "body", "acceptance", "position",
    "archivedAt", "createdAt") VALUES
    ('c-parent', 'p-1', null, 'l-backlog', 'Parent', 'The whole job', '', 0, null, '2026-01-01T00:00:00Z'),
    ('c-child', 'p-1', 'c-parent', 'l-doing', 'Child', '', 'Tests pass', 0, null, '2026-01-02T00:00:00Z'),
    ('c-done', 'p-1', null, 'l-done', 'Shipped', '', '', 0, null, '2026-01-03T00:00:00Z'),
    ('c-archived', 'p-1', null, 'l-review', 'Put away', '', '', 1, '2026-02-01T00:00:00Z', '2026-01-04T00:00:00Z');
  INSERT INTO card_deps VALUES
    ('d-1', 'c-child', 'c-done'),
    ('d-2', 'c-done', 'c-parent');
  INSERT INTO card_notes ("id", "cardId", "kind", "author", "body") VALUES
    ('n-1', 'c-child', 'report', 'agent', 'I did the thing.'),
    ('n-2', 'c-child', 'note', 'user', 'Watch out for X.'),
    ('n-3', 'c-done', 'verdict', 'agent', 'PASS');
  INSERT INTO card_events ("id", "cardId", "fromLaneId", "toLaneId", "noteId", "actor", "createdAt") VALUES
    ('e-1', 'c-done', null, 'l-backlog', null, 'user', '2026-01-03T00:00:00Z'),
    ('e-2', 'c-done', 'l-backlog', 'l-review', null, 'user', '2026-01-05T00:00:00Z'),
    ('e-3', 'c-done', 'l-review', 'l-done', 'n-3', 'agent', '2026-01-06T00:00:00Z');
  INSERT INTO runs VALUES ('run-1'), ('run-2');
`;

async function kanbanSource(): Promise<{ source: KanbanSource; client: PGlite }> {
  const client = new PGlite('memory://');
  await client.exec(KANBAN_SCHEMA);
  await client.exec(KANBAN_DATA);
  return { source: fromPglite(client), client };
}

async function countRows(db: TestDb, userId: string): Promise<Record<string, number>> {
  const tables = {
    projects: dbSchema.projects,
    lanes: dbSchema.lanes,
    agents: dbSchema.agents,
    todos: dbSchema.todos,
    todoDependencies: dbSchema.todoDependencies,
    todoNotes: dbSchema.todoNotes,
    todoEvents: dbSchema.todoEvents,
  };
  const out: Record<string, number> = {};
  for (const [name, table] of Object.entries(tables)) {
    out[name] = (await db.select().from(table).where(eq(table.userId, userId))).length;
  }
  return out;
}

describe('importKanban', () => {
  let db: TestDb;
  let client: PGlite;
  let source: KanbanSource;
  let userId: string;
  let report: ImportReport;

  beforeAll(async () => {
    db = await createTestDb();
    userId = await createUser(db, 'me@example.com');
    ({ source, client } = await kanbanSource());
  });

  afterAll(async () => {
    await client.close();
  });

  it('refuses an unknown user', async () => {
    await expect(importKanban({ source, target: db, email: 'nobody@example.com' })).rejects.toThrow(/No telos user/);
  });

  it('writes nothing on a dry run, but reports what it would', async () => {
    const dry = await importKanban({ source, target: db, email: 'ME@example.com', dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.counts).toMatchObject({ projects: 1, lanes: 4, agents: 1, todos: 4, todoNotes: 3 });
    expect(await countRows(db, userId)).toEqual({
      projects: 0,
      lanes: 0,
      agents: 0,
      todos: 0,
      todoDependencies: 0,
      todoNotes: 0,
      todoEvents: 0,
    });
  });

  it('imports projects, lanes, agents, todos, dependencies, notes and history', async () => {
    report = await importKanban({ source, target: db, email: 'me@example.com' });
    expect(report.counts).toEqual(await countRows(db, userId));

    const [project] = await db.select().from(dbSchema.projects).where(eq(dbSchema.projects.userId, userId));
    expect(project).toMatchObject({ name: 'Research', description: 'Look into things', context: 'The repo is X' });
    // autoRun was on in kanban_server; an import never switches AI on.
    expect(project.aiEnabled).toBe(false);

    const lanes = await db
      .select()
      .from(dbSchema.lanes)
      .where(eq(dbSchema.lanes.projectId, project.id))
      .orderBy(asc(dbSchema.lanes.position));
    expect(lanes.map((lane: { name: string }) => lane.name)).toEqual(['Backlog', 'Doing', 'Review', 'Done']);
    const [backlog, doing, review, done] = lanes;
    expect(lanes.filter((lane: { isDone: boolean }) => lane.isDone)).toEqual([done]);
    expect(doing).toMatchObject({
      contract: 'work',
      prompt: 'Do the card.\n\nHere, use pnpm.',
      onSuccessLaneId: review.id,
      wipLimit: 2,
      maxAttempts: 0,
    });
    expect(review).toMatchObject({
      contract: 'verdict',
      onSuccessLaneId: done.id,
      onFailureLaneId: doing.id,
      wipLimit: 1,
    });
    expect(review.maxAttempts).toBe(3);
    expect(backlog.agentId).toBeNull();

    const [agent] = await db.select().from(dbSchema.agents).where(eq(dbSchema.agents.userId, userId));
    expect(doing.agentId).toBe(agent.id);
    expect(agent).toMatchObject({
      name: 'executor',
      baseUrl: 'http://llm.lan/v1',
      model: 'qwen',
      systemPrompt: 'Be terse.',
      temperature: 0.7,
      maxToolIterations: 20,
      toolDiscovery: false,
      apiKey: null,
    });
    expect(agent.mcpServers).toEqual([
      { id: 'files', name: 'Files', url: 'http://mcp.lan/mcp', hiddenTools: ['forget'] },
    ]);
    expect(report.notes.join('\n')).toMatch(/API keys are never copied/);
    expect(report.notes.join('\n')).toMatch(/header Authorization not copied/);

    const todos = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.userId, userId));
    const byTitle = Object.fromEntries(todos.map((todo: { title: string }) => [todo.title, todo]));
    expect(byTitle.Parent).toMatchObject({ laneId: backlog.id, completedAt: null, notes: 'The whole job' });
    expect(byTitle.Child).toMatchObject({ laneId: doing.id, parentId: byTitle.Parent.id, acceptance: 'Tests pass' });
    // In the done lane is completed, and completed when it arrived there.
    expect(byTitle.Shipped.laneId).toBe(done.id);
    expect(byTitle.Shipped.completedAt).toEqual(new Date('2026-01-06T00:00:00Z'));
    // Archived is completed, and drawn in the done lane.
    expect(byTitle['Put away'].laneId).toBe(done.id);
    expect(byTitle['Put away'].completedAt).toEqual(new Date('2026-02-01T00:00:00Z'));
    // Positions are one project-wide sequence, in board order.
    expect(todos.map((todo: { position: number }) => todo.position).sort()).toEqual([0, 1, 2, 3]);

    const deps = await db.select().from(dbSchema.todoDependencies).where(eq(dbSchema.todoDependencies.userId, userId));
    // Child waits on Shipped. Shipped waiting on the open Parent would leave a
    // completed todo blocked, which telos never allows, so that edge is dropped.
    expect(deps.map((dep: { todoId: string; dependsOnTodoId: string }) => [dep.todoId, dep.dependsOnTodoId])).toEqual([
      [byTitle.Child.id, byTitle.Shipped.id],
    ]);
    expect(report.skipped.join('\n')).toMatch(/"Shipped" is done/);

    const notes = await db.select().from(dbSchema.todoNotes).where(eq(dbSchema.todoNotes.userId, userId));
    expect(
      notes
        .map((note: { kind: string; actorKind: string; todoId: string }) => [note.kind, note.actorKind, note.todoId])
        .sort(),
    ).toEqual(
      [
        ['note', 'user', byTitle.Child.id],
        ['report', 'agent', byTitle.Child.id],
        ['verdict', 'agent', byTitle.Shipped.id],
      ].sort(),
    );

    const events = await db
      .select()
      .from(dbSchema.todoEvents)
      .where(eq(dbSchema.todoEvents.todoId, byTitle.Shipped.id))
      .orderBy(asc(dbSchema.todoEvents.at));
    expect(events.map((event: { kind: string }) => event.kind)).toEqual(['create', 'move', 'complete']);
    expect(events[0].at).toEqual(new Date('2026-01-03T00:00:00Z'));
    expect(events[2]).toMatchObject({ fromLaneId: review.id, toLaneId: done.id, actorKind: 'agent' });
    expect(events[2].noteId).toBe(notes.find((note: { kind: string }) => note.kind === 'verdict').id);

    expect(report.skipped.join('\n')).toMatch(/2 run\(s\)/);
  });

  it('refuses a second import of the same project', async () => {
    const before = await countRows(db, userId);
    await expect(importKanban({ source, target: db, email: 'me@example.com' })).rejects.toThrow(
      /Already in telos: "Research"/,
    );
    expect(await countRows(db, userId)).toEqual(before);
  });

  it('imports it again under a new name with rename, reusing the agent', async () => {
    const again = await importKanban({ source, target: db, email: 'me@example.com', rename: true });
    expect(again.projects).toEqual([{ from: 'Research', to: 'Research (kanban)', doneLane: 'Done' }]);
    expect(again.counts.agents).toBe(0);
    const projects = await db.select().from(dbSchema.projects).where(eq(dbSchema.projects.userId, userId));
    expect(projects.map((project: { name: string }) => project.name).sort()).toEqual(['Research', 'Research (kanban)']);
    expect((await db.select().from(dbSchema.agents).where(eq(dbSchema.agents.userId, userId))).length).toBe(1);
  });
});
