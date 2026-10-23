import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { MutationResolvers, QueryResolvers } from '../../__generated__/resolvers.ts';
import { requireAi } from '../ai/gate.ts';
import { attachResolvers } from '../graphql/attach-resolvers.ts';
import { DEFAULT_AGENT_INSTRUCTIONS } from './prompts.ts';

// The account's agent instructions (`users.agentInstructions`): what every
// agent of the account is told first, whatever its prompt, at the top of a
// run's system prompt (`assignmentFor` in runs/resolvers.ts). Null is the
// built-in default, so the default can improve under an account that never
// changed it, and "Reset to default" in the app is writing null.
//
// A person's only, as an agent's prompt is: they are instructions, and an
// agent that could rewrite them could widen its own job. `users` takes no
// generated writes (tenancy.ts), so this is the one way in.
//
// Applied only when the server offers AI.

const AGENT_INSTRUCTIONS_SDL = parse(`
  extend type Query {
    "What every agent is told first while an account has written none of its own (User.agentInstructions null)."
    defaultAgentInstructions: String!
  }

  extend type Mutation {
    "Replaces what every agent of this account is told first, whatever its prompt. Null or blank resets it to the default."
    setAgentInstructions(instructions: String): User!
  }
`);

/**
 * What an account's agents are told first: its own instructions, or the default.
 *
 * @param own - The account's `agentInstructions`.
 * @returns The instructions a run is handed.
 */
export function agentInstructionsOf(own: string | null | undefined): string {
  return own?.trim() ? own : DEFAULT_AGENT_INSTRUCTIONS;
}

export function applyAgentInstructionsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AGENT_INSTRUCTIONS_SDL);
  const queries: QueryResolvers = {};
  const mutations: MutationResolvers = {};

  queries.defaultAgentInstructions = async (_parent, _args, context) => {
    await requireAi(context);
    return DEFAULT_AGENT_INSTRUCTIONS;
  };

  mutations.setAgentInstructions = async (_parent, args, context) => {
    const userId = await requireAi(context);
    // The default is stored as null, not copied, so saving it unchanged is a reset too.
    const text = args.instructions?.trim();
    const own = text && text !== DEFAULT_AGENT_INSTRUCTIONS.trim() ? text : null;
    const [user] = await context.db
      .update(dbSchema.users)
      .set({ agentInstructions: own, updatedAt: new Date() })
      .where(eq(dbSchema.users.id, userId))
      .returning();
    return user;
  };

  return attachResolvers(extendedSchema, { Query: queries, Mutation: mutations });
}
