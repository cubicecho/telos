import * as dbSchema from '@telos/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { assertNoCycle, assertNotBlocked } from '../blocking.ts';
import { appLink } from '../config.ts';
import { type Context, isAiActor } from '../context.ts';
import { findDoneLaneId, findFirstOpenLaneId } from '../lanes.ts';
import { stampActor } from '../provenance.ts';
import { requireAuth } from './auth.ts';

// What generated CRUD cannot express: the derived fields the project screen
// reads, and the two state transitions that carry rules — completing a todo
// (which the dependency graph can forbid) and adding a dependency edge (which
// must not close a cycle, one at a time or as a whole list).

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const TODOS_SDL = parse(`
  extend type Todo {
    "Whether any todo this one depends on is still open."
    isBlocked: Boolean!
    "The open todos standing in the way, if any."
    blockedBy: [Todo!]!
    """
    Where the todo opens in the app, for anything outside it that wants to link
    back: \`APP_URL\` + \`/todos/<id>\`. It follows the todo from project to project.
    """
    url: String!
  }

  extend type Project {
    todoCount: Int!
    openTodoCount: Int!
    "Where the project opens in the app: \`APP_URL\` + \`/projects/<id>\`."
    url: String!
  }

  extend type Mutation {
    "Marks a todo done. Fails while any todo it depends on is still open. \`reason\` goes on the todo's history."
    completeTodo(id: ID!, reason: String): Todo!
    reopenTodo(id: ID!, reason: String): Todo!
    "Makes \`todoId\` wait on \`dependsOnTodoId\`. Rejects cycles."
    addTodoDependency(todoId: ID!, dependsOnTodoId: ID!): Todo!
    removeTodoDependency(todoId: ID!, dependsOnTodoId: ID!): Todo!
    """
    Replaces everything a todo waits on with \`dependsOn\`, in one transaction:
    all of it lands or none does. Rejects a list that would close a cycle,
    naming the todos in it. An empty list clears them.
    """
    setTodoDependencies(id: ID!, dependsOn: [ID!]!): Todo!
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
    .where(and(eq(dbSchema.todos.id, id), eq(dbSchema.todos.userId, userId), isNull(dbSchema.todos.archivedAt)))
    .limit(1);
  if (rows.length === 0) {
    throw new GraphQLError('Todo not found', { extensions: { code: 'NOT_FOUND' } });
  }
  return rows[0];
}

/** Refuses an edge that would leave `todo` completed and waiting at once. */
function assertNotCompletedBehind(todo: AnyRow, blocker: AnyRow): void {
  if (todo.completedAt != null && blocker.completedAt == null) {
    // Otherwise the todo would sit completed and blocked at once, and
    // `isBlocked` would stop meaning "cannot be completed".
    throw new GraphQLError('Reopen this todo before making it depend on an open one.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}

/**
 * Flips a todo's completion and moves it to the column that agrees — into the
 * project's done lane, or back out to its first open one. The list's checkbox
 * and the board are two renderings of the same fact, so one never moves without
 * the other; see lanes.ts for the invariant.
 *
 * A project with no done lane (or no open one) leaves `laneId` alone: there is
 * no column to move to, and dropping the todo off the board would be a larger
 * change than ticking a checkbox asked for.
 */
async function setCompletedAt(
  context: Context,
  todo: AnyRow,
  completedAt: Date | null,
  reason: string | null | undefined,
): Promise<AnyRow> {
  const userId = requireAuth(context);
  return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
    await stampActor(tx, context.actor, { reason });
    const laneId = completedAt
      ? await findDoneLaneId(tx, todo.projectId)
      : await findFirstOpenLaneId(tx, todo.projectId);
    const [updated] = await tx
      .update(dbSchema.todos)
      .set({ completedAt, updatedAt: new Date(), ...(laneId ? { laneId } : {}) })
      .where(and(eq(dbSchema.todos.id, todo.id), eq(dbSchema.todos.userId, userId)))
      .returning();
    if (!updated) throw new GraphQLError('Todo not found', { extensions: { code: 'NOT_FOUND' } });
    return updated;
  });
}

/**
 * The blockers an AI caller may see. The loader reads rows directly, outside
 * the tenancy scope, so a blocker the user told AI to ignore — or one in a
 * project closed to AI — would otherwise hand over its title. `isBlocked`
 * still counts them: that a todo is waiting is not a secret, what on is.
 */
async function visibleToAi(context: Context, blockers: AnyRow[]): Promise<AnyRow[]> {
  const candidates = blockers.filter((row) => !row.aiIgnored);
  if (candidates.length === 0) return [];
  const projectIds = [...new Set(candidates.map((row) => String(row.projectId)))];
  const open: Array<{ id: string }> = await (context.db as AnyRow)
    .select({ id: dbSchema.projects.id })
    .from(dbSchema.projects)
    .where(and(inArray(dbSchema.projects.id, projectIds), eq(dbSchema.projects.aiEnabled, true)));
  const openIds = new Set(open.map((row) => String(row.id)));
  return candidates.filter((row) => openIds.has(String(row.projectId)));
}

/**
 * Which of a caller's todos AI may not see: ignored, archived, or in a project
 * closed to AI.
 *
 * @param context The request.
 * @param userId The caller.
 * @param ids The todos to ask about.
 * @returns The ids among them that are hidden.
 */
async function hiddenFromAi(context: Context, userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) {
    return [];
  }
  const seen: Array<{ id: string }> = await (context.db as AnyRow)
    .select({ id: dbSchema.todos.id })
    .from(dbSchema.todos)
    .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.todos.projectId))
    .where(
      and(
        inArray(dbSchema.todos.id, ids),
        eq(dbSchema.todos.userId, userId),
        eq(dbSchema.todos.aiIgnored, false),
        isNull(dbSchema.todos.archivedAt),
        eq(dbSchema.projects.aiEnabled, true),
      ),
    );
  const seenIds = new Set(seen.map((row) => String(row.id)));
  return ids.filter((id) => !seenIds.has(id));
}

export function applyTodosExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, TODOS_SDL);

  const todoFields = (extendedSchema.getType('Todo') as GraphQLObjectType).getFields();
  todoFields.isBlocked.resolve = (parent: AnyRow, _args: unknown, context: Context) =>
    context.loaders.blocked.load(String(parent.id));
  todoFields.blockedBy.resolve = async (parent: AnyRow, _args: unknown, context: Context) => {
    const blockers = await context.loaders.blockers.load(String(parent.id));
    return isAiActor(context) ? visibleToAi(context, blockers) : blockers;
  };
  todoFields.url.resolve = (parent: AnyRow) => appLink(`/todos/${parent.id}`);

  const projectFields = (extendedSchema.getType('Project') as GraphQLObjectType).getFields();
  projectFields.todoCount.resolve = async (parent: AnyRow, _args: unknown, context: Context) =>
    (await context.loaders.todoCounts.load(String(parent.id))).total;
  projectFields.openTodoCount.resolve = async (parent: AnyRow, _args: unknown, context: Context) =>
    (await context.loaders.todoCounts.load(String(parent.id))).open;
  projectFields.url.resolve = (parent: AnyRow) => appLink(`/projects/${parent.id}`);

  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  type TransitionArgs = { id: string; reason?: string | null };

  mutations.completeTodo.resolve = async (_parent: unknown, args: TransitionArgs, context: Context) => {
    const todo = await loadOwnedTodo(context, args.id);
    if (todo.completedAt != null) return todo;
    await assertNotBlocked(context.db, [args.id]);
    return setCompletedAt(context, todo, new Date(), args.reason);
  };

  mutations.reopenTodo.resolve = async (_parent: unknown, args: TransitionArgs, context: Context) => {
    const todo = await loadOwnedTodo(context, args.id);
    if (todo.completedAt == null) return todo;
    return setCompletedAt(context, todo, null, args.reason);
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
    assertNotCompletedBehind(todo, blocker);
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

  mutations.setTodoDependencies.resolve = async (
    _parent: unknown,
    args: { id: string; dependsOn: string[] },
    context: Context,
  ) => {
    const userId = requireAuth(context);
    const todo = await loadOwnedTodo(context, args.id);
    const wanted = new Set(args.dependsOn);
    const existing: Array<{ dependsOnTodoId: string }> = await (context.db as AnyRow)
      .select({ dependsOnTodoId: dbSchema.todoDependencies.dependsOnTodoId })
      .from(dbSchema.todoDependencies)
      .where(and(eq(dbSchema.todoDependencies.userId, userId), eq(dbSchema.todoDependencies.todoId, todo.id)));
    const kept = new Set(existing.map((row) => String(row.dependsOnTodoId)));
    // An AI caller sends back the list it read, which leaves out what it may
    // not see. Those edges are not its to drop.
    for (const id of isAiActor(context) ? await hiddenFromAi(context, userId, [...kept]) : []) {
      wanted.add(id);
    }
    const dropped = [...kept].filter((id) => wanted.has(id) === false);
    // An edge already there is kept as it stands, so a caller can send back the
    // list it read. Only the new ones are held to what `addTodoDependency` asks.
    const added = [...wanted].filter((id) => kept.has(id) === false);
    for (const id of added) {
      if (id === todo.id) {
        throw new GraphQLError('A todo cannot depend on itself.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      assertNotCompletedBehind(todo, await loadOwnedTodo(context, id));
    }
    await (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      if (dropped.length > 0) {
        await tx
          .delete(dbSchema.todoDependencies)
          .where(
            and(
              eq(dbSchema.todoDependencies.userId, userId),
              eq(dbSchema.todoDependencies.todoId, todo.id),
              inArray(dbSchema.todoDependencies.dependsOnTodoId, dropped),
            ),
          );
      }
      // Checked against the graph as it will be: the dropped edges are gone, and
      // each new one is in place before the next is tried.
      for (const dependsOnTodoId of added) {
        await assertNoCycle(tx, todo.id, dependsOnTodoId);
        await tx
          .insert(dbSchema.todoDependencies)
          .values({ userId, todoId: todo.id, dependsOnTodoId })
          .onConflictDoNothing();
      }
    });
    return loadOwnedTodo(context, todo.id);
  };

  return extendedSchema;
}
