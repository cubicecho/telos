import * as dbSchema from '@telos/db/schema';
import { and, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { type BoardChange, boardEventsFor } from '../board-events.ts';
import type { Context } from '../context.ts';
import { requireAuth } from './auth.ts';

// Live boards: `boardChanged` says a project changed, and which table, as each
// change commits. It carries no rows: the client refetches through the queries
// it already has, so what it may see is decided in one place, the scope.
//
// For the person who owns the project. An MCP client or an agent works a board
// through tools and cannot hold a socket open, so it has no use for one.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const BOARD_CHANGES_SDL = (hasRoot: boolean) =>
  parse(`
  "A change to a board. Refetch what it names; the change itself carries no rows."
  type BoardChange {
    projectId: ID!
    "The table the change was in: todos, lanes, runs, todo_notes and so on."
    table: String!
  }

  ${hasRoot ? 'extend type Subscription' : 'type Subscription'} {
    "Each change to one of your projects, as it commits, whoever made it."
    boardChanged(projectId: ID!): BoardChange!
  }

  ${hasRoot ? '' : 'extend schema { subscription: Subscription }'}
`);

export function applyBoardChangesExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, BOARD_CHANGES_SDL(!!schema.getSubscriptionType()));
  const fields = (extendedSchema.getType('Subscription') as GraphQLObjectType).getFields();

  fields.boardChanged.subscribe = async (_parent: unknown, args: { projectId: string }, context: Context) => {
    const userId = requireAuth(context);
    if (context.actor.kind !== 'user') {
      throw new GraphQLError('Only a person can watch a board.', { extensions: { code: 'FORBIDDEN' } });
    }
    const [project] = await (context.db as AnyRow)
      .select({ id: dbSchema.projects.id })
      .from(dbSchema.projects)
      .where(and(eq(dbSchema.projects.id, args.projectId), eq(dbSchema.projects.userId, userId)));
    if (!project) throw new GraphQLError('Project not found', { extensions: { code: 'NOT_FOUND' } });

    const events = boardEventsFor(context.db);
    await events.listening();
    return events.watch(userId, project.id);
  };
  fields.boardChanged.resolve = (change: BoardChange) => ({ projectId: change.projectId, table: change.table });

  return extendedSchema;
}
