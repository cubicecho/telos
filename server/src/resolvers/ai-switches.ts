import * as dbSchema from '@telos/db/schema';
import { and, eq } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { MutationResolvers } from '../../__generated__/resolvers.ts';
import { requireAi } from '../ai-gate.ts';
import { attachResolvers } from '../attach-resolvers.ts';
import { badInput, forbidden, notFound } from '../errors.ts';
import { isAdmin, setInstanceAi } from '../instance.ts';
import { cancelRunsUnder, dropRunRequests } from '../ready.ts';
import { MAX_RETENTION_DAYS } from '../retention.ts';
import { authConfigFor, requireSession } from './auth.ts';

// The instance's, the account's and a project's AI switches. Only a person with a session
// flips them — a key or an agent switching AI on for itself would defeat the
// point — and only through here, never a generated write (write-guards.ts),
// because switching off is also where whatever AI was doing gets stopped: its
// running runs are asked to stop, and their tokens stop resolving at once.
//
// The switches nest: a project's only means anything while its owner's is on,
// and switching the account off leaves each project's setting where it was, so
// switching it back on restores the board the user had.
//
// A project has a second switch under its first: auto-run, whether its lanes' agents
// start on todos by themselves. It stops nothing when it goes off.
//
// The instance's switch is an admin's: it decides for every account at once.
//
// Applied only when the server offers AI (AI_ENABLED is not false). Without it
// there is nothing to switch.

const AI_SWITCHES_SDL = parse(`
  extend type Mutation {
    "Switches AI on or off for the whole instance. Admins only. Off, no account can use AI."
    setInstanceAiEnabled(enabled: Boolean!): AuthConfig!
    "Switches AI on or off for the whole account. Off, no key, agent or run touches any of it."
    setAiEnabled(enabled: Boolean!): User!
    "Opens a project to agents, or closes it. Opening one needs the account's AI on."
    setProjectAiEnabled(projectId: ID!, enabled: Boolean!): Project!
    "Lets a project's lanes' agents start on todos by themselves, or only when asked (runTodo). Off, running work finishes."
    setProjectAutoRun(projectId: ID!, enabled: Boolean!): Project!
    "How many days finished runs are kept before they are pruned. Null keeps them for good."
    setRunRetention(days: Int): User!
  }
`);

export function applyAiSwitchesExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AI_SWITCHES_SDL);
  const mutations: MutationResolvers = {};

  mutations.setInstanceAiEnabled = async (_parent, args, context) => {
    const userId = requireSession(context);
    if (!(await isAdmin(context.db, userId))) {
      throw forbidden('Only an admin can switch AI for the instance.');
    }
    await setInstanceAi(context.db, args.enabled);
    if (!args.enabled) await cancelRunsUnder(context.db, {});
    return authConfigFor(context, args.enabled, true);
  };

  mutations.setAiEnabled = async (_parent, args, context) => {
    const userId = requireSession(context);
    const [user] = await context.db
      .update(dbSchema.users)
      .set({ aiEnabled: args.enabled, updatedAt: new Date() })
      .where(eq(dbSchema.users.id, userId))
      .returning();
    if (!args.enabled) await cancelRunsUnder(context.db, { userId });
    return user;
  };

  mutations.setProjectAiEnabled = async (_parent, args, context) => {
    // Closing a project is always allowed; opening one is an AI action, and
    // for an account with AI off there is no such thing.
    const userId = requireSession(context);
    if (args.enabled) await requireAi(context);
    const [project] = await context.db
      .update(dbSchema.projects)
      .set({ aiEnabled: args.enabled, updatedAt: new Date() })
      .where(and(eq(dbSchema.projects.id, args.projectId), eq(dbSchema.projects.userId, userId)))
      .returning();
    if (!project) throw notFound('Project');
    if (!args.enabled) {
      await cancelRunsUnder(context.db, { userId, projectId: project.id });
      await dropRunRequests(context.db, { projectId: project.id });
    }
    return project;
  };

  mutations.setProjectAutoRun = async (_parent, args, context) => {
    // Off is always allowed and stops nothing: what is running finishes, and
    // nothing new starts. On is an AI action, like opening the project.
    const userId = requireSession(context);
    if (args.enabled) {
      await requireAi(context);
    }
    const [project] = await context.db
      .update(dbSchema.projects)
      .set({ autoRun: args.enabled, updatedAt: new Date() })
      .where(and(eq(dbSchema.projects.id, args.projectId), eq(dbSchema.projects.userId, userId)))
      .returning();
    if (project === undefined) {
      throw notFound('Project');
    }
    return project;
  };

  mutations.setRunRetention = async (_parent, args, context) => {
    const userId = requireSession(context);
    const days = args.days ?? null;
    if (days !== null && (days < 1 || days > MAX_RETENTION_DAYS)) {
      throw badInput(`Keep runs for 1 to ${MAX_RETENTION_DAYS} days, or for good.`);
    }
    const [user] = await context.db
      .update(dbSchema.users)
      .set({ runRetentionDays: days, updatedAt: new Date() })
      .where(eq(dbSchema.users.id, userId))
      .returning();
    return user;
  };

  return attachResolvers(extendedSchema, { Mutation: mutations });
}
