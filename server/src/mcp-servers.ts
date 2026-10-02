import * as dbSchema from '@telos/db/schema';
import { asc, eq } from 'drizzle-orm';

// The account's MCP servers an agent reaches, worked out where the secrets are:
// the runner is handed rows it can dial, and nothing else is.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

/** A server as the runner reads it: `McpServerRow` in runner/src/telos.ts. */
export interface RunnerServer {
  /** The slug, which the server's tools are named under. */
  id: string;
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  hiddenTools?: string[];
  hooks?: unknown[];
}

/** The servers an agent reaches, and what its list named that is not there. */
export interface AgentServers {
  servers: RunnerServer[];
  /** One line for each slug that names no server, for the run to show. */
  notices: string[];
}

/**
 * A registry row as the runner reads one, secrets included.
 *
 * @param server - The row.
 * @returns It, with what is empty left out.
 */
export function runnerServer(server: dbSchema.McpServer): RunnerServer {
  return {
    id: server.slug,
    name: server.name,
    ...(server.url ? { url: server.url } : {}),
    ...(server.command ? { command: server.command } : {}),
    ...(server.args.length > 0 ? { args: server.args } : {}),
    ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(server.hiddenTools.length > 0 ? { hiddenTools: server.hiddenTools } : {}),
    ...(server.hooks.length > 0 ? { hooks: server.hooks } : {}),
  };
}

/**
 * The servers an agent may reach. Its list is one of three things: absent
 * (null), which is every server the account has; empty, which is none; or
 * slugs, which is exactly those. A list only ever narrows: a slug that names
 * no server is dropped and said, never read as "all". A server switched off is
 * left out without a word, since switching it off was the word.
 *
 * In slug order whatever order the list is in, so the tools a run is offered
 * come in the same order every time and the prompt's prefix stays cacheable.
 *
 * @param db - The database, or the transaction the run is claimed in.
 * @param agent - The agent, with whose it is.
 * @returns The servers, and a notice for each slug that resolved to nothing.
 */
export async function serversFor(
  db: AnyRow,
  agent: Pick<dbSchema.Agent, 'userId' | 'name' | 'mcpServerSlugs'>,
): Promise<AgentServers> {
  const named = Array.isArray(agent.mcpServerSlugs)
    ? agent.mcpServerSlugs.filter((slug): slug is string => typeof slug === 'string')
    : null;
  if (named !== null && named.length === 0) {
    return { servers: [], notices: [] };
  }
  const registry: dbSchema.McpServer[] = await db
    .select()
    .from(dbSchema.mcpServers)
    .where(eq(dbSchema.mcpServers.userId, agent.userId))
    .orderBy(asc(dbSchema.mcpServers.slug));
  const known = new Set(registry.map((server) => server.slug));
  const wanted = named === null ? null : new Set(named);
  const servers = registry
    .filter((server) => server.enabled && (wanted === null || wanted.has(server.slug)))
    .map(runnerServer);
  const notices = [...(wanted ?? [])]
    .filter((slug) => known.has(slug) === false)
    .sort()
    .map((slug) => `${agent.name} names an MCP server "${slug}" that no longer exists, so it was left out.`);
  return { servers, notices };
}

/**
 * An agent as the runner is handed it: with the servers it reaches worked out.
 *
 * @param db - The database, or the transaction the run is claimed in.
 * @param agent - The agent's row, key included.
 * @returns The row, its servers as JSON, and what to say about them.
 */
export async function runnerAgent(db: AnyRow, agent: dbSchema.Agent) {
  const { servers, notices } = await serversFor(db, agent);
  return { ...agent, mcpServers: JSON.stringify(servers), mcpNotices: notices };
}
