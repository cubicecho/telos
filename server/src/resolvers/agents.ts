import * as dbSchema from '@telos/db/schema';
import { keyFor } from '@telos/runner/spec';
import { and, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { loadAgentDefaults } from '../agent-defaults.ts';
import { requireAi, requireSystem } from '../ai-gate.ts';
import type { Context } from '../context.ts';
import { askProbe, finishProbe, type McpProbe, readProbe, takeProbes } from '../mcp-probes.ts';
import { runnerServer } from '../mcp-servers.ts';
import { markRunnerSeen } from '../runner-seen.ts';
import { requireSession } from './auth.ts';

// An agent's API key, which is write-only. The column is excluded from the
// generated schema (build-schema.ts), so the only way in is this mutation and
// the only way out is the runner's `claimRun`. A person can see whether one is
// set, never what it is.
//
// An MCP server's headers and env are the same kind of thing, kept the same
// way: `setMcpServerSecret` writes one, the runner reads them with the run it
// claims, and a person sees their names.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const AGENTS_SDL = parse(`
  extend type Agent {
    "Whether an API key is stored for this agent. The key itself is never readable."
    hasApiKey: Boolean!
  }

  extend type McpServer {
    "The names of the headers stored for this server. Their values are never readable."
    headerNames: [String!]!
    "The names of the environment variables stored for this server. Their values are never readable."
    envNames: [String!]!
  }

  "Which of an MCP server's secrets: a header sent to its URL, or a variable in its command's environment."
  enum McpSecretKind {
    header
    env
  }

  "A model an endpoint offers, as its \`/models\` lists it."
  type AgentModel {
    id: String!
    "How many tokens it takes in, when the endpoint says."
    contextLength: Int
  }

  "A tool an MCP server offered when it was tested."
  type McpProbeTool {
    name: String!
    description: String!
  }

  "A test of an MCP server, made by the runner."
  type McpProbe {
    id: ID!
    "pending (waiting for the runner), testing, or done."
    status: String!
    ok: Boolean!
    tools: [McpProbeTool!]!
    "What the server says about itself, when it says anything."
    instructions: String!
    error: String
  }

  "A test waiting for the runner: the server row, as JSON."
  type RunnerProbe {
    id: ID!
    server: String!
  }

  input McpProbeToolInput {
    name: String!
    description: String!
  }

  input ProbeResultInput {
    ok: Boolean!
    tools: [McpProbeToolInput!]!
    instructions: String
    error: String
  }

  extend type Query {
    "A test of an MCP server you asked for. Null once it is forgotten, after a couple of minutes."
    mcpProbe(id: ID!): McpProbe
    "The MCP server tests waiting to be made. The runner's only; taking them marks them taken."
    runnerProbes: [RunnerProbe!]!
    """
    The models \`baseUrl\` offers, asked with the key a run would send there:
    \`agentId\`'s own when one is given and it has one, else your default key
    when \`baseUrl\` is your default endpoint. For picking a model while
    setting an agent, or your defaults, up.
    """
    agentModels(baseUrl: String!, agentId: ID): [AgentModel!]!
  }

  extend type Mutation {
    "Stores an agent's API key, or clears it with null."
    setAgentApiKey(agentId: ID!, apiKey: String): Agent!
    "Stores one header or environment variable of an MCP server, or removes it with a null value."
    setMcpServerSecret(id: ID!, kind: McpSecretKind!, name: String!, value: String): McpServer!
    "Asks the runner to connect to one of your MCP servers and list its tools. Read the answer with mcpProbe; the server keeps what was found."
    testMcpServer(id: ID!): McpProbe!
    "Records what a test found. The runner's only."
    finishProbe(id: ID!, result: ProbeResultInput!): Boolean!
  }
`);

/** How long an endpoint gets to list its models. */
export const MODELS_TIMEOUT_MS = 5000;

/** The most models returned: a picker, not an inventory. */
const MODELS_LIMIT = 500;

/** The most of a server's tools, and of each description, a test keeps. */
const PROBE_TOOLS = 200;
const PROBE_TEXT_CHARS = 1000;

const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/** A test as a person reads it: without whose it is or the row it tested. */
function visibleProbe(probe: McpProbe) {
  const { userId: _user, serverId: _serverId, server: _server, askedAt: _at, ...visible } = probe;
  return visible;
}

interface AgentModel {
  id: string;
  contextLength: number | null;
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/** The longest name and value a header or a variable may have. */
const SECRET_NAME_CHARS = 200;
const SECRET_VALUE_CHARS = 8000;
/** The most headers, and the most variables, one server keeps. */
const SECRET_LIMIT = 50;
/** A header's name, as HTTP spells a token. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** A variable's name, as a shell would take it. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The caller's MCP server, secrets and all, or NOT_FOUND.
 *
 * @param db The database or a transaction.
 * @param userId Whose it must be.
 * @param id The server.
 * @param lock Whether to hold the row until the transaction ends.
 * @returns The row.
 */
async function ownedServer(db: AnyRow, userId: string, id: string, lock = false): Promise<dbSchema.McpServer> {
  const query = db
    .select()
    .from(dbSchema.mcpServers)
    .where(and(eq(dbSchema.mcpServers.id, id), eq(dbSchema.mcpServers.userId, userId)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new GraphQLError('MCP server not found', { extensions: { code: 'NOT_FOUND' } });
  return row;
}

/** A server as a person reads it: without what its headers and env hold. */
function visibleServer(server: dbSchema.McpServer) {
  const { headers: _headers, env: _env, ...visible } = server;
  return visible;
}

/**
 * Asks an OpenAI-compatible endpoint what it serves. Only the model ids (and a
 * context length, where the endpoint reports one) come back, never the body,
 * so the call says nothing about a URL beyond whether it lists models.
 *
 * @param baseUrl The endpoint, as an agent's base URL.
 * @param apiKey The bearer key, if any.
 * @returns The models, sorted by id.
 */
export async function listModels(baseUrl: string, apiKey: string | null): Promise<AgentModel[]> {
  let url: URL;
  try {
    url = new URL(`${baseUrl.trim().replace(/\/+$/, '')}/models`);
  } catch {
    throw badInput('That base URL is not a URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badInput('A base URL is http or https.');
  let response: Response;
  try {
    response = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw badInput(`Could not reach ${url.origin}.`);
  }
  if (!response.ok) throw badInput(`${url.origin} answered ${response.status} when asked for its models.`);
  // biome-ignore lint/suspicious/noExplicitAny: an endpoint's own JSON
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw badInput(`${url.origin} did not answer with a list of models.`);
  }
  // OpenAI's shape is `{ data: [...] }`; Ollama's native one is `{ models: [...] }`.
  const rows: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const models = new Map<string, AgentModel>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : null;
    if (!id) continue;
    const length = entry.context_length ?? entry.max_context_length ?? entry.context_window;
    const contextLength = typeof length === 'number' && length > 0 ? Math.floor(length) : null;
    models.set(id, { id, contextLength: contextLength ?? models.get(id)?.contextLength ?? null });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MODELS_LIMIT);
}

export function applyAgentsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AGENTS_SDL);
  const agent = (extendedSchema.getType('Agent') as GraphQLObjectType).getFields();
  const mcpServer = (extendedSchema.getType('McpServer') as GraphQLObjectType).getFields();
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();
  const queries = (extendedSchema.getType('Query') as GraphQLObjectType).getFields();

  queries.agentModels.resolve = async (
    _parent: unknown,
    args: { baseUrl: string; agentId?: string | null },
    context: Context,
  ) => {
    // A person only: an agent or a key has no business making the server
    // fetch a URL of its choosing.
    requireSession(context);
    const userId = await requireAi(context);
    let own: string | null = null;
    if (args.agentId) {
      const [row] = await (context.db as AnyRow)
        .select({ apiKey: dbSchema.agents.apiKey })
        .from(dbSchema.agents)
        .where(and(eq(dbSchema.agents.id, args.agentId), eq(dbSchema.agents.userId, userId)));
      if (!row) throw new GraphQLError('Agent not found', { extensions: { code: 'NOT_FOUND' } });
      own = row.apiKey;
    }
    const defaults = await loadAgentDefaults(context.db, userId);
    return listModels(args.baseUrl, keyFor(args.baseUrl, own, defaults));
  };

  queries.mcpProbe.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    requireSession(context);
    const userId = await requireAi(context);
    const probe = readProbe(args.id, userId);
    return probe ? visibleProbe(probe) : null;
  };

  queries.runnerProbes.resolve = (_parent: unknown, _args: unknown, context: Context) => {
    requireSystem(context);
    markRunnerSeen();
    return takeProbes().map(({ id, server }) => ({ id, server }));
  };

  mutations.testMcpServer.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    // A person only, as with the models: it has a process dial where it is told.
    requireSession(context);
    const userId = await requireAi(context);
    const server = await ownedServer(context.db, userId, args.id);
    const probe = askProbe(userId, server.id, JSON.stringify(runnerServer(server)));
    if (!probe) throw badInput('Some tests are still waiting; try again when they are done.');
    return visibleProbe(probe);
  };

  mutations.finishProbe.resolve = async (
    _parent: unknown,
    args: {
      id: string;
      result: {
        ok: boolean;
        tools: Array<{ name: string; description: string }>;
        instructions?: string | null;
        error?: string | null;
      };
    },
    context: Context,
  ) => {
    requireSystem(context);
    const { ok, tools, instructions, error } = args.result;
    const probe = finishProbe(args.id, {
      ok,
      tools: tools.slice(0, PROBE_TOOLS).map((tool) => ({
        name: cut(tool.name, 200),
        description: cut(tool.description, PROBE_TEXT_CHARS),
      })),
      instructions: cut(instructions ?? '', PROBE_TEXT_CHARS * 4),
      error: ok ? null : cut(error || 'The server could not be reached.', PROBE_TEXT_CHARS),
    });
    if (!probe) return false;
    // Kept on the server's row, so its page can say what it offered after the
    // test itself is forgotten. A failed test keeps the tools the last good one found.
    await (context.db as AnyRow)
      .update(dbSchema.mcpServers)
      .set({
        checkedAt: new Date(),
        checkOk: probe.ok,
        checkError: probe.error,
        ...(probe.ok ? { tools: probe.tools } : {}),
      })
      .where(and(eq(dbSchema.mcpServers.id, probe.serverId), eq(dbSchema.mcpServers.userId, probe.userId)));
    return true;
  };

  // The generated resolvers never select an excluded column, so ask.
  const secretNames =
    (column: 'headers' | 'env') => async (parent: { id: string }, _args: unknown, context: Context) => {
      const [row] = await (context.db as AnyRow)
        .select({ secrets: dbSchema.mcpServers[column] })
        .from(dbSchema.mcpServers)
        .where(eq(dbSchema.mcpServers.id, parent.id));
      return Object.keys(row?.secrets ?? {}).sort();
    };
  mcpServer.headerNames.resolve = secretNames('headers');
  mcpServer.envNames.resolve = secretNames('env');

  mutations.setMcpServerSecret.resolve = async (
    _parent: unknown,
    args: { id: string; kind: 'header' | 'env'; name: string; value?: string | null },
    context: Context,
  ) => {
    const userId = requireSession(context);
    const name = args.name.trim();
    const pattern = args.kind === 'header' ? HEADER_NAME : ENV_NAME;
    if (name.length > SECRET_NAME_CHARS || !pattern.test(name)) {
      throw badInput(
        args.kind === 'header'
          ? 'A header name is letters, digits and dashes, such as Authorization.'
          : 'A variable name is letters, digits and underscores, and does not start with a digit, such as API_TOKEN.',
      );
    }
    if ((args.value?.length ?? 0) > SECRET_VALUE_CHARS) {
      throw badInput(`A value can be at most ${SECRET_VALUE_CHARS} characters.`);
    }
    const column = args.kind === 'header' ? 'headers' : 'env';
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const server = await ownedServer(tx, userId, args.id, true);
      const secrets = { ...server[column] };
      if (args.value == null || args.value === '') delete secrets[name];
      else secrets[name] = args.value;
      if (Object.keys(secrets).length > SECRET_LIMIT) {
        throw badInput(`A server keeps at most ${SECRET_LIMIT} of these. Remove one first.`);
      }
      const [row] = await tx
        .update(dbSchema.mcpServers)
        .set({ [column]: secrets })
        .where(eq(dbSchema.mcpServers.id, server.id))
        .returning();
      return visibleServer(row);
    });
  };

  // The generated resolvers never select an excluded column, so ask.
  agent.hasApiKey.resolve = async (parent: { id: string }, _args: unknown, context: Context) => {
    const [row] = await (context.db as AnyRow)
      .select({ apiKey: dbSchema.agents.apiKey })
      .from(dbSchema.agents)
      .where(eq(dbSchema.agents.id, parent.id));
    return !!row?.apiKey;
  };

  mutations.setAgentApiKey.resolve = async (
    _parent: unknown,
    args: { agentId: string; apiKey?: string | null },
    context: Context,
  ) => {
    const userId = requireSession(context);
    const [row] = await (context.db as AnyRow)
      .update(dbSchema.agents)
      .set({ apiKey: args.apiKey?.trim() || null })
      .where(and(eq(dbSchema.agents.id, args.agentId), eq(dbSchema.agents.userId, userId)))
      .returning();
    if (!row) throw new GraphQLError('Agent not found', { extensions: { code: 'NOT_FOUND' } });
    const { apiKey: _secret, ...visible } = row;
    return visible;
  };

  return extendedSchema;
}
