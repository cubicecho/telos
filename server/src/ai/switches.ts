import * as dbSchema from '@telos/db/schema';
import { and, eq } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { MutationResolvers, QueryResolvers } from '../../__generated__/resolvers.ts';
import { authConfigFor, requireAuth } from '../auth/resolvers.ts';
import type { Context } from '../core/context.ts';
import { AiModeEnum, withEnums } from '../core/enums.ts';
import { badInput, forbidden, notFound } from '../core/errors.ts';
import { attachResolvers } from '../graphql/attach-resolvers.ts';
import { instanceRunLimit, isAdmin, MAX_RUN_LIMIT, setInstanceAi, setInstanceRunLimit } from '../instance/settings.ts';
import { cancelRunsUnder, dropFollows, dropRunRequests } from '../runs/ready.ts';
import { MAX_RETENTION_DAYS } from '../runs/retention.ts';
import { requireAi } from './gate.ts';

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
// A project's switch is one of four modes (AiMode, setProjectAiMode): off, or on
// with a run mode saying how far its lanes' agents go by themselves — every
// ready todo (auto), one lane per ask (lane), or every lane after one ask
// (follow). Changing the run mode stops nothing that is running.
//
// The instance's switch is an admin's: it decides for every account at once.
// So is its run limit, the most runs every runner works at once between them.
//
// Applied only when the server offers AI (AI_ENABLED is not false). Without it
// there is nothing to switch.

const AI_SWITCHES_SDL = parse(`
  extend type Query {
    "The most runs the instance works at once, across every runner and account. Admins only."
    instanceRunLimit: Int!
  }

  extend type Mutation {
    "Switches AI on or off for the whole instance. Admins only. Off, no account can use AI."
    setInstanceAiEnabled(enabled: Boolean!): AuthConfig!
    "Sets the most runs the instance works at once, 1 to ${MAX_RUN_LIMIT}. Admins only. Lowering it stops nothing that is running."
    setInstanceRunLimit(limit: Int!): Int!
    "Switches AI on or off for the whole account. Off, no key, agent or run touches any of it."
    setAiEnabled(enabled: Boolean!): User!
    "Opens a project to agents, or closes it. Opening one needs the account's AI on."
    setProjectAiEnabled(projectId: ID!, enabled: Boolean!): Project!
    """
    Sets how far AI works a project. OFF closes it to agents, as setProjectAiEnabled(false)
    does. AUTO, LANE and FOLLOW open it (which needs the account's AI on) and say
    how far its lanes' agents go by themselves. A run mode changed stops nothing
    that is running; leaving FOLLOW forgets which todos were followed.
    """
    setProjectAiMode(projectId: ID!, mode: AiMode!): Project!
    "How many days finished runs are kept before they are pruned. Null keeps them for good."
    setRunRetention(days: Int): User!
  }
`);

export function applyAiSwitchesExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(withEnums(schema, [AiModeEnum]), AI_SWITCHES_SDL);
  const queries: QueryResolvers = {};
  const mutations: MutationResolvers = {};

  queries.instanceRunLimit = async (_parent, _args, context) => {
    await requireAdmin(context, "Only an admin can see the instance's run limit.");
    return instanceRunLimit(context.db);
  };

  mutations.setInstanceRunLimit = async (_parent, args, context) => {
    await requireAdmin(context, "Only an admin can set the instance's run limit.");
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_RUN_LIMIT) {
      throw badInput(`Work 1 to ${MAX_RUN_LIMIT} runs at once.`);
    }
    await setInstanceRunLimit(context.db, args.limit);
    return args.limit;
  };

  mutations.setInstanceAiEnabled = async (_parent, args, context) => {
    const userId = requireAuth(context);
    if (!(await isAdmin(context.db, userId))) {
      throw forbidden('Only an admin can switch AI for the instance.');
    }
    await setInstanceAi(context.db, args.enabled);
    if (!args.enabled) await cancelRunsUnder(context.db, {});
    return authConfigFor(context, args.enabled, true);
  };

  mutations.setAiEnabled = async (_parent, args, context) => {
    const userId = requireAuth(context);
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
    const userId = requireAuth(context);
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

  mutations.setProjectAiMode = async (_parent, args, context) => {
    // OFF is always allowed, and stops what was running; any other mode opens
    // the project, an AI action, so it needs the account's AI on. A run mode
    // changed stops nothing: what is running finishes.
    const userId = requireAuth(context);
    const on = args.mode !== 'off';
    if (on) await requireAi(context);
    const [project] = await context.db
      .update(dbSchema.projects)
      .set({ aiEnabled: on, ...(on ? { runMode: args.mode } : {}), updatedAt: new Date() })
      .where(and(eq(dbSchema.projects.id, args.projectId), eq(dbSchema.projects.userId, userId)))
      .returning();
    if (project === undefined) throw notFound('Project');
    if (!on) {
      await cancelRunsUnder(context.db, { userId, projectId: project.id });
      await dropRunRequests(context.db, { projectId: project.id });
    } else if (args.mode !== 'follow') {
      await dropFollows(context.db, project.id);
    }
    return project;
  };

  mutations.setRunRetention = async (_parent, args, context) => {
    const userId = requireAuth(context);
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

  return attachResolvers(extendedSchema, { Query: queries, Mutation: mutations });
}

/**
 * Refuses anyone but an admin with a session.
 *
 * @param context - The request.
 * @param message - What to say to anyone else.
 */
async function requireAdmin(context: Context, message: string): Promise<void> {
  const userId = requireAuth(context);
  if (!(await isAdmin(context.db, userId))) throw forbidden(message);
}
