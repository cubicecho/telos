import type { McpPool, McpServerConfig } from '@cubicecho/agent-mcp-pool';
import { HOST } from './execute.ts';
import type { SessionDelete, Telos } from './telos.ts';
import { openPool, readServers, serverConfig } from './tools.ts';

// A todo is the session an agent's MCP hooks file things under, and a deleted
// todo is a session that is gone. Telos cannot reach the servers to say so and
// the runner can, so telos keeps a list of what is owed and the runner comes
// for it, as it comes for MCP tests: it fires `sessionDelete` on the servers
// that asked to hear, and reports whether they did. Telos decides what a
// failure means — try again later, or give up.

/**
 * Tells one agent's servers that a todo's session is gone.
 *
 * @param owed The session, and the servers to tell.
 * @param allowStdio Whether commands may be spawned.
 * @param open Connects to the servers; `openPool` unless a test says otherwise.
 * @returns Null when every hook ran, or why one did not.
 */
export async function tellServers(
  owed: SessionDelete,
  allowStdio: boolean,
  open: (configs: McpServerConfig[]) => Promise<McpPool> = openPool,
): Promise<string | null> {
  const problems: string[] = [];
  const configs: McpServerConfig[] = [];
  for (const row of readServers(owed.mcpServers)) {
    // What is said of a server only counts against it when it cannot be told.
    const said: string[] = [];
    const config = serverConfig(row, allowStdio, (text) => said.push(text));
    if (config?.hooks?.length) configs.push(config);
    else if (config) problems.push(...said);
    else problems.push(`"${row.name || row.id}" is not a server this runner can reach.`);
  }
  if (configs.length === 0) return problems.join(' ') || 'No server to tell.';
  const pool = await open(configs);
  try {
    const outcomes = await pool.runHooks('sessionDelete', {
      session: { id: owed.todoId },
      host: HOST,
      vars: { todoId: owed.todoId },
    });
    for (const outcome of outcomes) {
      if (!outcome.ok) problems.push(`${outcome.label}: ${outcome.error || 'the hook did not run'}`);
    }
    if (outcomes.length === 0) problems.push('No hook ran.');
  } finally {
    await pool.shutdown().catch(() => {});
  }
  return problems.length > 0 ? problems.join(' ') : null;
}

/**
 * Takes the deleted sessions owed and tells their servers, each reported as it
 * finishes. Nothing waits on them: they must not hold up the board's work.
 *
 * @param telos The runner's client.
 * @param allowStdio Whether commands may be spawned.
 * @param log Told when a server could not be told, or a report does not reach telos.
 * @param open Connects to the servers.
 * @returns The tellings under way.
 */
export async function takeSessionDeletes(
  telos: Telos,
  allowStdio: boolean,
  log: (text: string) => void,
  open: (configs: McpServerConfig[]) => Promise<McpPool> = openPool,
): Promise<Array<Promise<void>>> {
  return (await telos.sessionDeletes()).map((owed) =>
    tellServers(owed, allowStdio, open)
      .catch((error) => (error instanceof Error ? error.message : String(error)))
      .then((error) => {
        if (error) log(`[runner] telling ${owed.agentName}'s servers todo ${owed.todoId} was deleted failed: ${error}`);
        return telos.finishSessionDelete(owed.id, error);
      })
      .catch((error) =>
        log(`[runner] reporting a deleted session failed: ${error instanceof Error ? error.message : String(error)}`),
      ),
  );
}
