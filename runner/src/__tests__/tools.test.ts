import type { probe } from '@cubicecho/agent-mcp-pool';
import { describe, expect, it } from 'vitest';
import { PROBE_TIMEOUT_MS, testServer } from '../probes.ts';
import { serverConfig } from '../tools.ts';

// A server's row as the pool reads it: where a command runs, and how long a
// server is given to connect, to answer and to sit idle.

const command = { id: 'files', name: 'Files', command: 'npx', args: ['-y', 'files-server'] };

describe("a server's limits", () => {
  it('pass through to the pool, with the working directory for a command', () => {
    const row = { ...command, cwd: '/srv/files', connectTimeoutMs: 120_000, callTimeoutMs: 90_000, idleTimeoutMs: 0 };
    expect(serverConfig(row, true)).toMatchObject({
      transport: 'stdio',
      cwd: '/srv/files',
      connectTimeoutMs: 120_000,
      callTimeoutMs: 90_000,
      idleTimeoutMs: 0,
    });
  });

  it("are the pool's own when the row sets none, or one it could not mean", () => {
    expect(serverConfig(command, true)).toMatchObject({
      cwd: null,
      connectTimeoutMs: null,
      callTimeoutMs: null,
      idleTimeoutMs: null,
    });
    expect(serverConfig({ ...command, connectTimeoutMs: 0, callTimeoutMs: -1 }, true)).toMatchObject({
      connectTimeoutMs: null,
      callTimeoutMs: null,
    });
  });

  it('leave a command and its directory alone where the runner spawns nothing', () => {
    expect(serverConfig({ ...command, cwd: '/srv/files' }, false)).toBeNull();
  });
});

describe("a server's test", () => {
  async function waitedFor(row: Record<string, unknown>): Promise<number | undefined> {
    let waited: number | undefined;
    const dial = (async (_config, _client, options) => {
      waited = options?.timeoutMs;
      return { ok: true, tools: [], error: '', instructions: '' };
    }) as typeof probe;
    await testServer({ id: 'p', server: JSON.stringify(row) }, true, dial);
    return waited;
  }

  it('waits as long as the server is given to connect', async () => {
    expect(await waitedFor({ ...command, connectTimeoutMs: 120_000 })).toBe(120_000);
  });

  it('waits the usual time for a server that sets nothing', async () => {
    expect(await waitedFor(command)).toBe(PROBE_TIMEOUT_MS);
  });
});
