import * as dbSchema from '@telos/db/schema';
import { and, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi } from '../ai-gate.ts';
import type { Context } from '../context.ts';
import { cancelRunsUnder } from '../stations.ts';
import { requireSession } from './auth.ts';

// The account's and a project's AI switches. Only a person with a session
// flips them — a key or an agent switching AI on for itself would defeat the
// point — and only through here, never a generated write (write-guards.ts),
// because switching off is also where whatever AI was doing gets stopped: its
// running runs are asked to stop, and their tokens stop resolving at once.
//
// The switches nest: a project's only means anything while its owner's is on,
// and switching the account off leaves each project's setting where it was, so
// switching it back on restores the board the user had.
//
// Applied only when the instance has AI on. With it off there is nothing to
// switch.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const AI_SWITCHES_SDL = parse(`
  extend type Mutation {
    "Switches AI on or off for the whole account. Off, no key, agent or run touches any of it."
    setAiEnabled(enabled: Boolean!): User!
    "Opens a project to agents, or closes it. Opening one needs the account's AI on."
    setProjectAiEnabled(projectId: ID!, enabled: Boolean!): Project!
  }
`);

export function applyAiSwitchesExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AI_SWITCHES_SDL);
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  mutations.setAiEnabled.resolve = async (_parent: unknown, args: { enabled: boolean }, context: Context) => {
    const userId = requireSession(context);
    const [user] = await (context.db as AnyRow)
      .update(dbSchema.users)
      .set({ aiEnabled: args.enabled, updatedAt: new Date() })
      .where(eq(dbSchema.users.id, userId))
      .returning();
    if (!args.enabled) await cancelRunsUnder(context.db, { userId });
    return user;
  };

  mutations.setProjectAiEnabled.resolve = async (
    _parent: unknown,
    args: { projectId: string; enabled: boolean },
    context: Context,
  ) => {
    // Closing a project is always allowed; opening one is an AI action, and
    // for an account with AI off there is no such thing.
    const userId = requireSession(context);
    if (args.enabled) await requireAi(context);
    const [project] = await (context.db as AnyRow)
      .update(dbSchema.projects)
      .set({ aiEnabled: args.enabled, updatedAt: new Date() })
      .where(and(eq(dbSchema.projects.id, args.projectId), eq(dbSchema.projects.userId, userId)))
      .returning();
    if (!project) throw new GraphQLError('Project not found', { extensions: { code: 'NOT_FOUND' } });
    if (!args.enabled) await cancelRunsUnder(context.db, { userId, projectId: project.id });
    return project;
  };

  return extendedSchema;
}
