import * as dbSchema from '@telos/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { MutationResolvers, QueryResolvers } from '../../__generated__/resolvers.ts';
import { requireAi } from '../ai/gate.ts';
import type { Context } from '../core/context.ts';
import { badInput, notFound } from '../core/errors.ts';
import { attachResolvers } from '../graphql/attach-resolvers.ts';
import { DOOR_TOOL_NAMES, DOOR_TOOLS, NOT_FOR_RUNS, onForRuns } from '../mcp/door.ts';
import { requireAuth } from './resolvers.ts';

// API keys: how an MCP host reaches this server as one of its users. They are
// the AI door, so this whole extension exists only when the instance has AI
// on, and every field needs the account's AI switch on too. Only a person
// with a session manages keys; a key cannot mint, list or revoke keys, nor
// change its own switches.
//
// Minting and revoking are better-auth's own `createApiKey` and `deleteApiKey`,
// served by auth/endpoints.ts behind `requireKeyManager`. Listing is a
// plain read of the table. A key's switches, one per tool of the door, are
// kept beside it (`api_key_tools`, gone with the key): every tool is on until
// its owner turns it off, and auth.ts reads them when the key is used.

const API_KEYS_SDL = parse(`
  "An API key, without the key: only its first characters are kept in the clear."
  type ApiKey {
    id: ID!
    name: String
    "The key's first characters, to tell keys apart."
    start: String
    createdAt: DateTime!
    "When the key was last used, if ever."
    lastRequest: DateTime
    "When the key stops working. Null never expires."
    expiresAt: DateTime
    "The MCP door's tools switched off for this key. Every other tool is on."
    toolsOff: [String!]!
  }

  "One tool of the MCP door, as a key's or an agent's switches list it."
  type McpTool {
    name: String!
    "What the tool does, as an MCP client is told."
    description: String!
    "Whether it changes anything, rather than only reading."
    writes: Boolean!
    "Whether an agent's runs may have it at all. One that may not is off for every run."
    forRuns: Boolean!
    "Whether a run has it when its agent's \`toolsOff\` is null: every read, and adding work and notes."
    runDefault: Boolean!
  }

  extend type Query {
    apiKeys: [ApiKey!]!
    "Every tool of the MCP door, in the order a client is shown them. Settings lists a key's and an agent's switches from it."
    mcpTools: [McpTool!]!
  }

  extend type Mutation {
    "Says which of the MCP door's tools are off for a key, replacing the list it had. Every tool not named is on."
    setApiKeyTools(id: ID!, off: [String!]!): ApiKey!
  }
`);

const KEY_COLUMNS = {
  id: dbSchema.apikeys.id,
  name: dbSchema.apikeys.name,
  start: dbSchema.apikeys.start,
  createdAt: dbSchema.apikeys.createdAt,
  lastRequest: dbSchema.apikeys.lastRequest,
  expiresAt: dbSchema.apikeys.expiresAt,
};

/** A key's columns, as `KEY_COLUMNS` reads them. */
interface KeyRow {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: Date;
  lastRequest: Date | null;
  expiresAt: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only a person with AI on manages keys: their fields are a person's alone
 * (graphql/permissions.ts), so a key cannot mint its own successor.
 *
 * @param ctx The request.
 * @returns The caller.
 */
export async function requireKeyManager(ctx: Context): Promise<string> {
  const userId = requireAuth(ctx);
  await requireAi(ctx);
  return userId;
}

/**
 * A key's row with its switches, in door order. A tool the door no longer has
 * is left out: its switch has nothing to switch.
 *
 * @param key The key's columns.
 * @param off The names stored as off for it.
 * @returns The key as the API gives it.
 */
function withSwitches<T>(key: T, off: readonly string[] | null | undefined): T & { toolsOff: string[] } {
  const stored = new Set(off ?? []);
  return { ...key, toolsOff: DOOR_TOOLS.map((tool) => tool.name).filter((name) => stored.has(name)) };
}

/**
 * The caller's keys, with their switches.
 *
 * @param ctx The request.
 * @param userId The caller.
 * @param id One key, or all of them when left out.
 * @returns The keys, newest first.
 */
async function keysOf(ctx: Context, userId: string, id?: string) {
  const rows: Array<{ key: KeyRow; off: string[] | null }> = await ctx.db
    .select({ key: KEY_COLUMNS, off: dbSchema.apiKeyTools.off })
    .from(dbSchema.apikeys)
    .leftJoin(dbSchema.apiKeyTools, eq(dbSchema.apiKeyTools.keyId, dbSchema.apikeys.id))
    .where(and(eq(dbSchema.apikeys.referenceId, userId), id ? eq(dbSchema.apikeys.id, id) : undefined))
    .orderBy(desc(dbSchema.apikeys.createdAt));
  return rows.map((row) => withSwitches(row.key, row.off));
}

export function applyApiKeysExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, API_KEYS_SDL);

  const query: QueryResolvers = {};
  query.apiKeys = async (_parent, _args, ctx) => {
    const userId = await requireKeyManager(ctx);
    return keysOf(ctx, userId);
  };

  query.mcpTools = async (_parent, _args, ctx) => {
    await requireKeyManager(ctx);
    return DOOR_TOOLS.map((tool) => ({ ...tool, forRuns: !NOT_FOR_RUNS.has(tool.name), runDefault: onForRuns(tool) }));
  };

  const mutation: MutationResolvers = {};
  mutation.setApiKeyTools = async (_parent, args, ctx) => {
    const userId = await requireKeyManager(ctx);
    const unknown = args.off.filter((name) => !DOOR_TOOL_NAMES.has(name));
    if (unknown.length > 0) {
      throw badInput(`The MCP door has no tool ${unknown.join(', ')}.`);
    }
    const [owned] = UUID.test(args.id) ? await keysOf(ctx, userId, args.id) : [];
    if (owned === undefined) {
      throw notFound('API key');
    }
    const off = [...new Set(args.off)];
    await ctx.db
      .insert(dbSchema.apiKeyTools)
      .values({ keyId: args.id, userId, off })
      .onConflictDoUpdate({ target: dbSchema.apiKeyTools.keyId, set: { off, updatedAt: new Date() } });
    return withSwitches(owned, off);
  };

  return attachResolvers(extended, { Query: query, Mutation: mutation });
}
