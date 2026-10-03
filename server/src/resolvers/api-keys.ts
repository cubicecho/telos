import * as dbSchema from '@telos/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi } from '../ai-gate.ts';
import { mintApiKey } from '../auth.ts';
import type { Context } from '../context.ts';
import { DOOR_TOOL_NAMES, DOOR_TOOLS, NOT_FOR_RUNS, onForRuns } from '../door.ts';
import { requireSession } from './auth.ts';

// API keys: how an MCP host reaches this server as one of its users. They are
// the AI door, so this whole extension exists only when the instance has AI
// on, and every field needs the account's AI switch on too. Only a person
// with a session manages keys; a key cannot mint, list or revoke keys, nor
// change its own switches.
//
// Minting goes through better-auth, which owns the hashing. Listing and
// revoking are plain reads and deletes on the table. A key's switches, one per
// tool of the door, are kept beside it (`api_key_tools`): every tool is on
// until its owner turns it off, and auth.ts reads them when the key is used.

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

  type CreatedApiKey {
    apiKey: ApiKey!
    "The key itself. Shown this once: only a hash of it is stored."
    key: String!
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
    "Mints a key for an MCP client. \`expiresInDays\` is 1 to 365; omitted, the key never expires."
    createApiKey(name: String!, expiresInDays: Int): CreatedApiKey!
    "Revokes a key. False when there was no such key."
    deleteApiKey(id: ID!): Boolean!
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

async function requireKeyManager(ctx: Context): Promise<string> {
  const userId = requireSession(ctx);
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

  const query = (extended.getType('Query') as GraphQLObjectType).getFields();
  query.apiKeys.resolve = async (_parent: unknown, _args: unknown, ctx: Context) => {
    const userId = await requireKeyManager(ctx);
    return keysOf(ctx, userId);
  };

  query.mcpTools.resolve = async (_parent: unknown, _args: unknown, ctx: Context) => {
    await requireKeyManager(ctx);
    return DOOR_TOOLS.map((tool) => ({ ...tool, forRuns: !NOT_FOR_RUNS.has(tool.name), runDefault: onForRuns(tool) }));
  };

  const mutation = (extended.getType('Mutation') as GraphQLObjectType).getFields();
  mutation.createApiKey.resolve = async (
    _parent: unknown,
    args: { name: string; expiresInDays?: number | null },
    ctx: Context,
  ) => {
    const userId = await requireKeyManager(ctx);
    const name = args.name.trim();
    if (!name) throw new GraphQLError('A key needs a name', { extensions: { code: 'BAD_USER_INPUT' } });
    const days = args.expiresInDays;
    if (days != null && (days < 1 || days > 365)) {
      throw new GraphQLError('expiresInDays must be 1 to 365', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    const { id, key } = await mintApiKey(ctx.auth, { userId, name, expiresInDays: days });
    const [apiKey] = await ctx.db.select(KEY_COLUMNS).from(dbSchema.apikeys).where(eq(dbSchema.apikeys.id, id));
    return { apiKey: withSwitches(apiKey, []), key };
  };

  mutation.deleteApiKey.resolve = async (_parent: unknown, args: { id: string }, ctx: Context) => {
    const userId = await requireKeyManager(ctx);
    if (!UUID.test(args.id)) return false;
    const deleted = await ctx.db
      .delete(dbSchema.apikeys)
      .where(and(eq(dbSchema.apikeys.id, args.id), eq(dbSchema.apikeys.referenceId, userId)))
      .returning({ id: dbSchema.apikeys.id });
    return deleted.length > 0;
  };

  mutation.setApiKeyTools.resolve = async (_parent: unknown, args: { id: string; off: string[] }, ctx: Context) => {
    const userId = await requireKeyManager(ctx);
    const unknown = args.off.filter((name) => !DOOR_TOOL_NAMES.has(name));
    if (unknown.length > 0) {
      throw new GraphQLError(`The MCP door has no tool ${unknown.join(', ')}.`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    const [owned] = UUID.test(args.id) ? await keysOf(ctx, userId, args.id) : [];
    if (owned === undefined) {
      throw new GraphQLError('API key not found', { extensions: { code: 'NOT_FOUND' } });
    }
    const off = [...new Set(args.off)];
    await ctx.db
      .insert(dbSchema.apiKeyTools)
      .values({ keyId: args.id, userId, off })
      .onConflictDoUpdate({ target: dbSchema.apiKeyTools.keyId, set: { off, updatedAt: new Date() } });
    return withSwitches(owned, off);
  };

  return extended;
}
