import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import * as dbSchema from '@telos/db/schema';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, createBoard, FINISH, runnerClient } from '../board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from '../helpers.ts';

// The account's MCP servers: one row per server however many agents use it,
// an agent naming the ones it may reach by slug, and the headers kept where
// only the runner reads them. Every server is a URL: telos runs no stdio ones.

let db: TestDb;
let board: Board;
let runner: TestClient;

const CREATE = `mutation ($values: CreateMcpServerInput!) {
  createMcpServer(values: $values) { id slug name url hiddenTools hooks enabled headerNames }
}`;
const UPDATE = `mutation ($id: UUID!, $set: UpdateMcpServerInput!) {
  updateMcpServer(set: $set, where: { id: { eq: $id } }) { id slug enabled }
}`;
const DELETE = `mutation ($id: UUID!) { deleteMcpServer(where: { id: { eq: $id } }) { id } }`;
const LIST = `query {
  mcpServers(orderBy: { slug: { direction: asc, priority: 1 } }) { id slug headerNames }
}`;
const SECRET = `mutation ($id: ID!, $kind: McpSecretKind!, $name: String!, $value: String) {
  setMcpServerSecret(id: $id, kind: $kind, name: $name, value: $value) { id headerNames }
}`;
const SET_AGENT = `mutation ($id: UUID!, $set: UpdateAgentInput!) {
  updateAgent(set: $set, where: { id: { eq: $id } }) { id mcpServerSlugs }
}`;
const CLAIM_SERVERS = `mutation ($todoId: ID!, $laneId: ID!) {
  claimRun(todoId: $todoId, laneId: $laneId) { runId agent { mcpServers mcpNotices } }
}`;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
  runner = runnerClient(db);
});

async function addServer(slug: string, more: Record<string, unknown> = {}): Promise<string> {
  const values = { slug, name: slug, url: `http://${slug}.test/mcp`, ...more };
  return (await board.person.expectOk(CREATE, { values })).createMcpServer.id;
}

/** What the runner is handed for a new todo in the board's agent lane. The run is ended, so the lane is free again. */
async function claimed(): Promise<{ servers: Array<Record<string, unknown>>; notices: string[] }> {
  const todoId = await board.addTodo('Write it');
  const { runId, agent } = (await runner.expectOk(CLAIM_SERVERS, { todoId, laneId: board.lanes[0].id })).claimRun;
  await runner.expectOk(FINISH, { id: runId, result: { status: 'ERROR', error: 'model unreachable' } });
  return { servers: JSON.parse(agent.mcpServers), notices: agent.mcpNotices };
}

async function nameServers(slugs: string[] | null): Promise<void> {
  await board.person.expectOk(SET_AGENT, { id: board.agentId, set: { mcpServerSlugs: slugs } });
}

describe('the registry', () => {
  it('keeps a server, and shows the names of its secrets but never the values', async () => {
    const id = await addServer('docs', { hiddenTools: ['forget'] });
    await board.person.expectOk(SECRET, { id, kind: 'HEADER', name: 'X-Team', value: 'core' });
    const { setMcpServerSecret } = await board.person.expectOk(SECRET, {
      id,
      kind: 'HEADER',
      name: 'Authorization',
      value: 'Bearer s3',
    });
    expect(setMcpServerSecret).toEqual({ id, headerNames: ['Authorization', 'X-Team'] });
    expect((await board.person.expectOk(LIST)).mcpServers).toEqual([
      { id, slug: 'docs', headerNames: ['Authorization', 'X-Team'] },
    ]);

    // The column is not in the schema to ask for, or to state on a write.
    const read = await board.person.run('query { mcpServers { headers } }');
    expect(read.errors?.[0]?.message).toMatch(/Cannot query field/);
    const written = await board.person.run(UPDATE, { id, set: { headers: { A: 'b' } } });
    expect(written.errors?.[0]?.message).toMatch(/not defined/);

    // A null value takes one away.
    await board.person.expectOk(SECRET, { id, kind: 'HEADER', name: 'Authorization', value: null });
    const [row] = await db.select().from(dbSchema.mcpServers).where(eq(dbSchema.mcpServers.id, id));
    expect(row.headers).toEqual({ 'X-Team': 'core' });
  });

  it('keeps no environment variables, since it runs no commands', async () => {
    const id = await addServer('docs');
    const env = await board.person.run(SECRET, { id, kind: 'ENV', name: 'API_TOKEN', value: 't0p' });
    expect(env.errors?.[0]?.message).toMatch(/does not exist in "McpSecretKind" enum/);
    const names = await board.person.run('query { mcpServers { envNames } }');
    expect(names.errors?.[0]?.message).toMatch(/Cannot query field/);
  });

  it('refuses a secret whose name could not be sent', async () => {
    const id = await addServer('docs');
    for (const [kind, name] of [
      ['HEADER', 'Bad Name'],
      ['HEADER', ''],
      ['HEADER', 'X:Key'],
    ]) {
      expect((await board.person.expectError(SECRET, { id, kind, name, value: 'x' })).code).toBe('BAD_USER_INPUT');
    }
  });

  it('refuses a server the runner could not use, and says why', async () => {
    const refused = async (values: Record<string, unknown>) =>
      board.person.expectError(CREATE, { values: { slug: 'docs', name: 'Docs', url: 'http://docs.test', ...values } });
    expect((await refused({ slug: 'my docs' })).message).toMatch(/slug is letters/);
    expect((await refused({ slug: 'telos' })).message).toMatch(/board's own tools/);
    expect((await refused({ url: 'file:///etc/passwd' })).message).toMatch(/http or https/);
    expect((await refused({ url: ' ' })).message).toMatch(/needs a URL/);
    // Without one at all, the API itself refuses it: a URL is required.
    expect((await refused({ url: undefined })).message).toMatch(/"url" of required type "String!" was not provided/);
    expect((await refused({ url: null })).message).toMatch(/not to be null/);
    expect((await refused({ hiddenTools: [1] })).message).toMatch(/list of strings/);
    expect((await refused({ connectTimeoutMs: 0 })).message).toMatch(/connectTimeoutMs is a whole number/);
    expect((await refused({ callTimeoutMs: -5 })).message).toMatch(/callTimeoutMs is a whole number/);
    expect((await refused({ idleTimeoutMs: -1 })).message).toMatch(/idleTimeoutMs is a whole number/);
    await addServer('docs');
    expect((await refused({})).message).toMatch(/already have an MCP server with the slug "docs"/);
  });

  it('refuses a command where a server is given, and an edit that takes its URL away', async () => {
    const stdio = await board.person.run(CREATE, {
      values: { slug: 'files', name: 'Files', url: 'http://files.test/mcp', command: 'npx' },
    });
    expect(stdio.errors?.[0]?.message).toMatch(/"command" is not defined/);
    const id = await addServer('docs');
    // The column is NOT NULL, so drizzle-graphql refuses a null before the hook sees it.
    expect((await board.person.expectError(UPDATE, { id, set: { url: null } })).message).toMatch(
      /'url' cannot be set to null/,
    );
    expect((await board.person.expectError(UPDATE, { id, set: { url: '' } })).message).toMatch(/needs a URL/);
  });

  it("is the owner's alone, and not for AI to read or write", async () => {
    const id = await addServer('docs');
    const other = await createBoard(db, 'other@example.com');
    expect((await other.person.expectOk(LIST)).mcpServers).toEqual([]);
    expect((await other.person.expectOk(UPDATE, { id, set: { enabled: false } })).updateMcpServer).toBeNull();
    expect((await other.person.expectOk(DELETE, { id })).deleteMcpServer).toBeNull();
    expect((await other.person.expectError(SECRET, { id, kind: 'HEADER', name: 'A', value: 'b' })).code).toBe(
      'NOT_FOUND',
    );
    // The same slug is free in another account.
    await other.person.expectOk(CREATE, { values: { slug: 'docs', name: 'Docs', url: 'http://docs.test' } });

    const key = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'apiKey', userId: board.userId, keyId: '00000000-0000-0000-0000-000000000000' },
    });
    expect((await key.expectOk(LIST)).mcpServers).toEqual([]);
    expect((await key.expectError(UPDATE, { id, set: { enabled: false } })).code).toBe('FORBIDDEN');
    expect((await key.expectError(SECRET, { id, kind: 'HEADER', name: 'A', value: 'b' })).code).toBe('FORBIDDEN');
    expect((await runner.expectError(SECRET, { id, kind: 'HEADER', name: 'A', value: 'b' })).code).toBe('FORBIDDEN');
  });

  it('does not let a client say what a test found', async () => {
    const stated = await board.person.run(CREATE, {
      values: { slug: 'docs', name: 'Docs', url: 'http://docs.test', checkOk: true },
    });
    expect(stated.errors?.[0]?.message).toMatch(/not defined/);
  });
});

describe("an agent's servers", () => {
  beforeEach(async () => {
    await addServer('zeta');
    await addServer('alpha', { hooks: [{ id: 'recall', on: 'beforeTurn', tool: 'recall' }] });
    await addServer('mid');
  });

  it('are every server when it names none, in slug order, with their secrets', async () => {
    const [alpha] = await db.select().from(dbSchema.mcpServers).where(eq(dbSchema.mcpServers.slug, 'alpha'));
    await board.person.expectOk(SECRET, { id: alpha.id, kind: 'HEADER', name: 'X-Key', value: 's3' });
    const { servers, notices } = await claimed();
    expect(servers).toEqual([
      {
        id: 'alpha',
        name: 'alpha',
        url: 'http://alpha.test/mcp',
        headers: { 'X-Key': 's3' },
        hooks: [{ id: 'recall', on: 'beforeTurn', tool: 'recall' }],
      },
      { id: 'mid', name: 'mid', url: 'http://mid.test/mcp' },
      { id: 'zeta', name: 'zeta', url: 'http://zeta.test/mcp' },
    ]);
    expect(notices).toEqual([]);
  });

  it('carry how long a server is given, when that is set', async () => {
    const [mid] = await db.select().from(dbSchema.mcpServers).where(eq(dbSchema.mcpServers.slug, 'mid'));
    const set = { connectTimeoutMs: 120_000, callTimeoutMs: 90_000, idleTimeoutMs: 0 };
    await board.person.expectOk(UPDATE, { id: mid.id, set });
    await nameServers(['mid']);
    expect((await claimed()).servers).toEqual([{ id: 'mid', name: 'mid', url: 'http://mid.test/mcp', ...set }]);
  });

  it('are none when its list is empty', async () => {
    await nameServers([]);
    expect(await claimed()).toEqual({ servers: [], notices: [] });
  });

  it('are exactly those it lists, in slug order whatever order it lists them in', async () => {
    await nameServers(['zeta', 'alpha']);
    const { servers, notices } = await claimed();
    expect(servers.map((server) => server.id)).toEqual(['alpha', 'zeta']);
    expect(notices).toEqual([]);
  });

  it('drops a slug that names nothing and says so, rather than widening to all', async () => {
    await nameServers(['gone', 'zeta']);
    const { servers, notices } = await claimed();
    expect(servers.map((server) => server.id)).toEqual(['zeta']);
    expect(notices).toEqual(['Worker names an MCP server "gone" that no longer exists, so it was left out.']);

    // Every slug gone is still a list: no servers, not all of them.
    await nameServers(['gone']);
    expect((await claimed()).servers).toEqual([]);
  });

  it('leave out a server that is switched off, without a notice', async () => {
    const [zeta] = await db.select().from(dbSchema.mcpServers).where(eq(dbSchema.mcpServers.slug, 'zeta'));
    await board.person.expectOk(UPDATE, { id: zeta.id, set: { enabled: false } });
    await nameServers(['zeta', 'alpha']);
    const listed = await claimed();
    expect(listed.servers.map((server) => server.id)).toEqual(['alpha']);
    expect(listed.notices).toEqual([]);

    await nameServers(null);
    expect((await claimed()).servers.map((server) => server.id)).toEqual(['alpha', 'mid']);
  });

  it('follow a server that is renamed', async () => {
    await nameServers(['zeta', 'alpha']);
    const [zeta] = await db.select().from(dbSchema.mcpServers).where(eq(dbSchema.mcpServers.slug, 'zeta'));
    await board.person.expectOk(UPDATE, { id: zeta.id, set: { slug: 'omega' } });
    const [agent] = await db.select().from(dbSchema.agents).where(eq(dbSchema.agents.id, board.agentId));
    expect(agent.mcpServerSlugs).toEqual(['omega', 'alpha']);
    expect((await claimed()).servers.map((server) => server.id)).toEqual(['alpha', 'omega']);
  });

  it('must be null or a list of slugs', async () => {
    const refused = await board.person.expectError(SET_AGENT, { id: board.agentId, set: { mcpServerSlugs: 'alpha' } });
    expect(refused.code).toBe('BAD_USER_INPUT');
  });
});

describe('the migrations', () => {
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

  it("lifts each agent's servers into the registry, merging the same ones and keeping its selection", async () => {
    // The schema as it was just before, built from the migrations ahead of this one.
    const old = drizzle({ client: new PGlite('memory://') });
    await migrateUpTo(old, '_mcp_servers');

    const memory = { url: 'http://memory.test/mcp', headers: { Authorization: 'Bearer s3' } };
    const agents: Array<[string, string, unknown]> = [
      ['a@example.com', 'First', [{ id: 'f0e1d2c3-0000-4000-8000-000000000001', name: 'Team Memory', ...memory }]],
      [
        'a@example.com',
        'Second',
        [
          // The same server under another id and name, a hand-written id, and a row nothing could use.
          { id: 'f0e1d2c3-0000-4000-8000-000000000002', name: 'Memory again', ...memory },
          { id: 'docs', command: 'npx', args: ['docs-server'], env: { TOKEN: 't' }, hiddenTools: ['wipe'] },
          { id: 'f0e1d2c3-0000-4000-8000-000000000003', name: 'Blank' },
        ],
      ],
      ['a@example.com', 'Third', []],
      // Another account's server of the same definition is its own row.
      ['b@example.com', 'Theirs', [{ id: 'f0e1d2c3-0000-4000-8000-000000000004', name: 'Team Memory', ...memory }]],
      // An unnamed uuid row, and a hand-written id the board's own door has.
      [
        'b@example.com',
        'Odd',
        [
          { id: 'f0e1d2c3-0000-4000-8000-000000000005', url: 'http://x.test' },
          { id: 'telos', url: 'http://y.test' },
        ],
      ],
    ];
    for (const [email, name, servers] of agents) {
      await old.execute(sql`INSERT INTO users (email) VALUES (${email}) ON CONFLICT DO NOTHING`);
      await old.execute(sql`
        INSERT INTO agents (user_id, name, base_url, model, mcp_servers, created_at)
        SELECT id, ${name}, 'http://llm.test/v1', 'tiny', ${JSON.stringify(servers)}::jsonb,
          now() + ${agents.findIndex((row) => row[1] === name)} * interval '1 second'
        FROM users WHERE email = ${email}
      `);
    }

    // Up to the registry as it stood while it still held stdio servers.
    await migrateUpTo(old, '_no_stdio_mcp');

    const lifted = await old.execute(sql`
      SELECT u.email, a.name, a.mcp_server_slugs AS slugs FROM agents a JOIN users u ON u.id = a.user_id ORDER BY a.created_at
    `);
    expect(lifted.rows).toEqual([
      { email: 'a@example.com', name: 'First', slugs: ['team_memory'] },
      { email: 'a@example.com', name: 'Second', slugs: ['team_memory', 'docs'] },
      { email: 'a@example.com', name: 'Third', slugs: [] },
      { email: 'b@example.com', name: 'Theirs', slugs: ['team_memory'] },
      { email: 'b@example.com', name: 'Odd', slugs: ['server', 'server_2'] },
    ]);
    const servers = await old.execute(sql`
      SELECT u.email, s.slug, s.name, s.url, s.command, s.args, s.headers, s.env, s.hidden_tools, s.enabled
      FROM mcp_servers s JOIN users u ON u.id = s.user_id ORDER BY u.email, s.slug
    `);
    expect(servers.rows).toEqual([
      {
        email: 'a@example.com',
        slug: 'docs',
        name: 'docs',
        url: null,
        command: 'npx',
        args: ['docs-server'],
        headers: {},
        env: { TOKEN: 't' },
        hidden_tools: ['wipe'],
        enabled: true,
      },
      expect.objectContaining({ email: 'a@example.com', slug: 'team_memory', name: 'Team Memory', ...memory }),
      expect.objectContaining({ email: 'b@example.com', slug: 'server', url: 'http://x.test' }),
      expect.objectContaining({ email: 'b@example.com', slug: 'server_2', url: 'http://y.test' }),
      expect.objectContaining({ email: 'b@example.com', slug: 'team_memory', name: 'Team Memory', ...memory }),
    ]);
  });

  it('removes stdio servers, their secrets and the slugs naming them, and keeps every URL', async () => {
    const old = drizzle({ client: new PGlite('memory://') });
    await migrateUpTo(old, '_no_stdio_mcp');
    for (const email of ['a@example.com', 'b@example.com']) {
      await old.execute(sql`INSERT INTO users (email) VALUES (${email})`);
    }
    const server = (email: string, slug: string, url: string | null, command: string | null) => sql`
      INSERT INTO mcp_servers (user_id, slug, name, url, command, args, headers, env)
      SELECT id, ${slug}, ${slug}, ${url}, ${command}, '["-y"]'::jsonb, '{"Authorization":"Bearer s3"}'::jsonb,
        '{"TOKEN":"t"}'::jsonb
      FROM users WHERE email = ${email}
    `;
    await old.execute(server('a@example.com', 'docs', 'http://docs.test/mcp', null));
    await old.execute(server('a@example.com', 'files', null, 'npx'));
    await old.execute(server('a@example.com', 'both', 'http://both.test/mcp', 'npx'));
    // Another account's server of the same slug is a URL, and stays named.
    await old.execute(server('b@example.com', 'files', 'http://files.test/mcp', null));
    const agent = (email: string, name: string, slugs: string[] | null, order: number) => sql`
      INSERT INTO agents (user_id, name, base_url, model, mcp_server_slugs, created_at)
      SELECT id, ${name}, 'http://llm.test/v1', 'tiny', ${slugs === null ? null : JSON.stringify(slugs)}::jsonb,
        now() + ${order} * interval '1 second'
      FROM users WHERE email = ${email}
    `;
    await old.execute(agent('a@example.com', 'Every', null, 0));
    await old.execute(agent('a@example.com', 'Some', ['files', 'docs', 'gone', 'both'], 1));
    await old.execute(agent('a@example.com', 'Only', ['files'], 2));
    await old.execute(agent('b@example.com', 'Theirs', ['files'], 3));

    await migrateUpTo(old);

    const servers = await old.execute(sql`
      SELECT u.email, s.slug, s.url, s.headers FROM mcp_servers s JOIN users u ON u.id = s.user_id
      ORDER BY u.email, s.slug
    `);
    const headers = { Authorization: 'Bearer s3' };
    expect(servers.rows).toEqual([
      { email: 'a@example.com', slug: 'both', url: 'http://both.test/mcp', headers },
      { email: 'a@example.com', slug: 'docs', url: 'http://docs.test/mcp', headers },
      { email: 'b@example.com', slug: 'files', url: 'http://files.test/mcp', headers },
    ]);
    const columns = await old.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'mcp_servers' AND column_name IN ('command', 'args', 'cwd', 'env')
    `);
    expect(columns.rows).toEqual([]);

    // A list loses the slug and keeps the rest in order; one with nothing left names none.
    const lists = await old.execute(sql`SELECT name, mcp_server_slugs AS slugs FROM agents ORDER BY created_at`);
    expect(lists.rows).toEqual([
      { name: 'Every', slugs: null },
      { name: 'Some', slugs: ['docs', 'gone', 'both'] },
      { name: 'Only', slugs: [] },
      { name: 'Theirs', slugs: ['files'] },
    ]);

    // And a row without a URL cannot be written again.
    await expect(
      old.execute(sql`INSERT INTO mcp_servers (user_id, slug, name) SELECT id, 'x', 'x' FROM users LIMIT 1`),
    ).rejects.toThrow();
  });
});
