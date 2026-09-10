import * as dbSchema from '@telos/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { assertNotBlocked } from '../blocking.ts';
import type { Context } from '../context.ts';
import { syncLaneCompletion } from '../lanes.ts';
import { requireAuth } from './auth.ts';

// The board's own transitions. Generated CRUD already creates, renames and
// deletes lanes; what it cannot express is the three moves that have to keep
// something true afterwards:
//
//   moveTodo      — a drop into the done lane completes the todo, and out of it
//                   reopens it, so the board and the list never disagree
//   setDoneLane   — the flag is single per project, and moving it moves the
//                   todos' completion with it
//   reorderLanes  — one statement per lane, so no intermediate order is visible
//
// See lanes.ts for the invariant these maintain and write-guards.ts for the
// re-assertion that catches anything reaching the tables another way.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const LANES_SDL = parse(`
  extend type Mutation {
    """
    Puts a todo in a lane, optionally at an index within it. Completes the todo
    when the lane marks work done, and reopens it when the lane does not.
    """
    moveTodo(id: ID!, laneId: ID!, position: Int): Todo!
    "Chooses which lane means done, or none at all. At most one per project."
    setDoneLane(projectId: ID!, laneId: ID): [Lane!]!
    "Rewrites lane order from the given ids, first to last."
    reorderLanes(projectId: ID!, laneIds: [ID!]!): [Lane!]!
  }
`);

async function loadOwnedLane(db: AnyRow, userId: string, id: string): Promise<AnyRow> {
  const rows = await db
    .select()
    .from(dbSchema.lanes)
    .where(and(eq(dbSchema.lanes.id, id), eq(dbSchema.lanes.userId, userId)))
    .limit(1);
  if (rows.length === 0) throw new GraphQLError('Lane not found', { extensions: { code: 'NOT_FOUND' } });
  return rows[0];
}

async function loadOwnedProject(db: AnyRow, userId: string, id: string): Promise<AnyRow> {
  const rows = await db
    .select()
    .from(dbSchema.projects)
    .where(and(eq(dbSchema.projects.id, id), eq(dbSchema.projects.userId, userId)))
    .limit(1);
  if (rows.length === 0) throw new GraphQLError('Project not found', { extensions: { code: 'NOT_FOUND' } });
  return rows[0];
}

function projectLanes(db: AnyRow, projectId: string): Promise<AnyRow[]> {
  return db
    .select()
    .from(dbSchema.lanes)
    .where(eq(dbSchema.lanes.projectId, projectId))
    .orderBy(asc(dbSchema.lanes.position), asc(dbSchema.lanes.createdAt));
}

/**
 * The project's todos in the single order both views read, with `id` moved to
 * `index` within `laneId`'s own run.
 *
 * `position` is project-wide rather than per-lane, so the list and the board
 * order the same todos the same way. A drop names an index inside one column;
 * translating it through the global sequence is what keeps the other view's
 * order from jumping around when a todo moves.
 */
function reposition(
  ordered: Array<{ id: string; laneId: string | null }>,
  id: string,
  laneId: string,
  index: number,
): string[] {
  const others = ordered.filter((row) => row.id !== id);
  const inLane = others.filter((row) => row.laneId === laneId);
  const clamped = Math.max(0, Math.min(index, inLane.length));
  // Landing after the last of the lane's todos means landing where that lane
  // ends, not where the project does.
  const anchor = inLane[clamped];
  const at = anchor ? others.findIndex((row) => row.id === anchor.id) : others.length;
  const ids = others.map((row) => row.id);
  ids.splice(at, 0, id);
  return ids;
}

export function applyLanesExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, LANES_SDL);
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  mutations.moveTodo.resolve = async (
    _parent: unknown,
    args: { id: string; laneId: string; position?: number | null },
    context: Context,
  ) => {
    const userId = requireAuth(context);
    const db = context.db as AnyRow;

    return db.transaction(async (tx: AnyRow) => {
      const [todo] = await tx
        .select()
        .from(dbSchema.todos)
        .where(and(eq(dbSchema.todos.id, args.id), eq(dbSchema.todos.userId, userId)))
        .limit(1);
      if (!todo) throw new GraphQLError('Todo not found', { extensions: { code: 'NOT_FOUND' } });

      const lane = await loadOwnedLane(tx, userId, args.laneId);
      if (lane.projectId !== todo.projectId) {
        throw new GraphQLError('That lane belongs to another project.', { extensions: { code: 'BAD_USER_INPUT' } });
      }

      // Completion follows the lane. Entering the done lane is a completion and
      // obeys the same dependency rule `completeTodo` does; leaving it reopens.
      let completedAt: Date | null = todo.completedAt;
      if (lane.isDone && todo.completedAt == null) {
        await assertNotBlocked(tx, [args.id]);
        completedAt = new Date();
      } else if (!lane.isDone && todo.completedAt != null) {
        completedAt = null;
      }

      const now = new Date();
      await tx
        .update(dbSchema.todos)
        .set({ laneId: args.laneId, completedAt, updatedAt: now })
        .where(and(eq(dbSchema.todos.id, args.id), eq(dbSchema.todos.userId, userId)));

      if (args.position != null) {
        const ordered = await tx
          .select({ id: dbSchema.todos.id, laneId: dbSchema.todos.laneId })
          .from(dbSchema.todos)
          .where(eq(dbSchema.todos.projectId, todo.projectId))
          .orderBy(asc(dbSchema.todos.position), asc(dbSchema.todos.createdAt));
        const ids = reposition(ordered, args.id, args.laneId, args.position);
        await Promise.all(
          ids.map((id, position) => tx.update(dbSchema.todos).set({ position }).where(eq(dbSchema.todos.id, id))),
        );
      }

      const [updated] = await tx.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, args.id)).limit(1);
      return updated;
    });
  };

  mutations.setDoneLane.resolve = async (
    _parent: unknown,
    args: { projectId: string; laneId?: string | null },
    context: Context,
  ) => {
    const userId = requireAuth(context);
    const db = context.db as AnyRow;

    return db.transaction(async (tx: AnyRow) => {
      await loadOwnedProject(tx, userId, args.projectId);
      const now = new Date();
      // Cleared first, unconditionally: the partial unique index allows one done
      // lane per project, so the flag has to leave the old lane before it can
      // land on the new one.
      await tx
        .update(dbSchema.lanes)
        .set({ isDone: false, updatedAt: now })
        .where(and(eq(dbSchema.lanes.projectId, args.projectId), eq(dbSchema.lanes.isDone, true)));

      if (args.laneId) {
        const lane = await loadOwnedLane(tx, userId, args.laneId);
        if (lane.projectId !== args.projectId) {
          throw new GraphQLError('That lane belongs to another project.', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        await tx.update(dbSchema.lanes).set({ isDone: true, updatedAt: now }).where(eq(dbSchema.lanes.id, args.laneId));
        // The same rows mean something different now, so the todos move with the
        // flag rather than being left contradicting their own column.
        await syncLaneCompletion(tx, args.projectId, args.laneId);
      }

      return projectLanes(tx, args.projectId);
    });
  };

  mutations.reorderLanes.resolve = async (
    _parent: unknown,
    args: { projectId: string; laneIds: string[] },
    context: Context,
  ) => {
    const userId = requireAuth(context);
    const db = context.db as AnyRow;

    return db.transaction(async (tx: AnyRow) => {
      await loadOwnedProject(tx, userId, args.projectId);
      const lanes = await projectLanes(tx, args.projectId);
      const known = new Set(lanes.map((lane: AnyRow) => lane.id as string));
      const distinct = new Set(args.laneIds);
      if (distinct.size !== lanes.length || args.laneIds.some((id) => !known.has(id))) {
        // A partial list would silently leave the omitted lanes at whatever
        // position they held, which is rarely the order the client drew.
        throw new GraphQLError('Reordering must list every lane in the project exactly once.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const now = new Date();
      await Promise.all(
        args.laneIds.map((id, position) =>
          tx.update(dbSchema.lanes).set({ position, updatedAt: now }).where(eq(dbSchema.lanes.id, id)),
        ),
      );
      return projectLanes(tx, args.projectId);
    });
  };

  return extendedSchema;
}
