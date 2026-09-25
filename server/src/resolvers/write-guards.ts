import * as dbSchema from '@telos/db/schema';
import type { BuildSchemaConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { assertNoBlockedCompletions, resultRows } from '../blocking.ts';
import type { Context } from '../context.ts';
import { assertCompletionMatchesLane, assertEveryProjectHasLanes, realignLanes, seedMissingLanes } from '../lanes.ts';
import { stampActor } from '../provenance.ts';
import { cancelRunsUnder } from '../stations.ts';
import { requireAuth } from './auth.ts';

// A row scope confines reads, updates and deletes, but it cannot reach a plain
// insert, and it says nothing about the rows a foreign key *points at*. These
// hooks close the two holes that leaves:
//
//   1. Ownership on insert — every id a caller can state must be theirs.
//   2. Blocking on completion — a write that marks a todo done goes through the
//      same check `completeTodo` does, so the generated `updateTodo` cannot
//      route around the dependency rule.
//
// They also stamp the actor on the transaction before anything touches a todo,
// so the history trigger can say who did it (provenance.ts).
//
// They run inside the mutation's own transaction, so a throw rolls the write
// back and there is no window between the check and the write.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyTable = any;
type Row = Record<string, unknown>;

/** A foreign key and the parent table that says whether the caller owns its target. */
interface ForeignKey {
  /** Column property name on the referencing table. */
  key: string;
  /** Name used in the "not found" a caller sees — never leak another user's row. */
  entity: string;
  parent: AnyTable;
}

const project: ForeignKey = { key: 'projectId', entity: 'Project', parent: dbSchema.projects };
const todo: ForeignKey = { key: 'todoId', entity: 'Todo', parent: dbSchema.todos };
const label: ForeignKey = { key: 'labelId', entity: 'Label', parent: dbSchema.labels };
const lane: ForeignKey = { key: 'laneId', entity: 'Lane', parent: dbSchema.lanes };
const parentTodo: ForeignKey = { key: 'parentId', entity: 'Todo', parent: dbSchema.todos };
const agent: ForeignKey = { key: 'agentId', entity: 'Agent', parent: dbSchema.agents };
const onSuccessLane: ForeignKey = { key: 'onSuccessLaneId', entity: 'Lane', parent: dbSchema.lanes };
const onFailureLane: ForeignKey = { key: 'onFailureLaneId', entity: 'Lane', parent: dbSchema.lanes };

const FOREIGN_KEYS: Record<string, ForeignKey[]> = {
  lanes: [project, agent, onSuccessLane, onFailureLane],
  todos: [project, lane, parentTodo],
  todoLabels: [todo, label],
  projectLabels: [project, label],
  todoNotes: [todo],
};

/**
 * The rows a mutation is about to write: `values` on a create (one row or a
 * list), `set` on an update, one `set` per entry on a batch update. A delete
 * writes nothing and so has nothing to check.
 */
export function writtenRows(args: { values?: Row | Row[]; set?: Row; updates?: Array<{ set?: Row }> }): Row[] {
  if (args.values) return Array.isArray(args.values) ? args.values : [args.values];
  if (args.updates) return args.updates.flatMap((entry) => (entry.set ? [entry.set] : []));
  return args.set ? [args.set] : [];
}

async function assertForeignKeysOwned(
  tx: AnyTable,
  userId: string,
  rows: Row[],
  foreignKeys: ForeignKey[],
): Promise<void> {
  for (const fk of foreignKeys) {
    const referenced = [
      ...new Set(rows.map((row) => row[fk.key]).filter((id): id is string => typeof id === 'string')),
    ];
    if (referenced.length === 0) continue;
    const owned: Array<{ id: string }> = await tx
      .select({ id: fk.parent.id })
      .from(fk.parent)
      .where(and(inArray(fk.parent.id, referenced), eq(fk.parent.userId, userId)));
    const ownedIds = new Set(owned.map((row) => row.id));
    if (referenced.some((id) => !ownedIds.has(id))) {
      // NOT_FOUND, not FORBIDDEN: "you may not touch this" would confirm the row
      // exists, which is itself something the caller is not entitled to know.
      throw new GraphQLError(`${fk.entity} not found`, { extensions: { code: 'NOT_FOUND' } });
    }
  }
}

/** Whether this write is putting a non-null `completedAt` on any row. */
function marksComplete(args: Parameters<typeof writtenRows>[0]): boolean {
  return writtenRows(args).some((row) => 'completedAt' in row && row.completedAt != null);
}

/** Whether this write states a todo's completion, either way. */
function statesCompletion(args: Parameters<typeof writtenRows>[0]): boolean {
  return writtenRows(args).some((row) => 'completedAt' in row);
}

/** Whether this write states a todo's lane. */
function statesLane(args: Parameters<typeof writtenRows>[0]): boolean {
  return writtenRows(args).some((row) => 'laneId' in row);
}

/** Whether this write states any of `keys`. */
function states(args: Parameters<typeof writtenRows>[0], ...keys: string[]): boolean {
  return writtenRows(args).some((row) => keys.some((key) => key in row));
}

/**
 * The AI switches are only ever flipped by a person, through the mutations in
 * ai-switches.ts, which also stop whatever the switch was letting run. A
 * generated write would flip the flag and leave the rest running.
 */
function assertAiSwitchUntouched(args: Parameters<typeof writtenRows>[0]): void {
  if (!states(args, 'aiEnabled')) return;
  throw new GraphQLError('Use setProjectAiEnabled to switch AI on or off for a project.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/**
 * "AI ignores this" is a person's instruction to agents, so no agent or key may
 * set it or, more to the point, clear it.
 */
function assertIgnoreFlagFromPerson(args: Parameters<typeof writtenRows>[0], context: Context): void {
  if (!states(args, 'aiIgnored') || context.actor.kind === 'user') return;
  throw new GraphQLError('Only a person can change whether AI ignores a todo.', {
    extensions: { code: 'FORBIDDEN' },
  });
}

/**
 * People write plain notes. Reports and verdicts are what a run leaves behind,
 * and the server writes those itself, so a generated insert cannot pass one off.
 */
function assertPlainNotes(args: Parameters<typeof writtenRows>[0]): void {
  if (writtenRows(args).every((row) => row.kind === undefined || row.kind === 'note')) return;
  throw new GraphQLError('Only notes of kind "note" can be written directly.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/**
 * A todo's parent is in its own project, and following parents never comes back
 * around. Checked over the caller's todos after the write, for the reason the
 * completion invariant is: the rows a `where` touched are not knowable before.
 */
async function assertParentsSound(tx: AnyTable, userId: string): Promise<void> {
  const crossProject = resultRows(
    await tx.execute(sql`
      SELECT 1 FROM todos child JOIN todos parent ON parent.id = child.parent_id
      WHERE child.user_id = ${userId} AND parent.project_id <> child.project_id
      LIMIT 1
    `),
  );
  if (crossProject.length > 0) {
    throw new GraphQLError("A todo's parent must be in the same project.", { extensions: { code: 'BAD_USER_INPUT' } });
  }
  // The depth bound only stops the walk; any chain that long has already met a
  // repeat, since no user has that many todos stacked in one line.
  const cycles = resultRows(
    await tx.execute(sql`
      WITH RECURSIVE chain(start_id, parent_id, depth) AS (
        SELECT id, parent_id, 1 FROM todos WHERE user_id = ${userId} AND parent_id IS NOT NULL
        UNION ALL
        SELECT chain.start_id, t.parent_id, chain.depth + 1
        FROM chain JOIN todos t ON t.id = chain.parent_id
        WHERE t.parent_id IS NOT NULL AND chain.start_id <> chain.parent_id AND chain.depth < 1000
      )
      SELECT 1 FROM chain WHERE start_id = parent_id LIMIT 1
    `),
  );
  if (cycles.length > 0) {
    throw new GraphQLError('A todo cannot be its own ancestor.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
}

/**
 * A station's arrows point within its own board. Checked over the caller's
 * lanes after the write, like the other invariants here.
 */
async function assertArrowsInProject(tx: AnyTable, userId: string): Promise<void> {
  const stray = resultRows(
    await tx.execute(sql`
      SELECT 1 FROM lanes l JOIN lanes target ON target.id IN (l.on_success_lane_id, l.on_failure_lane_id)
      WHERE l.user_id = ${userId} AND target.project_id <> l.project_id
      LIMIT 1
    `),
  );
  if (stray.length === 0) return;
  throw new GraphQLError('A lane can only send todos to lanes on its own board.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/**
 * Which lane means done is `setDoneLane`'s to decide: moving the flag has to
 * move the todos with it, and a generated write would leave the board saying one
 * thing and the list another.
 */
function assertDoneFlagUntouched(args: Parameters<typeof writtenRows>[0]): void {
  if (!writtenRows(args).some((row) => 'isDone' in row)) return;
  throw new GraphQLError('Use setDoneLane to choose which lane marks a todo done.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

export const onWrite: NonNullable<BuildSchemaConfig['onWrite']> = {
  ...Object.fromEntries(
    Object.entries(FOREIGN_KEYS).map(([table, foreignKeys]) => [
      table,
      {
        before: async ({ args, context, tx }: WriteHookPayload) =>
          assertForeignKeysOwned(tx, requireAuth(context as Context), writtenRows(args), foreignKeys),
      },
    ]),
  ),
  lanes: {
    before: async ({ args, context, tx }: WriteHookPayload) => {
      assertDoneFlagUntouched(args);
      // Deleting a lane moves its todos (see `after`), which is history.
      await stampActor(tx, (context as Context).actor);
      await assertForeignKeysOwned(tx, requireAuth(context as Context), writtenRows(args), FOREIGN_KEYS.lanes);
    },
    // Deleting a lane sets its todos' `lane_id` to null, which can strand a
    // completed todo outside the done lane, and can empty a project's board
    // entirely. Re-asserted here for the same reason it is on todos: the
    // invariant, not the statement, is what must hold.
    after: async ({ args, context, tx }: WriteHookPayload) => {
      const userId = requireAuth(context as Context);
      if (states(args, 'onSuccessLaneId', 'onFailureLaneId')) await assertArrowsInProject(tx, userId);
      await assertEveryProjectHasLanes(tx, userId);
      await realignLanes(tx, userId);
      await assertCompletionMatchesLane(tx, userId);
    },
  },
  projects: {
    before: async ({ args }: WriteHookPayload) => assertAiSwitchUntouched(args),
    // A project without lanes has an empty board, so every project gets one at
    // the moment it is created — inside the creating transaction, so a project
    // never exists without it.
    after: async ({ context, operation, tx }: WriteHookPayload) => {
      if (operation !== 'insert') return;
      await seedMissingLanes(tx, requireAuth(context as Context));
    },
  },
  todos: {
    before: async ({ args, context, tx }: WriteHookPayload) => {
      assertIgnoreFlagFromPerson(args, context as Context);
      await assertForeignKeysOwned(tx, requireAuth(context as Context), writtenRows(args), FOREIGN_KEYS.todos);
      await stampActor(tx, (context as Context).actor);
    },
    // Checked after the statement rather than before it: a `where` may name the
    // affected rows by anything at all, so which todos a write completes is only
    // knowable once it has run. The returned rows cannot answer that either —
    // they carry only the columns the client selected — so the invariant is
    // re-asserted over the caller's todos instead. The throw rolls the
    // transaction back, statement included.
    after: async ({ args, context, operation, tx }: WriteHookPayload) => {
      if (operation === 'delete' || operation === 'restore') return;
      const created = operation === 'insert' || operation === 'upsert';
      const userId = requireAuth(context as Context);
      if (states(args, 'parentId')) await assertParentsSound(tx, userId);
      // Ignoring a todo stops whatever agent is working it.
      if (states(args, 'aiIgnored')) await cancelRunsUnder(tx, { userId, ignoredTodos: true });
      if (!created && !statesCompletion(args) && !statesLane(args)) return;
      if (marksComplete(args)) await assertNoBlockedCompletions(tx, userId);
      // A write that says what is done gets its lanes fixed to match; a write
      // that only names a lane is refused, because guessing which of the two the
      // caller meant would silently undo one of them.
      if (created || statesCompletion(args)) await realignLanes(tx, userId);
      await assertCompletionMatchesLane(tx, userId);
    },
  },
  todoNotes: {
    before: async ({ args, context, tx }: WriteHookPayload) => {
      assertPlainNotes(args);
      await assertForeignKeysOwned(tx, requireAuth(context as Context), writtenRows(args), FOREIGN_KEYS.todoNotes);
    },
  },
};
