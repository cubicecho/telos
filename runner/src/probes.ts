import { probe } from '@cubicecho/agent-mcp-pool';
import type { ProbeResult, RunnerProbe, Telos } from './telos.ts';
import { readServers, serverConfig } from './tools.ts';

// "Test this MCP server" from the agent form, made here: the runner is where
// an agent's tools are reached from, so a server that answers the runner is
// one a run can use, whatever the person's own machine can see.

/** How long a server gets to answer a test. */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Connects to one server, lists its tools and hangs up.
 *
 * @param test The test telos handed over.
 * @param allowStdio Whether commands may be spawned.
 * @param dial Makes the connection; `probe` unless a test says otherwise.
 * @returns What was found.
 */
export async function testServer(
  test: RunnerProbe,
  allowStdio: boolean,
  dial: typeof probe = probe,
): Promise<ProbeResult> {
  const [row] = readServers(`[${test.server}]`);
  if (!row) return { ok: false, tools: [], error: 'The server row could not be read.' };
  const notices: string[] = [];
  const config = serverConfig(row, allowStdio, (text) => notices.push(text));
  if (!config) {
    return {
      ok: false,
      tools: [],
      error: row.command
        ? 'This runner does not run commands: its host has not set RUNNER_ALLOW_STDIO.'
        : 'The server has no URL or command this runner can use.',
    };
  }
  const found = await dial(config, 'telos-runner', { timeoutMs: PROBE_TIMEOUT_MS });
  if (!found.ok) return { ok: false, tools: [], error: found.error || 'The server could not be reached.' };
  return {
    ok: true,
    tools: found.tools.map(({ name, description }) => ({ name, description: description ?? '' })),
    instructions: [found.instructions, ...notices].filter(Boolean).join('\n\n'),
  };
}

/**
 * Takes the tests waiting and makes them, each reported as it finishes.
 * Nothing waits on them: a test must not hold up the board's work.
 *
 * @param telos The runner's client.
 * @param allowStdio Whether commands may be spawned.
 * @param log Told when a report does not reach telos.
 * @param dial Makes the connection.
 * @returns The tests under way.
 */
export async function takeTests(
  telos: Telos,
  allowStdio: boolean,
  log: (text: string) => void,
  dial: typeof probe = probe,
): Promise<Array<Promise<void>>> {
  return (await telos.probes()).map((test) =>
    testServer(test, allowStdio, dial)
      .then((result) => telos.finishProbe(test.id, result))
      .catch((error) =>
        log(`[runner] reporting an MCP test failed: ${error instanceof Error ? error.message : String(error)}`),
      ),
  );
}
