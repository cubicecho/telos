import * as dbSchema from '@telos/db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import type { Context } from '../context.ts';
import { requireAuth } from './auth.ts';

// Board templates: a project's lanes, and their station settings, saved to
// start another project from. Listing, renaming and deleting one is generated
// CRUD; saving reads the board, and applying writes one, so those are here.
//
// Applying replaces a board, so it is only for a project with no todos yet —
// archived ones included, since they still sit in its lanes.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

type TemplateLane = dbSchema.TemplateLane;

const BOARD_TEMPLATES_SDL = parse(`
  extend type Mutation {
    "Saves a project's lanes and their station settings as a template, replacing one of the same name."
    saveBoardTemplate(projectId: ID!, name: String!): BoardTemplate!
    "Gives a project with no todos a template's lanes, in place of the ones it has."
    applyBoardTemplate(projectId: ID!, templateId: ID!): Project!
  }
`);

/** The most lanes a template may hold. */
const MAX_LANES = 50;
const MAX_NAME = 100;
const CONTRACTS = new Set(['work', 'verdict', 'expand']);

const badInput = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
const notFound = (what: string) => new GraphQLError(`${what} not found`, { extensions: { code: 'NOT_FOUND' } });

/**
 * The caller's project, or NOT_FOUND.
 *
 * @param db The database or transaction.
 * @param projectId The project.
 * @param userId Its owner, supposedly.
 * @returns The project.
 */
async function ownedProject(db: AnyRow, projectId: string, userId: string) {
  const [project] = await db
    .select()
    .from(dbSchema.projects)
    .where(and(eq(dbSchema.projects.id, projectId), eq(dbSchema.projects.userId, userId)));
  if (!project) throw notFound('Project');
  return project;
}

/**
 * A template's lanes, checked, since a person may have edited them directly.
 *
 * @param value What is stored.
 * @returns The lanes.
 */
export function checkTemplateLanes(value: unknown): TemplateLane[] {
  if (!Array.isArray(value) || value.length === 0) throw badInput('A template needs at least one lane.');
  if (value.length > MAX_LANES) throw badInput(`A template holds at most ${MAX_LANES} lanes.`);
  const index = (at: unknown) => {
    if (at == null) return null;
    if (!Number.isInteger(at) || (at as number) < 0 || (at as number) >= value.length) {
      throw badInput('A station in the template sends its todos to a lane it does not have.');
    }
    return at as number;
  };
  const lanes = value.map((raw): TemplateLane => {
    const lane = (raw ?? {}) as Record<string, unknown>;
    const name = typeof lane.name === 'string' ? lane.name.trim() : '';
    if (!name || name.length > MAX_NAME) throw badInput('Every lane in a template needs a name.');
    const contract = lane.contract ?? 'work';
    if (typeof contract !== 'string' || !CONTRACTS.has(contract)) throw badInput(`"${name}" has an unknown contract.`);
    const wipLimit = lane.wipLimit ?? 1;
    const maxAttempts = lane.maxAttempts ?? 3;
    if (!Number.isInteger(wipLimit) || (wipLimit as number) < 1)
      throw badInput(`"${name}" needs a WIP limit of 1 or more.`);
    if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 0) {
      throw badInput(`"${name}" needs 0 or more attempts.`);
    }
    return {
      name,
      isDone: lane.isDone === true,
      agentId: typeof lane.agentId === 'string' ? lane.agentId : null,
      contract: contract as TemplateLane['contract'],
      prompt: typeof lane.prompt === 'string' ? lane.prompt : null,
      onSuccess: index(lane.onSuccess),
      onFailure: index(lane.onFailure),
      wipLimit: wipLimit as number,
      maxAttempts: maxAttempts as number,
    };
  });
  if (lanes.filter((lane) => lane.isDone).length > 1) throw badInput('A template may have only one done lane.');
  return lanes;
}

export function applyBoardTemplatesExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, BOARD_TEMPLATES_SDL);
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  mutations.saveBoardTemplate.resolve = async (
    _parent: unknown,
    args: { projectId: string; name: string },
    context: Context,
  ) => {
    const userId = requireAuth(context);
    const name = args.name.trim();
    if (!name || name.length > MAX_NAME) throw badInput(`Name the template, in ${MAX_NAME} characters or fewer.`);
    const db = context.db as AnyRow;
    await ownedProject(db, args.projectId, userId);
    const rows = await db
      .select()
      .from(dbSchema.lanes)
      .where(eq(dbSchema.lanes.projectId, args.projectId))
      .orderBy(asc(dbSchema.lanes.position), asc(dbSchema.lanes.createdAt));
    const at = new Map<string, number>(rows.map((lane: { id: string }, i: number) => [lane.id, i]));
    const lanes: TemplateLane[] = rows.map((lane: dbSchema.Lane) => ({
      name: lane.name,
      isDone: lane.isDone,
      agentId: lane.agentId,
      contract: lane.contract,
      prompt: lane.prompt,
      onSuccess: lane.onSuccessLaneId ? (at.get(lane.onSuccessLaneId) ?? null) : null,
      onFailure: lane.onFailureLaneId ? (at.get(lane.onFailureLaneId) ?? null) : null,
      wipLimit: lane.wipLimit,
      maxAttempts: lane.maxAttempts,
    }));
    const [template] = await db
      .insert(dbSchema.boardTemplates)
      .values({ userId, name, lanes })
      .onConflictDoUpdate({
        target: [dbSchema.boardTemplates.userId, dbSchema.boardTemplates.name],
        set: { lanes, updatedAt: new Date() },
      })
      .returning();
    return template;
  };

  mutations.applyBoardTemplate.resolve = async (
    _parent: unknown,
    args: { projectId: string; templateId: string },
    context: Context,
  ) => {
    const userId = requireAuth(context);
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const project = await ownedProject(tx, args.projectId, userId);
      const [template] = await tx
        .select()
        .from(dbSchema.boardTemplates)
        .where(and(eq(dbSchema.boardTemplates.id, args.templateId), eq(dbSchema.boardTemplates.userId, userId)));
      if (!template) throw notFound('Template');
      const lanes = checkTemplateLanes(template.lanes);

      const [todo] = await tx
        .select({ id: dbSchema.todos.id })
        .from(dbSchema.todos)
        .where(eq(dbSchema.todos.projectId, project.id))
        .limit(1);
      if (todo) {
        throw new GraphQLError('Only a board with no todos, archived ones included, can take a template.', {
          extensions: { code: 'CONFLICT' },
        });
      }

      // An agent the template names that is gone, or not the caller's, leaves
      // its lane a plain lane.
      const named = [...new Set(lanes.map((lane) => lane.agentId).filter((id): id is string => !!id))];
      const agents = named.length
        ? new Set(
            (
              await tx
                .select({ id: dbSchema.agents.id })
                .from(dbSchema.agents)
                .where(and(inArray(dbSchema.agents.id, named), eq(dbSchema.agents.userId, userId)))
            ).map((row: { id: string }) => row.id),
          )
        : new Set<string>();

      await tx.delete(dbSchema.lanes).where(eq(dbSchema.lanes.projectId, project.id));
      const inserted = await tx
        .insert(dbSchema.lanes)
        .values(
          lanes.map((lane, position) => ({
            userId,
            projectId: project.id,
            name: lane.name,
            position,
            isDone: lane.isDone,
            agentId: lane.agentId && agents.has(lane.agentId) ? lane.agentId : null,
            contract: lane.contract ?? 'work',
            prompt: lane.prompt ?? null,
            wipLimit: lane.wipLimit ?? 1,
            maxAttempts: lane.maxAttempts ?? 3,
          })),
        )
        .returning({ id: dbSchema.lanes.id, position: dbSchema.lanes.position });
      const ids = new Map<number, string>(
        inserted.map((row: { id: string; position: number }) => [row.position, row.id]),
      );
      for (const [position, lane] of lanes.entries()) {
        if (lane.onSuccess == null && lane.onFailure == null) continue;
        await tx
          .update(dbSchema.lanes)
          .set({
            onSuccessLaneId: lane.onSuccess == null ? null : ids.get(lane.onSuccess),
            onFailureLaneId: lane.onFailure == null ? null : ids.get(lane.onFailure),
          })
          .where(eq(dbSchema.lanes.id, ids.get(position) as string));
      }
      return project;
    });
  };

  return extendedSchema;
}
