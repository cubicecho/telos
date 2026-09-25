import { McpPool, type McpServerConfig, type ToolHook, validateHooks } from '@cubicecho/agent-mcp-pool';
import type { Claim, McpServerRow } from './telos.ts';

// The MCP servers one run may reach: the agent's own, plus telos itself, which
// the agent reaches through /mcp as the run (x-run-token). The telos door is
// per run — its header is the run's token — so the pool is too. It opens when
// the run starts and closes when it ends; nothing an agent reached outlives
// its run.

/** The slug telos's own tools are named under: `telos__submit_request`, and so on. */
export const TELOS_SERVER = 'telos';

/**
 * An agent's server as the pool reads it, or null when this runner will not
 * reach it (a command, with stdio off).
 *
 * Hooks that do not check out are dropped, all of them: a half-applied set
 * is harder to reason about than none, and the notice says why.
 *
 * @param row The agent's entry.
 * @param allowStdio Whether commands may be spawned.
 * @param onNotice Told about hooks left out.
 * @returns The pool's config, or null.
 */
export function serverConfig(
  row: McpServerRow,
  allowStdio: boolean,
  onNotice?: (text: string) => void,
): McpServerConfig | null {
  const slug = row.id.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!slug || slug === TELOS_SERVER) return null;
  const problems = row.hooks?.length ? validateHooks(row.hooks) : [];
  if (problems.length > 0) onNotice?.(`Hooks on "${row.name || row.id}" left out: ${problems.join('; ')}`);
  const base = {
    id: slug,
    slug,
    label: row.name || row.id,
    enabled: true,
    hiddenTools: Array.isArray(row.hiddenTools) ? row.hiddenTools.filter((name) => typeof name === 'string') : null,
    hooks: row.hooks?.length && problems.length === 0 ? (row.hooks as ToolHook[]) : null,
  };
  if (row.url) return { ...base, transport: 'http', url: row.url, headers: row.headers ?? null };
  if (row.command && allowStdio) {
    return { ...base, transport: 'stdio', command: row.command, args: row.args ?? null, env: row.env ?? null };
  }
  return null;
}

/**
 * The agent's servers out of the JSON telos sends. Garbage is no servers.
 *
 * @param json `agent.mcpServers`.
 * @returns The entries.
 */
export function readServers(json: string): McpServerRow[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((row): row is McpServerRow => !!row && typeof row === 'object' && typeof row.id === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Opens the servers a run may reach.
 *
 * @param claim The run.
 * @param options Where telos is, and whether commands may be spawned.
 * @param options.telosUrl Telos's origin.
 * @param options.allowStdio Whether commands may be spawned.
 * @param options.onNotice Told about servers left out.
 * @returns The run's pool. Close it with `shutdown()`.
 */
export async function openTools(
  claim: Claim,
  options: { telosUrl: string; allowStdio: boolean; onNotice?: (text: string) => void },
): Promise<McpPool> {
  const configs: McpServerConfig[] = [
    {
      id: TELOS_SERVER,
      slug: TELOS_SERVER,
      label: 'telos',
      enabled: true,
      transport: 'http',
      url: `${options.telosUrl}/mcp`,
      headers: { 'x-run-token': claim.token },
    },
  ];
  for (const row of readServers(claim.agent.mcpServers)) {
    const config = serverConfig(row, options.allowStdio, options.onNotice);
    if (config) configs.push(config);
    else options.onNotice?.(`MCP server "${row.name || row.id}" left out: this runner does not spawn commands.`);
  }
  const pool = new McpPool({
    clientName: 'telos-runner',
    log: { info: () => {}, error: (message) => console.error(`[mcp] ${message}`) },
  });
  await pool.sync(configs);
  return pool;
}
