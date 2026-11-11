import { type McpConnection, McpPool, type McpProbe } from '@cubicecho/agent-mcp-pool';
import type { ProbeResult, RunnerProbe, Telos } from './telos.ts';
import { readServers, serverConfig, unreachable } from './tools.ts';

// "Test this MCP server" from the account's list of them, made here: the runner is where
// an agent's tools are reached from, so a server that answers the runner is
// one a run can use, whatever the person's own machine can see.

/** How long a server gets to answer a test, unless it sets its own connect timeout. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Makes one test's connection. */
export type Dial = (config: McpConnection) => Promise<McpProbe>;

// A pool with no servers, only for its `probe`: it introduces itself as a run's
// pool does, and gives a row's own connect timeout precedence over the test's,
// so a server slow to start fails no test it would pass in a run. It opens
// nothing until asked, so one is enough for every test.
const prober = new McpPool({ clientName: 'telos-runner', probeTimeoutMs: PROBE_TIMEOUT_MS });
const probe: Dial = (config) => prober.probe(config);

/**
 * Connects to one server, lists its tools and hangs up.
 *
 * @param test The test telos handed over.
 * @param dial Makes the connection; the runner's prober unless a test says otherwise.
 * @returns What was found.
 */
export async function testServer(test: RunnerProbe, dial: Dial = probe): Promise<ProbeResult> {
  const [row] = readServers(`[${test.server}]`);
  if (!row) return { ok: false, tools: [], error: 'The server row could not be read.' };
  const notices: string[] = [];
  const config = serverConfig(row, (text) => notices.push(text));
  if (!config) return { ok: false, tools: [], error: unreachable(row) };
  const found = await dial(config);
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
 * @param log Told when a report does not reach telos.
 * @param dial Makes the connection.
 * @returns The tests under way.
 */
export async function takeTests(
  telos: Telos,
  log: (text: string) => void,
  dial: Dial = probe,
): Promise<Array<Promise<void>>> {
  return (await telos.probes()).map((test) =>
    testServer(test, dial)
      .then((result) => telos.finishProbe(test.id, result))
      .catch((error) =>
        log(`[runner] reporting an MCP test failed: ${error instanceof Error ? error.message : String(error)}`),
      ),
  );
}
