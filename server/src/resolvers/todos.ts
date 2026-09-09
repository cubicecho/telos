import * as dbSchema from '@telos/db/schema';
import { and, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { assertNoCycle, assertNotBlocked } from '../blocking.ts';
import type { Context } from '../context.ts';
import { requireAuth } from './auth.ts';

// What generated CRUD cannot express: the derived fields the project screen
// reads, and the two state transitions that carry rules — completing a todo
// (which the dependency graph can forbid) and adding a dependency edge (which
// must not close a cycle).

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const TODOS_SDL = parse(`
  extend type Todo {
    "Whether any todo this one depends on is still open."
    isBlocked: Boolean!
    "The open todos standing in the way, if any."
    blockedBy: [Todo!]!
  }

  extend type Project {
    todoCount: Int!
    openTodoCount: Int!
  }

  extend type Mutation {
    "Marks a todo done. Fails while any todo it depends on is still open."
    completeTodo(id: ID!): Todo!
    reopenTodo(id: ID!): Todo!
    "Makes \`todoId\` wait on \`dependsOnTodoId\`. Rejects cycles."
    addTodoDependency(todoId: ID!, dependsOnTodoId: ID!): Todo!
    removeTodoDependency(todoId: ID!, dependsOnTodoId: ID!): Todo!
  }
`);

/**
 * A todo the caller owns, or NOT_FOUND. The hand-written mutations sit outside
 * the generated resolvers, so they do not inherit the `scope` from tenancy.ts
 * and have to state ownership themselves.
 */
async function loadOwnedTodo(context: Context, id: string): Promise<AnyRow> {
  const userId = requireAuth(context);
  const rows = await (context.db as AnyRow)
    .select()
    .from(dbSchema.todos)
    .where(and(eq(dbSchema.todos.id, id), eq(dbSchema.todos.userId, userId)))
    .limit(1);
  if (rows.length === 0) {
    throw new GraphQLError('Todo not found', { extensions: { code: 'NOT_FOUND' } });
  }
  return rows[0];
}

async function setCompletedAt(context: Context, id: string, completedAt: Date | null): Promise<AnyRow> {
  const [updated] = await (context.db as AnyRow)
    .update(dbSchema.todos)
    .set({ completedAt, updatedAt: new Date() })
    .where(and(eq(dbSchema.todos.id, id), eq(dbSchema.todos.userId, requireAuth(context))))
    .returning();
  if (!updated) throw new GraphQLError('Todo not found', { extensions: { code: 'NOT_FOUND' } });
  return updated;
}

export function applyTodosExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, TODOS_SDL);

  const todoFields = (extendedSchema.getType('Todo') as GraphQLObjectType).getFields();
  todoFields.isBlocked.resolve = (parent: AnyRow, _args: unknown, context: Context) =>
    context.loaders.blocked.load(String(parent.id));
  todoFields.blockedBy.resolve = (parent: AnyRow, _args: unknown, context: Context) =>
    context.loaders.blockers.load(String(parent.id));

  const projectFields = (extendedSchema.getType('Project') as GraphQLObjectType).getFields();
  projectFields.todoCount.resolve = async (parent: AnyRow, _args: unknown, context: Context) =>
    (await context.loaders.todoCounts.load(String(parent.id))).total;
  projectFields.openTodoCount.resolve = async (parent: AnyRow, _args: unknown, context: Context) =>
    (await context.loaders.todoCounts.load(String(parent.id))).open;

  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  mutations.completeTodo.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    const todo = await loadOwnedTodo(context, args.id);
    if (todo.completedAt != null) return todo;
    await assertNotBlocked(context.db, [args.id]);
    return setCompletedAt(context, args.id, new Date());
  };

  mutations.reopenTodo.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    const todo = await loadOwnedTodo(context, args.id);
    if (todo.completedAt == null) return todo;
    return setCompletedAt(context, args.id, null);
  };

  mutations.addTodoDependency.resolve = async (
    _parent: unknown,
    args: { todoId: string; dependsOnTodoId: string },
    context: Context,
  ) => {
    const userId = requireAuth(context);
    // Both ends must be the caller's — otherwise the edge would leak whether a
    // stranger's todo exists, and later report it as a blocker.
    const [todo, blocker] = await Promise.all([
      loadOwnedTodo(context, args.todoId),
      loadOwnedTodo(context, args.dependsOnTodoId),
    ]);
    if (todo.completedAt != null && blocker.completedAt == null) {
      // Otherwise the todo would sit completed and blocked at once, and
      // `isBlocked` would stop meaning "cannot be completed".
      throw new GraphQLError('Reopen this todo before making it depend on an open one.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    await assertNoCycle(context.db, args.todoId, args.dependsOnTodoId);
    await (context.db as AnyRow)
      .insert(dbSchema.todoDependencies)
      .values({ userId, todoId: args.todoId, dependsOnTodoId: args.dependsOnTodoId })
      .onConflictDoNothing();
    return loadOwnedTodo(context, args.todoId);
  };

  mutations.removeTodoDependency.resolve = async (
    _parent: unknown,
    args: { todoId: string; dependsOnTodoId: string },
    context: Context,
  ) => {
    const userId = requireAuth(context);
    await (context.db as AnyRow)
      .delete(dbSchema.todoDependencies)
      .where(
        and(
          eq(dbSchema.todoDependencies.userId, userId),
          eq(dbSchema.todoDependencies.todoId, args.todoId),
          eq(dbSchema.todoDependencies.dependsOnTodoId, args.dependsOnTodoId),
        ),
      );
    return loadOwnedTodo(context, args.todoId);
  };

  return extendedSchema;
}
