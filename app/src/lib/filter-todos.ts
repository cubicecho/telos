import type { TodoSummary } from '@/components/domain/todo/types';
import { parseDate } from './dates';

/**
 * Narrowing a project's todos down to the one you were looking for.
 *
 * Entirely client-side, and that is a deliberate reading of the data rather
 * than a shortcut: `ProjectTodosDocument` has no `limit` and no pagination, so
 * the array these functions receive is already every todo in the project.
 * Filtering it here costs one pass over rows that are in memory anyway, and
 * keeps the board and the list filtering identically by construction. The
 * generated schema does expose `ilike` on `Todo.title` if a project ever grows
 * past what is worth shipping to the browser; that is the day to move this.
 */

/** How the list is ordered. */
export type TodoSort = 'manual' | 'due';

/** Everything the filter bar can ask for, and the whole of what lives in the URL. */
export interface TodoFilter {
  /** Free text, matched against title and notes. */
  text: string;
  /** A label id, or null for "any label". */
  labelId: string | null;
  sort: TodoSort;
}

export const NO_FILTER: TodoFilter = { text: '', labelId: null, sort: 'manual' };

/** True when the filter would narrow anything — which is what decides whether to say so. */
export function isFiltering(filter: TodoFilter): boolean {
  return filter.text.trim() !== '' || filter.labelId !== null;
}

/**
 * Case-insensitive substring over title and notes.
 *
 * `toLocaleLowerCase` rather than `toLowerCase`: the user typed the query in
 * their own locale, and Turkish dotted and dotless i are the standing reminder
 * that those are not the same function.
 */
function matchesText(todo: TodoSummary, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return todo.title.toLocaleLowerCase().includes(needle) || (todo.notes ?? '').toLocaleLowerCase().includes(needle);
}

/** The todos a filter admits, in the order it asks for. */
export function filterTodos(todos: readonly TodoSummary[], filter: TodoFilter): TodoSummary[] {
  const kept = todos.filter(
    (todo) =>
      matchesText(todo, filter.text) &&
      (filter.labelId === null || todo.labels.some((label) => label.id === filter.labelId)),
  );
  return filter.sort === 'due' ? sortByDueDate(kept) : kept;
}

/**
 * Soonest first, with undated todos last.
 *
 * Undated at the end rather than the start because "no due date" is not "due at
 * the beginning of time" — a todo nobody has scheduled should not push past
 * everything that has been. Ties fall back to `position`, so the manual order
 * is what breaks them and the sort stays stable against itself.
 */
function sortByDueDate(todos: readonly TodoSummary[]): TodoSummary[] {
  return [...todos].sort((a, b) => {
    const left = parseDate(a.dueAt)?.getTime();
    const right = parseDate(b.dueAt)?.getTime();
    if (left === undefined && right === undefined) return (a.position ?? 0) - (b.position ?? 0);
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right || (a.position ?? 0) - (b.position ?? 0);
  });
}

/** Every label actually in use in this project, by name — the only ones worth offering. */
export function labelsInUse(todos: readonly TodoSummary[]) {
  const seen = new Map<string, TodoSummary['labels'][number]>();
  for (const todo of todos) for (const label of todo.labels) seen.set(label.id, label);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
