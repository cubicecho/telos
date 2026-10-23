import type { probe } from '@cubicecho/agent-mcp-pool';
import { describe, expect, it, vi } from 'vitest';
import { configWarnings, readConfig } from '../config.ts';
import { PROBE_TIMEOUT_MS, testServer } from '../probes.ts';
import { tellServers } from '../session-deletes.ts';
import type { AgentClaim } from '../telos.ts';
import { openTools, serverConfig } from '../tools.ts';

// A server's row as the pool reads it: a URL, and how long a server is given
// to connect, to answer and to sit idle. A stdio server is never spawned.

const docs = { id: 'docs', name: 'Docs', url: 'http://docs.test/mcp' };
/** What a telos from before stdio servers were removed could still send. */
const stdio = { id: 'files', name: 'Files', command: 'npx', args: ['-y', 'files-server'], env: { TOKEN: 't' } };
const STDIO_LEFT_OUT =
  'MCP server "Files" left out: it is a command (stdio), and telos runs only MCP servers at a URL.';

describe("a server's limits", () => {
  it('pass through to the pool', () => {
    const row = { ...docs, connectTimeoutMs: 120_000, callTimeoutMs: 90_000, idleTimeoutMs: 0 };
    expect(serverConfig(row)).toMatchObject({
      transport: 'http',
      url: 'http://docs.test/mcp',
      connectTimeoutMs: 120_000,
      callTimeoutMs: 90_000,
      idleTimeoutMs: 0,
    });
  });

  it("are the pool's own when the row sets none, or one it could not mean", () => {
    expect(serverConfig(docs)).toMatchObject({ connectTimeoutMs: null, callTimeoutMs: null, idleTimeoutMs: null });
    expect(serverConfig({ ...docs, connectTimeoutMs: 0, callTimeoutMs: -1 })).toMatchObject({
      connectTimeoutMs: null,
      callTimeoutMs: null,
    });
  });
});

describe('a stdio server', () => {
  it('is never handed to the pool', () => {
    expect(serverConfig(stdio)).toBeNull();
    // A row with a URL as well is reached at the URL, and its command ignored.
    expect(serverConfig({ ...stdio, url: 'http://files.test/mcp' })).toMatchObject({
      transport: 'http',
      url: 'http://files.test/mcp',
    });
  });

  it('is left out of a run, which says why', async () => {
    const notices: string[] = [];
    const claim = {
      token: 't',
      agent: { mcpServers: JSON.stringify([stdio]), mcpNotices: [] },
    } as unknown as AgentClaim;
    const pool = await openTools(claim, { telosUrl: 'http://127.0.0.1:1', onNotice: (text) => notices.push(text) });
    try {
      expect(pool.state().map((server) => server.id)).toEqual(['telos']);
    } finally {
      await pool.shutdown();
    }
    expect(notices).toEqual([STDIO_LEFT_OUT]);
  });

  it('fails its test, saying why', async () => {
    const dial = vi.fn() as unknown as typeof probe;
    expect(await testServer({ id: 'p', server: JSON.stringify(stdio) }, dial)).toEqual({
      ok: false,
      tools: [],
      error: STDIO_LEFT_OUT,
    });
    expect(dial).not.toHaveBeenCalled();
  });

  it('is not told a session is gone', async () => {
    const open = vi.fn();
    const said = await tellServers({ id: 's', todoId: 't', agentName: 'A', mcpServers: JSON.stringify([stdio]) }, open);
    expect(said).toBe(STDIO_LEFT_OUT);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("a server's test", () => {
  async function waitedFor(row: Record<string, unknown>): Promise<number | undefined> {
    let waited: number | undefined;
    const dial = (async (_config, _client, options) => {
      waited = options?.timeoutMs;
      return { ok: true, tools: [], toolsFingerprint: '', error: '', instructions: '' };
    }) as typeof probe;
    await testServer({ id: 'p', server: JSON.stringify(row) }, dial);
    return waited;
  }

  it('waits as long as the server is given to connect', async () => {
    expect(await waitedFor({ ...docs, connectTimeoutMs: 120_000 })).toBe(120_000);
  });

  it('waits the usual time for a server that sets nothing', async () => {
    expect(await waitedFor(docs)).toBe(PROBE_TIMEOUT_MS);
  });
});

describe("the runner's settings", () => {
  const env = { RUNNER_KEY: 'k' };

  it('run check lanes only with RUNNER_ALLOW_CHECKS=true', () => {
    expect(readConfig(env)?.allowChecks).toBe(false);
    expect(readConfig({ ...env, RUNNER_ALLOW_CHECKS: 'yes' })?.allowChecks).toBe(false);
    expect(readConfig({ ...env, RUNNER_ALLOW_CHECKS: 'true' })?.allowChecks).toBe(true);
    // The old switch turns nothing on.
    expect(readConfig({ ...env, RUNNER_ALLOW_STDIO: 'true' })?.allowChecks).toBe(false);
  });

  it('say when checks are on, and that RUNNER_ALLOW_STDIO is no longer read', () => {
    const quiet = readConfig(env);
    expect(quiet && configWarnings(quiet, env)).toEqual([]);
    const old = { ...env, RUNNER_ALLOW_STDIO: 'true' };
    const [warning] = configWarnings(readConfig(old) as NonNullable<typeof quiet>, old);
    expect(warning).toMatch(/RUNNER_ALLOW_STDIO is no longer read/);
    expect(warning).toMatch(/RUNNER_ALLOW_CHECKS/);
    const on = { ...env, RUNNER_ALLOW_CHECKS: 'true' };
    expect(configWarnings(readConfig(on) as NonNullable<typeof quiet>, on)).toEqual([
      '⚠️  RUNNER_ALLOW_CHECKS is on: check lanes may run shell commands on this host.',
    ]);
  });

  it('say that RUNNER_CONCURRENCY is no longer read, and where the run limit went', () => {
    const old = { ...env, RUNNER_CONCURRENCY: '4' };
    const [warning] = configWarnings(readConfig(old) as NonNullable<ReturnType<typeof readConfig>>, old);
    expect(warning).toMatch(/RUNNER_CONCURRENCY is no longer read/);
    expect(warning).toMatch(/Settings → Agents/);
  });
});
