import * as dbSchema from '@telos/db/schema';
import { and, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi, requireSystem } from '../ai-gate.ts';
import type { Context } from '../context.ts';
import { askProbe, finishProbe, type McpProbe, readProbe, takeProbes } from '../mcp-probes.ts';
import { markRunnerSeen } from '../runner-seen.ts';
import { requireSession } from './auth.ts';

// An agent's API key, which is write-only. The column is excluded from the
// generated schema (build-schema.ts), so the only way in is this mutation and
// the only way out is the runner's `claimRun`. A person can see whether one is
// set, never what it is.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const AGENTS_SDL = parse(`
  extend type Agent {
    "Whether an API key is stored for this agent. The key itself is never readable."
    hasApiKey: Boolean!
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
    The models \`baseUrl\` offers, asked with \`agentId\`'s stored key when one is
    given. For picking a model while setting an agent up.
    """
    agentModels(baseUrl: String!, agentId: ID): [AgentModel!]!
  }

  extend type Mutation {
    "Stores an agent's API key, or clears it with null."
    setAgentApiKey(agentId: ID!, apiKey: String): Agent!
    "Asks the runner to connect to an MCP server row (JSON, saved or not) and list its tools. Read the answer with mcpProbe."
    testMcpServer(server: String!): McpProbe!
    "Records what a test found. The runner's only."
    finishProbe(id: ID!, result: ProbeResultInput!): Boolean!
  }
`);

/** How long an endpoint gets to list its models. */
export const MODELS_TIMEOUT_MS = 5000;

/** The most models returned: a picker, not an inventory. */
const MODELS_LIMIT = 500;

/** The longest server row a test takes: a row is a URL and a few headers. */
const PROBE_SERVER_CHARS = 20_000;
/** The most of a server's tools, and of each description, a test keeps. */
const PROBE_TOOLS = 200;
const PROBE_TEXT_CHARS = 1000;

/**
 * A server row a test can be made of, as JSON, or why not.
 *
 * @param json What was sent.
 * @returns The row, re-serialized.
 */
function probeServer(json: string): string {
  if (json.length > PROBE_SERVER_CHARS) throw badInput('That server is too long to test.');
  let row: unknown;
  try {
    row = JSON.parse(json);
  } catch {
    throw badInput('The server is not JSON.');
  }
  const { id, url, command } = (row ?? {}) as Record<string, unknown>;
  if (!row || typeof row !== 'object' || Array.isArray(row) || typeof id !== 'string' || !id) {
    throw badInput('A server needs an id.');
  }
  if (typeof url === 'string' && url.trim()) {
    const protocol = URL.canParse(url) ? new URL(url).protocol : '';
    if (protocol !== 'http:' && protocol !== 'https:') throw badInput('The URL must be http or https.');
  } else if (typeof command !== 'string' || !command.trim()) {
    throw badInput('Give the server a URL or a command first.');
  }
  return JSON.stringify(row);
}

const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/** A test as a person reads it: without whose it is or the row it tested. */
function visibleProbe(probe: McpProbe) {
  const { userId: _user, server: _server, askedAt: _at, ...visible } = probe;
  return visible;
}

interface AgentModel {
  id: string;
  contextLength: number | null;
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
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
    let apiKey: string | null = null;
    if (args.agentId) {
      const [row] = await (context.db as AnyRow)
        .select({ apiKey: dbSchema.agents.apiKey })
        .from(dbSchema.agents)
        .where(and(eq(dbSchema.agents.id, args.agentId), eq(dbSchema.agents.userId, userId)));
      if (!row) throw new GraphQLError('Agent not found', { extensions: { code: 'NOT_FOUND' } });
      apiKey = row.apiKey;
    }
    return listModels(args.baseUrl, apiKey);
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

  mutations.testMcpServer.resolve = async (_parent: unknown, args: { server: string }, context: Context) => {
    // A person only, as with the models: it has a process dial where it is told.
    requireSession(context);
    const userId = await requireAi(context);
    const probe = askProbe(userId, probeServer(args.server));
    if (!probe) throw badInput('Some tests are still waiting; try again when they are done.');
    return visibleProbe(probe);
  };

  mutations.finishProbe.resolve = (
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
    return finishProbe(args.id, {
      ok,
      tools: tools.slice(0, PROBE_TOOLS).map((tool) => ({
        name: cut(tool.name, 200),
        description: cut(tool.description, PROBE_TEXT_CHARS),
      })),
      instructions: cut(instructions ?? '', PROBE_TEXT_CHARS * 4),
      error: ok ? null : cut(error || 'The server could not be reached.', PROBE_TEXT_CHARS),
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
