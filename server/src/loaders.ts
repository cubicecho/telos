import * as dbSchema from '@telos/db/schema';
import DataLoader from 'dataloader';
import { inArray, sql } from 'drizzle-orm';
import { findBlocked, findBlockers, type TodoRow } from './blocking.ts';

// Per-request batching. The project screen is a list of todos each asking
// whether it is blocked, and a sidebar of projects each asking for its counts —
// both are one query here rather than one per row.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyDb = any;

export interface TodoCounts {
  total: number;
  open: number;
}

const NO_TODOS: TodoCounts = { total: 0, open: 0 };

async function findTodoCounts(db: AnyDb, projectIds: readonly string[]): Promise<Map<string, TodoCounts>> {
  const byProject = new Map<string, TodoCounts>();
  if (projectIds.length === 0) return byProject;
  const rows: Array<{ projectId: string; total: number; open: number }> = await db
    .select({
      projectId: dbSchema.todos.projectId,
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${dbSchema.todos.completedAt} is null)::int`,
    })
    .from(dbSchema.todos)
    .where(inArray(dbSchema.todos.projectId, [...projectIds]))
    .groupBy(dbSchema.todos.projectId);
  for (const row of rows) {
    byProject.set(row.projectId, { total: Number(row.total), open: Number(row.open) });
  }
  return byProject;
}

export interface Loaders {
  blocked: DataLoader<string, boolean>;
  blockers: DataLoader<string, TodoRow[]>;
  todoCounts: DataLoader<string, TodoCounts>;
}

/**
 * Built once per request: a loader's batching window and its cache are only ever
 * valid within one request, and must not outlive it.
 */
export function createLoaders(db: AnyDb): Loaders {
  return {
    blocked: new DataLoader<string, boolean>(async (ids) => {
      const blocked = await findBlocked(db, ids);
      return ids.map((id) => blocked.has(id));
    }),
    blockers: new DataLoader<string, TodoRow[]>(async (ids) => {
      const byTodo = await findBlockers(db, ids);
      return ids.map((id) => byTodo.get(id) ?? []);
    }),
    todoCounts: new DataLoader<string, TodoCounts>(async (ids) => {
      const byProject = await findTodoCounts(db, ids);
      return ids.map((id) => byProject.get(id) ?? NO_TODOS);
    }),
  };
}
