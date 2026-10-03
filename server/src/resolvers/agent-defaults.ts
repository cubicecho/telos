import * as dbSchema from '@telos/db/schema';
import { resolveAgent } from '@telos/runner/spec';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { LAYER_FIELDS, loadAgentDefaults } from '../agent-defaults.ts';
import { requireAi } from '../ai-gate.ts';
import type { Context } from '../context.ts';
import { requireSession } from './auth.ts';

// The account's agent defaults (db/src/models/agent-defaults.ts): read and set
// by a person in Settings, as their agents are (`requireSession`), and closed
// to AI and the runner by the actor lock. The table generates nothing, so a missing row can read as "no
// defaults" and a save can be one upsert of the whole layer. The key is
// write-only, as an agent's is: `hasApiKey` says whether there is one.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const AGENT_DEFAULTS_SDL = parse(`
  """
  What your agents inherit. A field an agent leaves blank comes from here, and
  one left blank here from agent-core's own defaults. Blank is null: zero and
  an empty string are values.
  """
  type AgentDefaults {
    "Your account's id: there is one set of defaults per account."
    id: ID!
    baseUrl: String
    model: String
    temperature: Float
    maxTokens: Int
    contextLength: Int
    maxToolIterations: Int
    toolDiscovery: Boolean
    toolSelectModel: String
    reasoningEffort: String
    requestTimeoutSeconds: Int
    maxRetries: Int
    "Whether a default API key is stored. The key itself is never readable."
    hasApiKey: Boolean!
    "What an agent that leaves a field blank gets for it: these, with agent-core's own beneath."
    resolved: ResolvedAgentSettings!
    "What a field left blank here falls to: agent-core's own defaults."
    builtIn: ResolvedAgentSettings!
  }

  "Agent settings as a run would be given them. An empty baseUrl or model is none."
  type ResolvedAgentSettings {
    baseUrl: String!
    model: String!
    temperature: Float!
    "Zero sends no ceiling and leaves it to the endpoint."
    maxTokens: Int!
    "Zero asks the endpoint."
    contextLength: Int!
    maxToolIterations: Int!
    toolDiscovery: Boolean!
    "Empty is none: tools are not preselected."
    toolSelectModel: String!
    "Empty or off sends none: the endpoint's own."
    reasoningEffort: String!
    "Null is no limit."
    requestTimeoutSeconds: Int
    maxRetries: Int!
  }

  "Your agent defaults, whole: a field left out or null is blank."
  input AgentDefaultsInput {
    baseUrl: String
    model: String
    temperature: Float
    maxTokens: Int
    contextLength: Int
    maxToolIterations: Int
    toolDiscovery: Boolean
    toolSelectModel: String
    reasoningEffort: String
    requestTimeoutSeconds: Int
    maxRetries: Int
  }

  extend type Query {
    "What your agents inherit."
    agentDefaults: AgentDefaults!
  }

  extend type Mutation {
    "Replaces what your agents inherit."
    setAgentDefaults(values: AgentDefaultsInput!): AgentDefaults!
    "Stores the default API key, or clears it with null. It is sent only to the default endpoint."
    setAgentDefaultsApiKey(apiKey: String): AgentDefaults!
  }
`);

type LayerField = (typeof LAYER_FIELDS)[number];
type LayerValues = Partial<Record<LayerField, string | number | boolean | null>>;

const badInput = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * The defaults as a person reads them: without the key, with what they resolve to.
 *
 * @param userId - Whose.
 * @param row - The row, or null for none.
 * @returns The `AgentDefaults` value.
 */
function visible(userId: string, row: dbSchema.AgentDefaults | null) {
  const own = Object.fromEntries(LAYER_FIELDS.map((field) => [field, row?.[field] ?? null]));
  return { id: userId, ...own, hasApiKey: !!row?.apiKey, resolved: settings(row), builtIn: settings(null) };
}

/**
 * What an agent that leaves every field blank resolves to over a layer.
 *
 * @param row - The layer, or null for agent-core's own alone.
 * @returns A `ResolvedAgentSettings` value.
 */
function settings(row: dbSchema.AgentDefaults | null) {
  const { config } = resolveAgent(row, {});
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    contextLength: config.contextLength,
    maxToolIterations: config.maxToolIterations,
    toolDiscovery: config.toolDiscovery !== 'eager',
    toolSelectModel: config.toolSelectModel,
    reasoningEffort: config.reasoningEffort ?? '',
    requestTimeoutSeconds: config.requestTimeoutSeconds ?? null,
    maxRetries: config.maxRetries,
  };
}

/**
 * The input as a row's columns: strings trimmed, blank strings null, and every
 * value the agent spec would drop refused with what is wrong.
 *
 * @param values - What was sent.
 * @returns The columns.
 */
function columns(values: LayerValues): Record<LayerField, string | number | boolean | null> {
  const row = Object.fromEntries(
    LAYER_FIELDS.map((field) => {
      const value = values[field];
      if (typeof value === 'string') return [field, value.trim() || null];
      return [field, value ?? null];
    }),
  ) as Record<LayerField, string | number | boolean | null>;
  // The runner drops a value the spec will not take; better to say so now.
  const { warnings } = resolveAgent(row as dbSchema.AgentDefaults, {});
  if (warnings.length > 0) throw badInput(warnings.map((warning) => warning.replace(/^defaults: /, '')).join('; '));
  if (typeof row.maxToolIterations === 'number' && row.maxToolIterations < 1) {
    throw badInput('Tool iterations must be at least 1.');
  }
  return row;
}

/**
 * Adds the account's agent defaults to the schema.
 *
 * @param schema - The schema so far.
 * @returns The schema with `agentDefaults` and its two mutations.
 */
export function applyAgentDefaultsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AGENT_DEFAULTS_SDL);
  const queries = (extendedSchema.getType('Query') as GraphQLObjectType).getFields();
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  queries.agentDefaults.resolve = async (_parent: unknown, _args: unknown, context: Context) => {
    requireSession(context);
    const userId = await requireAi(context);
    return visible(userId, await loadAgentDefaults(context.db, userId));
  };

  mutations.setAgentDefaults.resolve = async (_parent: unknown, args: { values: LayerValues }, context: Context) => {
    requireSession(context);
    const userId = await requireAi(context);
    const set = columns(args.values);
    const [row] = await (context.db as AnyRow)
      .insert(dbSchema.agentDefaults)
      .values({ userId, ...set })
      .onConflictDoUpdate({ target: dbSchema.agentDefaults.userId, set: { ...set, updatedAt: new Date() } })
      .returning();
    return visible(userId, row);
  };

  mutations.setAgentDefaultsApiKey.resolve = async (
    _parent: unknown,
    args: { apiKey?: string | null },
    context: Context,
  ) => {
    requireSession(context);
    const userId = await requireAi(context);
    const apiKey = args.apiKey?.trim() || null;
    const [row] = await (context.db as AnyRow)
      .insert(dbSchema.agentDefaults)
      .values({ userId, apiKey })
      .onConflictDoUpdate({ target: dbSchema.agentDefaults.userId, set: { apiKey, updatedAt: new Date() } })
      .returning();
    return visible(userId, row);
  };

  return extendedSchema;
}
