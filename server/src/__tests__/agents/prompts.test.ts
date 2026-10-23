import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { DEFAULT_AGENT_INSTRUCTIONS, SEEDED_PROMPTS } from '@telos/db/prompt-seeds';
import * as dbSchema from '@telos/db/schema';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedPrompts } from '../../agents/prompts.ts';
import { signInOnLocalNet } from '../../auth/better-auth.ts';
import { type Board, CLAIM, createBoard, FINISH, runnerClient, setLane } from '../board.ts';
import { authFor, createClient, createTestDb, type TestClient, type TestDb } from '../helpers.ts';

// What a run is told is its job: the account's prompts, which an agent names,
// under the account's agent instructions. Both are a person's to write.

let db: TestDb;
let board: Board;
let runner: TestClient;

beforeEach(async () => {
  db = await createTestDb({ instanceAi: true });
  board = await createBoard(db, 'person@example.com');
  runner = runnerClient(db);
});

const PROMPTS = `query { prompts(orderBy: { name: { direction: asc, priority: 1 } }) { id name body } }`;
const CREATE = `mutation ($name: String!, $body: String!) { createPrompt(values: { name: $name, body: $body }) { id name body } }`;
const UPDATE = `mutation ($id: UUID!, $body: String!) { updatePrompt(set: { body: $body }, where: { id: { eq: $id } }) { id body } }`;
const DELETE = `mutation ($id: UUID!) { deletePrompt(where: { id: { eq: $id } }) { id } }`;
const SET_PROMPT = `mutation ($id: UUID!, $promptId: UUID) { updateAgent(set: { promptId: $promptId }, where: { id: { eq: $id } }) { id promptId } }`;
const INSTRUCTIONS = `query { users { agentInstructions } defaultAgentInstructions }`;
const SET_INSTRUCTIONS = `mutation ($text: String) { setAgentInstructions(instructions: $text) { id agentInstructions } }`;

/** The board's person's client over an API key, as AI is. */
function keyClient(): TestClient {
  return createClient(db, board.userId, {
    ai: true,
    actor: { kind: 'apiKey', userId: board.userId, keyId: 'k' },
  });
}

/** The board's agent's client, as a run is. */
function runClient(): TestClient {
  return createClient(db, board.userId, {
    ai: true,
    actor: { kind: 'agent', userId: board.userId, runId: '00000000-0000-4000-8000-000000000000' },
  });
}

describe('an account’s prompts', () => {
  it('start as the seeded ones when the account is made', async () => {
    const fresh = await createTestDb();
    const { userId } = await signInOnLocalNet(authFor(fresh), 'new@example.com');
    const rows = await fresh
      .select({ name: dbSchema.prompts.name, body: dbSchema.prompts.body })
      .from(dbSchema.prompts)
      .where(eq(dbSchema.prompts.userId, userId))
      .orderBy(dbSchema.prompts.name);
    expect(rows).toEqual(SEEDED_PROMPTS.map(({ name, body }) => ({ name, body })));
  });

  it('are seeded once, whatever the account has changed or added since', async () => {
    await seedPrompts(db, board.userId);
    const [worker] = (await board.person.expectOk(PROMPTS)).prompts.filter(
      (prompt: { name: string }) => prompt.name === 'Worker',
    );
    await board.person.expectOk(UPDATE, { id: worker.id, body: 'Mine now.' });
    await seedPrompts(db, board.userId);
    const prompts = (await board.person.expectOk(PROMPTS)).prompts;
    expect(prompts.map((prompt: { name: string }) => prompt.name)).toEqual(['Planner', 'Reviewer', 'Worker']);
    expect(prompts.find((prompt: { name: string }) => prompt.name === 'Worker').body).toBe('Mine now.');
  });

  it('are a person’s to add, change and delete, the seeded ones included', async () => {
    const made = (await board.person.expectOk(CREATE, { name: 'Writer', body: 'You write docs.' })).createPrompt;
    expect(made).toMatchObject({ name: 'Writer', body: 'You write docs.' });
    await board.person.expectOk(UPDATE, { id: made.id, body: 'You write docs, briefly.' });
    await seedPrompts(db, board.userId);
    const seeded = (await board.person.expectOk(PROMPTS)).prompts.find(
      (prompt: { name: string }) => prompt.name === 'Planner',
    );
    await board.person.expectOk(DELETE, { id: seeded.id });
    expect((await board.person.expectOk(PROMPTS)).prompts.map((prompt: { name: string }) => prompt.name)).toEqual([
      'Reviewer',
      'Worker',
      'Writer',
    ]);
  });

  it('are one account’s own', async () => {
    const mine = (await board.person.expectOk(CREATE, { name: 'Mine', body: 'x' })).createPrompt;
    const other = await createBoard(db, 'other@example.com');
    expect((await other.person.expectOk(PROMPTS)).prompts).toEqual([]);
    expect((await other.person.expectOk(UPDATE, { id: mine.id, body: 'y' })).updatePrompt).toBeNull();
    // Nor may another account's agent name it.
    const refused = await other.person.expectError(SET_PROMPT, { id: other.agentId, promptId: mine.id });
    expect(refused.code).toBe('NOT_FOUND');
  });

  it('are closed to AI and to the runner', async () => {
    const mine = (await board.person.expectOk(CREATE, { name: 'Mine', body: 'x' })).createPrompt;
    for (const caller of [keyClient(), runClient()]) {
      expect((await caller.run(PROMPTS)).errors).toBeUndefined();
      expect((await caller.expectOk(PROMPTS)).prompts).toEqual([]);
      expect((await caller.expectError(CREATE, { name: 'AI', body: 'x' })).code).toBe('FORBIDDEN');
      expect((await caller.expectError(UPDATE, { id: mine.id, body: 'y' })).code).toBe('FORBIDDEN');
      expect((await caller.expectError(DELETE, { id: mine.id })).code).toBe('FORBIDDEN');
    }
    expect((await runner.expectError(CREATE, { name: 'Runner', body: 'x' })).code).toBe('FORBIDDEN');
    expect((await runner.expectError(PROMPTS)).code).toBeDefined();
  });

  it('leave an agent with none when the one it names is deleted', async () => {
    const mine = (await board.person.expectOk(CREATE, { name: 'Mine', body: 'x' })).createPrompt;
    await board.person.expectOk(SET_PROMPT, { id: board.agentId, promptId: mine.id });
    await board.person.expectOk(DELETE, { id: mine.id });
    const [agent] = await db.select().from(dbSchema.agents).where(eq(dbSchema.agents.id, board.agentId));
    expect(agent.promptId).toBeNull();
  });
});

describe('a run’s prompt', () => {
  async function claim(todoId: string) {
    return (await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id })).claimRun;
  }

  it('is the agent’s prompt’s body, under the default instructions until the account writes its own', async () => {
    const mine = (await board.person.expectOk(CREATE, { name: 'Mine', body: 'You review carefully.' })).createPrompt;
    await board.person.expectOk(SET_PROMPT, { id: board.agentId, promptId: mine.id });
    const claimed = await claim(await board.addTodo('Write it'));
    expect(claimed.agent.prompt).toBe('You review carefully.');
    expect(claimed.assignment.agentInstructions).toBe(DEFAULT_AGENT_INSTRUCTIONS);
  });

  it('has no prompt layer for an agent that names none', async () => {
    const claimed = await claim(await board.addTodo('Write it'));
    expect(claimed.agent.prompt).toBeNull();
  });

  it('is told a prompt in the Reviewer’s format as a ruling', async () => {
    await seedPrompts(db, board.userId);
    const reviewer = (await board.person.expectOk(PROMPTS)).prompts.find(
      (prompt: { name: string }) => prompt.name === 'Reviewer',
    );
    await board.person.expectOk(SET_PROMPT, { id: board.agentId, promptId: reviewer.id });
    await setLane(board.person, board.lanes[0].id, { onFailureLaneId: board.lanes[1].id });
    const claimed = await claim(await board.addTodo('Review it'));
    expect(claimed.agent.prompt).toContain('Begin your reply with PASS or FAIL on its own line');
    // A reply written as the Reviewer asks: the bare word, then each criterion.
    const reply = 'FAIL\n- It exists: not met. `ls docs/` printed nothing.\n- It is linked: not met, nothing to link.';
    const run = (await runner.expectOk(FINISH, { id: claimed.runId, result: { status: 'OK', output: reply } }))
      .finishRun;
    expect(run).toMatchObject({ status: 'ok', verdict: 'fail' });
  });
});

describe('the account’s agent instructions', () => {
  it('read as the default until written, and go back to it on a reset', async () => {
    expect(await board.person.expectOk(INSTRUCTIONS)).toEqual({
      users: [{ agentInstructions: null }],
      defaultAgentInstructions: DEFAULT_AGENT_INSTRUCTIONS,
    });
    const set = await board.person.expectOk(SET_INSTRUCTIONS, { text: '  Work runs on the homelab.\n' });
    expect(set.setAgentInstructions).toEqual({ id: board.userId, agentInstructions: 'Work runs on the homelab.' });
    await board.person.expectOk(SET_INSTRUCTIONS, { text: null });
    expect((await board.person.expectOk(INSTRUCTIONS)).users).toEqual([{ agentInstructions: null }]);
    // Saving the default unchanged is a reset too, so the default can still improve under it.
    await board.person.expectOk(SET_INSTRUCTIONS, { text: DEFAULT_AGENT_INSTRUCTIONS });
    expect((await board.person.expectOk(INSTRUCTIONS)).users).toEqual([{ agentInstructions: null }]);
  });

  it('are handed to a run as the account wrote them', async () => {
    await board.person.expectOk(SET_INSTRUCTIONS, { text: 'Work runs on the homelab.' });
    const claimed = (
      await runner.expectOk(CLAIM, { todoId: await board.addTodo('Write it'), laneId: board.lanes[0].id })
    ).claimRun;
    expect(claimed.assignment.agentInstructions).toBe('Work runs on the homelab.');
  });

  it('are a person’s to write', async () => {
    for (const caller of [keyClient(), runClient(), runner]) {
      expect((await caller.expectError(SET_INSTRUCTIONS, { text: 'Widen my job.' })).code).toBe('FORBIDDEN');
    }
  });
});

describe('the prompts migration', () => {
  const drizzleFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../db/drizzle');
  const folders = readdirSync(drizzleFolder).sort();

  /** Applies the migrations before the one named by `suffix`, or all of them without one. */
  async function migrateUpTo(old: ReturnType<typeof drizzle>, suffix?: string): Promise<void> {
    const at = suffix ? folders.findIndex((folder) => folder.endsWith(suffix)) : folders.length;
    expect(at).toBeGreaterThan(0);
    const some = mkdtempSync(path.join(tmpdir(), 'telos-migrations-'));
    try {
      for (const folder of folders.slice(0, at)) {
        cpSync(path.join(drizzleFolder, folder), path.join(some, folder), { recursive: true });
      }
      await migrate(old as never, { migrationsFolder: some });
    } finally {
      rmSync(some, { recursive: true, force: true });
    }
  }

  it('seeds every account, points its agents at the Worker, and keeps what context said', async () => {
    const old = drizzle({ client: new PGlite('memory://') });
    await migrateUpTo(old, '20261023033840_prompts');
    await old.execute(sql`
      INSERT INTO users (email, global_context) VALUES
        ('a@example.com', '  Work runs on the homelab.  '), ('b@example.com', NULL), ('c@example.com', '   ')
    `);
    await old.execute(sql`
      INSERT INTO agents (user_id, name, system_prompt)
      SELECT id, 'Coder', 'You write code.' FROM users WHERE email = 'a@example.com'
      UNION ALL SELECT id, 'Plain', NULL FROM users WHERE email = 'b@example.com'
    `);
    await old.execute(sql`
      INSERT INTO projects (user_id, name, context, prompt)
      SELECT id, 'Both', 'A pnpm monorepo.', 'Keep artifacts in /srv.' FROM users WHERE email = 'a@example.com'
      UNION ALL SELECT id, 'Context only', ' The garden. ', '  ' FROM users WHERE email = 'a@example.com'
      UNION ALL SELECT id, 'Prompt only', NULL, 'Be brief.' FROM users WHERE email = 'b@example.com'
    `);

    await migrateUpTo(old);

    const prompts = await old.execute(sql`
      SELECT u.email, p.name, p.body FROM prompts p JOIN users u ON u.id = p.user_id ORDER BY u.email, p.name
    `);
    expect(prompts.rows).toEqual(
      ['a@example.com', 'b@example.com', 'c@example.com'].flatMap((email) =>
        SEEDED_PROMPTS.map(({ name, body }) => ({ email, name, body })),
      ),
    );
    const agents = await old.execute(sql`
      SELECT a.name, p.name AS prompt, p.user_id = a.user_id AS own
      FROM agents a JOIN prompts p ON p.id = a.prompt_id ORDER BY a.name
    `);
    expect(agents.rows).toEqual([
      { name: 'Coder', prompt: 'Worker', own: true },
      { name: 'Plain', prompt: 'Worker', own: true },
    ]);
    const users = await old.execute(sql`SELECT email, agent_instructions FROM users ORDER BY email`);
    expect(users.rows).toEqual([
      { email: 'a@example.com', agent_instructions: `${DEFAULT_AGENT_INSTRUCTIONS}\n\nWork runs on the homelab.` },
      { email: 'b@example.com', agent_instructions: null },
      { email: 'c@example.com', agent_instructions: null },
    ]);
    const projects = await old.execute(sql`SELECT name, prompt FROM projects ORDER BY name`);
    expect(projects.rows).toEqual([
      { name: 'Both', prompt: 'Keep artifacts in /srv.\n\nA pnpm monorepo.' },
      { name: 'Context only', prompt: 'The garden.' },
      { name: 'Prompt only', prompt: 'Be brief.' },
    ]);
  });
});
