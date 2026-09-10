import type { CachedTodo } from './blocking';
import type { CachedLane } from './cache';

/** A todo as it reads once it sits in `lane`. */
function landed(todo: CachedTodo, lane: CachedLane, now: string): CachedTodo {
  return {
    ...todo,
    lane,
    // Completion follows the lane, the way the server has it: a card in the
    // done column is finished, and one dragged out of it is open again.
    completedAt: lane.isDone ? (todo.completedAt ?? now) : null,
  };
}

/**
 * Move a todo into `lane`, over the list the cache holds.
 *
 * `index` is a position *within the lane*, because that is what a drop names;
 * `position` is project-wide, so the whole list is renumbered around the move.
 * Both views read that one sequence, and they have to renumber it the same way
 * the server does or the next fetch reshuffles the board under the pointer.
 *
 * Leaving `index` out changes only the column — which is what the "Move to"
 * menu means, and what the server does when given no position.
 */
export function moveTodoInList(
  todos: readonly CachedTodo[],
  id: string,
  lane: CachedLane,
  index?: number,
  now: string = new Date().toISOString(),
): CachedTodo[] {
  const moved = todos.find((todo) => todo.id === id);
  if (!moved) return [...todos];
  if (index == null) return todos.map((todo) => (todo.id === id ? landed(todo, lane, now) : todo));

  const others = todos.filter((todo) => todo.id !== id);
  const inLane = others.filter((todo) => todo.lane?.id === lane.id);
  const clamped = Math.max(0, Math.min(index, inLane.length));
  const anchor = inLane[clamped];
  const last = inLane[inLane.length - 1];
  // Dropping past the last card in a column lands where that column ends, not
  // where the project does — otherwise the bottom of "To do" would be after
  // everything already done.
  const at = anchor ? others.indexOf(anchor) : last ? others.indexOf(last) + 1 : others.length;

  const reordered = [...others];
  reordered.splice(at, 0, landed(moved, lane, now));

  return reordered.map((todo, position) => (todo.position === position ? todo : { ...todo, position }));
}

/**
 * The todos in one lane, in the order the board draws them.
 *
 * Generic over the row, because the board hands it the cached shape and the
 * components hand it their own narrower one; all either has to say is which
 * lane the todo is in.
 */
export function todosInLane<T extends { lane: { id: string } | null }>(todos: readonly T[], laneId: string): T[] {
  return todos.filter((todo) => todo.lane?.id === laneId);
}
