import * as dbSchema from '@telos/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi } from '../ai-gate.ts';
import type { Context } from '../context.ts';
import { findFirstOpenLaneId } from '../lanes.ts';
import { stampActor } from '../provenance.ts';

// How AI hands work to the board. A request is a todo — there is no second
// table — dropped into the project's first open lane, where the board's own
// agents (or its person) pick it up. The caller adds work and talks about it;
// it never moves it, which is what actor-lock.ts enforces.
//
// Every mutation here is answered NOT_FOUND for anything AI may not see: an
// account or project with AI off, a todo the user told AI to ignore. From the
// AI side those simply are not there.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const REQUESTS_SDL = parse(`
  extend type Mutation {
    """
    Hands a piece of work to a project: a new todo in its first open lane.
    \`brief\` is what to do and why; \`acceptance\` is how to tell it is done.
    \`parentId\` makes it part of a larger todo in the same project.
    The project must have AI switched on.
    """
    submitRequest(projectId: ID!, title: String!, brief: String, acceptance: String, parentId: ID): Todo!
    """
    Withdraws a request: AI stops seeing it and it goes back to its owner, who
    decides what to do with it. \`reason\` is added to its thread.
    """
    cancelRequest(id: ID!, reason: String): Boolean!
    "Adds a note to a todo's thread, signed as whoever is calling."
    addTodoNote(todoId: ID!, body: String!): TodoNote!
  }
`);

function notFound(what: string): GraphQLError {
  return new GraphQLError(`${what} not found`, { extensions: { code: 'NOT_FOUND' } });
}

/** A project of the caller's with AI on, or NOT_FOUND. */
async function loadAiProject(context: Context, userId: string, projectId: string): Promise<AnyRow> {
  const [project] = await (context.db as AnyRow)
    .select()
    .from(dbSchema.projects)
    .where(
      and(
        eq(dbSchema.projects.id, projectId),
        eq(dbSchema.projects.userId, userId),
        eq(dbSchema.projects.aiEnabled, true),
      ),
    );
  if (!project) throw notFound('Project');
  return project;
}

/** A todo of the caller's that AI may see, or NOT_FOUND. */
async function loadAiTodo(context: Context, userId: string, todoId: string): Promise<AnyRow> {
  const [row] = await (context.db as AnyRow)
    .select({ todo: dbSchema.todos })
    .from(dbSchema.todos)
    .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.todos.projectId))
    .where(
      and(
        eq(dbSchema.todos.id, todoId),
        eq(dbSchema.todos.userId, userId),
        eq(dbSchema.todos.aiIgnored, false),
        isNull(dbSchema.todos.archivedAt),
        eq(dbSchema.projects.aiEnabled, true),
      ),
    );
  if (!row) throw notFound('Todo');
  return row.todo;
}

/** Below the lane's last card, so a new request queues behind what is there. */
async function nextPosition(tx: AnyRow, projectId: string, laneId: string | null): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${dbSchema.todos.position})` })
    .from(dbSchema.todos)
    .where(
      and(
        eq(dbSchema.todos.projectId, projectId),
        laneId ? eq(dbSchema.todos.laneId, laneId) : sql`${dbSchema.todos.laneId} is null`,
      ),
    );
  return row?.max == null ? 0 : Number(row.max) + 1;
}

async function insertNote(tx: AnyRow, context: Context, userId: string, todoId: string, body: string): Promise<AnyRow> {
  const [note] = await tx
    .insert(dbSchema.todoNotes)
    .values({
      userId,
      todoId,
      kind: 'note',
      body,
      actorKind: context.actor.kind === 'anonymous' ? 'system' : context.actor.kind,
      actorKeyId: context.actor.keyId ?? null,
      runId: context.actor.runId ?? null,
    })
    .returning();
  return note;
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new GraphQLError(`${field} cannot be empty`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return trimmed;
}

export function applyRequestsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, REQUESTS_SDL);
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  mutations.submitRequest.resolve = async (
    _parent: unknown,
    args: {
      projectId: string;
      title: string;
      brief?: string | null;
      acceptance?: string | null;
      parentId?: string | null;
    },
    context: Context,
  ) => {
    const userId = await requireAi(context);
    const title = requireText(args.title, 'title');
    const project = await loadAiProject(context, userId, args.projectId);
    if (args.parentId) {
      const parent = await loadAiTodo(context, userId, args.parentId);
      if (parent.projectId !== project.id) throw notFound('Parent todo');
    }
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      await stampActor(tx, context.actor);
      const laneId = await findFirstOpenLaneId(tx, project.id);
      const [todo] = await tx
        .insert(dbSchema.todos)
        .values({
          userId,
          projectId: project.id,
          title,
          notes: args.brief?.trim() || null,
          acceptance: args.acceptance?.trim() || null,
          parentId: args.parentId ?? null,
          laneId,
          position: await nextPosition(tx, project.id, laneId),
        })
        .returning();
      return todo;
    });
  };

  mutations.cancelRequest.resolve = async (
    _parent: unknown,
    args: { id: string; reason?: string | null },
    context: Context,
  ) => {
    const userId = await requireAi(context);
    const todo = await loadAiTodo(context, userId, args.id);
    const reason = args.reason?.trim() || null;
    await (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const note = reason ? await insertNote(tx, context, userId, todo.id, reason) : null;
      await stampActor(tx, context.actor, { reason, noteId: note?.id });
      await tx
        .update(dbSchema.todos)
        .set({ aiIgnored: true, updatedAt: new Date() })
        .where(and(eq(dbSchema.todos.id, todo.id), eq(dbSchema.todos.userId, userId)));
    });
    return true;
  };

  mutations.addTodoNote.resolve = async (
    _parent: unknown,
    args: { todoId: string; body: string },
    context: Context,
  ) => {
    const userId = await requireAi(context);
    const body = requireText(args.body, 'body');
    const todo = await loadAiTodo(context, userId, args.todoId);
    return insertNote(context.db, context, userId, todo.id, body);
  };

  return extendedSchema;
}
