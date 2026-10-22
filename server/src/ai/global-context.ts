import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { MutationResolvers, QueryResolvers } from '../../__generated__/resolvers.ts';
import { attachResolvers } from '../graphql/attach-resolvers.ts';
import { requireAi } from './gate.ts';

// The account's global context (`users.globalContext`): what every agent of
// the account should know, whichever project it works in. It is the base
// layer of a run's system prompt, under the project's context and prompt
// (`assignmentFor` in runs/resolvers.ts).
//
// It is a context, as a project's is, not an instruction: a person writes it
// in Settings, and AI may keep it up to date, so both read and write it
// through here (the door's `global_context` and `set_global_context`). It
// lives on the account's own row rather than in `agent_defaults`, which is a
// server table closed to AI and the agent spec's layer, not the prompt's.
// `users` takes no generated writes (tenancy.ts), so this is the one way in.
//
// Applied only when the server offers AI.

const GLOBAL_CONTEXT_SDL = parse(`
  extend type Query {
    "What every agent of this account is told, whichever project it works in. Null when nothing is."
    globalContext: String
  }

  extend type Mutation {
    "Replaces what every agent of this account is told, whichever project it works in. Null or blank clears it."
    setGlobalContext(context: String): User!
  }
`);

export function applyGlobalContextExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, GLOBAL_CONTEXT_SDL);
  const queries: QueryResolvers = {};
  const mutations: MutationResolvers = {};

  queries.globalContext = async (_parent, _args, context) => {
    const userId = await requireAi(context);
    const [user] = await context.db
      .select({ globalContext: dbSchema.users.globalContext })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, userId));
    return user?.globalContext ?? null;
  };

  mutations.setGlobalContext = async (_parent, args, context) => {
    const userId = await requireAi(context);
    const text = args.context?.trim() ? args.context.trim() : null;
    const [user] = await context.db
      .update(dbSchema.users)
      .set({ globalContext: text, updatedAt: new Date() })
      .where(eq(dbSchema.users.id, userId))
      .returning();
    return user;
  };

  return attachResolvers(extendedSchema, { Query: queries, Mutation: mutations });
}
