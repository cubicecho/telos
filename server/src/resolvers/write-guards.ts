import * as dbSchema from '@telos/db/schema';
import type { BuildSchemaConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import { and, eq, inArray } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { assertNoBlockedCompletions } from '../blocking.ts';
import type { Context } from '../context.ts';
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

const FOREIGN_KEYS: Record<string, ForeignKey[]> = {
  todos: [project],
  todoLabels: [todo, label],
  projectLabels: [project, label],
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
  todos: {
    before: async ({ args, context, tx }: WriteHookPayload) =>
      assertForeignKeysOwned(tx, requireAuth(context as Context), writtenRows(args), FOREIGN_KEYS.todos),
    // Checked after the statement rather than before it: a `where` may name the
    // affected rows by anything at all, so which todos a write completes is only
    // knowable once it has run. The returned rows cannot answer that either —
    // they carry only the columns the client selected — so the invariant is
    // re-asserted over the caller's todos instead. The throw rolls the
    // transaction back, statement included.
    after: async ({ args, context, operation, tx }: WriteHookPayload) => {
      if (operation === 'delete' || operation === 'restore') return;
      if (!marksComplete(args)) return;
      await assertNoBlockedCompletions(tx, requireAuth(context as Context));
    },
  },
};
