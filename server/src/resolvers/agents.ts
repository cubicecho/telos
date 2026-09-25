import * as dbSchema from '@telos/db/schema';
import { and, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import type { Context } from '../context.ts';
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

  extend type Mutation {
    "Stores an agent's API key, or clears it with null."
    setAgentApiKey(agentId: ID!, apiKey: String): Agent!
  }
`);

export function applyAgentsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AGENTS_SDL);
  const agent = (extendedSchema.getType('Agent') as GraphQLObjectType).getFields();
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

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
