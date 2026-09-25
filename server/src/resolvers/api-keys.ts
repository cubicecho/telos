import * as dbSchema from '@telos/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi } from '../ai-gate.ts';
import { mintApiKey } from '../auth.ts';
import type { Context } from '../context.ts';
import { requireSession } from './auth.ts';

// API keys: how an MCP host reaches this server as one of its users. They are
// the AI door, so this whole extension exists only when the instance has AI
// on, and every field needs the account's AI switch on too. Only a person
// with a session manages keys; a key cannot mint, list or revoke keys.
//
// Minting goes through better-auth, which owns the hashing. Listing and
// revoking are plain reads and deletes on the table.

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
  }

  type CreatedApiKey {
    apiKey: ApiKey!
    "The key itself. Shown this once: only a hash of it is stored."
    key: String!
  }

  extend type Query {
    apiKeys: [ApiKey!]!
  }

  extend type Mutation {
    "Mints a key for an MCP client. \`expiresInDays\` is 1 to 365; omitted, the key never expires."
    createApiKey(name: String!, expiresInDays: Int): CreatedApiKey!
    "Revokes a key. False when there was no such key."
    deleteApiKey(id: ID!): Boolean!
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireKeyManager(ctx: Context): Promise<string> {
  const userId = requireSession(ctx);
  await requireAi(ctx);
  return userId;
}

export function applyApiKeysExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, API_KEYS_SDL);

  const query = (extended.getType('Query') as GraphQLObjectType).getFields();
  query.apiKeys.resolve = async (_parent: unknown, _args: unknown, ctx: Context) => {
    const userId = await requireKeyManager(ctx);
    return ctx.db
      .select(KEY_COLUMNS)
      .from(dbSchema.apikeys)
      .where(eq(dbSchema.apikeys.referenceId, userId))
      .orderBy(desc(dbSchema.apikeys.createdAt));
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
    return { apiKey, key };
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

  return extended;
}
